# Session Sidebar Documentation

## Architecture & Layout

- `SessionSidebar.tsx` orchestrates sidebar components and lifecycle; core state and rendering logic lives in focused hooks and components.
- Layout (web/desktop): the session list starts at the top of the sidebar. Chrome and session cards share a `0.75rem` (`px-3`) gutter; the session scroller is full-width so its overlay scrollbar sits on the sidebar edge. `SidebarNav` uses that same gutter so New session lines up with the icon toolbar, and only grows left to clear OS window chrome. It shares the header height and vertical centering of the content-area session title. On dedicated mobile, New session is a circular opaque FAB on the empty 28% scrim beside the 72% sessions drawer, not inside the sidebar and not as `SidebarNav`.
- **Project zones & session lists**: Project zones display sessions in a unified recency and lifecycle order with per-row branch markers. Folders render after loose sessions.
- Folder and project identity belongs to `SidebarSpacesBar`, above the session scroller. Git projects expand linked worktrees as indented branch rows. The project row targets the primary checkout; a worktree row targets that linked checkout. Both filter the session list by authoritative directory ownership, while the worktree remains owned by the registered project and never becomes a separate project. The session list never paints a duplicate sticky folder identity. Collapsed projects show an aggregated busy/unseen indicator (`ProjectAggregateStatusIndicator`), derived from the live status index and notification store scoped to the project's directories.
- **Activity indicator**: While a session is running (`busy`/`retry`), the row shows a spinner and elapsed turn time. When a background session finishes a turn, the relative timestamp is replaced by a foreground unread dot until that session is opened. Aggregate indicators for collapsed folders and projects show a spinner while any child is running, or the unread dot when a finished turn is still unseen.
- Session rows have a single layout; rows show an inline branch label as normal text when the session lives in a branch or sub-directory, and bold titles while unread. Fork families use the same theme-aware tinted row backgrounds on desktop, tablet, and mobile. The active session uses the selection fill only; the title color does not change. Session rows do not show files-changed or diff counts. Hovering a row swaps the relative timestamp (or live status) for the archive action in the same slot so the title does not shift. Session rows do not open hover or long-press tooltips; the visible title and meta are the only session summary.
- Folders render **flat** after loose sessions: nested folders display at one level with a "Parent / Child" path label (`SessionFolderItem.displayName`); collapsing a folder hides its whole subtree.
- Archived sessions are not shown in the web/desktop sidebar; the Archive dialog (`ArchiveView`, `useUIStore.isArchivePageOpen`) replaces the old toggle. VS Code keeps inline archived buckets behind `showArchivedSessions` (compact webview has no page surfaces). Restore (unarchive) is available per session (row context menu, Archive dialog row) and in bulk (selection bar) and writes `time.archived = 0`.
- Directory loading is demand-driven: the sidebar publishes one complete priority plan for all known project directories, while the sync layer owns bounded execution. The global cache keeps each successful project snapshot independently, so activating or opening a session in one project never removes sessions belonging to another; a failed project refresh preserves that project's prior snapshot. The session list stays mounted while the sidebar is closed so opening it can slide with `transform` instead of remounting the tree. Close collapses layout width immediately, in the same 200ms easing as the header title spacers, so the session title does not slide right (header reserving toggle space) and then left (sidebar width dropping). Hidden-sidebar subscriptions still gate on `isVisible`.

## VS Code grouping

- VS Code uses the **same grouped project tree** as web/desktop (project headers + folders + pinned-first ordering), not a separate flat list. Each open VS Code workspace folder is a project header.
- VS Code groups strictly **by open workspace**: `useSessionGrouping` funnels every non-archived session into the project's root group. `getSessionsForProject` buckets sessions to a workspace by exact directory match, so only sessions whose directory is an open workspace folder appear.
- VS Code passes `hideDirectoryControls` (clean workspace headers, no close chrome) and no longer passes `showOnlyMainWorkspace`/`sharedSessionsOnly`. Folders and pinning work natively, scoped to the workspace root.

## File summaries

### Components

- `SidebarHeader.tsx`: Top header UI for add-project, session search, selection mode, and archive access. Projects retain their manual order; there is no sidebar display/sort menu. On dedicated mobile the toolbar occupies `var(--oc-header-height, 56px)` with `px-2` / `size-9` round icon buttons (`size-4` icons) so the chrome matches the chat header height without oversized sidebar type. Add folder / Add project still go through `sessionEvents.requestDirectoryDialog()`; dedicated mobile mounts `SessionDialogs` so the explorer overlay actually opens.
- `SidebarSpacesBar.tsx`: All Folders / project-folder / linked-worktree / Add folder rows share one row class (`px-3`, mobile `py-1.5`) so icons line up with each other and with session rows. Folder reorder handles stay `size-4` and do not take dnd-kit `role="button"` attributes, which would inherit the mobile 36px min touch target and indent the icon.
- `SidebarNav.tsx`: Text-style New session control (no row chrome or hover background; label brightens on hover) plus hide-sessions control above the tree; hidden in VS Code and on the dedicated mobile sidebar, which uses a new-session FAB on the drawer scrim instead. On desktop the top strip is a window-drag region with a no-drag carve under the persistent PiChamber menu overlay so Electron cannot steal those clicks while the sidebar is open.
- `SidebarFooter.tsx`: Static footer with icon-only settings, shortcuts, and about actions. Hidden on mobile; those actions live in the mobile sidebar header.
- `SidebarProjectsList.tsx`: Main scrollable renderer for project zones and their flat/archived groups plus empty/search states; owns project drag-to-reorder.
- `SessionGroupSection.tsx`: Renders one flat (or archived) group: sessions first, then flat folder entries with path labels, session-shaped show-more/new-session rows, and explicit loading/error/retry state for empty groups.
- `SessionNodeItem.tsx`: Renders one session row/tree node with a single-line layout, inline branch label, indicators, menu actions, and nested children. Pending-question counts stay per-session while expanded and roll up hidden descendants from their owning directory stores while collapsed. Rows do not wrap the title in a tooltip or paint an inner press fill; the row selection/hover chrome is the only highlight.
- `collapsedActivityIndicator.tsx`: Aggregate busy/unseen dot for collapsed groups and folders.
- `ConfirmDialogs.tsx`: Shared confirm dialog wrappers for session delete and folder delete flows.
- `sortableItems.tsx`: DnD sortable wrappers for project and group ordering.
- `sessionFolderDnd.tsx`: Folder/session DnD scope and wrappers for dropping/moving sessions into folders.
- `sessionOwnership.ts`: Resolves session directories once into shared project/worktree ownership and folder-scope indexes. Worktree ownership comes from Git discovery, not filesystem containment beneath the project path.

### Hooks

- `hooks/useProjectSessionSelection.ts`: Resolves active/current project-session selection logic and session-directory context. While a new-session draft is open it does not steal the view onto an existing session; the draft target follows the sidebar's active project instead. Switching a project/folder still loads that folder's remembered or first session in the background, but dedicated mobile keeps the sessions drawer open so the user can pick a different session. Opening Settings from the mobile sidebar closes the drawer.
- `hooks/useSessionActions.ts`: Centralizes session row actions (select/open, rename, share/unshare, archive/delete, confirmations). Explicit session picks still close the mobile sessions drawer; project-folder auto-selects pass `keepPanelOpen`.
- `hooks/useSessionSearchEffects.ts`: Handles search open/close UX and input focus behavior.
- `hooks/useSessionPrefetch.ts`: Publishes directory-aware nearby/active session prefetch demand to the shared message loader.
- `hooks/useSessionGrouping.ts`: Builds grouped session structures and search text/filter helpers.
- `hooks/useSessionSidebarSections.ts`: Composes final per-project sections and group search metadata for rendering.
- `hooks/useArchivedAutoFolders.ts`: Maintains archived auto-folder structure and assignment behavior.
- `hooks/useSidebarPersistence.ts`: Persists sidebar UI state (expanded/collapsed/pinned/project sort/active session) to storage + desktop settings.
- `hooks/useProjectRepoStatus.ts`: Tracks per-project git-repo state and root branch metadata.
- `hooks/useProjectSessionLists.ts`: Reads live and archived project buckets from the shared ownership index.
- `hooks/useAuthoritativeSessionCleanup.ts`: Establishes the first complete active+archived list as a non-destructive baseline, then cleans persisted state only for sessions omitted by a later authoritative snapshot.

### Types and utilities

- `types.ts`: Shared sidebar types (`SessionNode`, `SessionGroup`, summary/search metadata).
- `sessionNodeItemUtils.ts`: Memoization and extraction utilities for session node rows.
- `utils.ts`: Deduplication, search matching, path normalization, and shared row class names.
- `highlightedText.tsx`: Search highlight markup for session and group labels.
- `sidebarRowChrome.tsx`: Session-shaped row buttons.
