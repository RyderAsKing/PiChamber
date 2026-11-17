# 13 Composer controls in a new-session draft

Asked on 2026-11-17: a new session should show its extensions' controls
right away, not only after the first send. Pi writes a session file only
once it has a message, so a session can run for a draft without leaving
anything behind (measured: 82 ms cold, 20 to 30 ms warm, no file).

Decided: start a draft session when a draft opens, show the folder's
remembered controls until it reports, keep clicks made before then, and
adopt the draft session on send.

- Daemon: `sessions.create` with `draft: true` starts a session that is
  marked from the moment Pi assigns its id (the `beforeSession` runtime
  hook), so all its events carry `draft: true`. It never becomes the active
  session, is left out of `sessions.list`, `sessions.pendingInput`, and Open
  request attribution, and gets the five-minute idle lifetime at once.
  `sessions.create` with `draftSessionId` adopts it (same id, the controls'
  state kept, model and thinking set only when they differ); a gone or
  mismatched draft falls back to an ordinary create. `sessions.discardDraft`
  disposes a draft and nothing else. A model turn that starts in a draft
  session (a control's command sent a message) ends the draft: the session
  becomes an ordinary listed one and the turn runs (decided 2026-11-17, it
  was aborted before). The open draft lets go of it and starts no other.
- Server: `POST /api/pi/sessions/:id/discard-draft`; `projectEventFrame`
  passes `draft: true` through; notifications ignore draft events.
- UI: the session store sends draft events to `subscribeDraftEvents`, never
  the catalog or reducer. `plugins/draftRuntime.ts` starts, adopts, and
  discards the draft session, keeps clicks, and keeps model and thinking in
  step both ways. `plugins/rememberedControls.ts` keeps each folder's last
  controls (per server and folder). Worktree, branch, and fork drafts start
  none: remembered controls, clicks applied after create. Servers without the
  `sessions.discardDraft` capability are not asked.
- Known limit: a page reload or closed tab leaves its draft session to the
  idle lifetime (five minutes).

Accept: real-SDK daemon test (hidden, marked from `session_start`, adopted
with its control state, fallback, discard, nothing written), route and
notification tests, store, draft-runtime, and remembered-controls unit
tests, a live check (controls appear and a click is confirmed by the draft
session with no sidebar row), and the `composer-controls-draft` screenshot.
