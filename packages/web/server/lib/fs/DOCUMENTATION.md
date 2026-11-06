# FS Module Documentation

## Purpose
Own filesystem API behavior for the web server runtime, including workspace-bound file operations, directory listing, reveal, and background command execution jobs.

## Entrypoints and structure
- `packages/web/server/lib/fs/routes.js`: route registration and runtime-owned state for `/api/fs/*` endpoints.
- `packages/web/server/lib/fs/search.js`: bounded-concurrency fuzzy filesystem search runtime used by `GET /api/fs/find`.
- `packages/web/server/lib/fs/atomic-write.js`: shared symlink-preserving atomic write for server-owned config and state files.
- `packages/web/server/lib/fs/project-icon.js`: finds the icon a project already ships, for `GET /api/fs/project-icon`.

## Atomic config/state writes
- `writeFileAtomic(file, data, { fs, encoding, mode = 0o600, dirMode = 0o700 })` and `writeFileAtomicSync(...)` write a temp file and rename it over the file's real target, then chmod that target (best effort, skipped on Windows; a chmod failure does not fail the write because the content is already in place). They return the written target path.
- Symlinks are preserved so user-managed links (for example GNU Stow dotfiles for `settings.json`, `pi/snippets.json`, `stt/config.json`) keep receiving changes. Existing paths resolve through `realpath`. A missing path is written in place. A dangling link writes to its target path, resolved relative to the link's directory, and creates the target's parent directory.
- The temp file lives in the real target's directory so the rename stays on one filesystem. It is removed when the write or rename fails, and the previous content is left untouched.
- Cross-process locking stays with callers, keyed on the caller-facing path (`${file}.lock`), so locking semantics do not change when a file becomes a symlink.
- Injected `fs` objects must provide `realpath`, `readlink`, `mkdir`, `writeFile`, `rename`, `rm`, and `chmod` (or the `*Sync` equivalents).

## Public exports
- `registerFsRoutes(app, dependencies)` from `routes.js`
  - Registers all filesystem routes:
    - `GET /api/fs/home`
    - `POST /api/fs/mkdir`
    - `POST /api/fs/clone`
    - `GET /api/fs/read`
    - `GET /api/fs/stat`
    - `GET /api/fs/raw`
    - `GET /api/fs/project-icon`
    - `GET /api/fs/serve/:path(*)`
    - `POST /api/fs/write`
    - `POST /api/fs/delete`
    - `POST /api/fs/rename`
    - `POST /api/fs/reveal`
    - `POST /api/fs/exec`
    - `GET /api/fs/exec/:jobId`
    - `GET /api/fs/list`
    - `GET /api/fs/find`
  - Owns exec job queue state (`execJobs`) and lifecycle/TTL pruning.
  - Enforces workspace boundary checks with active project + worktree fallback support. An explicit `directory` query is authoritative over a stale runtime directory header, which lets user-confirmed directory-browser operations and project-local optional configuration probes scope themselves to the selected directory. `optional=true` converts only a missing file to an empty success; it never bypasses workspace policy.
- `createFsSearchRuntime({ fsPromises, path, spawn, resolveGitBinaryForSpawn, gitCheckIgnoreTimeoutMs })` from `search.js`
  - Returns `{ searchFilesystemFiles(rootPath, options) }`.
  - Supports fuzzy file and directory matching, hidden-file handling, fixed build-output exclusions, and optional `git check-ignore` filtering.
  - Git-ignore checks use bounded directory concurrency and a positive configurable timeout (`PICHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS`, default 2500 ms). Concurrent searches share identical in-flight checks. A failed or timed-out check fails the search instead of returning files that may be ignored.
  - Search reads through canonical paths for boundary enforcement, but result paths stay in the caller's requested path space so symlinked workspaces remain navigable.

## Project icons
- `GET /api/fs/project-icon?directory=<dir>` returns the image a project already uses as its icon, or HTTP 204 when it has none. `directory` is required; the route never falls back to the server cwd or the `x-pichamber-directory` header alone. A missing directory is HTTP 404, distinct from "no icon".
- Lookup order: well-known files at the project root (`favicon.*`, `public/`, `static/`, Next.js `app/` and `src/app/` icons, `assets/icon|logo`), then the icon declared in an HTML `<link rel="icon">` or a framework head config (`{ rel: 'icon', href }`) in `index.html` or a root route file, then the same search inside monorepo packages under `apps/*` and `packages/*` (`web`, `app`, `www`, `site`, `frontend`, `client`, `ui` first, at most 32 per parent).
- Only `.svg`, `.ico`, `.png`, `.jpg`/`.jpeg`, `.webp`, and `.gif` files up to 1 MiB are served. Every candidate, including declared hrefs, must resolve (after `realpath`) inside the project directory; remote, `data:`, and escaping hrefs are ignored.
- Responses carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and a sandboxing CSP so an SVG opened directly cannot run script.
- Results are cached in memory per canonical directory: found icons for 10 minutes (re-checked for existence on each hit), misses for 1 minute.
- The UI (`packages/ui/src/lib/projectIcon.ts`) fetches through `runtimeFetch`, keeps object URLs keyed by runtime and directory, and on a failed request keeps any icon already shown instead of treating the failure as "no icon".

## File-save revisions (finding #8)
- Revisions are opaque exact strings (`v1:<size>:<mtimeMs>[:<sha256>]`, 5 MiB hash ceiling). `null` means missing at read time; `undefined` means legacy/unknown and never guards a save.
- `GET /api/fs/read` returns `x-pichamber-file-revision` plus `Cache-Control: no-store`; optional missing reads also return `x-pichamber-file-exists: false`. The server CORS policy exposes both headers so HMR, packaged desktop, and Capacitor clients retain revision authority across origins.
- `GET /api/fs/stat` returns `{ revision, exists }` and accepts `?knownRevision=` to echo the client revision when size+mtime (and hash-ceiling category) match, skipping read+hash.
- `POST /api/fs/write` accepts `{ expectedRevision, overwrite }`. Omitting `expectedRevision` keeps legacy unconditional writes. `expectedRevision: null` (or `'missing'`) is create-only. `overwrite: true` is the explicit force path. Mismatches return HTTP 409 `{ reason: 'file-revision-conflict', currentRevision, exists, path }`. Identical content is an idempotent `{ noop: true }` success without rewrite. Writes serialize per canonical (realpath) file with re-keying for create/re-point races, preserve mode across atomic temp+rename, and never normalize line endings.
- External writers that bypass the protocol are non-cooperating: last writer wins on disk, and the next cooperating save conflicts instead of silently overwriting.
- The exact `~` global-session sentinel resolves to the server user's home directory before workspace validation. Other relative paths keep normal server-cwd resolution.

## Composition contract with `index.js`
- `index.js` provides composition-time dependencies only (platform primitives + callbacks such as `resolveProjectDirectory`, `normalizeDirectoryPath`, and `buildAugmentedPath`).
- `index.js` no longer owns FS route handlers or FS exec job state.

## Notes for contributors
- Keep filesystem policy (workspace root checks, error mapping, exec timeout behavior) inside this module, not in the composition root.
- Filesystem `EPERM`/`EACCES` failures use the stable `reason: "os-permission"` response marker. Policy denials such as workspace-boundary or missing-grant failures must not use that marker because a native folder picker cannot remediate them.
- If adding new `/api/fs/*` endpoints, add them in `routes.js` and extend this document.
- `POST /api/fs/clone` clones a repository into the requested destination using the user's normal git credentials only. It never writes git config. It returns the cloned path and rejects an existing destination with HTTP 409.
- `GET /api/fs/list` may resolve symlinks with `realpath` to read directory contents, but the response `path` and each entry `path` must stay in the caller’s requested path space (`path.join(requestedPath, name)`). Returning real paths breaks file-tree expansion for directories reached through workspace symlinks.
