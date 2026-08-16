# Session Sidebar Documentation

## Architecture & Layout

- `SessionSidebar.tsx` orchestrates sidebar components and lifecycle; core state and rendering logic lives in focused hooks and components.
- Layout (web/desktop): top navigation (`SidebarNav`: New session, Archive), then one zone per project with a flat session list.
- **Project zones & session lists**: Project zones display sessions in a unified recency and lifecycle order with per-row branch markers. Folders render after loose sessions.
- When sticky zone headers are enabled, project headers are sticky "zone" bands (`SortableProjectItem`); on a vibrant desktop the scrolling content fades behind an unmasked, non-interactive copy of the stuck icon/title without painting a background. The transparent fade zone blocks interaction with obscured rows. Collapsed projects show an aggregated busy/unseen indicator (`ProjectAggregateStatusIndicator`), derived from the live status index and notification store scoped to the project's directories.
- **Activity indicator**: While a session is running (`busy`/`retry`), the row shows a spinner and elapsed turn time. When a background session finishes a turn, the relative timestamp is replaced by a foreground unread dot until that session is opened. Aggregate indicators for collapsed folders and projects show a spinner while any child is running, or the unread dot when a finished turn is still unseen.
- Session rows have a single layout; rows show an inline branch label when the session lives in a branch or sub-directory, and bold titles while unread.
- Folders render **flat** after loose sessions: nested folders display at one level with a "Parent / Child" path label (`SessionFolderItem.displayName`); collapsing a folder hides its whole subtree.
- Archived sessions are not shown in the web/desktop sidebar; the Archive page (`ArchiveView`, `useUIStore.isArchivePageOpen`) replaces the old toggle. VS Code keeps inline archived buckets behind `showArchivedSessions` (compact webview has no page surfaces). Restore (unarchive) is available per session (row context menu, Archive page row) and in bulk (selection bar) and writes `time.archived = 0`.
- Directory loading is demand-driven: the sidebar publishes one complete priority plan for all known project directories, while the sync layer owns bounded execution. The global cache keeps each successful project snapshot independently, so activating or opening a session in one project never removes sessions belonging to another; a failed project refresh preserves that project's prior snapshot.

## VS Code grouping

- VS Code uses the **same grouped project tree** as web/desktop (project headers + folders + pinned-first ordering), not a separate flat list. Each open VS Code workspace folder is a project header.
- VS Code groups strictly **by open workspace**: `useSessionGrouping` funnels every non-archived session into the project's root group. `getSessionsForProject` buckets sessions to a workspace by exact directory match, so only sessions whose directory is an open workspace folder appear.
- VS Code passes `hideDirectoryControls` (clean workspace headers, no close chrome) and no longer passes `showOnlyMainWorkspace`/`sharedSessionsOnly`. Folders and pinning work natively, scoped to the workspace root.

## File summaries

### Components

- `SidebarHeader.tsx`: Top header UI for add-project, session search, selection mode, project sort, and the display menu (collapse/expand all).
- `SidebarNav.tsx`: Text navigation rows above the tree (New session, Archive); hidden in VS Code.
- `SidebarFooter.tsx`: Static footer with icon-only settings, shortcuts, and about actions.
- `SidebarProjectsList.tsx`: Main scrollable renderer for project zones and their flat/archived groups plus empty/search states; owns project drag-to-reorder.
- `SessionGroupSection.tsx`: Renders one flat (or archived) group: sessions first, then flat folder entries with path labels, session-shaped show-more/new-session rows, and explicit loading/error/retry state for empty groups.
- `SessionNodeItem.tsx`: Renders one session row/tree node with a single-line layout, inline branch label, indicators, menu actions, and nested children. Pending-question counts stay per-session while expanded and roll up hidden descendants from their owning directory stores while collapsed.
- `collapsedActivityIndicator.tsx`: Aggregate busy/unseen dot for collapsed groups and folders.
- `ConfirmDialogs.tsx`: Shared confirm dialog wrappers for session delete and folder delete flows.
- `sortableItems.tsx`: DnD sortable wrapper for project ordering plus the sticky zone-band project header and its action affordances.
- `sessionFolderDnd.tsx`: Folder/session DnD scope and wrappers for dropping/moving sessions into folders.
- `sessionOwnership.ts`: Resolves session directories once into shared project ownership and folder-scope indexes.

### Hooks

- `hooks/useSessionActions.ts`: Centralizes session row actions (select/open, rename, share/unshare, archive/delete, confirmations).
- `hooks/useSessionSearchEffects.ts`: Handles search open/close UX and input focus behavior.
- `hooks/useSessionPrefetch.ts`: Publishes directory-aware nearby/active session prefetch demand to the shared message loader.
- `hooks/useSessionGrouping.ts`: Builds grouped session structures and search text/filter helpers.
- `hooks/useSessionSidebarSections.ts`: Composes final per-project sections and group search metadata for rendering.
- `hooks/useProjectSessionSelection.ts`: Resolves active/current project-session selection logic and session-directory context.
- `hooks/useArchivedAutoFolders.ts`: Maintains archived auto-folder structure and assignment behavior.
- `hooks/useSidebarPersistence.ts`: Persists sidebar UI state (expanded/collapsed/pinned/project sort/active session) to storage + desktop settings.
- `hooks/useProjectRepoStatus.ts`: Tracks per-project git-repo state and root branch metadata.
- `hooks/useProjectSessionLists.ts`: Reads live and archived project buckets from the shared ownership index.
- `hooks/useAuthoritativeSessionCleanup.ts`: Establishes the first complete active+archived list as a non-destructive baseline, then cleans persisted state only for sessions omitted by a later authoritative snapshot.
- `hooks/useStickyProjectHeaders.ts`: Tracks which project headers are sticky/stuck via `IntersectionObserver`.

### Types and utilities

- `types.ts`: Shared sidebar types (`SessionNode`, `SessionGroup`, summary/search metadata).
- `sessionNodeItemUtils.ts`: Memoization and extraction utilities for session node rows.
- `utils.ts`: Deduplication, search matching, and path normalization helpers.
