# 01 Server: plugin registry, store and routes

Owner module: `packages/web/server/lib/plugins/` (new).

- `manifest.js`: parse a package's `pichamber` block, fail closed. Fields:
  `apiVersion: 1`, `id` (kebab, <= 40), `name`, `description`, `icon` (sprite
  name), `defaultEnabled` (must be false for bundled), `state` (map of
  `{ type: 'boolean'|'enum', scope: 'global'|'project', default, label, options? }`),
  `contributes.composerToggles` (`[{ id, state, label, icon }]`),
  `contributes.settings` (ordered state keys), `contributes.ui` (native UI id).
  The agent half comes from `pi.extensions[0]` (must stay inside the package).
- `registry.js`: read `packages/web/plugins/registry.json`, load each listed
  package, skip an invalid one with a logged reason, never block the others.
- `store.js`: `<dataDir>/pi/plugins.json` `{ version: 1, enabled: { [id]: bool },
  state: { [id]: { global: {..}, projects: { [dir]: {..} } } } }`. Atomic
  writes, validation against the manifest, unknown ids kept but ignored,
  malformed file = read error (not empty).
- Routes (authenticated, under `/api/pi/plugins`):
  - `GET /api/pi/plugins?directory=` -> plugins with manifest projection,
    `enabled`, resolved state for that directory, measured impact (ticket 03).
  - `PUT /api/pi/plugins/:id` `{ enabled }`.
  - `PUT /api/pi/plugins/:id/state` `{ key, value, directory? }`. The scope
    comes from the manifest; a `project` key requires `directory`.
  - Each mutation pushes config to the daemon (ticket 02). A
    `plugins.changed` event to other devices is not built yet; they catch up
    on their next list.

Accept: unit tests for manifest, store (missing vs malformed, round trip,
stale write), routes (validation, 404 unknown id).

Status: built in `packages/web/server/lib/plugins/` (see its
`DOCUMENTATION.md`). `service.js` joins registry, store and impact; the
manifest also accepts `replaceable` and a toggle `description`.
