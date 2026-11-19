# PiChamber plugins (server)

## Purpose

A plugin is a Pi package with a `pichamber` block in its `package.json`. The
`pi.extensions[0]` module is the agent half; the `pichamber` block declares
state and UI contributions. This module owns the bundled plugin list, the
manifest contract, the stored enabled set and state, measured agent impact,
the public routes, and pushing the config to the session daemon. The daemon
side is `../pi/session-daemon/plugin-host.js`.

Nothing reaches the agent unless the user turned it on: bundled plugins ship
disabled, and a disabled plugin loads no agent code.

## Entrypoints

- `manifest.js` parses a package fail-closed (`PluginManifestError`, code
  `INVALID_PLUGIN_MANIFEST`). Fields: `apiVersion: 1`, `id` (kebab case, at most
  40 characters), `name`, `description`, `icon` (a Remix sprite name),
  `defaultEnabled` (must be false for bundled plugins), `replaceable`
  (maps to the Pi factory's `replaceable`), `state` (`{ type: 'boolean' | 'enum',
  scope: 'global' | 'project', default, label, description?, options? }` per key),
  `contributes.composerToggles` (`{ id, state, label, icon, description? }`,
  bound to a boolean key; optional), `contributes.settings` (ordered keys,
  never a key a composer toggle sets), and
  `contributes.ui` (native UI id). The agent half must be a `.js`/`.mjs`
  module inside the package. The package `version` is the plugin version,
  its `name` is `packageName`, and its `keywords` (lowercased, at most 16,
  without the listing keywords `pi-package` and `pichamber`) are
  `keywords`, which the marketplace matches a search against.
- `registry.js` reads `packages/web/plugins/registry.json`
  (`{ version: 1, plugins: [id] }`) and loads each listed folder. An invalid
  plugin is skipped with a logged reason; the others still load. A missing or
  malformed registry file is `PLUGINS_UNREADABLE`, never an empty list. The
  entry is resolved through links and must stay in its package.
- `store.js` owns `<dataDir>/pi/plugins.json`:
  `{ version: 1, enabled: { [id]: bool }, state: { [id]: { global: {..}, projects: { [dir]: {..} }, sessions: { [sessionId]: {..} } } } }`.
  `sessions` holds composer switches: a session's own values, only for keys
  a composer toggle names (`isSessionStateKey`), keyed by Pi session id
  (`[A-Za-z0-9][A-Za-z0-9._:-]*`, at most 256 characters). The server
  stores any valid value it is sent; the UI sends `null` when a switch goes
  back to its default, so a session normally holds only values that differ
  from it. A composer toggle's key has no global or project value:
  `resolvePluginState` always starts it from the manifest default (ignoring
  any stored by an older build) and `setState` refuses it, so every new
  session starts from the default while the plugin is on. Each plugin
  keeps at most 1000 sessions; setting one moves it last, and the least
  recently set are dropped past the cap with a logged warning. Deleting a session
  (`DELETE /api/pi/sessions/:id`, through `registerPiRuntimeRoutes`'
  `onSessionDeleted`) drops its values and pushes the config.
  Files written before sessions existed read as `sessions: {}`.
  A missing file is empty; a malformed one is `PLUGINS_UNREADABLE` for reads
  and writes (it is never overwritten). Writes re-read under an in-process
  chain and a cross-process lock, then replace the file atomically, so a
  write never drops another writer's change. Unknown ids and keys are kept.
  Values are checked against the manifest when resolved: project value over
  global value over default, and a stored value of the wrong type, option, or
  scope falls back to the default. Project directories are absolute and
  normalized (`~` expands to the home folder).
- `impact.js` imports the agent half and calls it once with a recording
  stand-in for the Pi API and a `pichamber` handle with default state (its `ui` calls resolve with nothing, `openUrl` with `false`). It reports
  `{ tools: [{ name, exposure, tokens }], hooks, commands }`. `tokens` is
  `ceil(chars / 4)` of JSON `{ name, description, parameters }`. `hooks` lists
  the prompt-affecting events the plugin handles (`PROMPT_AFFECTING_EVENTS`:
  `resources_discover`, `input`, `before_agent_start`, `context`,
  `context_with_system`, `before_provider_request`, `tool_result`,
  `message_end`). Results are cached per id and version. A plugin that throws,
  has no default export, or takes over 5 seconds reports `impact: null` with a
  short `impactError`. Measurement runs bundled code in the server process.
- `service.js` combines the above: public views, mutations, and the daemon
  config.
- `routes.js` registers the public routes. `index.js` wires them; the global
  `/api` auth gate applies.
- `daemon-sync.js` pushes the config to the daemon (below).

## HTTP contract

- `GET /api/pi/plugins?directory=<absolute dir, optional>` answers
  `{ plugins: [PluginView] }`. State is resolved for `directory`.
- `PUT /api/pi/plugins/:id` with `{ enabled: boolean }` answers the view.
- `PUT /api/pi/plugins/:id/state` with `{ key, value, directory? }` answers the
  view resolved for `directory`. The scope comes from the manifest; a
  project-scoped key needs `directory`. These are the Settings values every
  session uses. A key a composer toggle sets is refused here
  (`INVALID_PLUGIN_REQUEST`); it changes per session only.
- `GET /api/pi/plugins/sessions/:sessionId` answers
  `{ sessionId, overrides: { [pluginId]: { [key]: value } } }`, plugins with
  values only.
- `PUT /api/pi/plugins/:id/sessions/:sessionId` with `{ key, value }` sets one
  session's own value; `value: null` clears it. Answers
  `{ id, sessionId, overrides }` for that plugin. Only keys a composer toggle
  names are accepted.
- Errors: 404 `{ error: { code: 'PLUGIN_NOT_FOUND' } }`, 400
  `INVALID_PLUGIN_REQUEST`, 500 `PLUGINS_UNREADABLE`.

`PluginView` is `{ id, name, description, icon, version, keywords, bundled,
enabled, state, stateSchema, contributes, impact, impactError? }`. It never
carries module paths.

`service.bundledPackageNames()` lists the npm names of the bundled plugins.
The marketplace (`../marketplace/`) leaves them out of every answer, since
PiChamber already ships them.

## Daemon push

The daemon never reads plugin state or the enabled set from disk: under a
nono sandbox it cannot read PiChamber's data folder. The server sends the
private `plugins.configure` command with
`{ plugins: [{ id, entry, replaceable, state: { global, projects, sessions } }] }`,
enabled plugins only. `global` holds every key resolved without a project;
`projects[dir]` holds the project-scoped values that differ;
`sessions[sessionId]` holds a session's own values. The daemon resolves
`{ ...global, ...projects[dir], ...sessions[sessionId] }`. A composer switch
is a committed change like any other, so the push runs before the next daemon
request, including the prompt sent right after it.

When it pushes (`daemon-sync.js`):

- A daemon process is identified by its `streamEpoch`, a random id picked at
  daemon start and returned by every `runtime.health`. The supervisor probes
  health before each request, subscription, and health call and then runs its
  `onDaemonReady` hook with the probe result and a request function bound to
  that daemon. The sync pushes when it has not configured that epoch at the
  current revision, so a new, restarted, or reused daemon (after a server
  restart) is configured before the request runs.
- After each committed change the routes call `changed()`, which bumps the
  revision and runs a health probe, which pushes.
- At server start, after the daemon starts, `index.js` runs one health probe.
- Pushes are serialized, and each builds the config when it runs, so an older
  config never lands after a newer one. Concurrent requests share one push.
- A failed push (daemon error, unreadable store) logs and is retried on a
  later probe, at most every 2 seconds for the same epoch and revision. It
  never fails the request. A daemon that was never configured runs with every
  plugin off.
- The last 32 epochs are remembered, so a daemon pool is configured per
  daemon as each is reached. A change probes the profile daemon only; others
  pick it up on their next request.
- A sandboxed project's daemon gets its hook from
  `onDaemonReadyFor({ roots })`, the folders it owns. Its config is
  `daemonConfig({ roots })`: `projects` keeps only folders at or below those
  roots, so sandboxed code never learns where other projects live.
  `sessions` holds opaque ids and values and is sent whole.

## Bundled plugins

Listed in `packages/web/plugins/registry.json`, one folder each:

- `visuals/`: two tools. `render_html` reads a page from the call's `html`
  or from a file inside the session's folder, and returns it as the result
  details for the UI to draw. `render_choices` (`choices.js`) takes a
  question and 2 to 6 options, each a page (`html`, or `path` to an `.html`
  file) or an image file in the project (`path` to a `.png`, `.jpg`, `.webp`,
  `.gif` or `.svg`, sent as a `data:` URL). It reports the options as a
  partial result, waits a turn of the event loop so they reach clients first,
  then asks with `pichamber.ui.choose(ctx, ...)` and its own tool call id, and returns the
  chosen option and the user's note. The details are
  `{ title, options, answer }`: `answer` is `{ id, note? }`, `null` when the
  question was closed, and absent when the client could not ask. Under plain
  Pi it asks with `ctx.ui.select` (labels only, the variants are not drawn).
  `files.js` resolves every path through links and keeps it inside the
  project. Limits: 512,000 characters a page, 750 KB an image before
  encoding, 1.5 million characters for one call's options together, since
  they are stored in the session file. State `allowNetwork` only: no composer
  toggle, so both tools are in every session while the plugin is on. It adds
  its tools at `session_start` and uses the `pichamber` handle only for `render_choices`.
- `subagents/`: the `subagent` tool, adapted from Pi's MIT example (credit in
  its `LICENSE`). Runs `pi --mode json -p --no-session` children through the
  daemon's Pi CLI (`process.argv[1]`), so a sandboxed daemon's children stay
  in its sandbox. Bundled agents (`agents/*.md`) use the session's model and
  are overridden by user or project agents of the same name. Details are the
  compact `{ mode, agentScope, results }` shape the UI reads, with updates at
  most every 250 ms. `replaceable`, so a user's own `subagent` extension wins.
  State `on`, set by its composer toggle only (default on).

Sub-agents switches its tool with the `on` value through `pi.setActiveTools`,
so a composer toggle takes effect without recreating the runtime. It reads the
session id from `ctx.sessionManager.getSessionId()` at `session_start` and
pass it to `pichamber.state(cwd, sessionId)`, so a composer switch changes that
session only. It adds or removes only its own tool, and only at
`session_start` or when their resolved `on` value flips, so an unrelated
state push leaves a tool list the user edited as it is.

## Deliberate limits

- Bundled plugins only. User installs and frame-hosted UI are out of scope.
- A question is live: a daemon restart or a runtime recreation cancels it,
  and the tool returns as if the user had closed it. A message typed while a
  question waits is queued like any other.
- A forked session starts with the plugin's defaults, not its parent's
  composer switches.
- No `plugins.changed` event reaches other devices yet; they see changes on
  their next `GET /api/pi/plugins`.
- Bundled code is trusted: the server imports it to measure impact, and the
  daemon only imports modules under `packages/web/plugins/`.

## Replaced plugins

Pi leaves a `replaceable` extension out when another extension registers the same tool, command, or flag. Bundled plugins load as replaceable inline factories, so a plugin can be on in Settings and still not loaded (the user's own `subagent` extension replaces Sub-agents, for example). The server does nothing about this itself. The daemon reports it in the `replaced` field of the extension config answers (see `extension-replacements.js` and `plugin-host.js` in `../pi/session-daemon/DOCUMENTATION.md`), and the public routes `GET /api/pi/extensions/config`, `PUT /api/pi/extensions/config/:id`, `POST /api/pi/extensions/packages`, `POST /api/pi/extensions/packages/:id/update`, and `DELETE /api/pi/extensions/packages/:id` pass it through `projectExtensionConfig` in `../pi/routes.js`. That projection keeps only `kind` (`plugin` or `builtin`), `id`, and the optional `registers` and `by`. It drops an entry with a bad kind or id, leaves out a malformed optional part, and copies nothing else. The field is absent when no live runtime answered, which means unknown, not "nothing replaced".
