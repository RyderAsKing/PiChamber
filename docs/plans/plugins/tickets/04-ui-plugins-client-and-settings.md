# 04 UI: plugin client, store and Settings -> Plugins

- `packages/ui/src/plugins/`: `client.ts` (runtimeFetch calls, failure is not
  empty), `store.ts` (zustand, runtime-scoped, refetch on `plugins.changed`
  and runtime switch), `registry.ts` (native UI halves by id), `DOCUMENTATION.md`.
- Settings page `plugins` in the Pi group: one row per plugin (icon, name,
  description, enable switch, agent impact line, what it adds), then that
  plugin's settings fields when enabled. Shared settings primitives only.
  Search entries for the page.

Accept: client tests, page renders all states (loading, error, disabled,
enabled, impact unknown).
