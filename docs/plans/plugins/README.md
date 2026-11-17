# PiChamber plugins

Local spec. Not published as an issue. Tickets live in `tickets/`.

## Status (2026-11-16)

Tickets 01 to 10 are built on `pichamber/plugin-ecosystem-sdk` (uncommitted):
server registry, daemon host, impact, UI client and Settings → Plugins,
composer toggles (per session since ticket 10), turn artifacts, Visuals,
Sub-agents (with the Agents panel), docs and screenshot pages. `bun run
test`, type-check, and lint pass. A real scout-then-reviewer chain ran
through the Pi CLI with the bundled extension. An end-to-end pass (a faux
model provider, API and browser flows) and a code review followed; its
fixes are listed in ticket 10. Ticket 11: composer toggles are optional and
start from the manifest default; Visuals has none, Sub-agents keeps one.
Ticket 12: plain Pi extensions declare composer controls (a toggle, a
cycle such as a mode picker, or an action) that run their own commands.
Ticket 13: a new-session draft gets them too, from a draft session the
daemon starts for it (remembered controls until it reports; adopted on send).
Ticket 14 (2026-11-17): a plugin's tool can ask a question with
`pichamber.ui.choose(ctx, ...)`, tied to its tool call so its chat component answers it;
Visuals gains `render_choices` (variants one at a time at full width, pick
one, add a note).
Open: merging with `pichamber/nono-sandbox` (below), a check of the packaged
Electron app, and a `plugins.changed` push to other devices.

## Goal

Let PiChamber be extended past what Pi extensions can do: composer controls,
views inside the transcript, panels on the rail, settings. Ship native plugins
first (Visuals, then Sub-agents), then open the same contract to third parties.

One rule above all: **nothing reaches the agent unless the user turned it on.**
Bundled plugins ship disabled. A disabled plugin loads no agent code and
registers no tools, prompt text or hooks.

## References studied

| Project | What we take | What we leave |
|---|---|---|
| OpenChamber `packages/sdk` | Manifest in `package.json`, built-in registry with reserved ids, disabled state kept apart from code, capability list approved once | Prompt-injected UI language, a "service" process with full access (Pi extensions already are that) |
| A coding-agent GUI with an HTML tool | `html_render` page drawn from the tool call's own input in a sandboxed frame, theme guidance in the tool description, frame sized to content | MCP bridge (we load Pi extensions directly) |
| deepseek-harness | Typed slots that features fill, every package states its "Model Experience" and cache effect, built-ins use the same slots as add-ons | Rewriting the core as plugins; running third-party code in the page with full trust |

## Decisions

1. **Format.** A plugin is a Pi package with a `pichamber` block in its
   `package.json`. The `pi.extensions` entry is the agent half; the
   `pichamber` block declares the UI half and state.
2. **Bundled plugins** live in `packages/web/plugins/<id>/`, listed in
   `packages/web/plugins/registry.json`. Ids are reserved; user installs (later)
   cannot reuse them. The folder sits inside the web package, which a nono
   sandbox already grants read access to.
3. **Off by default.** Enabled state lives in `<dataDir>/pi/plugins.json`.
   Enabling or disabling takes effect at the next safe edge: the daemon
   recreates idle runtimes at once and busy ones when their turn ends (the
   existing `scheduleRuntimeRecreation` path). A running turn is never cut.
4. **State.** A plugin declares typed values (`boolean` or `enum`) with a scope:
   `global` or `project`. The server owns them. A value a composer toggle
   names is set per session only (tickets 10 and 11): it starts from the
   manifest default in every session and has no Settings value; other values
   have no session scope.
5. **Daemon sync is pushed, never read.** The server sends
   `plugins.configure { plugins: [{ id, entry, state }] }` to the daemon at start,
   after every change, and whenever it reconnects to a daemon process it has
   not configured yet. The daemon never reads PiChamber's data folder for
   plugins, so a sandboxed daemon works without new grants. A daemon that was
   never configured runs with every plugin off.
6. **Agent half contract.** The extension module's default export is a normal
   Pi extension factory, `(pi, pichamber) => void`. PiChamber passes `pichamber`:
   `{ id, ui, state(directory, sessionId), onStateChange(listener) }`, where `ui`
   holds PiChamber's own dialog calls (`choose`, `form`, `openUrl`, each taking
   `ctx` first). The Pi CLI passes
   nothing, so the extension falls back to its declared defaults. A state
   change reaches live runtimes without a reload; the extension reacts (for
   example with `pi.setActiveTools`).
7. **Agent impact is measured, not declared.** The server runs the agent half
   once against a recording stub of the Pi API and reports: tools registered
   (name, exposure, token estimate of name + description + schema), and
   whether it hooks events that can change the prompt or request
   (`before_agent_start`, `context`, `before_provider_request`). Settings shows
   it on the plugin row.
8. **UI half, v1.** Native plugins only: their UI is compiled into the app and
   registered in `packages/ui/src/plugins/`. Slots:
   - `composer.toggles`: declarative, from the manifest. A toggle is bound to
     one boolean state value and changes it for the open session only; every
     new session starts from the manifest default (tickets 10 and 11).
     Optional: only a plugin a user would turn on and off per session (Sub-
     agents, a future plan mode) declares one. Rendered by the host, so it
     looks native. The same slot draws controls a plain Pi extension declares with
     `pichamber:composer` (ticket 12), so a `/plan` or `/balance` extension
     gets a pill without becoming a plugin.
   - `turn.artifacts`: a native component keyed by tool name, drawn between a
     turn's activity rail and its final reply, so it stays visible after the
     rail collapses.
   - `rail.surface`: a native context panel surface.
   - `settings`: declarative fields for each state value.
   Native plugins add; they never replace built-in controls (v1).
9. **Third-party (later).** Install from Pi packages that carry a `pichamber`
   block, UI in sandboxed frames (`allow-scripts` only) mounted from
   `srcdoc`, declarative slots open to everyone. Not in this round.

## Native plugin: Visuals

- Agent half registers `render_html` while the plugin is on, in every
  session: no composer switch, since a page can help in any turn (ticket 11).
  Parameters: `title`, `html` or
  `path` (a file in the project), optional `height`. It returns a short
  confirmation and puts the page in `details` (`{ title, html, height }`), so a
  page read from a file is kept in the session.
- Pages are capped at 512 KB.
- The page draws as a turn artifact: a sandboxed frame (`allow-scripts`)
  holding the page in a second sandboxed frame, a CSP that blocks network
  unless the plugin's "Allow network" setting is on (the outer frame's
  `frame-src 'none'` also stops the page navigating itself away), links
  that open only right after a click in the frame,
  PiChamber theme colours injected as CSS variables, height fitted to
  content up to a cap, then scroll. Actions: Expand (full window dialog),
  Copy HTML, Download.
- Cost: one direct tool with a short description. Shown on the Settings row.

## Native plugin: Sub-agents

- Agent half: Pi's MIT `subagent` example, adapted. Children run as
  `pi --mode json -p --no-session` processes through the daemon's own Pi CLI
  (`process.argv[1]` is already pointed at it), so a sandboxed daemon's
  children run inside the same sandbox.
- A composer switch, on by default in every session, turns the tool off for
  one session.
- Marked `replaceable`: a user's own extension that registers `subagent`
  wins, and the UI still draws its calls, since the details shape is the same.
- The UI draws from the tool's live partial updates and final details
  (`state.metadata`): a turn artifact with one card per child (agent, task,
  status, current tool, usage, final output, expandable transcript) and an
  "Agents" rail surface listing the session's sub-agent runs.
- Agents come from Pi's agent folders (`<agent dir>/agents`, by default
  `~/.pi/agent/agents`, and `.pi/agents`). Each child is its own Pi run on
  the agent's model or the default one, so its tokens add to the session's;
  the plugin description says so.
  The plugin ships defaults (scout, planner, reviewer, worker) used when the
  user has none.

## Runtimes

| Runtime | Behaviour |
|---|---|
| Web, Electron | Everything |
| Hosted mobile, Capacitor | Settings, composer toggles (one sliders button beside Send opening a sheet of switches, with a dot while the session differs from the defaults), turn artifacts. Rail surfaces are desktop-only in v1; a run opens in a sheet instead |

## Sandbox (nono) compatibility

- No new daemon file reads: state and the enabled set arrive over IPC.
- Plugin code lives under `packages/web/`, already a read root of the sandbox.
- Sub-agent children inherit the daemon's sandbox.
- With the daemon pool (`pichamber/nono-sandbox`), each daemon is configured
  the same way: the server pushes to every daemon it talks to.

### Merging with `pichamber/nono-sandbox`

Checked with a trial merge on 2026-11-16 (`git merge-tree`, nothing written):

- Text conflicts in `server/index.js` (imports), `supervisor.js` (both add
  options in the same place) and the session-daemon `DOCUMENTATION.md`. Keep
  both sides in each.
- Sandboxed daemons get their supervisors from `project-sandbox-manager.js`
  (`createSupervisor({ ...options, ... })`). Pass
  `pluginDaemonSync.onDaemonReady` into those options as well, or a sandboxed
  project's daemon never receives `plugins.configure` and runs with every
  plugin off.
- `changed()` probes only the main daemon. Pool daemons pick up a change on
  their next request; that is fine because the push runs before the request.
- Trim the payload's `state.projects` to the daemon's own roots before sending
  it to a sandboxed daemon, so it does not learn other project paths.
  `state.sessions` holds only opaque session ids and booleans; trimming it to
  the daemon's sessions is optional.
- Add a nono e2e case: a sandboxed daemon with Visuals on declares
  `render_html`, and a sub-agent child runs inside the sandbox.

## Out of scope now

Third-party installs, frame-hosted plugin UI, session values for keys no
composer toggle names, replacing built-in controls, moving built-in features
onto slots.
