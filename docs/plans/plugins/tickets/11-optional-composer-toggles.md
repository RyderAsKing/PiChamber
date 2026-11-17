# 11 Optional composer toggles that start from the default

Asked on 2026-11-16: a new session's composer should show what Settings →
Plugins says, and a toggle is not a must. Visuals can help in any turn, so it
gets no toggle; Sub-agents keeps one, as would a future plan mode.

- Visuals: no `on` state and no composer toggle. Its tool is in every session
  while the plugin is on. Settings keeps `allowNetwork`.
- Sub-agents: keeps its `on` toggle (default on). The "Let the agent use
  sub-agents" Settings checkbox is gone: the plugin's own On switch in
  Settings → Plugins is what decides whether the toggle shows at all.
- Manifest: `contributes.settings` may not list a key a composer toggle sets.
- Server: a composer toggle's key always resolves to its manifest default;
  a stored global or project value (from an older build) is ignored and
  `PUT /state` refuses the key. Only a session's own value changes it.
- UI: `defaultOn` replaces `settingsOn`. Tooltip and sheet name the default
  when a session differs ("Off for this session, on by default"); the sheet
  intro says new sessions start with their defaults. Settings → Plugins'
  app features row reads "On in every new session; changes that session
  only".

Accept: manifest, store, route, extension, and real-SDK daemon tests
(Visuals declared whenever configured; Sub-agents follows global and session
`on`).
