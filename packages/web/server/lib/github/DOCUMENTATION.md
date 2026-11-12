# GitHub Module Documentation

## Purpose

Server-side GitHub pull request and issue integration for the PiChamber web
server runtime. Every GitHub call runs here; the shared UI talks to
`/api/github/*` through `RuntimeAPIs.github`, so web, desktop, hosted
mobile, and Capacitor share one code path. Tokens never reach a client.

## Entrypoints and structure

- `packages/web/server/lib/github/`: module directory.
  - `index.js`: module re-exports (`registerGitHubRoutes` and the service
    factories; route tests inject fakes through
    `registerGitHubRoutes(app, overrides)`).
  - `routes.js`: thin Express adapter (`registerGitHubRoutes`), §5.3 routes.
  - `gh-cli.js`: `gh` binary resolution (login-shell PATH), version gate,
    `auth status` (JSON with plain-text fallback), `auth token` reads.
    Binary and version are cached for the process lifetime; the working
    `auth status` flavor is remembered so older gh CLIs do not pay a
    failed `--json` spawn on every call.
  - `credential.js`: per-operation token pinning, fingerprinting, viewer cache.
  - `client.js`: native-fetch REST + GraphQL, 8 s timeout, ETag cache,
    rate-limit detection, taxonomy error mapping, host safety.
  - `repo-scope.js`: §4 discovery, remote parsing, allow-list matching, fork
    metadata loader.
  - `templates.js`: issue-template listing (`.github/ISSUE_TEMPLATE/*.md`
    via the contents API, YAML forms skipped) with a 5 min TTL cache.
  - `pulls.js` / `issues.js` / `checks.js`: domain reads and mutations with
    TTL caches and stale fallback. Detail/comment reads request
    `Accept: application/vnd.github.full+json` (`FULL_ACCEPT` in `pulls.js`)
    so responses carry `body_html` alongside `body`; the mappers expose it
    as `bodyHtml` on PR detail bodies, PR conversation comments, reviews,
    review-thread comments (`bodyHTML` in `REVIEW_THREADS_QUERY`), issue
    bodies, and issue comments. List summaries stay body-free. PR detail carries per-section
    `sectionErrors` (`reviews`/`threads`); issue detail carries
    `sectionErrors` (`linkedPullRequests`); checks carry `sectionErrors`
    (`runs`/`statuses`). A failed section keeps its array as `[]` but is
    never authoritative empty — callers render the section error.
  - `pulls.js` also serves PR conversation comments through the issues
    comments API for the PR number (paginated, ~15 s cache; posting
    invalidates the number's entries so the re-read sees the comment).
    Both detail readers attach
    `viewerPermission` (`level` + `fallback`), `capabilities`, and
    `viewerLogin` (see Credential model); issue detail additionally returns
    `linkedPullRequests` (number, title, state, draft, url, repo) resolved
    via GraphQL (`closedByPullRequestsReferences` plus `CrossReferenced` /
    `Connected` timeline PR sources, deduped).
  - `context.js`: agent-facing context payloads with budgets (§8).
  - `cache.js`: TTL caches with in-flight coalescing + rate-limit windows,
    plus shared key/predicate helpers (`repoCachePrefix`,
    `repoInvalidatePredicate`, `nextCursor`).
  - Shared mapping/validation helpers: `mapUser`/`mapLabel` live in
    `pulls.js` (imported by `issues.js`); `parsePerPage`/`parseEnumParam`
    and the viewer-context loader (`buildViewerContextLoader`) live in
    `repo-scope.js`; `toSectionError` lives in `errors.js`.
  - `errors.js`: §5.1 taxonomy, HTTP mapping, secret redaction.

Registered in `packages/web/server/lib/workspace/host.js` via
`registerGitHubRoutes(app)` alongside the git/fs routes. All `/api/*`
routes run behind the global auth gate in
`lib/server/core-routes.js`, which is what protects the mutating routes —
no per-route auth is added here.

## Credential model (§3.1, §3.2)

- Source of truth is the GitHub CLI's active account. No login flow, no
  stored tokens, no account switcher.
- Binary: `GH_BINARY` / `PICHAMBER_GH_BINARY` override, then the
  login-shell PATH (`$SHELL -l -c 'printf %s "$PATH"'`, 2.5 s timeout,
  5 min cache), then the process PATH via the shared
  `lib/tunnels/executable-search.js` helpers.
- Minimum gh version: `2.4.0` (`MIN_GH_VERSION` in `gh-cli.js`), floored by
  the flags used (`gh auth token --hostname`, plain `gh auth status`).
  `gh auth status --json hosts` is attempted first and plain-text parsing
  is the fallback for gh versions that reject `--json` (2.46 does). Current
  gh lists every account signed in to a host; status reports one entry per
  host, the active account, and counts it signed in only when its `state`
  is `success`.
- Token: `gh auth token --hostname <host>` via `execFile` (arg array, no
  shell), 5 s timeout, memory only, ~30 s cache per host.
- Pinning: `withPinnedCredential(host, task)` reads the token once per
  logical operation; every request in the chain uses that token. Cache keys
  use `sha256(host + token)` fingerprints, never the token.
- Viewer (`GET /user`) cached per fingerprint ~10 min, successes only.
- Viewer permission reuses the repo-info loader (`GET /repos/{owner}/{repo}`
  `permissions`: `admin`, `maintain`, `push`, `triage`, `pull`), so it is
  cached per fingerprint + repo ~5 min with successes only. Resolution never
  throws: failure resolves to `{ level: null, fallback: true }` with
  permissive capabilities, so the UI keeps controls enabled and the single
  attempt reports the server error instead of hiding controls silently.
- Never runs `gh auth switch/login/logout/setup-git`, never writes git
  config or `~/.git-credentials`. `gh` stdout is never logged or forwarded.

## Scope resolution (§4.1, §4.2)

- Containing: `git rev-parse --show-toplevel`. Enclosing: upward walk from
  the containing root's parent, bounded at `$HOME`/filesystem root (64
  levels max). Nested: breadth-first walk below the root — max depth 4,
  max 50 repos, max 5000 dirs, 2 s budget, skipping `node_modules`, `.git`,
  build/output dirs; `.gitmodules` paths marked `submodule: true`;
  ignored paths filtered with one batched `git check-ignore --stdin`
  spawn. Any cutoff sets `truncated: true`, never a silent short list.
- Worktrees share the containing checkout's identity `(host, owner, repo)`.
- Remote parsing: `https://`, `http://`, `ssh://`, scp-like
  `git@host:owner/repo`, optional `.git`/port/credentials. Default remote:
  tracking → `origin` → `upstream` → first GitHub remote. Fork parent via
  `GET /repos/{owner}/{repo}` (lazy, credential required).
- Git reads run fail-closed: `GIT_TERMINAL_PROMPT=0`,
  `GCM_INTERACTIVE=never`, empty `GIT_ASKPASS`/`SSH_ASKPASS`. Scope cached
  per directory 30 s; `POST /api/github/invalidate` clears it.
- `GET /api/github/scope` enriches every GitHub entry with fork/parent/
  default-branch metadata (the UI reads these for whichever repository is
  selected), paced at 4 concurrent repo-info reads; repeat loads hit the
  5 min repo-info cache.
- v1 enables `github.com` only; the client stays host-aware for later
  Enterprise enablement.

## Caching (§5.2)

| Read | TTL |
|---|---|
| Lists (PRs, issues) | 30 s |
| PR / issue detail | 15 s |
| Checks | 15 s |
| PR files, PR/issue comments, job steps, annotations, repo meta | ~15 s (mutations invalidate; comment posts invalidate that number) |
| Scope | 30 s per directory |
| Repo info (fork, default branch) | 5 min |
| Viewer | 10 min per fingerprint |
| Viewer permission (`GET /repos/{o}/{r}` `permissions`) | 5 min per fingerprint + repo (shared repo-info cache) |
| Token | ~30 s per host |
| Issue templates | 5 min |

Only successes are cached. Identical in-flight reads coalesce.
Rate-limited/timed-out reads serve last-good with `stale: true` +
`fetchedAt`; any other failure propagates so it never reads as empty.
Per-section failures (PR reviews/threads, check runs/statuses) surface in
`sectionErrors` instead of degrading to `[]`.
Background reads should check `client.isRateLimited(host)` and pause
during the window; user actions are still attempted.

`body_html` attachment/private images are rewritten by GitHub to
short-lived signed URLs (expire ~5 min). Detail caches hold them only
15 s and comment lists only ~15 s, so a served body can never outlive
its image URLs by a meaningful margin.

## Error taxonomy (§5.1)

Success payload, or `{ error: … }`:

- `{ kind: 'unavailable', reason }`: `gh-missing` | `gh-outdated` |
  `gh-unauthenticated` | `not-github` | `no-repository` | `no-access` |
  `scope-missing` (with `scopes` when known).
- `{ kind: 'rate-limited', retryAt }` (ms epoch).
- `{ kind: 'failed', message }` (secret-free).

HTTP mapping: `scope-missing` → 403; `not-github` / `no-repository` /
`no-access` (incl. repo allow-list rejection) → 404; `gh-*` → 503;
`rate-limited` → 429; `failed` → 502; bad input → 400
`{ error: { kind: 'failed', message } }` (via `inputError`, same body shape
with `statusCode` 400 so callers can distinguish bad input from upstream
failures).

## Routes (§5.3 + UI support)

All repo-scoped routes take `directory` (query or body) plus
`repo=host/owner/name`, validated against the scope allow-list.

```
GET  /api/github/status
GET  /api/github/scope?directory=
GET  /api/github/pulls?repo=&directory=&state=&filter=&q=&cursor=&sort=
GET  /api/github/pulls/:number?repo=&directory=
GET  /api/github/pulls/:number/files?repo=&directory=&cursor=
GET  /api/github/pulls/:number/checks?repo=&directory=&details=
GET  /api/github/pulls/:number/comments?repo=&directory=&cursor=
GET  /api/github/pr-status?directory=&branch=
POST /api/github/pulls                        { title, head, base, body?, draft? }
POST /api/github/pulls/:number/actions        { action, expectedHeadSha? }
POST /api/github/pulls/:number/comments       { body }
POST /api/github/pulls/:number/reviews        { event, body?, comments?[], commitId? }
POST /api/github/pulls/:number/threads/:threadId  { action: reply|resolve|unresolve, body?, commentId? }
PATCH /api/github/pulls/:number               { title?, body? }
POST /api/github/pulls/:number/checkout       { mode: worktree|current }
GET  /api/github/issues?repo=&directory=&state=&filter=&q=&labels=&cursor=&sort=
GET  /api/github/issues/:number?repo=&directory=
GET  /api/github/issues/:number/comments?repo=&directory=&cursor=
POST /api/github/issues                       { title, body?, labels?, assignees?, milestone? }
PATCH /api/github/issues/:number              { title?, body?, state?, stateReason?, labels?, assignees?, milestone? }
POST /api/github/issues/:number/comments      { body }
GET  /api/github/meta?repo=&directory=&kinds= { kinds?: labels|assignees }
GET  /api/github/templates?repo=&directory=  markdown issue templates (name, filename, body)
GET  /api/github/checks/jobs?repo=&directory=&runId=&jobId=
GET  /api/github/checks/annotations?repo=&directory=&checkRunId=
POST /api/github/checks/rerun                 { repo, directory, runId }
GET  /api/github/context?type=&repo=&directory=&number=[&ref=][&includeDiff=]
POST /api/github/invalidate                   { directory?, repo?, kind?, number? }
```

- `state`: pulls `open|closed|merged|all`; issues `open|closed|all`.
  Unknown values are 400 input errors (absent/empty keeps the default).
- `filter`: pulls `all|mine|review|assigned`; issues `all|mine|assigned|mentioned`.
  Unknown values are 400 input errors.
- `sort`: `updated|created` on both list routes; unknown values are 400s.
- `cursor`/`perPage`: validated as before (`perPage` 1..100, default 30).
- `cursor`: opaque page cursor (page number). `nextCursor: null` ends paging.
  `state=merged` advances from the raw closed page, so a page filtered to
  zero merged PRs still continues paging instead of stalling.
- `pr-status`: PR for the directory's branch (open preferred over
  closed/merged), checks summary for open PRs; default branch returns
  `{ pr: null, skippedDefaultBranch: true }`. Branch names are capped at
  300 characters.
- `pulls/:number/checks`: resolves the head SHA with one single-resource
  PR read, not the full detail fan-out (reviews/threads/viewer).
- `pulls/:number/comments`: top-level PR conversation comments via the
  issues comments API for the PR number (oldest-first pages of 100,
  `nextCursor`, ~15 s cache; failures propagate so they never read as empty).
- Thread ids (`threads/:threadId`) must be non-empty strings ≤ 200 chars.
- `issues/:number` detail now returns `linkedPullRequests` (with
  `sectionErrors.linkedPullRequests` on GraphQL failure) plus
  `viewerPermission`/`capabilities`/`viewerLogin`; `pulls/:number` detail
  returns `viewerPermission`/`capabilities`/`viewerLogin`.
- Mutation results stay lightweight: `runAction`/`updatePull` return
  `pr: null` and `updateIssue` returns `issue: null` (the UI re-reads
  after invalidating). Caches are still invalidated server-side.
  Unmapped summary fields (`headLabel`, `maintainerCanModify`,
  `requestedTeams`) were dropped — no UI reader consumed them.
- `meta` loads labels + assignees concurrently and is cached ~15 s;
  template candidate files load with a concurrency of 4 in priority order.
- `checkout`: fetches `refs/pull/<n>/head` with git only into
  `pr-<n>-<slug>`, then creates the worktree through
  `lib/git/service.js` (`validateWorktreeCreate`/`createWorktree`,
  dynamically imported so git-module refactors degrade to an explicit
  error rather than a crash). A leftover local branch is reused (the live
  worktree path when still checked out, otherwise a safe ancestor-only
  fast-forward plus a `mode: 'existing'` attach that preserves local
  commits). `mode: current` creates the branch and checks it out in place
  instead (also fast-forwarding only when safe and not checked out elsewhere).
- `context` types: `issue`, `pr` (`includeDiff=1`), `checks` (PR number
  or explicit `ref`), `threads`. See `context.js` for budgets. A failed
  comments/files fetch inside `issue`/`pr` context is marked with a
  `Note: … could not be loaded` line in the context text — partial reads
  stay partial and never render as authoritative empty. No new response
  fields were added (`warnings` is a builder input only).

## Invariants

- Never mutate shared user state: no git config writes, no `gh auth`
  mutations, no credential files.
- Tokens: memory only; never logged, returned, or embedded in errors;
  `gh` output never forwarded raw. `redactSecrets` guards fragments.
- `execFile` with argument arrays only. Owner/repo charset validated,
  numbers are positive integers, before use in URLs or git refs.
- `repo` restricted to resolver-produced repositories (§5.3 allow-list).
- Mutations are idempotent-safe on retry and never auto-retried after an
  uncertain outcome; destructive UI actions need confirmation (UI layer).
- Markdown from GitHub renders through `GitHubRichBody` (GitHub's own
  `bodyHTML`, sanitized again client-side with DOMPurify) with a sanitized
  markdown fallback; images load without credentials (UI layer).
- Never return an empty list on failure; stale serves are explicit. A
  failed section (`sectionErrors`) never reads as an empty section.

## Notes for contributors

- Add domain logic in `pulls.js` / `issues.js` / `checks.js`, keep
  `routes.js` a thin adapter (validation + allow-list + error mapping).
- New reads need a TTL cache entry above, fingerprint-scoped keys, and
  `readWithStaleFallback` where last-good serves are appropriate.
- Tests live beside the module (`*.test.js`, vitest). `gh` is faked via
  injected `execFileAsync`; HTTP via injected `fetchImpl`; no network.
- `loadGitService` in `routes.js` dynamically imports
  `lib/git/service.js`: do not statically import the git module from here
  (it is under concurrent refactor and must degrade gracefully).
