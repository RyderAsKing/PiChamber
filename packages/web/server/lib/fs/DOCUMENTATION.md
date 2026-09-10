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

## Composition contract with `index.js`
- `index.js` provides composition-time dependencies only (platform primitives + callbacks such as `resolveProjectDirectory`, `normalizeDirectoryPath`, and `buildAugmentedPath`).
- `index.js` no longer owns FS route handlers or FS exec job state.

## Notes for contributors
- Keep filesystem policy (workspace root checks, error mapping, exec timeout behavior) inside this module, not in the composition root.
- Filesystem `EPERM`/`EACCES` failures use the stable `reason: "os-permission"` response marker. Policy denials such as workspace-boundary or missing-grant failures must not use that marker because a native folder picker cannot remediate them.
- If adding new `/api/fs/*` endpoints, add them in `routes.js` and extend this document.
- `POST /api/fs/clone` clones a repository into the requested destination and can apply a stored Git identity. It returns the cloned path and rejects an existing destination with HTTP 409.
- `GET /api/fs/list` may resolve symlinks with `realpath` to read directory contents, but the response `path` and each entry `path` must stay in the caller’s requested path space (`path.join(requestedPath, name)`). Returning real paths breaks file-tree expansion for directories reached through workspace symlinks.
