# Context Surfaces

## Purpose

`packages/ui/src/lib/surfaces` owns the declarative registry of context panel
surfaces — the desktop workspaces switched by the vertical rail on the right
edge (`components/layout/ContextPanelRail.tsx`) and rendered by
`components/layout/ContextPanel.tsx`.

## Model

- A surface maps 1:1 to a `ContextPanelMode` tab mode in `useUIStore`.
- `availability: 'always'` surfaces are always present on the rail.
  `availability: 'has-content'` surfaces, currently Preview, are hidden until
  a tab of their mode exists, and stay visible while in use.
- `CONTEXT_SURFACE_DEFAULT_WIDTH_FRACTION` is the panel width as a fraction of
  the content area for every surface. A user resize is stored once per
  directory (`contextPanelByDirectory[dir].width`) and applies to every rail
  surface.
- Git includes working-tree diffs, so there is no separate Changes rail. The
  Git rail uses the Changes icon and label when the current directory is not a
  Git repository. There is no Pull Request rail until that integration exists.
- Rail order is user-reorderable and persisted globally in
  `useUIStore.contextRailOrder`; `sortContextSurfaces` applies it on top of the
  registry's default order and appends any missing surfaces.
- `getVisibleContextRailSurfaces` is the single visibility filter shared by the
  rail and the global surface-switch shortcut (`switch_context_surface` in
  `lib/shortcuts.ts`): it hides `has-content` surfaces until a tab of their mode exists. Both consumers use
  it so the digit shown on a rail badge always maps to the same surface the
  shortcut opens.

## Adding a surface

1. Add a `ContextPanelMode` value in `useUIStore` (type union plus the
   sanitizer whitelist in `sanitizeContextPanelTabs`).
2. Register a descriptor here (icon, label, availability).
3. Render the mode in `ContextPanel.tsx` (content dispatch, label, icon).
4. Provide direct user-facing `label` and `description` in the descriptor.

No new header buttons: the rail and `openContextSurface` are the only entry
points for opening surfaces directly; deep links from chat/palette go through
the `openContext*` actions in `useUIStore`.

## Invariants

- Opening a surface must never require a control outside the rail, the
  command palette, or an in-content link.
- Multi-instance and stateful surfaces (file/editor, browser, terminal) are
  keep-alive panes in `ContextPanel.tsx`: switching surfaces must not reset
  their state (open tabs, xterm session, scroll positions).
  Singleton surfaces (git, context) and preview tabs intentionally
  remount on switch and must restore themselves from their stores/snapshots
  instead. Git embeds a stacked diff list of changed files, collapsed until
  the user expands a file.
- Runtime scope: desktop/web `MainLayout` only. VS Code and the dedicated
  mobile shell have their own layouts and do not consume this registry.
