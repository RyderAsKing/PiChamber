# 14 Questions from a plugin, and Visuals' choice of variants

Asked on 2026-11-17: let a plugin ask the user something through its own
chat UI. The case that started it: a Pi user wants the agent to mock up a
few variants of a layout or image, see them inline, and pick one.

Decided (by the agent, not reviewed with the user before building):

- PiChamber's own calls live on a `pichamber` handle, not on `ctx.ui`. The
  new piece is `pichamber.ui.choose(ctx, title, choices, opts)`, which any Pi
  extension can call (plugins get `pichamber` as the second factory argument,
  other extensions read `globalThis.pichamber`), plus a way to tie the
  question to a tool call. `ctx.ui.choose` does not exist, and `ctx.ui.form` and
  `ctx.ui.openUrl` are removed in favour of `pichamber.ui.form` and
  `pichamber.ui.openUrl`.
- 2026-11-18: the owner chose to remove `ctx.ui.form` and `ctx.ui.openUrl`
  outright instead of keeping them as deprecated aliases.
- 2026-11-17: the owner asked for PiChamber's own calls to live on a
  `pichamber` handle so a later Pi `ctx.ui` method cannot collide with them.
- `choices` is `[{ id, label, description? }]`, at most 12. `opts` takes
  `message`, `allowNote`, `toolCallId`, `signal`, `timeout`. It resolves
  `{ id, note? }` or `undefined`.
- A question with a `toolCallId` reaches that tool's turn artifact as a
  `question` prop. The dock above the composer shows the same question and
  folds to one line while the artifact is on screen, so there is one place
  to answer and other clients (or a tool without an artifact) still can.
- Visuals gets `render_choices`: 2 to 6 options, each a page or an image
  file in the project, always with a note. Images are sent as `data:` URLs
  (750 KB each, 1.5 million characters a call) because the result lives in
  the session file and the UI has no route that serves project files.
- The daemon keeps each running tool's latest partial result and returns it
  when a session is opened mid-call, so a reload while a question waits
  still shows the variants.

Built:

- Daemon: `choose` in `extension-bridge.js`, limits and the answer check in
  `extension-protocol.js`, partial results in `session-daemon.js`.
- Server: `extension.dialog` and snapshot projection for `choose`; `note` on
  `POST /api/pi/extensions/respond`.
- Visuals 1.1.0: `choices.js`, `files.js`.
- UI: `PluginQuestion` and `question` on `TurnArtifactProps`,
  `plugins/questions.ts`, the dock's `choose` body and fold,
  `visuals/ChoicesArtifact.tsx` and `choices.ts`.

Known limits:

- A daemon restart or runtime recreation cancels a waiting question.
- A client from before this change shows a `choose` dialog with nothing to
  pick; it can only dismiss it.
- Opening a session whose history has several large artifacts can leave the
  chat above the newest one on a phone (the artifacts load after the first
  scroll to the bottom). Seen with two `render_choices` turns; not specific
  to questions.

Accept: real-SDK daemon test (options before the question, the question in
a reopened session with the call's partial result, the answer and note in
the result), protocol, route and extension unit tests, UI unit tests
(parsing, question selection, dock, artifact states), a live check with the
seed's scripted model (ask, reload on a phone, answer with a note, skip),
and the `visuals-choices` and `visuals-choices-pending` screenshots.
