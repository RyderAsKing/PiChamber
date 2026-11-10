# GitHub Shared Views

`packages/ui/src/components/views/github/` owns reusable building blocks (import each module directly; there is no barrel) for
the Pull requests and Issues rail surfaces. Surfaces compose them; they never
call `RuntimeAPIs.github` directly except through `GitHubSurfaceShell`'s
scope/status bootstrap (stores own the fetch logic).

Visual language follows t3code's pull-request UI (layout, density, row and
header anatomy, empty/loading states), adapted to PiChamber semantic tokens,
typography, buttons, and icons. Issues share the exact same language — there
is no t3code issues equivalent, so issues reuse the PR rows, headers,
sections, and comment cards.

## Pieces

- `GitHubSurfaceShell`: scope/status bootstrap only — no title (the rail
  header already names the surface), no acting account, no stale banner
  (lists render the single stale banner). A compact `RepositoryPicker` row
  renders only when several repositories are in scope; single-repo scope
  shows no repo chrome. Body renders through `children({ repo, directory })`
  once a repository is selected; loading shows skeleton rows and every
  unavailable state renders centered here.
- `GitHubUnavailableState` + `toUnavailableInfo`: distinct copy + concrete
  fix per reason (`gh-missing`, `gh-outdated`, `gh-unauthenticated` with
  `gh auth login`, `not-github`, `no-repository`, `no-access`,
  `scope-missing` with the exact `gh auth refresh -s <scope>` command,
  `rate-limited` with retry time, `failed` with message + Retry). Commands
  render copyable. Centered layout shared with the list empty state.
- `RepositoryPicker`: `Select` trigger (`size="sm"`, chrome from
  `dropdownTriggerVariants` via `SelectTrigger`); disabled entries show why.
- `GitHubRow` (shared two-line row): leading glyph column `w-4` (PR state
  glyph with the checks glyph stacked below), line 1 = `#N` mono muted
  tabular + title truncate + signals (checks/review for PRs, comment count
  for issues) + `ml-auto` diffstat (PRs, hidden when both 0), line 2 = muted
  micro meta (author avatar `size-3.5` + login, PR branches `head → base`
  with the base kept visible, up to 3 label chips staged by row container
  width + `+N`) + `ml-auto` short relative time (`3h ago`). Flat rows
  (`rounded-md`), hover background, selection token when selected — no
  chevron, no borders. Lists render rows in `div.flex.flex-col.p-1.5`.
- List primitives (`GitHubListPrimitives`): `GitHubFilterTabBar` (kept for
  the composer link picker), `GitHubSearchInput` (80 ms debounce with the
  callback held in a ref, icon
  addon, qualifier placeholder — filtering is client-side, so typing never
  fetches), `GitHubListSkeleton` (muted low-alpha bars, first load — never
  spinners), `GitHubCenteredState` (glyph `size-6` muted/60,
  `typography-ui-label` title, `typography-micro` muted `max-w-60`
  description, optional outline sm action), `GitHubEmptyState`
  (`no-items` vs `no-match` with Clear filters), `GitHubLoadMore` (quiet
  outline sm at the list end), `GitHubStaleBanner`
  ("Showing saved results — last refresh failed" + Retry; exactly one
  renders per surface), `GitHubIncompleteNotice` (honesty footer for
  filtered incomplete collections: "Showing N matches from the M most
  recent loaded" + a ghost `Search all on GitHub` button), `GitHubRemoteSection`
  ("More results from GitHub" below the local rows with its own load-more
  and inline error + Retry — remote failures never replace local rows, and
  rate limits say so explicitly), `GitHubNumberJumpRow` (`#123` / `123`
  queries missing from loaded items render an `Open #N` row; the detail
  view loads by number with a null seed), `SectionError` (per-section
  failure row with Retry — a failed section never renders as empty).
  `GitHubListView` (`GitHubListView.tsx`) owns the whole list chrome both
  entity lists share (toolbar, stale banner, blocking error/first-load
  branching, empty state, load more, remote section, incomplete notice).
  There is no counts footer: the rows already show how many there are and
  when each changed, and the Filters menu shows the state. Pulls and issues
  pass only row rendering, filter menus, the primary action, and copy. The list toolbar (second row, `border-b border-border
  px-3 py-2`) always keeps search + filters (Filters dropdown, Sort).
  `GitHubListView` takes an optional `primaryAction` (the primary list
  action, e.g. New issue — explicitly separate from the filter controls)
  and an optional `headerActionsSlot` plus `headerActionsPresentation`
  (`desktop` ContextPanel header, `drawer` mobile/tablet header;
  TerminalView `terminalHeaderSlot` precedent): when a host provides the
  slot, the action controls (Refresh + `primaryAction`) portal into the
  host top header row and the toolbar keeps only search + filters; when
  absent (any other host) actions render inline in the toolbar exactly as
  before. Pulls/issues pass the slot through as `headerActionsSlot` +
  `headerActionsPresentation` (`PullRequestsSurface` / `IssuesSurface` →
  `PullsList` / `IssuesList` → `GitHubListView`), and only while the list
  is shown — detail/form routes unmount the list, so the portal unmounts
  and the header never shows list actions. Hosts gate the slot by
  visibility (`isActive ? slot : null`, terminal precedent). The desktop
  `ContextPanel` hosts one `githubHeaderSlot` in its `h-10` header (icon +
  title stay left, actions right-aligned before the panel buttons) with
  `desktop` sizing (ghost `h-8 w-8` icon buttons, `size-4` icons; New issue
  a ghost `h-8` text button). The mobile/tablet drawer
  (`MobileWorkspaceDrawer`) hosts one slot per tab inside its
  `MobileSurfaceHeader` actions with `drawer` sizing (ghost 36px `size-9`
  icon buttons, `h-9` text button, `size-4` icons), so the keep-alive
  hidden tab portals into its own hidden header and never leaks into the
  visible tab.
  `useGitHubRemoteSearch` owns the remote-search state both surfaces share
  (auto search after ~400 ms idle, manual search-all, remote paging,
  number-jump parsing, local dedupe).
- `GitHubFiltersMenu`: Filters `DropdownMenu` button (icon + active-count
  pill) holding State/Involvement radio submenus (plus a Labels entry for
  issues — the separate labels input is gone, behavior preserved through
  `filters.labels`), `GitHubSortMenu` icon button, `GitHubRefreshButton`
  icon button (spins while refreshing). Filters/Sort triggers are borderless ghost
  `Button`s (`h-8`, matching the search input, like the Git/Files header
  controls) inline in the list toolbar. `GitHubRefreshButton` takes
  `presentation`: `toolbar` renders the same ghost `h-8 w-8` inline, `desktop` renders a ghost `h-8 w-8`
  icon button (`size-4` icon) for the ContextPanel header, `drawer`
  renders a ghost 36px (`size="icon"`, `size-4` icon) button for the
  mobile/tablet drawer header.
- Detail scaffold (`GitHubDetailScaffold`): `formatGitHubRelativeTime`
  (short labels: `just now` / `{m}m ago` / `{h}h ago` / `{d}d ago` /
  `{w}w ago` / `{mo}mo ago` / `{y}y ago`),
  `GitHubAvatar` (`xs` = `size-3.5` for rows, `sm` = `size-5`/20px for
  comment cards), `GitHubStateGlyph` (PR open/draft/merged/closed; issue
  open/completed/not planned), `GitHubStatePill` (same states as a
  bordered pill with glyph + label, status tokens), `gitHubStateTintClass`
  (state tint for the `#N ↗` header link), `GitHubChecksGlyph`
  (success/failure/pending/neutral), `GitHubLabelChip` (GitHub label colors
  at low mix over theme surfaces for accessible contrast),
  `GitHubDetailHeader` (row 1 `h-7`: back ghost icon + repo muted only when
  multi-repo + `#N ↗` tinted by state + state pill, primary action + `⋯`
  menu right; row 2: title `text-base` semibold truncate + hover pencil,
  `·`-separated meta line, `base ← head` branches line; the header itself
  carries no status card — branch state renders as a strip below the action
  row), `GitHubDetailScaffold` (header block,
  underline tab nav (`h-9` text tabs, active 2px `bg-interactive-selection`
  bar, counts in muted micro, optional per-tab glyph) with right-side
  per-tab summary, scroll body), `GitHubMetaRow`
  (`grid-cols-[6rem_minmax(0,1fr)]` for Reviewers/Labels/Assignees/Milestone/
  Linked PRs), `GitHubSection` (collapsible, sticky `text-xs font-medium
  text-muted-foreground` header + rotating chevron, content directly on the
  tab background), `GitHubCommentCard` (the only bordered card allowed:
  `rounded-md border border-border/60`, header row `bg-muted/25 px-3 py-2`
  with 20px avatar, author, `·`-separated meta and the relative time linking
  to GitHub via `timeHref`, body `px-3 py-3`), `GitHubMarkdownBody` (renders
  GitHub's `bodyHTML` via `github/GitHubRichBody.tsx` — DOMPurify-sanitized
  with lazy/async/no-referrer images, external links via `openExternalUrl`,
  and an expired-image fallback link — falling back to `SimpleMarkdownRenderer`
  with raw `<img>` tags preprocessed into image syntax when html is absent;
  images load without credentials; sanitize results are memoized bounded
  by total characters), `GitHubCollapsibleBody` (same body with long text
  behind a "Show more" fade — collapsed renders a plain-text excerpt with
  no sanitize cost, the full body mounts only once expanded; thresholds in
  `github/githubBody.ts`), `useHeaderRepoName` (short `owner/repo`, null
  for single-repo scope), `useCopyGitHubLink` (stable copy-link handler),
  `GitHubThreadComment` (one thread card: avatar + author, relative time
  linking to GitHub, bot badge, collapsible body), `GitHubCommentOrderToggle`
  (newest/oldest switch), `GitHubBotCommentGroup` (bot cards behind one
  group toggle; human comments render fully above).
- `GitHubConfirmActionButton`: anchored confirm popover for state-changing
  actions (title, consequence, Cancel + confirm with progress label),
  shared by the PR and issue action rows (including checkout-in-current).
- `GitHubCommentForm`: presentational inline comment form (single-row
  bordered box, auto-growing draft, Comment button + optional ghost
  close/reopen-with-comment, Ctrl/⌘+Enter). Both composers keep keystroke
  state locally and persist it debounced to the pending-review store
  (`useDebouncedCommentDraft`, flushed on blur/unmount), so drafts survive
  navigation without a store write per keystroke. Posting plus the
  close/reopen follow-up runs through the shared `useCommentWithFollowUp`
  sequencing. Gating (hiding the form) stays with the caller.
- `PullRequestsSurface`: pull-request list/detail surface (companion worker).
  List toolbar (no title): search + Filters + Sort always inline; the
  action controls (Refresh — PRs have no primary action) portal into the
  host top header row (`headerActionsSlot` + `headerActionsPresentation`)
  while the list is shown, and render inline in the toolbar when no slot
  is provided; rows per
  `GitHubRow`; skeleton only on true first load of the
  needed collection(s). The list reads two wide collections (`open` +
  `closed`, perPage 100) and every view — state tab (merged split locally
  by `mergedAt`), involvement (viewer login from `useGitHubLogin`; unknown
  viewer falls back to remote search), text (title, `#N`, author, branches,
  labels; all tokens must match), sort — is a `useMemo` selector from the
  shared `githubListFiltering` helper, so tabs and keystrokes never fetch.
  Stale-while-revalidate with a 30 s fresh window: mounts show cache and
  revalidate only when stale (no forced refresh on mount); the toolbar
  refresh button forces; background revalidation spins only that button
  while the list stays mounted. Detail header carries the
  state pill; a wrapping action row below it holds the visible actions —
  split Merge pull request (method radio menu: Merge commit / Squash and
  merge / Rebase and merge, persisted via `readMergeMethod`/store), Ready
  for review / Convert to draft, Close / Reopen,
  Check out (worktree direct, plus a confirm-popover "Check out here"),
  Ask agent (PR context via
  `useSendGitHubContextToComposer`), Review on GitHub, trailing `⋯` menu —
  every gated action disabled with its reason, and merge/close/draft/ready/
  update-branch confirmed via a small popover anchored to the button
  (`pullActionConfirmCopy` titles/consequences/progress labels in
  `pullLogic.ts`). A branch-status strip below the action row (open PRs
  only, from `describeBranchStatus` in `pullLogic.ts`) shows `behind` as a
  warning with an Update branch confirm button, and `dirty` (merge
  conflicts) as an error with a Resolve on GitHub link instead of the
  update action. Underline tabs: Summary | Code (files count, plus a
  pending-review count when line comments await submission) | Checks
  (`success/total` + rollup glyph). Summary holds MetaRows + Description +
  Comments (cards only, newest/oldest toggle, older paging, bot comments
  collapsed, error with retry — never empty); Checks lives in
  `pulls/PullChecksTab` (rollup line + flat hover rows + re-run/details/send
  failed checks to agent/refresh + section errors); checkout renders an
  inline result row. `PullFilesTab` takes `headSha` for diff anchoring and
  an optional `onReviewSubmitted` refresh callback; its sticky summary bar
  holds the Review button (`pulls/PullComposer` `PullReviewControl`:
  `default` variant with `Review · N` while N line comments are pending,
  else `outline` Review — summary textarea, verdict select via
  `allowedReviewVerdicts`, discard-pending, submit via `canSubmitReview`).
  Commenting lives inline at the end of the Summary tab's Comments section
  (`PullCommentForm`: `border-t` separator, rounded bordered 2-row box that
  auto-grows to ~160px, Comment button inside the box's bottom-right with an
  optional ghost Close/Reopen-with-comment beside it, Ctrl/⌘+Enter to post,
  error text below; keystrokes stay local and persist debounced to the
  pending-review store, posting plus the follow-up through the shared
  `useCommentWithFollowUp` sequencing; hidden when the viewer cannot comment). The Files tab renders each file in
  a `FileCard` (`pulls/PullFileReview`) whose Pierre diff has gutter/line
  interaction: the gutter `+` (or a line-range selection, collapsed to its
  last line) opens an inline draft box under that line, pending comments
  render as dashed cards under their line until the review is submitted, and
  server threads render as cards under their diff line (resolved start
  collapsed; reply keeps text on failure; resolve/unresolve gated) with
  unanchored threads in a compact Other conversations block. Mobile
  (`hideFilesTab`) omits the Files tab; the inline comment form still posts
  comments and the Review button moves to the Summary comments header so
  summary-only reviews keep working. Detail Overview renders top-level conversation
  comments from `GET /pulls/:number/comments` (newest/oldest toggle, older
  paging, bot comments collapsed, error with retry — never empty) with
  optimistic posting and rollback; actions and edits are permission-gated
  with reasons (`pullLogic.ts`), falling back to attempt-and-surface when
  permission resolution failed.
- `IssuesSurface`: issues list (same toolbar; New issue arrives as
  `primaryAction` — explicitly separate from the filter controls — so it
  portals into the host header with Refresh while Filters/Sort stay
  inline in the toolbar,
  State/Involvement in Filters menu, labels via Filters Labels entry,
  cursor Load more per collection, last-known-first with the same 30 s
  stale-while-revalidate contract as pulls; local views add the labels
  filter, and `mentioned` involvement always consults the server since it
  has no local signal) and in-place detail (single Summary
  content, no tabs: MetaRows, Description, Comments cards + inline composer
  (`GitHubCommentForm`); header primary = Start session, with an action row
  below the header carrying Close issue (split completed/not-planned menu) /
  Reopen (each via an anchored confirm popover), Ask agent, Open on GitHub,
  and a `⋯` overflow (Edit title, Copy link). Human comments render fully;
  bot comments collapse into one group toggle and very long bodies behind a
  shared "Show more" collapse (`GitHubCollapsibleBody`; PR comments and
descriptions share it). Singleton: remounts on switch and restores filters/selection
  from `useGitHubIssuesStore`. Linked-PR rows reuse `GitHubRow` and open
  the PR in the Pull requests surface (`openPullRequestInSurface`) when its
  repository is in scope, otherwise on GitHub; a failed linked-PR section
  renders an error with retry, never empty. Actions and edits are
  permission-gated with reasons (`issueLogic.ts`), falling back to
  attempt-and-surface when permission resolution failed.
- `issues/`: issue-owned list/detail/form/dialog components plus pure
  `issueLogic.ts` (close-reason mapping, validation,
  template application, link parsing, worktree branch names). Permission
  gating, author matching, and title validation are shared with pulls via
  `github/githubPermissions.ts`; body-length helpers via
  `github/githubBody.ts`; label/assignee pickers and the `repoMeta` fetch
  via `GitHubMetaPickers.tsx` (also used by `NewIssueForm`).
- `githubListFiltering.ts`: pure shared list views for both surfaces —
  state split (pull merged via `mergedAt`), involvement (case-insensitive
  viewer match; unknown viewer or issue `mentioned` passes through for the
  server fallback), labels (filter + `label:` qualifiers), tokenized text
  search (all tokens must match across title, number, author, pull
  branches, label names), shared sort, `parseNumberQuery`, number-keyed
  merge/dedupe, comment-page id dedupe (`mergeCommentsById`, so cursor
  pages never duplicate a card in either display order). No React/store imports.
- `agent/`: session/composer integration shared with the PR surface —
  `useStartSessionFromGitHubItem` (current checkout or new-worktree draft
  seeding, never sent; reuses the leftover branch via `mode: 'existing'`
  or the live worktree path when still checked out), `GitHubLinkPicker` (composer attach-menu picker),
  `githubLink.ts` (`insertGitHubContextIntoComposer` + chip-payload builders).

## No nested cards

Detail views never nest bordered boxes: `FileCard` keeps its single outer
border while the diff wrapper is borderless; inside the diff, review threads
and pending comments render as the only bordered annotation cards under
their line (plus the inline draft box), and threads whose line left the diff
collect in one Other conversations block — never a second flat thread list
below the file. Checks/status rows are flat hover rows
(`rounded-md px-2 py-2 hover`); review/checkout render as flat sections or
header-menu items; the only bordered cards are comment cards placed
directly on the tab background.

## Narrow widths

Surfaces stack list → detail: detail opens in place with a back control
(`GitHubDetailHeader`), sharing the panel width with other rail surfaces.
Toolbars wrap (`flex-wrap`) for 320–420px rails. Capacitor/mobile reuse the
same stack; desktop keeps the single-column rail layout.

## Invariants

- A failed fetch never renders as empty: shell and list/detail paths prefer
  `GitHubUnavailableState` / `GitHubStaleBanner` over empty lists.
- The surfaces stay out of the eager startup graph: `ContextPanel` and the
  mobile drawer load `PullRequestsSurface` / `IssuesSurface` lazily, and
  callers outside this folder hand off a PR selection through
  `openPullRequestInSurface.ts`, never by importing the surface module (PR
  file review reaches `@pierre/diffs` → Shiki, ~1.2 MB raw).
- Theme tokens only; no hardcoded colors. Buttons use shared variants.
- Copy follows locale precedent (inline Sentence-case strings, `aria-label`
  on icon-only controls).

## API contract

List endpoints `GET /api/github/pulls` and `GET /api/github/issues` accept
`perPage` (integer 1..100, default 30; invalid values are 400s) so surfaces
can fetch one wide list and filter locally. `state=all` returns every state
on both the REST and search paths (pulls search: `merged` adds `is:merged`,
`closed` keeps `state:closed`, `all` omits the state qualifier). List
summaries carry `labels`, `assignees`, `requestedReviewers`,
`draft`, and `mergedAt` (from
`pull_request.merged_at` on search results) with no body text; full bodies
arrive via the detail endpoints. Detail/comment payloads additionally carry
`bodyHtml` (GitHub's rendered `bodyHTML`: PR description, conversation
comments, reviews, review-thread comments, issue body, issue comments) with
signed image URLs that expire ~5 min after render — well above the 15 s
server detail TTL and the uncached comment reads — so the UI prefers `html`
and falls back to markdown (older cache, optimistic post) without ever
showing literal `<img>` tags.

## Code tab

The PR Files tab (`pulls/PullFilesTab.tsx`, pure helpers in
`pulls/pullFilesLogic.ts`, cards in `pulls/PullFileReview.tsx`) renders the
changed-file list as a summary bar plus one `FileCard` per file.

- Summary bar (sticky `h-8`): file count, `GitHubDiffStat` totals, a
  `viewed/total viewed` counter, a "Files" jump control (base-ui `Popover`
  with a filter input and folder-grouped rows: status icon/letter tinted by
  `statusTintForFile`, muted directory + emphasized basename, diff stat,
  thread/pending counts, viewed check), and ghost icon buttons for Expand
  all / Collapse all (`aria-label`led). At the `@4xl` container width the
  grouped list also renders as a sticky left sidebar and the jump control
  hides; narrow widths keep only the jump control.
- `FileCard` headers are sticky below the summary bar and show a collapse
  chevron, a tinted status icon, the split path (full path in `title`), a
  status letter, the diff stat, open-thread/pending counts, and a Viewed
  checkbox (checking collapses the card; unchecking expands it). All
  existing annotation behavior (gutter draft, pending cards, inline
  threads, Other conversations, Send to agent) is unchanged, and
  `PierreDiffViewer`'s shadow-DOM annotation roots are untouched.
- Viewed state lives in `stores/github/useGitHubViewedFilesStore.ts`,
  keyed `${repo}#${number}` with the `headSha` the marks were viewed at; a
  head change clears the marks. Persisted to localStorage (viewed marks are
  durable reading progress, unlike in-memory pending-review drafts) and
  bounded to the 50 most recently written heads.
  `PullFilesTab` takes an optional `headSha` prop for this.
- Defaults: the first 3 small files start expanded; files with more than
  800 changed lines (`LARGE_FILE_CHANGED_LINES`) start collapsed behind a
  "Large diff — Load diff" button; files with no patch show a "Diff not
  available" row with an "Open on GitHub" blob link when a head SHA is
  known. Loading shows `GitHubListSkeleton`; paging keeps both "Show more
  files" (client window) and "Load more files" (server cursor).
- Performance: grouping/totals are memoized, `FileCard` and jump rows are
  memoized with stable per-file callbacks, and the jump list owns its
  filter text so typing never re-renders the diff cards.

## Git-surface create pull request

The Git view composes this directory's primitives below its unified header
(`git/GitPrSection.tsx`, form in `git/CreatePullRequestForm.tsx`, pure
decisions plus the in-memory collapse drafts in
`git/createPullRequestLogic.ts`). It renders nothing unless a directory,
branch, and selected GitHub repo exist, nothing on the default branch
(`skippedDefaultBranch`), and nothing until pr-status has fetched — the
same gating as before.

- No-PR state is collapsed by default: a compact row (PR icon, "No pull
  request for" + the head branch in a mono pill, an xs "Create pull
  request" button) that expands the form. The expanded form has a close
  (x) control (`aria-label` "Cancel") that collapses it. Typed
  title/body/base/mode survive collapse in the in-memory draft store keyed
  `${directory}\n${branch}` and clear after a successful create.
- The expanded form matches the detail header/composer language: an icon +
  "New pull request" header, an `into base ← head` branches line, a base
  picker (searchable `DropdownMenu` + `Command` over the `useGitStore`
  remote branches with the default first, free-text fallback when no list
  is available), a Title input with inline errors, Write/Preview underline
  tabs (2px selection bar) with an auto-growing description capped ~320px
  and `GitHubMarkdownBody` preview, an info no-upstream push-first notice,
  and a right-aligned split primary button (ready/draft radio menu like the
  merge-method menu, `Pushing…`/`Creating…` busy labels, Ctrl/⌘+Enter to
  submit). Push/create failures render as an inline error alert; success
  keeps the toast.
- The base defaults to the repo default branch. The scope entry's `parent`
  carries only `{ owner, repo }` (no parent default branch), so forks fall
  back to their own default until the server enriches it.
- The existing-PR state is a compact PR-style row (`GitHubStateGlyph` +
  `#N` + truncated title + `GitHubChecksGlyph` + ghost xs Open) that opens
  the PR via `openPullRequestInSurface`; the whole row is clickable with
  the merged/closed/draft/checks-failing/open aria-label.
- There is no title/body generation: the app never had a model-backed
description endpoint, so the form offers no Generate action and drafts are
typed by hand.
