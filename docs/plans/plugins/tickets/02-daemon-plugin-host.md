# 02 Daemon: plugin host and `plugins.configure`

- `session-daemon/plugin-host.js` (new): holds the configured plugins, imports
  each enabled agent half, builds `extensionFactories` entries
  (`{ name: 'pichamber:<id>', factory: (pi) => mod.default(pi, chamber), replaceable }`).
- `createPiSessionRuntime` and `createFreshPromptServices` append plugin
  factories after the built-ins.
- IPC command `plugins.configure` (private): validates, imports, then
  `scheduleRuntimeRecreation()` only when the enabled set changed; state-only
  changes notify `chamber.onStateChange` listeners without a reload.
- Server side: push on daemon start, on every change, and before the first
  request to a daemon process not yet configured (tracked by stream epoch or
  equivalent). A failed push logs and retries on the next request; it never
  fails the user's request.
- Unconfigured daemon: no plugin factories.

Accept: daemon unit tests (configure, enable -> recreation scheduled, state
change -> listener called without recreation, import failure isolates one
plugin), supervisor/route test for push-on-connect.

Status: built. The server push uses an `onDaemonReady({ health, request })`
hook in `supervisor.js` (runs after each health probe, before the request)
and `lib/plugins/daemon-sync.js`, keyed by `streamEpoch` per daemon process
and a change revision. Pi lists a plugin as `<inline:pichamber:<id>>` in
`extensions.list`. Real-SDK coverage: `session-daemon-plugins.e2e.test.js`.
