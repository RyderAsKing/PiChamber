# FS Module Documentation

## Purpose
Own filesystem API behavior for the web server runtime, including workspace-bound file operations, directory listing, reveal, and background command execution jobs.

## Entrypoints and structure
- `packages/web/server/lib/fs/routes.js`: route registration and runtime-owned state for `/api/fs/*` endpoints.
- `packages/web/server/lib/fs/search.js`: bounded-concurrency fuzzy filesystem search runtime used by `GET /api/fs/find`.

## Public exports
- `registerFsRoutes(app, dependencies)` from `routes.js`
  - Registers all filesystem routes:
    - `GET /api/fs/home`
    - `POST /api/fs/mkdir`
    - `POST /api/fs/clone`
    - `GET /api/fs/read`
    - `GET /api/fs/stat`
    - `GET /api/fs/raw`
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

## File-save revisions (finding #8)
- Revisions are opaque exact strings (`v1:<size>:<mtimeMs>[:<sha256>]`, 5 MiB hash ceiling). `null` means missing at read time; `undefined` means legacy/unknown and never guards a save.
- `GET /api/fs/read` returns `x-pichamber-file-revision` plus `Cache-Control: no-store`; optional missing reads also return `x-pichamber-file-exists: false`.
- `GET /api/fs/stat` returns `{ revision, exists }` and accepts `?knownRevision=` to echo the client revision when size+mtime (and hash-ceiling category) match, skipping read+hash.
- `POST /api/fs/write` accepts `{ expectedRevision, overwrite }`. Omitting `expectedRevision` keeps legacy unconditional writes. `expectedRevision: null` (or `'missing'`) is create-only. `overwrite: true` is the explicit force path. Mismatches return HTTP 409 `{ reason: 'file-revision-conflict', currentRevision, exists, path }`. Identical content is an idempotent `{ noop: true }` success without rewrite. Writes serialize per canonical (realpath) file with re-keying for create/re-point races, preserve mode across atomic temp+rename, and never normalize line endings.
- External writers that bypass the protocol are non-cooperating: last writer wins on disk, and the next cooperating save conflicts instead of silently overwriting.

## Composition contract with `index.js`
- `index.js` provides composition-time dependencies only (platform primitives + callbacks such as `resolveProjectDirectory`, `normalizeDirectoryPath`, and `buildAugmentedPath`).
- `index.js` no longer owns FS route handlers or FS exec job state.

## Notes for contributors
- Keep filesystem policy (workspace root checks, error mapping, exec timeout behavior) inside this module, not in the composition root.
- Filesystem `EPERM`/`EACCES` failures use the stable `reason: "os-permission"` response marker. Policy denials such as workspace-boundary or missing-grant failures must not use that marker because a native folder picker cannot remediate them.
- If adding new `/api/fs/*` endpoints, add them in `routes.js` and extend this document.
- `POST /api/fs/clone` clones a repository into the requested destination and can apply a stored Git identity. It returns the cloned path and rejects an existing destination with HTTP 409.
- `GET /api/fs/list` may resolve symlinks with `realpath` to read directory contents, but the response `path` and each entry `path` must stay in the caller’s requested path space (`path.join(requestedPath, name)`). Returning real paths breaks file-tree expansion for directories reached through workspace symlinks.
