# PiChamber Pi Migration: Workstream 5 Implementation Record

## Status and scope

Workstream 5 adds the Pi-native resource and trust boundary described in the
[migration plan](./pichamber-pimigration.md). The browser never receives a Pi
resource filesystem path or private daemon detail.

## Delivered

- Pi resource discovery lists skills, prompt templates, and applicable global
  and project instruction files through the daemon's ResourceLoader.
- Skills are browse-only. Pi prompt templates are created, edited, and deleted
  only when their top-level Pi source is editable; package/path sources remain
  read-only.
- Behavior settings edits Pi global and applicable project `AGENTS.md` sources
  via opaque resource IDs. The OpenCode optimizer and response-style settings
  are not part of this Pi surface.
- A trust dialog records an explicit Pi project decision before protected
  project resources load. Trust changes and resource edits are rejected during
  a streaming turn and re-create the idle runtime afterward.
- Native extensions remain disabled with `resourceLoaderOptions.noExtensions`.
  No extension configuration UI is exposed until its security contract exists.
- Magic Prompts remain PiChamber-owned in their existing data-root sidecar.
- The OpenCode skill catalog installer is no longer registered in Settings.

## Security and ownership

Pi owns skills, prompt templates, `AGENTS.md`, project trust, and extension
loading rules. PiChamber owns only its Magic Prompt sidecar. Resource responses
contain allowlisted metadata, text where editing/viewing requires it, and an
opaque resource ID; they never return server paths. Writes are scoped by a
server-resolved opaque ID rather than a browser-supplied path.

## Validation evidence

- `bun test packages/web/server/lib/pi/session-daemon/session-daemon.test.js packages/web/server/lib/pi/routes.test.js packages/ui/src/lib/pi/client.test.ts`
- `bun test packages/ui/src/stores/useSkillsStore.test.ts`
- `bun run type-check:ui`
- `bun run type-check:web`
- `bun run lint:ui`
- `bun run lint:web`
- `bun run build:web`
- `bun run dead-code` (reviewed; it reports the repository's existing broad unused-code inventory, including dormant later-migration OpenCode surfaces)
- `git diff --check`

Focused tests cover opaque resource projection, resource write persistence,
route allowlisting, and typed client requests. Static checks do not replace
manual browser validation; visual smoke coverage remains outstanding.
