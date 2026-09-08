# FS Module Documentation

## Purpose
Own filesystem API behavior for the web server runtime, including workspace-bound file operations, directory listing, reveal, and background command execution jobs.

## Entrypoints and structure
- `packages/web/server/lib/fs/routes.js`: route registration and runtime-owned state for `/api/fs/*` endpoints.
- `packages/web/server/lib/fs/search.js`: fuzzy filesystem search runtime used by non-FS routes (for example project icon discovery).

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
  - Owns exec job queue state (`execJobs`) and lifecycle/TTL pruning.
  - Enforces workspace boundary checks with active project + worktree fallback support. An explicit `directory` query is authoritative over a stale runtime directory header, which lets user-confirmed directory-browser operations and project-local optional configuration probes scope themselves to the selected directory. `optional=true` converts only a missing file to an empty success; it never bypasses workspace policy.
- `createFsSearchRuntime({ fsPromises, path, spawn, resolveGitBinaryForSpawn })` from `search.js`
  - Returns `{ searchFilesystemFiles(rootPath, options) }`.
  - Supports fuzzy matching, hidden-file handling, and optional `git check-ignore` filtering.

## Composition contract with `index.js`
- `index.js` provides composition-time dependencies only (platform primitives + callbacks such as `resolveProjectDirectory`, `normalizeDirectoryPath`, and `buildAugmentedPath`).
- `index.js` no longer owns FS route handlers or FS exec job state.

## Notes for contributors
- Keep filesystem policy (workspace root checks, error mapping, exec timeout behavior) inside this module, not in the composition root.
- Filesystem `EPERM`/`EACCES` failures use the stable `reason: "os-permission"` response marker. Policy denials such as workspace-boundary or missing-grant failures must not use that marker because a native folder picker cannot remediate them.
- If adding new `/api/fs/*` endpoints, add them in `routes.js` and extend this document.
- `POST /api/fs/clone` clones a repository into the requested destination and can apply a stored Git identity. It returns the cloned path and rejects an existing destination with HTTP 409.
- `GET /api/fs/list` may resolve symlinks with `realpath` to read directory contents, but the response `path` and each entry `path` must stay in the caller’s requested path space (`path.join(requestedPath, name)`). Returning real paths breaks file-tree expansion for directories reached through workspace symlinks.

## File-save revisions (finding #8)

Cooperating PiChamber editors guard every save with the opaque read-content
revision they loaded:

- `GET /api/fs/read` returns `text/plain` with `X-Pichamber-File-Revision`
  (`v1:<size>:<mtimeMs>:<sha256>` or `v1:<size>:<mtimeMs>` above the hash
  ceiling) and `Cache-Control: no-store`. Missing files with
  `optional=true` return empty text with `X-Pichamber-File-Exists: false`
  and no revision (wire `null`).
- `GET /api/fs/stat` returns `{ path, isFile, size, mtimeMs, revision,
  exists }` with the same revision bytes as `read` for guarded saves and
  external-change polling. Clients may pass `knownRevision` with the exact
  revision they already hold: when size+mtime still match (and the hash-ceiling
  category is unchanged), the route echoes the revision without re-reading and
  re-hashing the file. Any mismatch or malformed value falls through to the
  full read+hash path; the parameter is opaque and never reinterpreted.
- `POST /api/fs/write` accepts `{ path, content, expectedRevision?,
  overwrite? }`. `expectedRevision` is the exact base revision, `null`
  (or `'missing'`) requires a missing file (create-only), omitted preserves
  legacy unconditional writes, and `overwrite: true` forces explicit
overwrite. Responses carry `{ success, path, revision, noop? }`.
- Stale or violated expectations return HTTP 409
  `{ error, reason: 'file-revision-conflict', path, exists,
  currentRevision }`. Identical-content saves are idempotent no-ops: they
  succeed with the current revision without rewriting or bumping mtime.
- Writes serialize per canonical (realpath-resolved) path (`withFileWriteLock`,
  `canonicalFileWriteLockKey`) so two same-revision cooperating writers cannot
  interleave check+replace — including writes that arrive through different
  symlink spellings of the same file. Missing targets canonicalize through the
  deepest existing ancestor, and the write re-keys inside the lock if the
  target is created or re-pointed between key resolution and lock acquisition; the
  loser receives 409. Atomic replace uses temp+rename, writes bytes exactly
  (line endings preserved in the editor serializer), writes through symlinks
  via `realpath` without replacing the link, rejects targets resolving
  outside the workspace, and copies the existing mode onto the temp file
  before rename (new files keep the process default).

### External non-cooperating limitation

Check+replace is atomic only among cooperating writers that send
`expectedRevision` through this route. External processes, legacy callers
without `expectedRevision`, and direct filesystem edits bypass the per-file
lock: last writer still wins on disk. The next cooperating save then observes
a revision mismatch and conflicts instead of silently overwriting. Clients must
re-read, preserve dirty text, and offer explicit reload / overwrite / compare
rather than auto-merging.
