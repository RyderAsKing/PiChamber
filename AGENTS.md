# PiChamber Agent Guide

## Purpose

PiChamber provides web, desktop, hosted-mobile, and native-mobile UI surfaces for Pi Coding Agent.

> PiChamber is a community fork of [OpenChamber](https://github.com/openchamber/openchamber), now running through its Pi-native session daemon.

This file contains only always-on repository rules and routing. Detailed workflows belong to project skills and module documentation.

## Instruction Order

These steps are mandatory. Before editing, you **MUST**:

1. Follow this root guide.
2. Load every matching project skill and every task-required reference from
   those skills.
3. Read the nearest `DOCUMENTATION.md` and package `README.md` when present.
4. Follow local code and test precedent.

If these sources materially conflict, stop and resolve the conflict instead of silently choosing one.
Do not start editing when a matching skill or required reference has not been
read. Skill loading is a required part of the task, not optional guidance.

## Runtime Boundaries

- `packages/ui`: shared React UI, state, sync, and runtime contracts.
- `packages/web`: web surfaces, PiChamber server, Pi session-daemon lifecycle, and CLI.
- `packages/electron`: native desktop shell and privileged Electron boundary.
- `packages/mobile`: Capacitor iOS/Android shell; bundles the mobile web surface and connects to an existing PiChamber server.
- `packages/docs`: product documentation; not a Bun workspace.

Shared UI calls Pi through `/api/pi/*` using `runtimeFetch` and shared browser/realtime transport helpers. Runtime-specific PiChamber capabilities use `RuntimeAPIs`.

Electron starts the PiChamber backend in-process, never as a sidecar. Development may load loopback/HMR UI; packaged builds load staged assets through `pichamber-ui://` while the loopback server remains the API backend. Keep domain backends in web/runtime modules unless behavior is inherently native.

Shared contracts must define intentional behavior for every applicable runtime: web, desktop, hosted mobile, and Capacitor mobile.

## Always-On Constraints

- Do not modify `../opencode`; it is a separate repository.
- Do not run git or GitHub commands unless the user explicitly asks.
- Do not add dependencies unless explicitly requested.
- Never add or log secrets, bearer tokens, pairing credentials, or sensitive user data.
- Keep changes minimal and preserve unrelated worktree changes.
- Enforce security and correctness in core/runtime logic, not only UI visibility or prompts.
- Keep entrypoints and bridges thin; place domain logic in focused owning modules.
- Update owning documentation when module ownership, contracts, or invariants change.

## Correctness Invariants

- Prefer authoritative state over heuristics.
- Derive live activity from live channels, not persisted history.
- Scope temporary fallbacks narrowly and clear them when authoritative state arrives.
- Never let fetch failure masquerade as authoritative empty success.
- Make partial results, rollback, cleanup, and stale-data behavior explicit.
- One failed entity must not erase or block unrelated complete entities.
- Runtime-specific differences must be intentional and visible in code.

## Documentation Discovery

Before changing a module, search for the nearest `DOCUMENTATION.md`; before package-level work, read its `README.md`. Discover docs dynamically under `packages/**/DOCUMENTATION.md` rather than relying on a static exhaustive map.

High-value anchors:

- Sync: `packages/ui/src/sync/DOCUMENTATION.md`
- Stores: `packages/ui/src/stores/DOCUMENTATION.md`
- CLI: `packages/web/bin/lib/DOCUMENTATION.md`
- Performance measurement tooling: `scripts/perf/DOCUMENTATION.md`
- Electron: `packages/electron/README.md`
- Mobile: `packages/mobile/README.md`

## Project Skills

Project skills live under `.agents/skills/*/SKILL.md`. You **MUST** load every
skill matching the character of the change before editing; multiple skills may
apply, including companion skills required by another skill. Read every
task-required reference named by those skills. Skills are canonical for their
detailed workflows and checklists. Treating this table as optional advice is a
process violation.

| Trigger | Required skill |
|---|---|
| Any source, dependency, export, build-config, generated-asset, package-contract, or module-ownership change | `pichamber-change-discipline` |
| CLI commands, prompts, terminal output, non-TTY, `--quiet`, or `--json` behavior | `clack-cli-patterns` |
| Shared UI data access, Pi API, `RuntimeAPIs`, runtime fetch/auth/URLs, bridges/proxies, runtime switching, or server API routes | `ui-api-decoupling` |
| Electron main/preload, IPC, native UI, updater, deep links, SSH/tunnels, packaging, or child processes | `desktop-shell` |
| Session sync, bootstrap/reconnect, reducers, polling, optimistic state, queues, live status, reconciliation, or directory-scoped caches | `sync-state-invariants` |
| Render/store/event hot paths, large lists, caching/indexing, high CPU/memory, lag, jank, freezes, or performance regressions | `performance-engineering` |
| WebSocket, SSE, streaming transport, runtime transport internals, or private relay | `relay-transport` |
| UI components, styling, colors, buttons, or icons | `theme-system` |
| User-facing or accessible UI text, labels, aria, toasts, dialogs, or navigation copy | `locale-ui-patterns` |
| Settings UI, settings dialogs, configuration surfaces, or settings search | `settings-ui-patterns` |
| Sortable or drag-to-reorder behavior, especially `@dnd-kit` and touch/wrapping layouts | `drag-to-reorder` |
| iOS Simulator build, launch, preview, gestures, or `serve-sim` control | `serve-sim` |

Pure code-reading or explanation does not require implementation skills unless needed to interpret a specialized subsystem.

## Validation

- Use `package.json` scripts as the command source of truth.
- Prefer focused tests and package-scoped type-check/lint for executable source changes.
- `bun run test` runs every unit suite (web, ui, electron) and must pass before handoff. UI tests run under `bun test --isolate` (per-file isolation) because bun's `mock.module()` is process-global; keep new UI test files self-contained and avoid partial mocks of shared modules.
- Use workspace-wide checks for cross-workspace contracts, root tooling, dependencies, or shared generated assets.
- Run `bun run dead-code` when source files are added/deleted/renamed or exports, types, entrypoints, or import shape change; inspect its report because it is non-blocking.
- Do not assume TypeScript/lint covers server JS, CLI JS, Electron helpers, or native behavior; run focused tests, syntax checks, builds, or runtime validation for the touched surface.
- For docs-only or isolated config changes, run the narrowest relevant validation.
- Report exactly what was and was not validated. Static checks alone do not prove runtime, relay, performance, or platform correctness.

## Screenshots

`bun run screenshots [label] [page...]` captures named UI states with headless
Chrome/Chromium (system install or the Playwright browser cache; override with
`CHROME`). It writes `.screenshots/<label>/<page>-<viewport>-<theme>.png`.
Set `BASE_URL` (default `http://127.0.0.1:5180`, the `bun run dev` UI),
`THEME=light|dark`, and `OUT_DIR` as needed.

Demo data: `bun run screenshots --seed <dir>` recreates a synthetic git repo in
`<dir>/repo` (on a long branch, with a favicon and an unchanged `src/` folder), more folders in
`<dir>/folders` (one with a favicon and its own scripted model extension, a monorepo, one without an icon, one with
a dark logo on a transparent background and its own `subagent` extension),
a data
directory in `<dir>/data` that opens them all, and `<dir>/home`, a throwaway
`HOME` whose Pi agent directory holds one demo session (plus a few short
sessions across the folders, with backdated times and shelf state, for the
sidebar views, and three global snippets in the data directory) and whose `code/`
folder gives the Add folder dialog something to list. Start the
dev server with `HOME=<dir>/home PICHAMBER_DATA_DIR=<dir>/data` so it never
touches real `~/.pi` or `~/.config/pichamber` state.

Pages: `diff-all` (Git panel, All scope, desktop only, with staged-only,
staged-then-edited, and staged new files); `shell-transcript` (the demo
session's recorded `!cmd` shell rows: exit 0, a failing exit code, a `!!`
command kept from the model, and truncated output); `shell-composer` (the same
session with `!!git diff --stat` typed into the composer); `sidebar-projects`
(desktop only: the folder list with project icons and the fallback mark, and
session cards with a middle-truncated branch); `sidebar-projects-mobile` (the
same list in the mobile sessions drawer); `sidebar-threads` (desktop only: the
Threads view with its Snoozed and Archived shelves open, one session snoozed
and the two seeded archived sessions under Archived); `sidebar-threads-hover`
(the same view with the pointer on an active session, showing its Archive
action, desktop only); `sidebar-threads-archive` (the same view with its
shelf collapsed, just after the open session's Archive button: the session
leaves the list and a toast names it with Undo; it archives that session in
the data directory, so capture it last, desktop only);
`sidebar-timeline-unarchive` (Timeline just after Unarchive from the row menu
of the 5-day-old archived session, which stays under This week; it
unarchives that session in the data directory, so capture it last, desktop
only); `sidebar-timeline-unarchive-mobile` (the same in the mobile sessions
drawer, mobile only);
`sidebar-search-archived` (a search for `checkout` that matches an archived
session, shown in place with a muted title, desktop only); `sidebar-folder`
(the same sessions in the By folder view); `sidebar-folder-actions` (By folder
with the pointer on a folder header, showing its New session and folder menu
buttons, desktop only); `open-request` (an Open request for a
server-local page arriving in the demo session; set `OPEN_URL_SOCKET` to the
server's intake socket); `browser-page` (the Browser panel with a server-local
demo site the script serves on port 4777 typed into its address bar, desktop
only); `browser-downloads` (the Server browser's Downloads list under the
page: the demo site's report finished, with its Save actions, and a dataset
stuck partway with progress and Cancel, desktop only); `files-panel` (the Files panel beside the demo session with no file
open: in that narrow panel the tree fills it, with its change marks,
desktop only);
`files-panel-file` (the same panel with `billing.ts` open under its path bar,
desktop only); `files-panel-menu` (the same file with its File actions menu
open, desktop only); `files-panel-crumb` (`src/lib/dates.ts` open, then the
`src` step of its path bar: the tree opens over the file to that folder,
desktop only); `files-panel-search` (`.ts` typed into the tree's search:
name, folder, and change mark per hit, desktop only); `files-panel-nested`
(`src/lib/dates.ts` opened from search, then the search cleared, so the tree
has opened to it, desktop only); `files-panel-changes` (`billing.ts` open,
then its path bar's Changes button: the Git panel on the file's scope with it
expanded, desktop only); `add-folder` (the sidebar's Add folder dialog on its
first step, desktop only); `add-folder-browse`, `add-folder-clone`, and
`add-folder-new` (its three steps, each pointed at the seed's `~/code`,
desktop only); `settings-appearance` (a dense settings page, desktop only);
`settings-projects` (project cards with their icons, desktop only);
`settings-snippets` (the seeded snippet cards and the header's search,
copy file path, and refresh actions, desktop only);
`settings-archive` (Sessions settings at Archive and delete, desktop only);
`settings-sidebar-view` (Appearance at Sidebar view with Legacy views open,
desktop only); `command-palette` (opened with Ctrl+P, desktop only);
`extension-dialog` (the seed's demo extension answers `!git log` in the demo
session with a select() dialog whose title packs a whole permission request;
the dialog stays open, so later captures reuse it instead of sending again);
`settings-extension-interface` (Sessions settings at Extension interface,
with its info text showing, desktop only); `extension-surface` (the demo
extension answers `!git push` with a ctx.ui.custom() permission prompt in the
composer's place on a terminal screen in Pi's theme colours, focus on it; on
mobile with its key bar); `extension-surface-unfocused`
(the same prompt with focus on another control, so its footer offers to type
to it, desktop only); `extension-surface-keys` (the same prompt with its
footer's Show key buttons pressed; its Esc button answers the prompt afterwards, so capture it
last of the three, desktop only); `settings-sandboxing` (Projects settings
scrolled to Sandboxing: whether nono can run on the server machine, with Check
again, and the seed's Night Shift card labelled sandboxed or unavailable,
desktop only); `settings-project-sandbox` (Night Shift's Sandbox section: nono
with an allowed host, a local port and an extra folder, or why it cannot run,
desktop only); `session-sandboxed` (a Night Shift session: its header and row
say Sandboxed, or the chat says the sandbox is unavailable);
`terminal-sandboxed` (the terminal beside that session says it runs outside
the sandbox, desktop only). The seed sandboxes Night Shift with nono; on a
machine without Landlock those pages show the unavailable states.
The seed turns on the bundled Visuals and
Sub-agents plugins and adds two backdated sessions for them:
`settings-plugins` (Settings → Extensions & Plugins with both on, desktop
only);
`settings-marketplace` (Browse from that page's header: the featured picks
and popular packages, desktop only); `settings-marketplace-search` (Browse
searching `subagent`: the native Sub-agents plugin with its switch above the
npm results, desktop only); `settings-marketplace-mobile` (the same search on
a phone, from the composer sheet's Plugin settings, mobile only);
`settings-marketplace-package` (the seeded npm package's page, opened from
its name under Packages: enhanced for PiChamber, with Update to 1.3.0,
desktop only); `settings-marketplace-install` (the
Install dialog on a package page; nothing is installed, desktop only). The
marketplace pages read a made-up npm registry the script serves on port 4778
(`DEMO_NPM_PORT`): start the dev server with
`PICHAMBER_NPM_REGISTRY_URL=http://127.0.0.1:4778`,
`PICHAMBER_NPM_DOWNLOADS_URL=http://127.0.0.1:4778`, and
`PICHAMBER_FEATURED_URL=off`; the seed writes the featured list into the data
directory; `settings-extensions` (the same page at Pi extensions, Global: the
seed's npm package `@acme/pi-review-gate`, one release behind the demo
registry, with its Enhanced tag and Update; its local `review-kit` package
with one extension off; the demo
extensions, and Pi's built-ins); `settings-extensions-project` (Pi
extensions on This project, each extension with the project's own choice);
`settings-extensions-remove` (the package's Remove dialog; nothing is
removed, desktop only); `settings-extensions-mobile` (Pi extensions on This
project on a phone, reached from the composer sheet's Plugin settings,
mobile only);
`settings-plugin-detail` (Visuals' own page, opened from its row, desktop
only); `settings-plugin-replaced` (Sub-agents' own page from the Night Shift
session, whose folder has its own `subagent` extension: a warning callout
names it and offers to turn it off in that project, desktop only);
`visuals-page` (a `render_html` page in the reply column, with no frame of
its own, between the turn's activity and its reply, with the Sub-agents
toggle in the composer); `visuals-page-hover` (the same page with the
pointer on it, showing its More and Expand buttons, desktop only);
`visuals-choices` (an answered `render_choices` call: three variants, one
at a time at full width, opened on the chosen one with its switcher button
marked and the note under the frame); `visuals-choices-pending` (a
`render_choices` call that waits: the Acme Web folder's own extension is a
scripted model that answers the message with the call, so the shown variant
has a Choose button and the question sits folded above the composer; the page closes the question when it is
done, which adds a turn to that session, so re-seed for a clean capture);
`visuals-choices-switch` (the same waiting question after its second
switcher button, so variant B is in the frame; the page presses Choose B
when it is done, which also adds a turn);
`notices-mid-turn` (the same session's scripted model answers
`Run the release checks.` with three `run_check` tool rounds, and an
extension notice lands after each passing check, so each notice sits between
the rounds it arrived between while the last check runs; notices are
live-only, so the page stops the turn when done, which adds a turn, desktop
only); `notices-mid-turn-mobile` (the same on a phone, mobile only);
`notices-idle` (the same model answers `Start the nightly backup.` at once
and its extension raises a notice 1.5 s after the turn ends, so the notice
is its own row below the finished turn; each capture adds a turn);
`composer-plugin-sheet` (on a phone, the plugin button beside Send opened
to its sheet of switches, mobile only);
`composer-controls` (the demo session's footer with the seed's demo
extension's Mode cycle and Plan toggle after the plugin toggles, desktop
only); `composer-controls-sheet` (the same controls in the phone sheet,
mobile only); `composer-controls-draft` (a new-session draft whose draft
session reported those controls before any send, desktop only);
`visuals-expanded` (the same page from its Expand action, desktop only);
`turn-activity` (a seeded turn that read, searched, edited and ran two
commands, one failing: its `Worked for` line with the counts and `1 error`);
`turn-activity-open` (the same line pressed, showing the activity rail);
`draft-wallpaper-dither`, `draft-wallpaper-ascii`,
`draft-wallpaper-halftone`, `draft-wallpaper-strands`, and
`draft-wallpaper-grain` (the new-session
screen with each pattern, set through the `draftWallpaper` UI setting and
held still through `draftWallpaperMotion`, desktop only; pages without one
reset it to None); `settings-wallpaper` (Appearance at Wallpaper: a preview
tile per pattern, and the picture and motion rows; the seed has no
picture, so only its Choose button works, desktop only); `session-wallpaper`
(the demo session with Show in open sessions on: Halftone, still and faint,
at the top, faded out above the messages, desktop only);
`subagents-turn` (a finished scout-then-reviewer chain, a card per run);
`subagents-run` (the reviewer's card pressed: the run on its own, in the
Agents panel on desktop and a sheet on phones); and `subagents-panel` (the
whole chain in the Agents panel from Open in panel, desktop only).
Desktop captures report a mouse, so `hover:` styles apply; a page's
`hoverScript` returns the point to rest the pointer on before the shot. Server-route captures need Chrome on the server: under the throwaway
`HOME`, set `PICHAMBER_BROWSER_CHROME`, and as root
`PICHAMBER_BROWSER_NO_SANDBOX=1`. For before/after, run a second dev
server from a `main` worktree on other ports (`PICHAMBER_HMR_UI_PORT`,
`PICHAMBER_HMR_API_PORT`) and its own `XDG_RUNTIME_DIR` (otherwise the two share a daemon
socket and the second answers DAEMON_ENDPOINT_UNVERIFIED) and capture each with its own label.

## Pull Request Handoff

Before creating or updating a pull request, read `CONTRIBUTING.md` and
`.github/PULL_REQUEST_TEMPLATE.md`. Complete the template with concrete,
current evidence for the final PR HEAD; do not make the reviewer reconstruct
intent, affected surfaces, applicable guidance, validation, visual behavior,
or failure and rollback considerations from the diff alone.
