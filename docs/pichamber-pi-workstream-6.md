# PiChamber Pi Migration: Attachments and Local Developer Integrations Implementation Record

## Status and scope

This implementation record documents the completion of attachments and local developer integrations for the PiChamber Pi migration plan:

- Bounded server upload route `/api/pi/attachments` authenticated through the PiChamber client auth model, writing original bytes to OS temporary storage with Pi-style names (`pi-clipboard-<uuid><ext>`), sanitizing client-facing filenames, and passing server-local path metadata to the Pi session.
- Missing attachment path detection with explicit `ATTACHMENT_MISSING` protocol failure.
- Native server filesystem APIs (`/api/fs/home`, `/api/fs/list`, `/api/fs/find`, `/api/fs/mkdir`) and `@/lib/fsApi` helper facade in shared UI for directory listing, filesystem home, and file search.
- Server PTY terminal routes (`/api/terminal/*`) and `TerminalTransport` integration.
- Git status, diff, stage, commit, branch, and identity flows backed by `/api/git/*` and Pi small-model generation for commit messages and PR descriptions.
- Changes walkthrough integration backed by `/api/walkthrough/*` and small-model generation.
- Decoupling of shared UI stores and components (`useDirectoryStore`, `useFileSearchStore`, `DirectoryExplorerDialog`, `SidebarFilesTree`, `FilesView`, `ChatInput`, `FileMentionAutocomplete`) from legacy OpenCode client dependencies.

## Security and contracts

- Attachment payloads are bounded (max 100MB per file, 32 files limit) and written to temporary directory mode `0700` / file mode `0600`. Raw attachment paths never cross public responses and are redacted from transcript projections.
- Filesystem search and listing enforce workspace boundaries and return sanitized relative/canonical paths.
- Utility model calls for commit messages and PR descriptions consume `/api/small-model/generate` directly with server-side credential resolution.

## Validation evidence

- `bun test packages/web/server/lib/pi/session-daemon/session-daemon.test.js packages/web/server/lib/pi/routes.test.js packages/web/server/lib/pi/attachment-store.test.js`
- `bun test packages/web/server/lib/fs/routes.test.js`
- `bun test packages/ui/src/lib/pi/client.test.ts packages/ui/src/stores/useSkillsStore.test.ts packages/ui/src/apps/PiResourceSettings.test.ts`
- `bun run type-check:ui`
- `bun run type-check:web`
- `bun run lint:ui`
- `bun run lint:web`
- `bun run build:web`
- `bun run dead-code`
- `git diff --check`
