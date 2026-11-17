# 10 Composer switches per session

Changed by ticket 11: a composer toggle's key has no Settings value any more;
every session starts from the manifest default, and Visuals has no toggle.

Asked on 2026-11-16: a composer switch turns a plugin on or off for that
session only. Settings → Plugins stays the default for every session, and the
plugin's own switch there stays the master switch.

- Server: `state[id].sessions[sessionId]` in `plugins.json`, only for keys a
  composer toggle names. `GET /api/pi/plugins/sessions/:sessionId`,
  `PUT /api/pi/plugins/:id/sessions/:sessionId` (`value: null` clears).
  At most 1000 sessions per plugin (least recently set dropped). Deleting a
  session drops its values.
- Daemon: `plugins.configure` carries `state.sessions`; `chamber.state(cwd,
  sessionId)` resolves session over project over global. Visuals and
  Sub-agents read the id at `session_start`.
- UI: `plugins/sessionStore.ts`. A value is stored only while it differs from
  Settings. A new-session draft keeps its switches locally and writes them
  after the session is created and before the first prompt.
- Copy: tooltips and the phone sheet say "for this session" and name the
  Settings value when it differs; Settings says every session uses it unless
  its composer switch was changed.

Accept: store, route, host, and real-SDK e2e tests (another session's value
changes nothing; this session's value wins over the global one).

## End-to-end pass and review (2026-11-16)

Checked against a faux model provider (no paid model): through the API, the
model got the right tools per session right after a flip, after a Settings
change, and after a clear; a deleted session's values were gone. In the
browser: desktop flip, two sessions apart, reload, clear, Settings off with a
session override on, a draft flip then send, and the phone sheet.

Review fixes:

- Visuals: the page now sits in an inner sandboxed frame; the outer frame's
  `frame-src 'none'` stops a page navigating itself to a remote URL (script
  or `<meta refresh>`) while network is off. Links open only when the frame
  has focus, the click still counts as a user action, and at most once a
  second (`canOpenLink`).
- Extensions change the active tools only at session start or when their
  switch flips, so a tool list the user edited survives unrelated changes.
- `sessionStore`: a read keeps the local value only for keys written after
  it started; each write answer settles its own key. A first click before
  the first read no longer drops the session's other values.
- A draft switch that fails to save is named in a toast.
- A global Settings change reads the other folders again.
- Phones: a dot on the sliders button while the session differs from
  Settings (a "Use Settings" action in the sheet was tried and removed at
  the user's request). Pills stay focusable while
  saving (`aria-disabled`). Visuals' Copy and Download go into a menu in a
  narrow header.
- Copy: stopped sub-agent runs count as stopped, not failed; the tool
  description names the real agent folder; Settings says sub-agents use
  tokens of their own.
- The store logs when the session cap drops values.

Open: whether a forked session inherits its parent's switches (today it
starts from Settings).
