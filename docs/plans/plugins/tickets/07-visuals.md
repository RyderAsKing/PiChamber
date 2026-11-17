# 07 Native plugin: Visuals

- `packages/web/plugins/visuals/`: `package.json` (manifest), `extension.js`.
- `render_html` as in the spec. Registered active only while toggle `on`.
- UI: `VisualFrame` artifact (sandbox, CSP, theme variables, resize bridge,
  Expand / Copy / Download, error and streaming states), setting
  "Allow network in pages" (global, default off).

Accept: extension unit tests (path inside project only, cap, details shape),
frame document builder tests (CSP, theme vars), manual run with a real model.
