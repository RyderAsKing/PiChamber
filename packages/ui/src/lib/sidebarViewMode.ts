/**
 * How the session sidebar organizes sessions.
 *
 * - `workspace`: one folder is scoped at a time through the folder rail.
 * - `folder`: every folder is listed with its sessions nested beneath it.
 * - `timeline`: sessions from every folder are grouped by recency.
 *
 * Persisted server-side as the `sidebarViewMode` UI setting so every client
 * of a server renders the same view.
 */
const SIDEBAR_VIEW_MODES =['workspace', 'folder', 'timeline'] as const;

export type SidebarViewMode = (typeof SIDEBAR_VIEW_MODES)[number];

export const DEFAULT_SIDEBAR_VIEW_MODE: SidebarViewMode = 'workspace';

export const isSidebarViewMode = (value: unknown): value is SidebarViewMode =>
  typeof value === 'string' && (SIDEBAR_VIEW_MODES as readonly string[]).includes(value);
