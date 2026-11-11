# Plan: `ctx.ui.custom()` for Pi extensions

Status: keyboard, mouse, touch and `ctx.mode = "tui"` implemented (inline, overlays, multi-device size)
Scope: web, desktop, hosted mobile, Capacitor mobile
Pi pin: 1.5.0 (`@earendil-works/pi-coding-agent`, bumped in #211)

## 1. Goal

Pi extensions that call `ctx.ui.custom()` work in PiChamber without changes:
question pickers, questionnaires, the MCP manager, todo lists, games. Using one
should feel like part of PiChamber, not like a terminal pasted into a web page.
Keys, clicks and taps respond immediately, the surface fits the device it is
on, and it follows the user across devices the same way dialogs do since #191.

This plan covers `custom()` only. `setHeader`, `setFooter`, entry renderers,
`renderShell`, shortcuts and autocomplete stay in the wider compat plan
(decisions D1–D7, 2026-10-08) and reuse the host pieces built here.

## 2. Principles

1. **Pi semantics, PiChamber presentation.** Components render on the server
   exactly as Pi would render them. The browser decides only where and how
   large the result is shown, using PiChamber's own cards, sheets and tokens.
2. **Sized for the device that is using it.** The component renders at the
   width of the device the user is typing on, not a fixed width that a phone
   has to scroll sideways through.
3. **Input never waits on output.** Keys, clicks and taps are sent in order
   without waiting for the previous frame, and frames arrive as line patches.
4. **Every device agrees.** A surface is session state: it shows on every
   device, any device can drive it, and closing it anywhere closes it
   everywhere.
5. **Nothing hangs.** Every surface ends with a resolved promise, a disposed
   component and a dismiss event, whatever ends it.

## 3. What changed since the October plan

| Area | October plan | Now | Why |
|---|---|---|---|
| Terminal size (D2) | Fixed 100×30 for everyone | Sized to the active device (section 5.3) | A fixed 100 columns forces sideways scrolling on every phone. Pi components already handle any width. |
| Inline stacking (1c) | A new inline surface replaces the old one and resolves it | Inline surfaces stack; closing the top one shows the previous one | Pi 1.4.0 changed `pushExtensionDialog` to a stack. |
| Touch input (D4) | Key bar only | Taps and swipes become mouse events, plus the key bar | pi-tui 1.4.0 has `handleMouse`. SelectList, SettingsList, Input and Editor already handle clicks and wheel. |
| Frames | Full line arrays | Line patches with a version, full frame in snapshots | A 100×30 frame with colour is 5–10 KB. At 30 fps that is too much over a relay or on mobile data. |
| Needs input | Not covered | Capturing surfaces feed the #191 pending-input index | The badge, strip, toast and OS notification already exist; `custom()` should use them. |
| `blocked` option | Did not exist | Honoured when an extension passes it | Pi 1.5.0 adds `custom({ blocked: { kind, message } })`. The pin is 1.5.0 since #211, so the type is available. |

Carried over unchanged: D1 (report `ctx.mode = "tui"`, `tui.stop()` and
`tui.start()` throw), D3 (legacy xterm keys, CSI-u only where legacy cannot
express the combination), D6 (`runtimeFetch` POSTs, no new WebSocket), D7
(shared host pieces, native PiChamber UI wins over `ctx.ui`), 1a (resolve
`undefined` on close, stop, reload or deletion), 1b (Escape goes to the
component, the host has its own Close), 1g (a throwing factory rejects and
publishes `extension.error`).

Considered and rejected: running a real pi-tui `TUI` per session against a
virtual terminal and streaming it to xterm.js in the browser. It would match
Pi exactly, but it needs a new dependency, shows the whole screen as one
terminal instead of PiChamber cards, and cannot size per device.

## 4. What users see

### 4.1 Inline surfaces (no `overlay`)

Pi puts an inline component in place of the editor. PiChamber does the same:

- The surface takes `ChatInput`'s place in the composer column as a card: a
  header with the plug icon, the title, `blocked.message` when given, "N more
  below" when inline surfaces are stacked, Stop while an agent turn runs, and
  an X Close button (labelled "Close {title}"); then the terminal lines; then
  the hint "Keys go to the extension. Your draft is kept when it closes."
- `ChatInput` stays mounted and hidden, so the draft, history and editor
  state survive. It fades back in when the last inline surface closes and
  gets focus back if focus had nowhere else to go.
- The surface takes keyboard focus when the daemon gives it key focus.
- The body grows with the content up to the chat pane's height less the
  card's header and footer, then scrolls. Extensions size themselves to the
  terminal height PiChamber reports (the pane, as Pi reports the whole
  terminal; pi-doom draws that less 15 rows), so anything sized to it fits
  without a scrollbar, as in Pi; a tall surface leaves the transcript little
  room while it is open. (It was 60% of the viewport, which scrolled
  pi-doom.)
- A second inline surface stacks on top. Closing it shows the previous one.

The title is the running top-level tool's name, else `/<command>` for a
command PiChamber dispatched, else "Extension" (decision 2).

### 4.2 Overlay surfaces (`overlay: true`)

- Overlays are laid out by pi-tui's own `resolveOverlayLayout` on a "screen"
  the size of the whole chat pane (`[data-composer-bound]` minus 12 px of
  padding), not the chat column. Edge-anchored overlays, such as side panels,
  use the empty space beside the chat column on wide windows and overlap the
  column on narrow ones. A separate side panel or bottom sheet is not needed.
- Each overlay is an exact cell box (`width` in `ch`, `height` × 18 px) on
  a raised surface of PiChamber's own (card background, soft border,
  rounded corners, the inline card's shadow) that sits 5 px outside the
  cells. A terminal has no such edge, but an overlay that draws no border
  would otherwise read as loose text over the chat; one that draws its own
  border shows it just inside this edge. A small tab with the title and an X Close button sits above the box,
  below it when the box is at the top of the pane, or over its top right
  corner when the box is as tall as the pane (`titleTabSpot`; on a touch
  screen the key bar's rows do not count as room). Only the command's own
  overlay has one; panels it opens with `tui.showOverlay` (even from its
  constructor) are its children, closed with it, and draw no tab.
- Two or more shown panels of one command form a tab stack (Pi has no
  equivalent; a terminal just overlaps them). The stack sits where Pi put
  the first panel when two first showed together, and keeps that spot while
  any of its panels is shown (`overlayStacks.ts`), so neither picking a tab
  nor closing panels moves it. The front card is the
  focused panel, else the one Pi would draw on top, at its own size; up to
  two cards behind show an 8 px edge. Tabs are named from the first word of
  each panel's first text line (Pi overlays carry no label), else "Panel N".
  Picking a tab sends `focus`, which acts as `handle.focus()`; key focus in
  the browser stays on the overlay that owns the keyboard. The tabs are a
  tablist with one tab stop: on a focused tab the arrow keys, Home and End
  pick a panel and keep focus on the tabs, and Enter returns to the panel. The last panel
  of a stack keeps the spot, without tabs; a panel that never shared a
  stack sits at its own Pi position.
- Only a capturing overlay dims this session's pane (`bg-background/60`).
  Clicking the dimmed area returns focus to that overlay and makes this tab
  the driver (5.3), so on a device narrower than the driver the overlay
  redraws to fit or shows its notice. Until then the box is kept inside the
  pane, cut at its right edge, with Close in reach. `nonCapturing` overlays
  and inline surfaces dim nothing. A `nonCapturing` overlay that focused
  itself (pi-btw's side chat) takes the keyboard without dimming: it takes
  focus back when code moves it (the composer refocusing after a send)
  until the user clicks elsewhere in the pane, and the composer gets focus
  back when it closes or calls `unfocus()`. PiChamber sends no extension
  shortcuts (`pi.registerShortcut`), Pi's way back into such a panel, so a
  press on a non-capturing overlay whose component takes keys gives it
  focus when the component did not take focus itself. A composer menu left open (a half-typed
  `/`) closes when the dim appears.
- An extension dialog (`confirm`, `select`, `input`) in the prompt dock sits
  above the overlay layer and keeps focus: the overlay's own code may be
  waiting on it. The overlay stays open behind it, as in Pi. Only the dialog
  rises: while an overlay dims the pane the composer drops its own stacking
  order, so the dialog's z-index reaches the pane, and the rest of the
  composer (including the other-sessions strip) stays under the dim. Once the dialog is answered or dismissed, focus goes back
  to the overlay.
- An overlay whose `visible(w, h)` rejects the current size, or that the
  extension hid with `setHidden(true)`, neither captures nor dims. A strip
  above the composer says it is open but needs a wider window (or is hidden
  by the extension) and offers Close, so it cannot block the session
  unseen.
- `onHandle` gets a real handle: `hide`, `setHidden`, `isHidden`, `focus`,
  `unfocus`, `isFocused` and `getBounds` change server state and publish
  updates. Overlays a component opens itself (`tui.showOverlay`) are nested
  surfaces that close with their parent.

### 4.3 Input

Implemented:

- **Keyboard:** keys go to the focused surface as legacy xterm sequences
  (D3, `lib/pi/terminal-keys.ts`). `mod+c` with a selection copies;
  `mod+v` is sent as one bracketed paste (65,536 UTF-16 characters at
  most); `meta` chords and unknown keys stay with the browser. IME
  composition events are skipped. Shift+Enter and Ctrl+Enter, which have no
  legacy byte, go as CSI-u (`\x1b[13;2u`, `\x1b[13;5u`), which pi-tui reads
  without the kitty protocol. AltGr characters (Windows reports AltGr as
  Ctrl+Alt) are typed as themselves, not as control chords.
- **Cursor:** `CURSOR_MARKER` becomes `{ row, col }` and the browser draws a
  block there. Pi's fake-cursor markers become reverse video.

- **Mouse:** mouse and pen presses, drags with a button held, releases and
  the wheel go as SGR reports (`encodeMouseReport`, `useSurfacePointer.ts`).
  The cell comes from the surface's position and a measured `ch` width and
  is clamped to the surface, so a drag past the edge stays on it. Moves with
  no button held are not sent, as pi-tui's default button-motion tracking.
  The wheel sends one report per line (pixel deltas over the 18 px line,
  small trackpad deltas carried over, five at most per event) and stops the
  page scrolling. Shift+drag keeps the browser's text selection, links keep
  their click, and a press gives the surface key focus. The host turns the
  reports into `TuiMouseEvent`s and routes them as pi-tui's alt screen
  does: the press target keeps the gesture, a release on the press cell
  adds a `click` with a click count (500 ms), and `capture`, `focus` and the
  render defaults follow pi-tui. Non-capturing overlays get the mouse too.

- **Touch:** a tap is a left press and release (the host adds the click);
  a vertical swipe past 10 px is the wheel, one report per 18 px, finger up
  scrolling down as on a page. Surfaces take swipes with
  `touch-action: none`; an inline surface taller than its box (the chat
  pane less the card header and footer, see 4.1) keeps native scrolling
  (`pan-y`) instead. On touch-only devices
  (`hasTouchOnlyPointer`) a key bar (`SurfaceKeyBar.tsx`) sends Esc, Tab,
  the arrows and Enter: in the inline surface's footer, and at the bottom
  of the pane under a capturing overlay, which reports three fewer rows so
  Pi lays overlays out above it. Its Keyboard button focuses a hidden
  input for the phone keyboard: keys with a sequence of their own go on
  keydown, text as it lands, and in-place edits while a word is composed
  go as Backspaces and the new text (`textEditInput`). Key bar buttons keep
  focus where it is, so the phone keyboard stays up.

### 4.4 Across devices

- A capturing surface registers with the pending-input index, so the sidebar
  dot, other-sessions strip, toast and OS notification from #191 work. Kind
  comes from `blocked.kind` (`permission` → `approval`, otherwise `input`).
  `nonCapturing` overlays never count.
- A device that opens the session later gets every surface and its current
  frame from the snapshot or session detail, and can drive it straight away.
- Closing a surface anywhere closes it everywhere.
- When another device presses Close on a top-level surface this tab shows,
  a toast says "/title was closed on another device." Only Close sends the
  `cancelled` reason, and the tab remembers the surfaces it closed itself
  (`closedElsewhere`, fed by the store's `subscribeExtensionSurfaceDismissals`).

### 4.5 Look and motion

- Lines use `AnsiText`'s colour mapping (`renderSegmentStyle` in
  `lib/pi/ansi.ts`). Graphemes Pi counts as two cells, or zero, are drawn in
  fixed `ch` boxes using the cell widths the daemon sends, so borders stay
  aligned whatever the font does with emoji and CJK.
- Block elements (`▀`, `▄`, `█`) fill their cells top to bottom, as a
  terminal draws them, using the segment's colours as a two-stop fill
  (`blockGlyphs.ts`); as font glyphs they left a gap on every 18 px line.
  The characters stay as transparent text, so copying keeps them.
- Motion is CSS transform and opacity only: inline rise 180 ms, overlay pop
  160 ms, overlay out 120 ms, fades 140 ms. Under reduced motion each runs
  for 1 ms so `animationend` still fires. Only the entering or leaving
  surface animates; frame updates never do, and the chat reflows once.
  Leaving overlays stay mounted until their exit animation ends. No View
  Transitions.
- Known issue: Pi's `accent` colour is weak, most visibly in the light theme.

## 5. Server design

### 5.1 Component host (`extension-custom-host.js`)

- One host per daemon, state per session: surfaces in open order, key focus,
  the viewport, the clients that reported one, and the driver.
- A TUI stub per session whose `terminal.columns`/`rows` are the screen
  size; `requestRender` schedules the surface: the first change after a
  quiet spell draws on the next tick, later ones at most every 33 ms;
  `setFocus`, `showOverlay` and `hideOverlay` work; `stop()`/`start()` throw
  (D1).
- Inline surfaces render at the inline column width; overlays at the width
  pi-tui's layout gives them, sliced to it and to `maxHeight`.
- Overlay layout calls pi-tui's own `TuiBase.prototype.resolveOverlayLayout`
  (loaded from `tui.js` next to the pi-tui entry), so there is no port to keep
  in sync.
- Factory arguments: the marker theme, Pi's `KeybindingsManager` from the
  agent directory, and `done`.
- Bounds: 200 lines and 16,384 characters per line (about 400 cells in
  24-bit colour with a foreground and background each, as pi-doom draws),
  cut between escape sequences, never inside one; lines pass through the
  daemon's redaction.

### 5.2 Lifecycle

| Event | Result |
|---|---|
| `done(result)` | Resolve with `result`, dispose, publish dismiss `done` |
| Close button | Send Esc to the component, and again 300 ms later if it is still open; if it is still open 300 ms after that, resolve `undefined` and dispose. Dismiss `cancelled` either way |
| `done()` during the factory | The component is disposed and never shown |
| Factory throws or rejects | Reject, publish `extension.error` (`source: 'extension.custom'`), nothing mounts |
| `render()` throws | `extension.error`, then the surface is cancelled |
| Session closed | Resolve `undefined`, dismiss `session-closed` |
| Extension reload | Resolve `undefined`, dismiss `reload` |
| Daemon stop | Resolve `undefined`, dismiss `daemon-stopped` |
| Idle disposal | Waits while a surface is open |
| `dispose()` throws | Ignored, as in Pi |

### 5.3 Virtual terminal size

Each session has one size, `{ columns, screenColumns, rows }`: `columns` is
the inline column, `screenColumns` the overlay screen (the chat pane).

- The last client that acted drives the size: input and Close carry the
  sender's viewport and make it the driver. So does a tap or click on a
  surface or its dimmed pane (a viewport report with `claim`). Opening one
  does too: prompts carry the tab's `clientId`, and a new top-level surface
  goes to the client that sent the session's latest input, at once if it
  already reported a size, else on its first report, so the device that ran
  the command sees it at its own width even though the driver outlives
  earlier surfaces. A plain report on open or resize does not claim, so two
  idle screens never fight. The first client to report becomes the driver
  when there is none. A claim made before this tab measured waits for the
  measurement and is dropped when the session's surfaces close.
- A size change applies after 150 ms without further changes, then
  invalidates and re-renders every open surface.
- Before any report, 100 × 140 × 30. Columns are clamped to 20–200, screen
  columns to 20–400, rows to 10–80. The daemon remembers at most 16 clients
  per session.
- A device that is not driving draws a frame laid out for a bigger one
  smaller, whole, with CSS `zoom` (`fitScale`, half size at least): an
  inline surface to its column width, an overlay to the pane. Pointer input
  follows the scale. Past half size it is cropped as before.

### 5.4 Protocol

Events (session-scoped):

- `extension.custom` `{ surfaceId, parentId?, title, mode, capturing, hidden, focused, z, blocked? }`, replayed like other events.
- `extension.custom.frame`, live only (`publishTransient`, not in the replay
  log). Full: `{ surfaceId, version, length, lines, cells?, cursor, layout, visible, columns, screenColumns, rows }`.
  Patch: the same without `lines`/`cells`, plus `base` and
  `changes: [{ index, line, cells? }]`. A full frame is sent on open, after a
  shape change, or when more than half the lines changed.
- `extension.custom.dismiss` `{ surfaceId, reason }`.

Snapshots and session detail carry `extensionSurfaces` (each with its full
frame) and omit it when none are open; a snapshot replaces the client's list.
A client that attaches by replay gets each open surface's full frame as a
keyframe after the replay. A patch whose `base` does not match the frame the
client holds marks the surface stale; the client then asks for a refresh.

Commands, as `POST /api/pi/sessions/:id/extensions/custom/:action` through
`runtimeFetch`:

- `input` `{ surfaceId, clientId, viewport?, items: string[] }`: at most 256
  items and 65,536 UTF-16 characters in all (`isValidCustomInputItems`,
  checked by the route and the daemon); each item is one key sequence or one
  bracketed paste. Keys stay with the surface they were sent to and the
  overlays it opened: once a key closes it, the rest of the batch is dropped.
  Keys for an open surface that takes none right now (non-capturing
  without focus, or hidden at the driver's size) are dropped with a 204,
  never the 404 below. A non-capturing overlay takes keys while it or an
  overlay it opened holds focus (`handle.focus()`, or a click its component
  answers with `focus`), as in Pi.
- `viewport` `{ clientId, viewport, claim? }`
- `close` `{ surfaceId, clientId, viewport? }`
- `focus` `{ surfaceId, clientId, viewport? }`: a tab in a stack was picked.
  Accepted only for a shown panel a command opened with `tui.showOverlay`;
  the sender becomes the driver.
- `refresh` `{ surfaceId? }`

204 on success, 404 `EXTENSION_SURFACE_NOT_OPEN` otherwise; the client then
drops the surface. Input is serialized per surface in the browser: one POST
in flight, keys typed meanwhile go in the next one. Keys that fail to send
are dropped, not replayed later.

A registered extension command is accepted as soon as it is dispatched. Pi
reports `handled` only once the handler returns, which held the send, and the
composer text, for as long as a surface stayed open.

### 5.5 `ctx.mode`

`"tui"` (D1), in `ctx.mode` and in the `__PICHAMBER__` marker. In Pi 1.5.0
only the MCP extension (and llama.cpp, which PiChamber skips) branches on it:

- `/mcp` opens Pi's MCP manager through `custom()`, and sign-in happens in
  that manager. The MCP extension gets an `openUrl` that does nothing, since
  Pi would open the URL in a browser on the daemon host; the manager draws
  the URL as an OSC 8 hyperlink, which surfaces render as a link (http and
  https only). `session-daemon-mcp.e2e.test.js` opens and closes the manager.
- Pi's own examples (`todo.ts`, `snake.ts`, `question.ts`,
  `questionnaire.ts`) check `ctx.mode === "tui"` and now run.
- `setEditorComponent`, `onTerminalInput`, `setHeader` and `setFooter` keep
  their no-ops.
- The product docs no longer suggest `ctx.mode === "rpc"` for detecting
  PiChamber; the marker and `PICHAMBER=1` remain the way.

## 6. Browser design

- `lib/pi/reducers/customSurfaceReducers.ts`: surfaces per session, frames
  with patch apply, stale marking, `dropExtensionSurface`.
- `lib/pi/terminal-keys.ts`: key encoder and bracketed paste.
- `components/chat/extension/custom/surfaceTransport.ts`: per-tab client id,
  serialized input queue, viewport reports, Close and refresh.
- `components/chat/extension/custom/ExtensionSurfaces.tsx`:
  `ExtensionSurfaceComposer` (wraps `ChatInput`, inline card, the strip for
  unshown overlays, the size probe) and `ExtensionSurfaceOverlays` (the pane
  layer). `ChatContainer` mounts both in the transcript and command-only
  layouts.
- Sessions with an open surface are kept out of transcript eviction.

| Runtime | Inline | Overlay | Input |
|---|---|---|---|
| Web desktop | Composer card | Pane layer | Keyboard |
| Electron | Same as web | Same as web | Keyboard |
| Hosted mobile | Composer card, full width | Pane layer; `visible()` strip | Touch: taps, swipes, the key bar and the phone keyboard |
| Capacitor | Same as hosted mobile | Same as hosted mobile | Same |

## 7. Delivery

1. Host and protocol: done.
2. Inline surface with keyboard and mouse input: done.
3. Overlays, stacking, focus, `onHandle`, nested overlays: done.
4. Touch: done.
5. Multi-device: driver rule, reattach, keyframes, non-driver scaling and
   the "Closed on another device" toast: done.
6. `ctx.mode = "tui"`, with `/mcp` and the examples above: done.

## 8. Validation

Done:

- Unit: host lifecycle, layout (centre and side panel, `visible()`),
  non-capturing and nested overlays, driver rule, snapshot and keyframes
  (`extension-custom-host.test.js`); reducers
  (`event-reducer-custom-surfaces.test.ts`); key encoder
  (`terminal-keys.test.ts`); static rendering (`ExtensionSurfaces.test.tsx`);
  early acceptance of extension commands (`prompt-preflight.test.js`).
- Manual, in the dev server against the real daemon with Pi's
  `overlay-test.ts` and `overlay-qa-tests.ts` plus two demo commands: an
  inline pick list driven by keys to `done()`, a side panel, a passive panel,
  three stacked overlays, reattach from a fresh browser, and the `visible()`
  strip at phone size.
- Manual, step 6: `/snake` and `/mcp` (manager, no servers) open under
  `ctx.mode = "tui"`; a QA surface with OSC 8 links renders the https link
  and leaves a `javascript:` one as plain text.
- Unit, mouse: SGR routing with click counts, drag, wheel, modifiers, a Pi
  `Container` forwarding to the child under the pointer, and non-capturing
  overlays taking focus (`extension-custom-host.test.js`); the encoder
  (`terminal-keys.test.ts`); cell and wheel maths (`useSurfacePointer.test.ts`).
- Manual, mouse: a QA overlay around a Pi `SelectList` in headless Chrome
  with real mouse events. The wheel moved the selection three lines a tick,
  a drag ended with no click, click counts went 1 then 2, and a click on a
  row picked it and closed the overlay.
- Manual, touch: headless Chrome at 390x844 with touch emulation. A 40 px
  swipe moved the `SelectList` two lines, a tap picked a row, the key bar's
  arrows and Esc reached the overlay with the hidden input focused, typed
  text arrived (`"q"`, then `"ab"`), and the bar fits at 390 px for an
  overlay and in the inline footer (`/snake`).
- Manual, step 5: an overlay a 1440 px desktop opened drew whole at zoom
  0.82 on a 390 px phone that had not acted, and a tap there picked the row
  under it. With both open, Close on the desktop showed "/mouse-test was
  closed on another device." on the phone.

- Manual, two clients: a desktop pressing Down three times and a phone
  pressing the key bar's Down three times in the same second moved the
  selection 1 to 7, and both ended on 7/12.
- Manual, stale-patch refresh: a tab set to hold an older frame version
  than the next patch's base marked the surface stale, got a full frame,
  and applied patches on top of it again.
- Manual, paste: a paste of `hello\nworld` reached the extension as one
  bracketed-paste item, `\x1b[200~hello\nworld\x1b[201~`.
- Manual, latency: key to repaint over loopback, 30 samples, measured with
  a throwaway CDP script (not `scripts/perf`). With a fixed 33 ms coalesce
  it was p50 40 ms, p90 42 ms. Drawing the first change after a quiet spell
  at once cut it to p50 8.5 ms, p90 19 ms, max 34 ms; an animating surface
  still updates about 30 times a second.
- Manual, pi-btw 0.8.1 (a `nonCapturing` overlay that calls
  `handle.focus()` from `onHandle`): `/btw` opened with keyboard focus, text
  reached its composer, Alt+/ handed focus to the chat composer, Escape
  closed it with focus back in the composer, and `/btw` reopened it focused.
  A click on it after Alt+/ gives it focus back.
  Its hidden-thread state ignores `custom()` resolving, so after the host's
  Close it keeps a dead handle and `/btw` does nothing until the session
  reloads; Escape, its own way out, does not have this problem.
- Manual, pi-doom 0.1.2: lines of 100 half-block cells (about 4,000
  characters) draw whole, with no escape-sequence tails, and the picture
  has no gaps between rows. On this 3-core host (load average about 3,
  Chrome without a GPU, React in development mode) the browser applied 8 to
  14 of the 30 frames a second, the main thread busy all the time: about
  120 ms/s parsing ANSI, the rest building and styling about 2,600 spans.
  Not a measured budget; a canvas renderer for such surfaces is the likely
  next step if this matters.

Not done:

- Stop while an agent turn has a surface open: the demo model cannot run a
  turn here.
- `doom-overlay`, and MCP sign-in against a real OAuth server.
- Touch on a real phone: iOS and Android keyboards (composition order,
  autocorrect, Backspace on the sentinel) are only covered by the unit test
  for `textEditInput`.

## 9. Decisions

1. **Terminal size:** follows the device that last acted (section 5.3).
   Replaces D2. Accepted 2026-11-06.
2. **Title in the header:** Pi builds one shared `ctx.ui` per session runner,
   and `createContext()` takes no extension argument, so the daemon cannot
   tell which extension called `custom()`. The header shows the running
   tool's name, else the slash command PiChamber dispatched, else
   "Extension". Propose an upstream change that passes the extension path
   into the context. Accepted 2026-11-06.
3. **Background ticking:** frames are live only; a client that attaches gets
   full frames. Accepted 2026-11-06.
4. **Pin:** 1.5.0, merged in #211 on 2026-11-06.
5. **Location:** this file stays in `docs/plans/` and is committed once
   accepted.
6. **Presentation (prototype, 2026-11-06):** variant A. Inline surfaces
   replace the composer; overlays use Pi's layout on the chat pane. A
   PiChamber dialog for every overlay (B) was rejected; a separate side panel
   (C) is not needed because the pane screen already puts side panels at the
   side. The throwaway prototype is not part of `main`.
7. **Dim:** only capturing overlays dim, and only this session's pane.
8. **`ctx.mode`:** `"tui"` since step 6 (5.5).
9. **Hidden overlays and input (2026-11-06):** follow Pi. An overlay whose
   `visible()` is false is not drawn and gives keys back to the composer;
   no "show anyway" control. Pi's interactive mode holds input while a
   command runs, so a running extension command keeps the session busy on
   every device (`session.lifecycle: busy` with `command`), messages queue
   until it returns, Steer and Stop are not offered, and the daemon refuses
   input meanwhile (prompts, steer, follow-up, `!cmd`, and `/compact`). The
   hidden-overlay line says new messages wait. The transcript shows no
   Thinking row for it, since no model turn runs. The command returning or
   throwing is the only edge that ends the busy run; Pi's command parsing
   (case-sensitive, from the first character) decides what counts as one.
10. **No "show anyway" (2026-11-06):** a phone gets no control to draw a
    hidden overlay on a wider virtual screen; a prototype of one (an opaque
    full-pane view scrolling sideways) was rejected as too awkward. A hidden
    overlay keeps Pi's behaviour: the one-line notice with Close.
