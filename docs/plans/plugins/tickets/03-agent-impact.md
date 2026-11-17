# 03 Agent impact measurement

- `lib/plugins/impact.js`: import the agent half, call it with a recording
  stub (`registerTool`, `on`, `registerCommand`, `setActiveTools`, ... as
  no-ops) and `chamber` with default state. Report `{ tools: [{ name,
  exposure, tokens }], hooks: ['before_agent_start', ...], commands: [...] }`.
- Token estimate: ceil(chars / 4) of JSON `{ name, description, parameters }`.
- Cached per plugin version. A throwing plugin reports `impact: null` with a
  reason; the card says it could not be measured.

Accept: tests with fixture plugins.

Status: built. `hooks` reports prompt-affecting events only
(`resources_discover`, `input`, `before_agent_start`, `context`,
`context_with_system`, `before_provider_request`, `tool_result`,
`message_end`). Visuals measures one direct tool, `render_html`, 199 tokens,
no hooks, no commands.
