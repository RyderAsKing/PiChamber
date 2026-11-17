# Plugins (UI half)

`packages/ui/src/plugins` owns PiChamber's plugin slots in the shared UI: the
plugin list and its state, the native UI halves of bundled plugins, and the
slot components the app renders. The server half (manifests, the enabled set,
state storage, agent impact) lives in `packages/web/server/lib/plugins/`, and
the daemon half (loading agent code) in
`packages/web/server/lib/pi/session-daemon/plugin-host.js`.

## Model

A plugin is a Pi package with a `pichamber` block in its `package.json`. Its
`pi.extensions` entry is the agent half, loaded by the daemon only while the
plugin is on. Bundled plugins live in `packages/web/plugins/<id>/` and start
off, so a plugin the user never turned on adds nothing to the agent.

Each plugin declares typed state values (`boolean` or `enum`, scope `global`
or `project`). The server owns them and resolves them per directory (project
value, then global value, then the declared default).

## Data

- `piClient.listPlugins(directory?)`, `setPluginEnabled(id, enabled)`, and
  `setPluginState(id, { key, value, directory? })` call `/api/pi/plugins`.
  Types are `PiPlugin*` in `lib/pi/protocol.ts`.
- `store.ts` (`usePluginsStore`) keeps one entry per directory (`''` is the
  global view), keyed implicitly by the active runtime: a runtime switch
  clears it (`apps/runtimeEndpointReset.ts`) and drops reads still in flight.
- A failed read keeps the last list and sets `status: 'error'`; a failed
  first read is `plugins: null` with an error, never an empty list.
- Writes are optimistic. A failed write restores only the value it changed,
  and only while nothing newer replaced it, then reads every loaded folder
  again so the server decides. A read that started before a write
  keeps the written plugin's local copy. A global state write reads the other
  loaded directories again once it lands, so an open composer or page
  updates.
- `usePlugins(directory)` loads on mount and when the window becomes visible
  or focused again (reads fresher than 5 s are reused). There is no push
  event yet; another device's change arrives on the next focus or mount.
- Composer switches are per session. `sessionStore.ts`
  (`usePluginSessionStore`) keeps each session's own values
  (`piClient.getPluginSessionState` / `setPluginSessionState`, see the server
  `DOCUMENTATION.md`) on top of the defaults in `usePluginsStore` (the
  server resolves a composer toggle's key to its manifest default; Settings
  has no value for it, only the plugin's own On switch, which hides the
  toggle while off). `listComposerToggles(plugins, overrides)` gives each
  toggle `on` (this session) and `defaultOn`. Until a session's overrides
  have been read once (`selectComposerOverridesKnown`; a failed read is
  retried on focus), the switches draw the defaults and take no clicks,
  because the defaults are then a guess. A flip stores a value only
  while it differs from the default and clears it otherwise, so every new
  session starts from the default. Writes are optimistic and
  tracked per key: a read that started before a key's write keeps the local
  value for that key only, each write's answer (or rollback) touches only its
  own key and only while it is that key's latest write. A failed read keeps
  the last values; a runtime switch resets the store.
- A new-session draft (`ComposerTarget` `draft`) keeps its switches in the
  store under the draft id; only the open draft's are kept.
  `session-ui-draft-helpers.ts` awaits `applyDraftSwitches(draftId,
  sessionId)` after creating the session and before the first prompt; a
  switch that fails to save is taken back and named in a toast.

## Pi extensions and packages

The same settings page also lists what Pi itself loads, which is not a
PiChamber plugin: the extensions and packages `pi config`, `pi list`, and
`pi remove` work on. The server owns the list and every rule about it
(`packages/web/server/lib/pi/session-daemon/extension-config.js`); this side
only shows it and sends choices.

- `piClient.getExtensionConfig(directory?)`, `setExtensionConfig(id, write)`,
  and `removeExtensionPackage(id, directory?)` call
  `/api/pi/extensions/config` and `/api/pi/extensions/packages`. Types are
  `PiExtensionConfig*` in `lib/pi/protocol.ts`. IDs are opaque and names are
  display names; no server path crosses the API.
- `extensionConfigStore.ts` (`useExtensionConfigStore`) keeps one entry per
  view: `''` is the global view (Pi's settings with no project), a directory
  key is that project's view. A runtime switch clears it
  (`apps/runtimeEndpointReset.ts`).
- A failed read keeps the last list and sets `status: 'error'`; a failed
  first read is `config: null` with an error, never an empty list.
- An extension write shows its value at once and then stores the list the
  server answers with. One write per extension or package at a time. A read
  that started before a write is dropped. A failed write puts the one item
  back and reads the list again, because the server decides what was saved.
  Every write ages the other views, so they are read again when next shown.
- Removing a package is not optimistic: the package stays listed until the
  server says it is gone.
- A write's `deferred` answer means running sessions pick it up when idle;
  the page says so in a toast.
- `useExtensionConfig(directory)` loads on mount and when the window becomes
  visible or focused again, so a change made in a terminal shows up. It also
  reads again when its view is aged while shown (a write to another view, or
  `invalidate()`).
- `components/sections/plugins/ExtensionsSection.tsx` draws it: Global and
  This project chips (only with a folder open), packages with their
  extensions and a Remove action with a confirm dialog, extensions outside
  packages, the project's own, and Pi's built-ins. The global view has a
  switch per extension. The project view has the same switch, showing
  whether the extension loads in this project. It sends only on or off
  (`setProjectEnabled`), and the server stores the project's own choice
  (`load` or `unload`) when that differs from what the project would get
  anyway, and none (`inherit`) when it does not. The page does not decide
  this, because its copy of the global value can be older than a change made
  in a terminal or another tab. A global extension that differs here says "On in this
  project only" or "Off in this project only" under its name. A
  package is removed from the view of the scope that lists it. A project Pi
  does not trust answers with the global list, shown without controls.

### An extension that takes a plugin's place

Pi loads one extension per tool, command, or flag name. A plugin and Pi's
built-ins give way to the user's own extension, so a plugin can be on and not
loaded. The server reports this as `replaced` on the extension list, from a
live session in that folder. The field is absent when no session is running
there: that means unknown, and the page then shows no notice.

- `replacements.ts` holds the pure helpers: `findReplacement`, the row and
  sentence wording, `replacementNotes` for the extension rows, and
  `replacementFix`, which names the one write that lets the plugin load again
  (the winning extension off globally, or off in this project when the
  project declares it). It offers none when the list does not have that
  extension, when this project turns it on over the global setting, or when
  the project is not trusted.
- `PluginsPage.tsx` reads the list for the open folder (the global view with
  no folder). A replaced plugin's row says which extension took its place;
  its own page opens with a warning callout that has the reason and the
  button.
- `ExtensionsSection.tsx` marks a replaced built-in and the extension loaded
  in place of a plugin or built-in, from the list of the view it shows.
- Both files draw their rows with `SettingsList`, `SettingsListRow`, and
  `SettingsCallout` from `components/sections/shared/SettingsSection.tsx`,
  so plugins, extensions, packages, and a plugin's facts share one row. A
  plugin's icon is the bare line icon on its title's line, in the list and
  in its page title. Do not put it in a tile. A plugin's page has a link
  back above its title and its switch in an "Enabled" row in the body, away
  from the dialog's close button.
- A plugin's switch calls `useExtensionConfigStore.getState().invalidate()`
  when it is saved, because what Pi loads can change with it.
- `components/sections/plugins/extensionWriteReport.ts` reports a finished
  extension write (save state, deferred and busy toasts, and the text for
  each error code; the server sends a code and no message).

## Draft sessions

A new-session draft's composer shows the folder's Pi extension controls
before anything is sent.

- `draftRuntime.ts` owns the draft session: a session the daemon starts for
  the open draft (`createSession({ draft: true })`, see the session daemon's
  `DOCUMENTATION.md`), never listed. One per tab, for the open draft only.
  Its events reach it through `subscribeDraftEvents` on the shared session
  store, which keeps them out of the catalog and the reducer. Status is
  `starting`, `ready`, `failed` (retried after 30 seconds, when the window
  comes back, or on a click), or `expired` (idled out, a daemon restart, or
  dropped by the daemon; started again when the window comes back or on a
  click). A draft session the daemon dropped unnoticed (a request answers
  `INVALID_SESSION`, or a click does not run while the session shows another
  value) is started again at once, once per 30 seconds; after that it counts
  as failed. The old id is discarded as well, in case it is still there. A
  model turn that starts in the draft session (a control's command sent a
  message) ends the draft session differently: the daemon makes it an
  ordinary session, listed and running, and its last marked event is a busy
  `session.lifecycle` without `command`. The draft lets go of it without
  discarding it, drops the clicks it had sent there, and starts no other
  draft session (`turnStarted`): whatever started the turn would start one
  in each. Its remaining clicks run on the session the send creates. A
  server whose ready health check lacks the
  `sessions.discardDraft` capability is never asked again until the server
  or daemon changes, and its drafts work as before; a failed health check is
  only a failure.
- `useDraftRuntime.ts`: `useDraftRuntime()` (mounted by `ChatInput`) starts
  it while a draft is open and no session is; a module-level watcher on the
  session UI store discards it when the draft closes, changes, or moves to
  another folder. Drafts for a worktree or branch still to create, or that
  fork a session, start none. `useDraftComposerControls(draftId)` gives what
  the composer draws: the draft session's controls once reported (kept while
  it restarts), else the remembered ones.
- `rememberedControls.ts` keeps each folder's last controls in localStorage
  per server and folder (40 folders, shape-checked on read). A draft
  session's set is authoritative, empty included; an open session's is kept
  only when it has controls.
- Clicks before the draft session is ready are kept per draft and shown,
  then sent when it is ready, one at a time (the daemon refuses a second
  command while one runs); actions wait for it. A click equal to the value
  the live draft session reported is a no-op; one equal to a remembered
  value is kept. A sent click is shown until the extension reports it or 8
  seconds pass (each timer clears only its own click). Separately, the last
  value chosen for each control is kept for the whole draft. It follows what
  the composer shows: a change the live draft session makes on its own
  replaces it, a control the session removes is dropped, and a click that
  failed or was never confirmed falls back to the session's value. A draft
  session started again after it expired or failed is sent the chosen values
  it lacks, and so is a control the session declares only after it started.
  `materializeOpenDraftSession` waits up to 1.5 seconds for clicks still
  running (`settleDraftPicks`), hands the ready draft session to the send
  (`consumeDraftRuntime`, passed as `draftSessionId`; the daemon adopts it or
  creates as usual), then awaits `applyDraftControlPicks`, one click at a
  time, before the first prompt. When the created id is the draft session's,
  only clicks that never reached it run; otherwise (none, or the daemon had
  dropped it) every chosen value runs where the new session shows another.
  A click that does not run while the session still shows another value is
  reported as not applied.
- Model and thinking stay in step both ways: a change in the draft's
  composer reaches the draft session after 300 ms, and a change the draft
  session reports on its own (an extension's command) moves the composer,
  when the model is one the composer knows. Echoes of this tab's own changes
  are not adopted: one pending echo per kind, replaced by the next push,
  ignored after 5 seconds, and for thinking spent by the next report (a
  clamped level is adopted). When an extension sets a model the composer does
  not list, the composer's model and thinking are no longer pushed, and the
  adopting create and the first prompt send the draft session's own model
  and thinking (`MaterializedDraftSession.model`); a model picked in the
  composer, or a listed model reported again, ends that. Later prompts send
  the composer's model, as in any session whose extension set a model the
  composer does not list.

## Slots

Native plugins add to slots; none replaces a built-in control.

| Slot | Where | Defined by |
|---|---|---|
| `composer.toggles` | `components/chat/composer/ui/ComposerPluginToggles.tsx`. Desktop (stacked footer, not the mini-chat pill): a borderless pill per toggle after the model controls (a tinted fill when on, plain text when off, spaced like the model controls), icons only when the footer is narrow. Phones: one sliders button beside Send (the same whatever is on, plus a dot while the session differs from the defaults), opening a sheet with a switch per toggle that says it changes this session only; the model controls then shrink to fit (`useHasComposerToggles` turns off `keepLabels`) | Manifest `contributes.composerToggles`, each bound to one boolean state value (`composerToggles.ts` lists them). Changes the open session (or draft) only; the tooltip and sheet name the default when it differs. Optional: a plugin whose tool belongs in every session (Visuals) declares none. Drawn by the host; shown only while the plugin is on. The same slot then draws the open session's Pi extension controls (`extensionControls.ts`; declared with `pichamber:composer`, see the session daemon's `extension-controls.js`): a toggle pill like a plugin toggle, a cycle pill showing its option and moving to the next on click, an action pill; on phones, sheet rows (a switch, chips for every option, a Run button). A click shows its value until the extension reports it (or 8 seconds pass) and runs the extension's command through `piClient.runExtensionControl`. A new-session draft gets its own (see Draft sessions below). Desktop pills draw an icon only for names `icons.ts` knows, never a fallback; sheet rows are text only, plugin rows included, so they line up |
| `turn.artifacts` | `components/chat/components/TurnPluginArtifacts.tsx`, between a turn's activity rail and its reply, so it stays visible when the rail collapses | `NativePluginUi.turnArtifacts` in `registry.ts`, keyed by tool name, loaded lazily |
| `rail.surface` | A context panel surface (`lib/surfaces/registry.ts`, `ContextPanel.tsx`) | One per native plugin that needs it; desktop only |
| `settings` | Settings → Extensions & Plugins, the Plugins section (`components/sections/plugins/PluginsPage.tsx`): a list with a switch per plugin (All/On/Off filters), and a page per plugin with what it adds to the agent, what it adds to PiChamber, its options, and About | Manifest `stateSchema` and `contributes.settings` (field order); `NativePluginUi.features` for the "In PiChamber" lines |

Turn artifacts draw any finished call whose details have the plugin's shape,
also after the plugin was turned off: the result is part of the session.

### Questions

A plugin's tool asks the user with `pichamber.ui.choose(ctx, title, choices, opts)`
(see the session daemon's documentation). When the call passes its own
`toolCallId`, the question belongs to that tool call:

- `TurnPluginArtifacts` reads the session's pending `choose` dialogs on the
  `dialogs` topic (`questions.ts`: `selectToolQuestions`), maps them by tool
  call id, and hands the artifact a `question` prop (`PluginQuestion`: the
  title, the choices, `allowNote`, `answer(choiceId, note?)`, `dismiss()`).
  Both calls go through `respondToExtensionDialog`, the same request the dock
  sends, so a question another device answered counts as done.
- The component must offer every choice in `question.choices` for as long as
  it has the prop, whatever else it could read. While it is mounted with a
  question, `markQuestionDrawn` records the request id and the dock above the
  composer (`ExtensionPromptDock`) folds to one line, "Choose above" and the
  question, so the two do not repeat each other. Its header still opens the
  full list, and it unfolds by itself if the component goes away.
- The dock always knows `choose`: a question with no `toolCallId`, or one
  whose tool has no artifact here, is answered there (a list with a
  description per choice, keys 1 to 9, and a note field when allowed).
- The question is live state, never part of the session file. What was
  answered belongs in the tool's result details, which is what the artifact
  draws after the call ends.

Manifest icons are data the sprite generator cannot see; `icons.ts` lists the
names a manifest may use and falls back to `puzzle` for any other.

## Bundled plugins

### Visuals (`visuals/`)

- `render_html` calls draw as a page in a frame sandboxed with
  `allow-scripts` only (opaque origin, no access to PiChamber or its storage).
- `document.ts` builds two documents. The page: a Content-Security-Policy
  first (no network unless the plugin's `allowNetwork` value is on), the
  app's theme as `--pc-*` CSS variables with zero-specificity defaults, and a
  small bridge that reports the content height and hands link clicks to the
  host. The outer `srcdoc` holds the page in an inner frame, also
  `allow-scripts` only, under its own CSP whose `frame-src 'none'` (while
  network is off) stops the page navigating itself to a remote URL, which a
  page's CSP cannot prevent; it relays only the inner frame's bridge
  messages. The host reads messages from its frame's own window only, and
  opens a link through `openChatLink` only while that frame has focus and
  the click still counts as a user action, at most once a second
  (`canOpenLink`).
- The variables are `--pc-bg`, `--pc-surface`, `--pc-fg`, `--pc-muted`,
  `--pc-border`, `--pc-accent`, `--pc-font`, `--pc-mono`, `--pc-c1` to
  `--pc-c5` (the theme's chart palette), and `--pc-good`/`--pc-warn`/`--pc-bad`
  (status colours). The defaults style body text, headings, tables, buttons,
  inputs, and code, so the agent writes only layout; the tool description
  names them.
- `VisualFrame.tsx` fits the frame to its page up to 560 px (or the call's
  `height`), mounts it when it nears the viewport, and offers a Page/Code
  switch, Copy HTML, Download (in a menu when the header is narrower than
  28rem), and Expand (a full-window dialog with the same
  switch). While the call streams, `VisualDrawing` shows the title and the
  page's size instead of an empty frame.

- `render_choices` calls draw one variant at a time at the chat's full width
  (`ChoicesArtifact.tsx`, parsing in `choices.ts`): a row of buttons, one per
  option with its letter and label, switches the variant in the frame, with
  Left and Right stepping through them; the shown one has its description
  and Expand. An option is a page (the same sandboxed frame, fitted to its
  own page between 120 and 560 px) or an image (a `data:` URL of a type the
  agent half encodes; anything else is refused). Every variant is laid out
  in the same grid cell and only the shown one is visible, so the frame is
  as tall as the tallest and does not move on a switch. Side by side was
  tried first and dropped: at a third of the chat's width a layout no longer
  reads as itself.
- While the call waits on its question, the shown variant has a Choose
  button, a note field goes with the choice, and Skip closes the question.
  Afterwards the header says what was chosen, its button is marked, the
  frame opens on it (`shownChoice`), and the note shows under the frame; a
  closed question says "No choice made". The details carry
  `answer` (`{ id, note? }`, or `null` when closed).
- A waiting call draws from its details. Without them (the question arrived
  first), it draws from the call's input, where an option given as a file
  shows its path and "Preview not loaded"; failing that, from the question's
  own choices. The choice works in every case.

### Sub-agents (`subagents/`)

- `details.ts` reads `subagent` details from the bundled plugin (compact
  `status`/`activity`/`output` per run) and from Pi's own `subagent` example
  (full `messages` per run), so a user's own `subagent` extension still draws.
- `SubagentRuns.tsx` draws a run as a card (`SubagentRunCard`): the model's
  provider logo (`SubagentAvatar`, robot mark when unknown), step, agent,
  task, status, and the current tool or usage. `SubagentRunRow` is a
  finished run on one line (status mark, agent, task, time). `model.ts`
  turns the run's `provider/model` into the configured display name.
- `SubagentsArtifact.tsx` shows the call's cards in a grid, live from the
  tool's partial updates. A card opens that run on its own: on desktop it
  sets `selection.ts` (`{ callId, index }`) and opens the Agents panel; on
  phones it opens a sheet.
- `RunDetail.tsx` (`SubagentRunDetail`) is one run on its own: model, usage,
  task, steps, error, and answer.
- `AgentsSurface.tsx` is the Agents rail surface (availability `agents`).
  Its list has two parts: Working, the runs that are `running` or `queued`
  now, as live cards; and Finished, every other run as a row, newest call
  first. A run moves from the first to the second when it ends. Either opens
  the run on its own, with All agents, previous, and next (within its call).
  It selects only `subagent` tool parts from the session reducer by identity,
  so other streaming activity does not re-render it. The artifact's "Open in
  panel" action opens the list.
- `sessionCalls.ts` (`sessionHasSubagentCall`) tells the rail and the
  surface-switch shortcut whether the session has a `subagent` call, which
  puts Agents on the rail without opening it. It scans the session's parts
  once per `toolsByCallId` map, which the reducer replaces only when a tool
  call is added or the session is hydrated or paged, so text and tool
  updates cost a lookup.

## Runtimes

Web and Electron get every slot. Hosted mobile and the Capacitor app get
Settings, composer toggles (one button and a sheet), and turn artifacts; rail surfaces are desktop only. All runtimes reach the connected
server through `piClient`.

## Adding a native plugin UI

1. Add the plugin under `packages/web/plugins/<id>/` with its manifest.
2. Add a `NativePluginUi` entry in `registry.ts` with lazily loaded components.
3. Add any manifest icon name to `icons.ts`, then run `bun run icons:generate`.
4. Keep detail parsing in a pure module with tests; components only render.
5. If the tool asks a question with `pichamber.ui.choose` and its `toolCallId`,
   draw the `question` prop: every choice, and the note when `allowNote`.
