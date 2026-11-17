# 12 Composer controls declared by Pi extensions

Asked on 2026-11-16: a `/plan` or `/balance` extension should become a
switch in the composer. Clicking Balance again should move to the next mode,
and a model changed by hand should show in the control.

Decided: the extension declares the control and stays the source of truth.
No plugin needed, and the same file keeps working in the Pi CLI.

- Protocol: the extension emits `pichamber:composer` on `pi.events` with
  `{ id, kind: 'toggle' | 'cycle' | 'action', label, description?, icon?,
  value?, command | options[{ value, label, command }] }`, or
  `{ id, remove: true }`. Commands are the extension's own slash commands.
- Daemon (`session-daemon/extension-controls.js`): a hidden inline factory
  listens on every runtime's event bus and holds emits until `session_start`.
  Up to 16 controls per session, kept for snapshots like statuses, published
  as `extension.control`, cleared on reload. `extensions.control` resolves a
  click to a command (none when the value is already current), checks it is
  registered, and runs it as a typed extension command (steering while a turn
  streams), with no transcript entry and no title.
- Server: `POST /api/pi/extensions/control` (`{ sessionId, id, value?,
  clientId? }` → `{ ran }`; `ran: false` for a control that is gone
  or a value already set, 409 when the command is not
  registered). Event and snapshot projections re-validate controls.
- UI: the `composer.toggles` slot draws them after plugin toggles. Desktop
  pills: a toggle like a plugin toggle, a cycle showing its current option
  (click for the next, tooltip names it), an action. Phones: sheet rows with
  a switch, option chips, or a Run button. A click shows its value until the
  extension reports one (8 seconds at most). New-session drafts got them in
  ticket 13.
- The user's `modes.ts` (dotfiles) now emits a `mode` cycle control
  (Economy, Balance, Premium) whenever its status changes.

Accept: parser/store/listener unit tests, route projection tests, a real-SDK
daemon test (snapshot, hidden from `extensions.list`, click runs the command,
`ran: false`, `INVALID_ARGUMENT`, `CONTROL_UNAVAILABLE`, empty transcript), UI
helper and reducer tests, and screenshots with `modes.ts` loaded.
