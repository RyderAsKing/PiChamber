/* eslint-disable */
import React from 'react';
import type { Session } from '@/lib/chat/types';
import { ContextMenu } from '@base-ui/react/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { dropdownMenuItemClass, dropdownMenuPopupClass, dropdownMenuSeparatorClass, dropdownMenuSubTriggerClass } from '@/components/ui/dropdown-menu.styles';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn, formatDirectoryName } from '@/lib/utils';
import { canUseElectronDesktopIPC, invokeDesktop } from '@/lib/desktop';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { isSessionPinned, type SessionPinnedTarget } from '@/stores/useSessionPinnedStore';
import { Icon } from "@/components/icon/Icon";
import { AgentThinkingLoader } from '@/components/chat/AgentThinkingLoader';
import { buildExportFilename, downloadAsMarkdown, formatSessionAsMarkdown, getExportRevealLabel, revealExportedMarkdown, saveAsMarkdownDesktop } from '@/lib/exportSession';
import type { ChildSessionExport } from '@/lib/exportSession';
import { buildSessionMessageRecordsSnapshot, useDirectoryStore, useGlobalSessionStatus, useSessionPermissions, useSessionQuestionCount } from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { useViewportStore, viewportSessionKey } from '@/sync/viewport-store';
import { DraggableSessionRow } from './sessionFolderDnd';
import { nodeContainsSessionId, nodeHasPinnedMembershipChange, selectQuestionBadgeSessionScopes } from './sessionNodeItemUtils';
import type { SessionNodeChildRenderExtras, SessionNodeRenderExtras } from './sessionNodeItemUtils';
import type { SessionNode } from './types';
import { formatProjectLabel, formatSessionCompactDateLabel, normalizePath } from './utils';
import { renderHighlightedText } from './highlightedText';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useGitBranchLabel, useIsGitRepo } from '@/stores/useGitStore';
import { getGitHubPrStatusKey, usePrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { useSessionUnseenCount } from '@/sync/notification-store';
import { useHasSessionActivityDuration } from '@/sync/session-activity-timing';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { SessionUnreadDot } from './SessionUnreadDot';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { useShiftKeyHeld } from '@/hooks/useShiftKeyHeld';
import { getRuntimeBearerTokenSync } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { streamPerfCount } from '@/stores/utils/streamDebug';
import { useSessionUIStore } from '@/sync/session-ui-store';

type Folder = { id: string; name: string; sessionIds: string[] };

type SecondaryMeta = {
  projectLabel?: string | null;
  branchLabel?: string | null;
  showFolderLabel?: boolean;
};

type Props = {
  node: SessionNode;
  depth?: number;
  groupDirectory?: string | null;
  projectId?: string | null;
  archivedBucket?: boolean;
  pinnedSessionIds: Set<string>;
  expandedParents: Set<string>;
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  notifyOnSubtasks: boolean;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  editTitle: string;
  setEditTitle: (value: string) => void;
  handleSaveEdit: (titleOverride?: string) => void;
  handleCancelEdit: () => void;
  toggleParent: (expansionKey: string) => void;
  handleSessionSelect: (sessionId: string, sessionDirectory: string | null) => void;
  handleSessionDoubleClick: (sessionId: string, sessionTitle: string) => void;
  togglePinnedSession: (target: SessionPinnedTarget) => void;
  handleShareSession: (session: Session) => void;
  copiedSessionId: string | null;
  handleCopyShareUrl: (url: string, sessionId: string) => void;
  handleCopySessionId: (sessionId: string) => void;
  handleUnshareSession: (sessionId: string) => void;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  renamingFolderId: string | null;
  getFoldersForScope: (scopeKey: string) => Folder[];
  getSessionFolderId: (scopeKey: string, sessionId: string) => string | null;
  removeSessionFromFolder: (scopeKey: string, sessionId: string) => void;
  addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string) => void;
  createFolderAndStartRename: (scopeKey: string, parentId?: string | null) => { id: string } | null;
  openContextPanelTab: (directory: string, options: { mode: 'chat'; dedupeKey: string; label: string; sessionTitleFallback?: string; readOnly?: boolean }) => void;
  handleDeleteSession: (session: Session, source?: { archivedBucket?: boolean; hardDelete?: boolean; skipConfirm?: boolean }) => void;
  handleRestoreSession: (session: Session) => void;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  renderSessionNode: (
    node: SessionNode,
    depth?: number,
    groupDirectory?: string | null,
    projectId?: string | null,
    archivedBucket?: boolean,
    secondaryMeta?: SecondaryMeta | null,
    renderContext?: 'project' | 'recent',
    renderExtras?: SessionNodeRenderExtras,
  ) => React.ReactNode;
  secondaryMeta?: SecondaryMeta | null;
  renderContext?: 'project' | 'recent';
  /**
   * Precomputed set of session IDs whose subtree contains the session
   * currently being edited. Precomputed once per group render.
   */
  subtreeContainsEditing: Set<string>;
  /**
   * Precomputed session ID of the row whose sidebar menu is open, or null
   * if no menu is open. Only one row can have its menu open at a time.
   */
  menuOpenSessionId: string | null;
  /**
   * Precomputed structural key for this node. Encodes the IDs and child
   * counts of all descendants so a reference-only change to `node` (e.g.
   * a fresh tree rebuild) can be detected with a single string compare
   * instead of a recursive walk per row.
   */
  nodeStructureKey: string;
  /**
   * Resolves the per-row render extras for each child node. SessionGroupSection
   * walks the whole tree once to precompute the structure key for every
   * descendant; SessionNodeItem's recursive child render uses this lookup
   * to fetch the right key for each child it produces.
   */
  childRenderExtrasFor?: (child: SessionNode) => SessionNodeChildRenderExtras;
};

// Shared row geometry: the gutter edge matches the zone-header band padding
// (px-1.5 = 6px), the marker slot is icon-wide (14px) with a 6px gap, so row
// text starts exactly where the zone-header label starts. Nested children
// shift by one gutter step per depth level.
const ROW_GUTTER_LEFT_PX = 6;
const ROW_DEPTH_STEP_PX = 14;
const ROW_TEXT_LEFT_PX = ROW_GUTTER_LEFT_PX + 14 + 6;

const cancelScrollAnchorByContainer = new WeakMap<HTMLElement, () => void>();

const holdSessionRowPosition = (target: HTMLElement): void => {
  if (typeof window === 'undefined') return;
  const row = target.closest<HTMLElement>('[data-session-row]');
  const container = row?.closest<HTMLElement>('.overlay-scrollbar-container');
  if (!row || !container) return;

  cancelScrollAnchorByContainer.get(container)?.();

  const initialTop = row.getBoundingClientRect().top;
  let remainingFrames = 3;
  let cancelled = false;
  let frameId: number | null = null;
  const cancel = () => {
    cancelled = true;
    if (frameId !== null) window.cancelAnimationFrame(frameId);
    frameId = null;
    cancelScrollAnchorByContainer.delete(container);
    container.removeEventListener('wheel', cancel);
    container.removeEventListener('touchstart', cancel);
  };
  const restore = () => {
    if (cancelled || !row.isConnected || !container.isConnected) {
      cancel();
      return;
    }
    const delta = row.getBoundingClientRect().top - initialTop;
    if (Math.abs(delta) > 0.5) {
      container.scrollTop += delta;
      streamPerfCount('ui.sidebar.selection_scroll_anchor_adjustment');
    }
    remainingFrames -= 1;
    if (remainingFrames <= 0) {
      cancel();
      return;
    }
    frameId = window.requestAnimationFrame(restore);
  };

  container.addEventListener('wheel', cancel, { passive: true });
  container.addEventListener('touchstart', cancel, { passive: true });
  cancelScrollAnchorByContainer.set(container, cancel);
  frameId = window.requestAnimationFrame(restore);
};

type QuickSessionActionProps = {
  archiveLabel: string;
  deleteLabel: string;
  buttonSizeClass: string;
  iconSizeClass: string;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onMouseDown: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onArchive: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onDelete: (event: React.MouseEvent<HTMLButtonElement>) => void;
};

// Extracted so only this small button re-renders when Shift is pressed/released,
// instead of every mounted session row.
const QuickSessionAction = React.memo(function QuickSessionAction({
  archiveLabel,
  deleteLabel,
  buttonSizeClass,
  iconSizeClass,
  onPointerDown,
  onMouseDown,
  onArchive,
  onDelete,
}: QuickSessionActionProps): React.ReactNode {
  const shiftHeld = useShiftKeyHeld();
  const label = shiftHeld ? deleteLabel : archiveLabel;

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (shiftHeld || event.shiftKey) {
      onDelete(event);
      return;
    }
    onArchive(event);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-opacity',
            shiftHeld
              ? 'text-destructive hover:text-destructive'
              : 'text-muted-foreground hover:text-foreground',
            buttonSizeClass,
          )}
          aria-label={label}
          onPointerDown={onPointerDown}
          onMouseDown={onMouseDown}
          onClick={handleClick}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Icon name={shiftHeld ? 'delete-bin' : 'archive'} className={iconSizeClass} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
});

function SessionNodeItemComponent(props: Props): React.ReactNode {
  streamPerfCount('ui.sidebar_session_node.render');
  const {
    node,
    depth = 0,
    groupDirectory,
    projectId,
    archivedBucket = false,
    pinnedSessionIds,
    expandedParents,
    hasSessionSearchQuery,
    normalizedSessionSearchQuery,
    notifyOnSubtasks,
    editingId,
    setEditingId,
    editTitle,
    setEditTitle,
    handleSaveEdit,
    handleCancelEdit,
    toggleParent,
    handleSessionSelect,
    handleSessionDoubleClick,
    togglePinnedSession,
    handleShareSession,
    copiedSessionId,
    handleCopyShareUrl,
    handleCopySessionId,
    handleUnshareSession,
    openSidebarMenuKey,
    setOpenSidebarMenuKey,
    renamingFolderId,
    getFoldersForScope,
    getSessionFolderId,
    removeSessionFromFolder,
    addSessionToFolder,
    createFolderAndStartRename,
    openContextPanelTab,
    handleDeleteSession,
    handleRestoreSession,
    mobileVariant,
    alwaysShowActions,
    renderSessionNode,
    secondaryMeta,
    renderContext = 'project',
    subtreeContainsEditing,
    menuOpenSessionId,
    childRenderExtrasFor,
  } = props;

  const isElectron = React.useMemo(() => canUseElectronDesktopIPC(), []);
  const showQuickArchiveAction = !archivedBucket && !mobileVariant;
  const suppressNextSelectRef = React.useRef(false);
  const editingIdRef = React.useRef(editingId);
  editingIdRef.current = editingId;
  const pendingRenameRef = React.useRef<{ id: string; title: string } | null>(null);
  const handleSaveEditRef = React.useRef(handleSaveEdit);
  handleSaveEditRef.current = handleSaveEdit;
  const [renameDraft, setRenameDraft] = React.useState(editTitle);
  const renameDraftRef = React.useRef(renameDraft);
  renameDraftRef.current = renameDraft;
  const renameTargetRef = React.useRef<string | null>(null);
  const formRef = React.useRef<HTMLFormElement>(null);

  const session = node.session;
  const resolvedSession = session;
  const sessionDirectory =
    normalizePath((session as Session & { directory?: string | null }).directory ?? null)
    ?? normalizePath(groupDirectory ?? null);
  const isActive = useSessionUIStore((state) => state.currentSessionId === session.id);

  const liveBranch = useGitBranchLabel(sessionDirectory);
  const isGitRepoStatus = useIsGitRepo(sessionDirectory);

  // Tooltip context: recent rows receive project/branch via secondaryMeta;
  // project rows resolve them from the row's own props/node instead.
  const projectLabelFromStore = useProjectsStore(
    React.useCallback((state) => {
      if (secondaryMeta?.projectLabel || !projectId) return null;
      const project = state.projects.find((entry) => entry.id === projectId);
      if (!project) return null;
      return project.label?.trim() || formatDirectoryName(normalizePath(project.path) ?? project.path, null) || project.path;
    }, [projectId, secondaryMeta?.projectLabel]),
  );
  const tooltipProjectLabel = secondaryMeta?.projectLabel
    ?? (projectLabelFromStore ? formatProjectLabel(projectLabelFromStore) : null);
  const resolvedBranchLabel = secondaryMeta?.branchLabel
    ?? (node as any).worktree?.branch
    ?? (liveBranch && liveBranch !== 'HEAD' ? liveBranch : null);
  const tooltipBranchLabel = resolvedBranchLabel;
  const isGitRepo = isGitRepoStatus === true || Boolean(resolvedBranchLabel || (node as any).worktree);
  const subtaskCount = node.children.length;
  const agentName = (resolvedSession as Session & { agent?: string }).agent;

  const prLookupKey = React.useMemo(() => {
    const branch = (node as any).worktree?.branch?.trim() || resolvedBranchLabel?.trim();
    const directory = normalizePath((node as any).worktree?.path ?? sessionDirectory);
    return branch && directory ? getGitHubPrStatusKey() : null;
  }, [(node as any).worktree, resolvedBranchLabel, sessionDirectory]);
  const prSummary = usePrVisualSummary(prLookupKey);
  const prIconColor = prSummary ? `var(--pr-${prSummary.visualState})` : undefined;
  const prStatusLabel = React.useMemo(() => {
    if (!prSummary) return null;
    switch (prSummary.visualState) {
      case 'merged':
        return "Merged";
      case 'open':
        return (prSummary.canMerge === true || prSummary.mergeableState === 'clean' || prSummary.checks?.state === 'success')
          ? "Ready to merge"
          : "PR open";
      case 'blocked':
        return prSummary.mergeableState === 'dirty'
          ? "Merge conflicts"
          : "Merge blocked";
      case 'draft':
        return "Draft PR";
      case 'closed':
        return "Closed";
      default:
        return null;
    }
  }, [prSummary]);
  // Multi-select scope: sessions are flat per project, so selection groups by
  // project (falling back to the directory when no project is known) — a
  // selection must survive mixing sessions from different worktrees.
  const selectionScopeKey = projectId ?? sessionDirectory ?? null;
  // Directory bootstrap is scheduled once at sidebar level. A row only needs
  // the lightweight store reference for scoped state and export actions.
  const directoryStore = useDirectoryStore(sessionDirectory ?? undefined, { bootstrap: false });
  const sync = useSync();

  const selectionModeEnabled = useSessionMultiSelectStore((state) => state.enabled);
  const isRowSelected = useSessionMultiSelectStore(
    React.useCallback((state) => state.selectedIds.has(session.id), [session.id]),
  );
  const toggleRowSelected = useSessionMultiSelectStore((state) => state.toggleSelected);
  const setRowRange = useSessionMultiSelectStore((state) => state.setRange);

  const collectNodeDescendantIds = React.useCallback((root: SessionNode): string[] => {
    const out: string[] = [];
    const walk = (n: SessionNode) => {
      n.children.forEach((child) => {
        out.push(child.session.id);
        walk(child);
      });
    };
    walk(root);
    return out;
  }, []);

  const collectNodeDescendantSessions = React.useCallback((root: SessionNode): Session[] => {
    const out: Session[] = [];
    const walk = (current: SessionNode) => {
      current.children.forEach((child) => {
        out.push(child.session);
        walk(child);
      });
    };
    walk(root);
    return out;
  }, []);

  const [exportDialogOpen, setExportDialogOpen] = React.useState(false);
  const [exportIncludeSubtasks, setExportIncludeSubtasks] = React.useState(true);

  const menuInstanceKey = `${renderContext}:${archivedBucket ? 'archived' : 'active'}:${session.id}`;
  const isZombie = useViewportStore(
    React.useCallback((state) => Boolean(state.sessionMemoryState.get(viewportSessionKey(session.id))?.isZombie), [session.id]),
  );
  const sessionStatus = useGlobalSessionStatus(session.id);
  const statusType = sessionStatus?.type ?? 'idle';
  const isStreaming = statusType === 'busy' || statusType === 'retry';
  // Read as a boolean, not as the value: the row must not re-render on every
  // tick of the counter it only decides to mount.
  const hasActivityDuration = useHasSessionActivityDuration(session.id, isStreaming);
  const sessionPermissions = useSessionPermissions(session.id, sessionDirectory ?? undefined);
  const sessionTitle = resolvedSession.title || "Untitled Session";
  const hasChildren = node.children.length > 0;
  const isPinnedSession = isSessionPinned(pinnedSessionIds, sessionDirectory, session.id);
  // Per-render-context expansion key: the same session can appear in both
  // the project's root and the "Recent" list, and expanding one should not
  // expand the other. Matches the format of menuInstanceKey.
  const expansionKey = menuInstanceKey;
  const isExpanded = hasSessionSearchQuery ? true : expandedParents.has(expansionKey);
  const questionBadgeSessionScopes = React.useMemo(
    () => selectQuestionBadgeSessionScopes(node, isExpanded, sessionDirectory),
    [isExpanded, node, sessionDirectory],
  );
  const pendingQuestionCount = useSessionQuestionCount(questionBadgeSessionScopes);
  const isSubtaskSession = Boolean((resolvedSession as Session & { parentID?: string | null }).parentID);
  const unseenCount = useSessionUnseenCount(session.id);
  const needsAttention = unseenCount > 0 && (!isSubtaskSession || notifyOnSubtasks);
  const sessionTimestamp = resolvedSession.time?.updated || resolvedSession.time?.created || Date.now();
  const sessionCompactUpdatedLabel = formatSessionCompactDateLabel(sessionTimestamp);
  const isMenuOpen = openSidebarMenuKey === menuInstanceKey;
  const [isContextMenuOpen, setIsContextMenuOpen] = React.useState(false);
  const isSessionMenuOpen = isMenuOpen || isContextMenuOpen;

  const descendantCount = React.useMemo(() => collectNodeDescendantIds(node).length, [collectNodeDescendantIds, node]);

  const collectChildExports = React.useCallback(async (children: SessionNode[]): Promise<{ children: ChildSessionExport[]; skipped: number }> => {
    const results: ChildSessionExport[] = [];
    let skipped = 0;
    for (const child of children) {
      try {
        if (!sessionDirectory) throw new Error('Session directory is required for export');
        await (sync as any).loadCompleteHistory?.(child.session.id, sessionDirectory);
        const childRecords = buildSessionMessageRecordsSnapshot(directoryStore.getState(), child.session.id).list;
        const childTitle = child.session.title || "Untitled Sub-agent";
        const childAgent = (child.session as Session & { agent?: string }).agent;
        const grandChildren = await collectChildExports(child.children);
        skipped += grandChildren.skipped;
        results.push({
          title: childTitle,
          agent: childAgent,
          records: childRecords,
          children: grandChildren.children,
        });
      } catch {
        skipped += collectNodeDescendantIds(child).length + 1;
      }
    }
    return { children: results, skipped };
  }, [collectNodeDescendantIds, directoryStore, sessionDirectory, sync]);

  const showSkippedSubtasksWarning = React.useCallback((count: number) => {
    if (count <= 0) return;
    toast.warning(count === 1
      ? `Exported session, but skipped ${count} sub-agent task that could not be loaded.`
      : `Exported session, but skipped ${count} sub-agent tasks that could not be loaded.`);
  }, []);

  const doExportSession = React.useCallback(async (includeSubtasks: boolean) => {
    if (!sessionDirectory) {
      toast.error("Nothing to export");
      return;
    }

    try {
      await (sync as any).loadCompleteHistory?.(session.id, sessionDirectory);
    } catch {
      toast.error("Failed to load the complete session history");
      return;
    }

    const records = buildSessionMessageRecordsSnapshot(directoryStore.getState(), session.id).list;
    if (records.length === 0) {
      toast.error("Nothing to export");
      return;
    }

    let childExports: ChildSessionExport[] | undefined;
    let skippedSubtaskCount = 0;
    if (includeSubtasks && node.children.length > 0) {
      const collected = await collectChildExports(node.children);
      childExports = collected.children;
      skippedSubtaskCount = collected.skipped;
    }

    const markdown = formatSessionAsMarkdown(records, resolvedSession.title ?? null, childExports);
    const filename = buildExportFilename(resolvedSession.title ?? null);
    const savedPath = await saveAsMarkdownDesktop(markdown, filename);

    if (savedPath) {
      toast.success("Session exported", {
        action: {
          label: getExportRevealLabel(),
          onClick: () => {
            void revealExportedMarkdown(savedPath).then((revealed) => {
              if (!revealed) {
                toast.error("Failed to reveal path");
              }
            });
          },
        },
      });
      showSkippedSubtasksWarning(skippedSubtaskCount);
      return;
    }

    downloadAsMarkdown(markdown, filename);
    toast.success("Session exported");
    showSkippedSubtasksWarning(skippedSubtaskCount);
  }, [collectChildExports, directoryStore, node.children, resolvedSession.title, session.id, sessionDirectory, showSkippedSubtasksWarning, sync]);
  const handleExportSession = React.useCallback(async () => {
    if (node.children.length > 0) {
      setExportIncludeSubtasks(true);
      setExportDialogOpen(true);
      return;
    }
    await doExportSession(false);
  }, [doExportSession, node.children.length]);

  const handleOpenMiniChatWindow = React.useCallback(() => {
    if (!sessionDirectory) return;
    void invokeDesktop('desktop_open_session_mini_chat_window', {
      sessionId: session.id,
      directory: sessionDirectory,
      apiBaseUrl: getRuntimeApiBaseUrl(),
      clientToken: getRuntimeBearerTokenSync(),
    }).catch((error) => {
      console.warn('[session-sidebar] failed to open mini chat window', error);
    });
  }, [session.id, sessionDirectory]);

  // Capture outside-clicks to save edits — immune to focus-race with onBlur.
  React.useEffect(() => {
    if (editingId !== session.id) return;
    const handleDocMouseDown = (e: MouseEvent) => {
      // The same session can be rendered twice (recent + project), each with
      // its own rename form. A click inside ANY rename form for this session
      // must not count as "outside", or the sibling instance would save and
      // exit the rename mid-edit.
      const target = e.target as HTMLElement | null;
      const withinRenameForm = target?.closest?.(`[data-session-rename-form="${CSS.escape(session.id)}"]`);
      if (formRef.current && !withinRenameForm) {
        handleSaveEditRef.current(renameDraftRef.current);
      }
    };
    document.addEventListener('mousedown', handleDocMouseDown);
    return () => document.removeEventListener('mousedown', handleDocMouseDown);
  }, [editingId, session.id]);

  React.useLayoutEffect(() => {
    if (editingId !== session.id) {
      if (renameTargetRef.current === session.id) {
        renameTargetRef.current = null;
      }
      return;
    }
    if (renameTargetRef.current === session.id) return;
    renameTargetRef.current = session.id;
    setRenameDraft(editTitle);
  }, [editingId, editTitle, session.id]);

  const pendingPermissionCount = sessionPermissions.length;
  const pendingQuestionLabel = pendingQuestionCount === 1
    ? "1 pending question"
    : `${pendingQuestionCount} pending questions`;
  const showUnreadCompleteDot = !isStreaming && needsAttention && !isActive;
  const showActivityDuration = isStreaming && hasActivityDuration;
  const hideLeadingIndicatorOnHover = !alwaysShowActions && hasChildren && isPinnedSession;
  const showPinnedMarker = isPinnedSession;
  const pinnedMarkerContent = (
    <Icon
      name="pushpin"
      className="h-3 w-3 flex-shrink-0 text-primary"
      aria-label={"Pinned session"}
    />
  );
  const leadingIndicators = showPinnedMarker ? (
    <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
      {pinnedMarkerContent}
    </span>
  ) : null;
  const subsessionChevron = hasChildren ? (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        toggleParent(expansionKey);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          toggleParent(expansionKey);
        }
      }}
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
      aria-label={isExpanded ? "Collapse subsessions" : "Expand subsessions"}
    >
      {isExpanded ? <Icon name="arrow-down-s" className="h-3 w-3" /> : <Icon name="arrow-right-s" className="h-3 w-3" />}
    </button>
  ) : null;

  const streamingIndicator = isZombie
    ? <Icon name="error-warning" className="h-4 w-4 text-status-warning" />
    : null;

  const handleMenuOpenChange = (open: boolean) => {
    if (open) {
      setIsContextMenuOpen(false);
    }
    setOpenSidebarMenuKey(open ? menuInstanceKey : null);
  };

  const handleMenuOpenChangeComplete = (open: boolean) => {
    if (!open && pendingRenameRef.current) {
      const { id, title } = pendingRenameRef.current;
      pendingRenameRef.current = null;
      setEditingId(id);
      setEditTitle(title);
    }
  };

  const handleContextMenuOpenChange = (open: boolean) => {
    setIsContextMenuOpen(open);
  };

  const handleMenuTriggerClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setOpenSidebarMenuKey(isMenuOpen ? null : menuInstanceKey);
  };

  const handleMenuTriggerPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleMenuTriggerMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleQuickArchivePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleQuickArchiveMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleQuickArchiveClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setOpenSidebarMenuKey(null);
    handleDeleteSession(session, { archivedBucket });
  };

  const handleQuickDeleteClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setOpenSidebarMenuKey(null);
    handleDeleteSession(session, { archivedBucket, hardDelete: true, skipConfirm: true });
  };

  const handleRowSelect = (event?: React.MouseEvent<HTMLButtonElement>) => {
    if (suppressNextSelectRef.current) {
      suppressNextSelectRef.current = false;
      return;
    }
    if (selectionModeEnabled) {
      event?.preventDefault();
      event?.stopPropagation();
      if (event?.shiftKey) {
        const rows = typeof document !== 'undefined'
          ? Array.from(document.querySelectorAll<HTMLElement>('[data-session-row]'))
          : [];
        const orderedIds = rows
          .map((el) => el.getAttribute('data-session-row'))
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        const currentAnchor = useSessionMultiSelectStore.getState().anchorId;
        const descendantsById = new Map<string, string[]>();
        descendantsById.set(session.id, collectNodeDescendantIds(node));
        setRowRange(currentAnchor, session.id, orderedIds, selectionScopeKey, descendantsById);
        return;
      }
      toggleRowSelected(session.id, selectionScopeKey, collectNodeDescendantIds(node));
      return;
    }
    if (event?.currentTarget) holdSessionRowPosition(event.currentTarget);
    handleSessionSelect(session.id, sessionDirectory);
  };

  // The selection/active highlight covers the WHOLE row box (gutter, edge
  // paddings), while the primary click target is the inner title button.
  // Make the rest of the highlighted box clickable too — but only for clicks
  // that did not originate from an interactive child (title button, chevron,
  // action menu), so nothing double-fires.
  const handleRowBackgroundClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, [role="menuitem"], [role="menu"]')) return;
    handleRowSelect(event as unknown as React.MouseEvent<HTMLButtonElement>);
  };

  const handleRowMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (event.button === 2 || (event.button === 0 && event.ctrlKey && !selectionModeEnabled)) {
      suppressNextSelectRef.current = true;
    }
  };

  const renderSessionMenuItems = ({
    Item,
    Separator,
    Sub,
    SubTrigger,
    SubContent,
  }: {
    Item: React.ElementType;
    Separator: React.ElementType;
    Sub: React.ElementType;
    SubTrigger: React.ElementType;
    SubContent: React.ElementType;
  }) => (
    <>
      <Item
        onClick={() => {
          // Defer rename until dropdown close transition completes.
          // onOpenChangeComplete fires after animation + focus cleanup are done,
          // avoiding focus stealing from Base UI's unmount cleanup.
          pendingRenameRef.current = { id: session.id, title: sessionTitle };
        }}
        className="[&>svg]:mr-1"
      >
        <Icon name="pencil-ai" className="mr-1 h-4 w-4" />
        {"Rename"}
      </Item>
      <Item onClick={() => handleCopySessionId(session.id)} className="[&>svg]:mr-1">
        <Icon name="file-copy" className="mr-1 h-4 w-4" />
        {"Copy session ID"}
      </Item>
      <Item onClick={() => sessionDirectory && togglePinnedSession({ directory: sessionDirectory, sessionId: session.id })} className="[&>svg]:mr-1">
        {isPinnedSession ? <Icon name="unpin" className="mr-1 h-4 w-4" /> : <Icon name="pushpin" className="mr-1 h-4 w-4" />}
        {isPinnedSession ? "Unpin session" : "Pin session"}
      </Item>
      {!resolvedSession.share ? (
        <Item onClick={() => handleShareSession(resolvedSession)} className="[&>svg]:mr-1">
          <Icon name="share-2" className="mr-1 h-4 w-4" />
          {"Share"}
        </Item>
      ) : (
        <>
          <Item onClick={() => { if ((resolvedSession.share as any)?.url) handleCopyShareUrl((resolvedSession.share as any).url, session.id); }} className="[&>svg]:mr-1">
            {copiedSessionId === session.id
              ? <><Icon name="check" className="mr-1 h-4 w-4"  style={{ color: 'var(--status-success)' }}/>{"Copied"}</>
              : <><Icon name="file-copy" className="mr-1 h-4 w-4" />{"Copy link"}</>}
          </Item>
          <Item onClick={() => handleUnshareSession(session.id)} className="[&>svg]:mr-1">
            <Icon name="link-unlink-m" className="mr-1 h-4 w-4" />
            {"Unshare"}
          </Item>
        </>
      )}
      <Item onClick={() => { void handleExportSession(); }} className="[&>svg]:mr-1">
        <Icon name="download" className="mr-1 h-4 w-4" />
        {"Export Markdown"}
      </Item>
      {sessionDirectory && !archivedBucket ? (() => {
        const scopes: string[] = [];
        const pushScope = (candidate: string | null | undefined) => {
          const normalized = normalizePath(candidate ?? null);
          if (normalized && !scopes.includes(normalized)) scopes.push(normalized);
        };
        if (projectId) {
          const project = useProjectsStore.getState().projects.find((entry) => entry.id === projectId);
          const projectRoot = normalizePath(project?.path ?? null);
          pushScope(projectRoot);
        }
        pushScope(sessionDirectory);
        const folderEntries = scopes.flatMap((scope) =>
          getFoldersForScope(scope).map((folder) => ({ scope, folder })));
        const currentEntry = folderEntries.find(({ scope, folder }) =>
          getSessionFolderId(scope, session.id) === folder.id) ?? null;
        const defaultScope = scopes[0] ?? sessionDirectory;
        return (
          <>
            <Separator />
            <Sub>
              <SubTrigger className="[&>svg]:mr-1"><Icon name="folder" className="h-4 w-4" />{"Move to folder"}</SubTrigger>
              <SubContent className="min-w-[180px]">
                {folderEntries.length === 0 ? (
                  <Item disabled className="text-muted-foreground">{"No folders yet"}</Item>
                ) : (
                  folderEntries.map(({ scope, folder }) => {
                    const isCurrent = currentEntry?.folder.id === folder.id;
                    return (
                      <Item key={folder.id} onClick={() => {
                        if (isCurrent) {
                          removeSessionFromFolder(scope, session.id);
                          return;
                        }
                        if (currentEntry && currentEntry.scope !== scope) {
                          removeSessionFromFolder(currentEntry.scope, session.id);
                        }
                        addSessionToFolder(scope, folder.id, session.id);
                      }}>
                        <span className="flex-1 truncate">{folder.name}</span>
                        {isCurrent ? <Icon name="check" className="ml-2 h-3.5 w-3.5 text-primary flex-shrink-0" /> : null}
                      </Item>
                    );
                  })
                )}
                <Separator />
                <Item onClick={() => {
                  const newFolder = createFolderAndStartRename(defaultScope);
                  if (!newFolder) return;
                  if (currentEntry && currentEntry.scope !== defaultScope) {
                    removeSessionFromFolder(currentEntry.scope, session.id);
                  }
                  addSessionToFolder(defaultScope, newFolder.id, session.id);
                }}>
                  <Icon name="add" className="mr-1 h-4 w-4" />
                  {"New folder..."}
                </Item>
                {currentEntry ? (
                  <Item onClick={() => { removeSessionFromFolder(currentEntry.scope, session.id); }} className="text-destructive focus:text-destructive">
                    <Icon name="close" className="mr-1 h-4 w-4" />
                    {"Remove from folder"}
                  </Item>
                ) : null}
              </SubContent>
            </Sub>
          </>
        );
      })() : null}

      <Item
        disabled={!sessionDirectory}
        onClick={() => {
          if (!sessionDirectory) return;
          openContextPanelTab(sessionDirectory, {
              mode: 'chat',
              dedupeKey: `session:${session.id}`,
              label: sessionTitle,
              sessionTitleFallback: sessionTitle,
            });
          }}
          className="[&>svg]:mr-1"
        >
          <Icon name="chat-4" className="mr-1 h-4 w-4" />
          <span className="truncate">{"Open in Side Panel"}</span>
          <span className="shrink-0 typography-micro px-1 rounded leading-none pb-px text-[var(--status-warning)] bg-[var(--status-warning)]/10">{"beta"}</span>
        </Item>

      {isElectron ? (
        <Item
          disabled={!sessionDirectory}
          onClick={handleOpenMiniChatWindow}
          className="[&>svg]:mr-1"
        >
          <Icon name="window" className="mr-1 h-4 w-4" />
          <span className="truncate">{"Open in Mini Chat Window"}</span>
        </Item>
      ) : null}

      <Separator />
      {!archivedBucket ? (
        <Item className="[&>svg]:mr-1" onClick={() => handleDeleteSession(session, { archivedBucket })}>
          <Icon name="inbox-archive" className="mr-1 h-4 w-4" />
          {"Archive"}
        </Item>
      ) : null}
      {archivedBucket ? (
        <Item className="[&>svg]:mr-1" onClick={() => handleRestoreSession(session)}>
          <Icon name="inbox-unarchive" className="mr-1 h-4 w-4" />
          {"Restore"}
        </Item>
      ) : null}
      <Item className="text-destructive focus:text-destructive [&>svg]:mr-1" onClick={() => handleDeleteSession(session, { archivedBucket, hardDelete: true })}>
        <Icon name="delete-bin" className="mr-1 h-4 w-4" />
        {"Delete"}
      </Item>
    </>
  );

  const sessionMenuContent = (
    <DropdownMenuContent align="end" className="min-w-[180px]" finalFocus={() => (renamingFolderId || editingIdRef.current) ? false : true}>
      {renderSessionMenuItems({
        Item: DropdownMenuItem,
        Separator: DropdownMenuSeparator,
        Sub: DropdownMenuSub,
        SubTrigger: DropdownMenuSubTrigger,
        SubContent: DropdownMenuSubContent,
      })}
    </DropdownMenuContent>
  );

  const contextMenuContent = (
    <ContextMenu.Portal>
      <ContextMenu.Positioner className="app-region-no-drag z-50">
        <ContextMenu.Popup
          data-slot="dropdown-menu-content"
          finalFocus={() => (renamingFolderId || editingIdRef.current) ? false : true}
          style={{
            color: 'var(--surface-elevated-foreground)',
          }}
          className={cn(dropdownMenuPopupClass, 'min-w-[180px]')}
        >
          {renderSessionMenuItems({
            Item: ({ className, ...itemProps }: React.ComponentProps<typeof ContextMenu.Item>) => (
              <ContextMenu.Item className={cn(dropdownMenuItemClass, className)} {...itemProps} />
            ),
            Separator: ({ className, ...separatorProps }: React.ComponentProps<typeof ContextMenu.Separator>) => (
              <ContextMenu.Separator className={cn(dropdownMenuSeparatorClass, className)} {...separatorProps} />
            ),
            Sub: ContextMenu.SubmenuRoot,
            SubTrigger: ({ className, children, ...triggerProps }: React.ComponentProps<typeof ContextMenu.SubmenuTrigger>) => (
              <ContextMenu.SubmenuTrigger className={cn(dropdownMenuSubTriggerClass, className)} {...triggerProps}>
                {children}
                <Icon name="arrow-right-s" className="ml-auto size-3.5" />
              </ContextMenu.SubmenuTrigger>
            ),
            SubContent: ({ className, children, ...popupProps }: React.ComponentProps<typeof ContextMenu.Popup>) => (
              <ContextMenu.Portal>
                <ContextMenu.Positioner className="app-region-no-drag z-50">
                  <ContextMenu.Popup
                    data-slot="dropdown-menu-sub-content"
                    style={{
                      backgroundColor: 'var(--surface-elevated)',
                      color: 'var(--surface-elevated-foreground)',
                    }}
                    className={cn(dropdownMenuPopupClass, className)}
                    {...popupProps}
                  >
                    {children}
                  </ContextMenu.Popup>
                </ContextMenu.Positioner>
              </ContextMenu.Portal>
            ),
          })}
        </ContextMenu.Popup>
      </ContextMenu.Positioner>
    </ContextMenu.Portal>
  );

  return (
    <React.Fragment key={session.id}>
      <DraggableSessionRow sessionId={session.id} sessionDirectory={sessionDirectory ?? null} sessionTitle={sessionTitle}>
        <ContextMenu.Root open={isContextMenuOpen} onOpenChange={handleContextMenuOpenChange} onOpenChangeComplete={handleMenuOpenChangeComplete}>
          <ContextMenu.Trigger
            render={
              <div
                data-session-row={session.id}
                data-session-scope={selectionScopeKey ?? ''}
                data-session-archived={archivedBucket ? '1' : '0'}
                onClick={handleRowBackgroundClick}
                style={depth > 0 ? { marginLeft: `${depth * 14}px` } : undefined}
                className={cn(
                  'group relative my-0.5 flex cursor-pointer items-center rounded-xl px-3 py-2 transition-colors',
                  depth > 0
                    ? 'bg-secondary/30 hover:bg-interactive-hover'
                    : 'hover:bg-interactive-hover',
                  isActive && !isRowSelected && 'bg-interactive-selection',
                  isRowSelected && 'bg-interactive-selection',
                )}
              />
            }
          >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {subsessionChevron}
            {leadingIndicators}
            {editingId === session.id ? (
              <form
                ref={formRef}
                data-session-rename-form={session.id}
                className="flex min-h-8 min-w-0 flex-1 items-center gap-2"
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onSubmit={(event) => {
                  event.preventDefault();
                  handleSaveEdit(renameDraft);
                }}
              >
                <input
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  className="min-w-0 flex-1 bg-transparent typography-ui-label text-foreground outline-none placeholder:text-muted-foreground"
                  autoFocus
                  placeholder={"Rename"}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Escape') {
                      handleCancelEdit();
                    }
                  }}
                />
                <button
                  type="submit"
                  aria-label={"Save session name"}
                  title={"Save session name"}
                  className="shrink-0 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                >
                  <Icon name="check" className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={handleCancelEdit}
                  aria-label={"Cancel renaming session"}
                  title={"Cancel renaming session"}
                  className="shrink-0 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                >
                  <Icon name="close" className="size-4" />
                </button>
              </form>
            ) : (
              <button
                type="button"
                onMouseDown={handleRowMouseDown}
                onClick={(event) => handleRowSelect(event)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  handleSessionDoubleClick(session.id, sessionTitle);
                }}
                className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 overflow-hidden text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 text-foreground select-none"
              >
                <div className="flex w-full items-center min-w-0 flex-1 gap-1.5 overflow-hidden">
                  <div className={cn('block min-w-0 flex-1 truncate font-normal typography-ui-label', needsAttention ? 'text-foreground' : 'text-foreground/90')}>
                    {renderHighlightedText(sessionTitle, normalizedSessionSearchQuery)}
                  </div>
                </div>

                {((secondaryMeta?.showFolderLabel && tooltipProjectLabel) || tooltipBranchLabel || isGitRepo || prSummary || subtaskCount > 0 || (agentName && agentName !== 'default') || showActivityDuration || pendingPermissionCount > 0 || pendingQuestionCount > 0) ? (
                  <div className="flex w-full min-w-0 items-center gap-2 overflow-hidden pt-0.5 typography-ui-label font-normal text-muted-foreground">
                    {secondaryMeta?.showFolderLabel && tooltipProjectLabel ? (
                      <span className="min-w-0 max-w-[110px] shrink-0 truncate">
                        {tooltipProjectLabel}
                      </span>
                    ) : null}

                    {tooltipBranchLabel ? (
                      <span className="inline-flex min-w-0 max-w-[160px] shrink-0 items-center gap-1">
                        <Icon
                          name="git-branch"
                          className={cn('size-3.5 shrink-0', !prIconColor && 'text-muted-foreground')}
                          style={prIconColor ? { color: prIconColor } : undefined}
                        />
                        <span className="truncate">{tooltipBranchLabel}</span>
                      </span>
                    ) : isGitRepo ? (
                      <span className="inline-flex shrink-0 items-center gap-1">
                        <Icon name="git-repository" className="size-3.5 shrink-0 text-muted-foreground" />
                        <span>git</span>
                      </span>
                    ) : null}

                    {prSummary ? (
                      <span
                        className="inline-flex shrink-0 items-center gap-1"
                        style={prIconColor ? { color: prIconColor } : undefined}
                      >
                        <Icon name="git-pull-request" className="size-3.5 shrink-0" />
                        <span>#{prSummary.number}</span>
                      </span>
                    ) : null}

                    {subtaskCount > 0 ? (
                      <span className="inline-flex shrink-0 items-center gap-1">
                        <Icon name="node-tree" className="size-3.5 shrink-0" />
                        <span>{subtaskCount}</span>
                      </span>
                    ) : null}

                    {agentName && agentName !== 'default' ? (
                      <span className="min-w-0 max-w-[80px] shrink-0 truncate">
                        {agentName}
                      </span>
                    ) : null}

                    {showActivityDuration ? (
                      <SessionActivityDuration sessionId={session.id} running={isStreaming} className="text-muted-foreground/70" />
                    ) : null}

                    {pendingPermissionCount > 0 ? (
                      <span className="inline-flex items-center gap-0.5 text-destructive shrink-0" aria-label={"Permission required"}>
                        <Icon name="shield" className="size-3.5" />
                        <span>{pendingPermissionCount}</span>
                      </span>
                    ) : null}

                    {pendingQuestionCount > 0 ? (
                      <span className="inline-flex items-center gap-0.5 text-status-info shrink-0" aria-label={pendingQuestionLabel}>
                        <Icon name="question" className="size-3.5" />
                        <span>{pendingQuestionCount}</span>
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </button>
            )}
          </div>

          {isPinnedSession ? (
            <Icon name="star-fill" className="h-3 w-3 text-primary shrink-0" />
          ) : null}

          <div className="relative ml-1 flex h-6 min-w-6 shrink-0 items-center justify-end">
            <div
              className={cn(
                'flex items-center justify-end',
                showQuickArchiveAction && (alwaysShowActions || isContextMenuOpen)
                  ? 'opacity-0'
                  : showQuickArchiveAction
                    ? 'group-hover:opacity-0 group-focus-within:opacity-0'
                    : null,
              )}
            >
              {isStreaming ? (
                <AgentThinkingLoader
                  variant="inline"
                  text={null}
                  animationType="spinner"
                  speedMs={80}
                  className="text-primary text-xs shrink-0"
                />
              ) : showUnreadCompleteDot ? (
                <SessionUnreadDot label={"Session complete"} />
              ) : (
                <span className="text-[11px] text-muted-foreground/75 whitespace-nowrap">
                  {sessionCompactUpdatedLabel}
                </span>
              )}
            </div>
            {showQuickArchiveAction ? (
              <div
                className={cn(
                  'absolute inset-0 flex items-center justify-end',
                  alwaysShowActions || isContextMenuOpen
                    ? 'opacity-100'
                    : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100',
                )}
              >
                <QuickSessionAction
                  archiveLabel={"Archive"}
                  deleteLabel={"Delete"}
                  buttonSizeClass="h-6 w-6"
                  iconSizeClass="h-3.5 w-3.5"
                  onPointerDown={handleQuickArchivePointerDown}
                  onMouseDown={handleQuickArchiveMouseDown}
                  onArchive={handleQuickArchiveClick}
                  onDelete={handleQuickDeleteClick}
                />
              </div>
            ) : null}
          </div>

          {streamingIndicator && !mobileVariant ? (
            <div className="absolute right-0 top-1/2 -translate-y-1/2 z-10">
              {streamingIndicator}
            </div>
          ) : null}
          </ContextMenu.Trigger>
          {contextMenuContent}
        </ContextMenu.Root>
      </DraggableSessionRow>
      {hasChildren && isExpanded
        ? node.children.map((child): React.ReactNode => {
          const childRenderExtras: SessionNodeChildRenderExtras = childRenderExtrasFor
            ? childRenderExtrasFor(child)
            : {
                subtreeContainsEditing,
                menuOpenSessionId,
                nodeStructureKey: '',
              };
          return (
            <React.Fragment key={child.session.id}>
              {renderSessionNode(
                child,
                depth + 1,
                sessionDirectory ?? groupDirectory,
                projectId,
                archivedBucket,
                undefined,
                renderContext,
                childRenderExtras,
              )}
            </React.Fragment>
          );
        })
        : null}
      <Dialog open={exportDialogOpen} onOpenChange={setExportDialogOpen}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>{"Export Markdown"}</DialogTitle>
            <DialogDescription>
              {descendantCount === 1
                ? `This session has ${descendantCount} sub-agent task. Include it in the export?`
                : `This session has ${descendantCount} sub-agent tasks. Include them in the export?`}
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 typography-ui-label cursor-pointer">
            <input
              type="checkbox"
              checked={exportIncludeSubtasks}
              onChange={(e) => setExportIncludeSubtasks(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            {"Include sub-agent tasks"}
          </label>
          <DialogFooter>
            <Button
              type="button"
              onClick={() => setExportDialogOpen(false)}
              variant="outline"
              size="sm"
            >
              {"Cancel"}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setExportDialogOpen(false);
                void doExportSession(exportIncludeSubtasks);
              }}
              size="sm"
            >
              {"Export"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </React.Fragment>
  );
}

const getNodeSessionDirectory = (node: SessionNode): string | null => {
  return normalizePath((node.session as Session & { directory?: string | null }).directory ?? null);
};

const isSecondaryMetaEqual = (prev?: SecondaryMeta | null, next?: SecondaryMeta | null): boolean => {
  return (prev?.projectLabel ?? null) === (next?.projectLabel ?? null)
    && (prev?.branchLabel ?? null) === (next?.branchLabel ?? null)
    && (prev?.showFolderLabel ?? false) === (next?.showFolderLabel ?? false);
};

const getMenuSessionIdFromKey = (props: Props): string | null => {
  if (!props.openSidebarMenuKey) return null;
  const bucketTag = props.archivedBucket ? 'archived' : 'active';
  const prefix = `${props.renderContext ?? 'project'}:${bucketTag}:`;
  return props.openSidebarMenuKey.startsWith(prefix)
    ? props.openSidebarMenuKey.slice(prefix.length)
    : null;
};

const getRelevantMenuSessionId = (props: Props): string | null => {
  return props.menuOpenSessionId ?? getMenuSessionIdFromKey(props);
};

const subtreeContainsSession = (
  props: Props,
  sessionId: string | null,
  precomputed: Set<string>,
): boolean => {
  if (!sessionId) return false;
  if (precomputed.has(props.node.session.id)) return true;
  return nodeContainsSessionId(props.node, sessionId);
};

const hasSetMembershipChangeInNode = (
  prevNode: SessionNode,
  nextNode: SessionNode,
  prevSet: Set<string>,
  nextSet: Set<string>,
  getKey: (node: SessionNode) => string,
): boolean => {
  if (prevNode.session.id !== nextNode.session.id) return true;
  const key = getKey(prevNode);
  if (prevSet.has(key) !== nextSet.has(key)) return true;
  if (prevNode.children.length !== nextNode.children.length) return true;
  for (let i = 0; i < prevNode.children.length; i += 1) {
    if (hasSetMembershipChangeInNode(prevNode.children[i], nextNode.children[i], prevSet, nextSet, getKey)) {
      return true;
    }
  }
  return false;
};

const hasExpansionMembershipChange = (prev: Props, next: Props): boolean => {
  if (prev.hasSessionSearchQuery || next.hasSessionSearchQuery) return false;
  const prevBucketTag = prev.archivedBucket ? 'archived' : 'active';
  const nextBucketTag = next.archivedBucket ? 'archived' : 'active';
  return hasSetMembershipChangeInNode(
    prev.node,
    next.node,
    prev.expandedParents,
    next.expandedParents,
    (node) => `${prev.renderContext ?? 'project'}:${prevBucketTag}:${node.session.id}`,
  ) || hasSetMembershipChangeInNode(
    prev.node,
    next.node,
    prev.expandedParents,
    next.expandedParents,
    (node) => `${next.renderContext ?? 'project'}:${nextBucketTag}:${node.session.id}`,
  );
};

const areSessionNodeItemPropsEqual = (prev: Props, next: Props): boolean => {
  if (prev.node.session.id !== next.node.session.id) return false;
  if (prev.node.session !== next.node.session) return false;
  if (prev.depth !== next.depth) return false;
  if (prev.groupDirectory !== next.groupDirectory) return false;
  if (prev.projectId !== next.projectId) return false;
  if (prev.archivedBucket !== next.archivedBucket) return false;
  if ((prev.renderContext ?? 'project') !== (next.renderContext ?? 'project')) return false;
  if (prev.mobileVariant !== next.mobileVariant) return false;
  if (prev.alwaysShowActions !== next.alwaysShowActions) return false;
  if (prev.hasSessionSearchQuery !== next.hasSessionSearchQuery) return false;
  if (prev.normalizedSessionSearchQuery !== next.normalizedSessionSearchQuery) return false;
  if (prev.notifyOnSubtasks !== next.notifyOnSubtasks) return false;
  if (prev.nodeStructureKey !== next.nodeStructureKey) return false;
  if (getNodeSessionDirectory(prev.node) !== getNodeSessionDirectory(next.node)) return false;
  if (!isSecondaryMetaEqual(prev.secondaryMeta, next.secondaryMeta)) return false;

  if (prev.pinnedSessionIds !== next.pinnedSessionIds
    && nodeHasPinnedMembershipChange(
      prev.node,
      next.node,
      prev.pinnedSessionIds,
      next.pinnedSessionIds,
      prev.groupDirectory,
      next.groupDirectory,
    )) {
    return false;
  }

  if (prev.expandedParents !== next.expandedParents && hasExpansionMembershipChange(prev, next)) {
    return false;
  }

  if (prev.editingId !== next.editingId
    && (
      subtreeContainsSession(prev, prev.editingId, prev.subtreeContainsEditing)
      || subtreeContainsSession(next, next.editingId, next.subtreeContainsEditing)
    )) {
    return false;
  }

  if (prev.editTitle !== next.editTitle
    && (
      subtreeContainsSession(prev, prev.editingId, prev.subtreeContainsEditing)
      || subtreeContainsSession(next, next.editingId, next.subtreeContainsEditing)
    )) {
    return false;
  }

  if (prev.copiedSessionId !== next.copiedSessionId
    && (
      nodeContainsSessionId(prev.node, prev.copiedSessionId)
      || nodeContainsSessionId(next.node, next.copiedSessionId)
    )) {
    return false;
  }

  if (prev.openSidebarMenuKey !== next.openSidebarMenuKey) {
    const prevMenuSessionId = getRelevantMenuSessionId(prev);
    const nextMenuSessionId = getRelevantMenuSessionId(next);
    if (nodeContainsSessionId(prev.node, prevMenuSessionId) || nodeContainsSessionId(next.node, nextMenuSessionId)) {
      return false;
    }
  }

  if (prev.renamingFolderId !== next.renamingFolderId) {
    const prevMenuSessionId = getRelevantMenuSessionId(prev);
    const nextMenuSessionId = getRelevantMenuSessionId(next);
    if (nodeContainsSessionId(prev.node, prevMenuSessionId) || nodeContainsSessionId(next.node, nextMenuSessionId)) {
      return false;
    }
  }

  return prev.setEditingId === next.setEditingId
    && prev.setEditTitle === next.setEditTitle
    && prev.handleSaveEdit === next.handleSaveEdit
    && prev.handleCancelEdit === next.handleCancelEdit
    && prev.toggleParent === next.toggleParent
    && prev.handleSessionSelect === next.handleSessionSelect
    && prev.handleSessionDoubleClick === next.handleSessionDoubleClick
    && prev.togglePinnedSession === next.togglePinnedSession
    && prev.handleShareSession === next.handleShareSession
    && prev.handleCopyShareUrl === next.handleCopyShareUrl
    && prev.handleCopySessionId === next.handleCopySessionId
    && prev.handleUnshareSession === next.handleUnshareSession
    && prev.setOpenSidebarMenuKey === next.setOpenSidebarMenuKey
    && prev.getFoldersForScope === next.getFoldersForScope
    && prev.getSessionFolderId === next.getSessionFolderId
    && prev.removeSessionFromFolder === next.removeSessionFromFolder
    && prev.addSessionToFolder === next.addSessionToFolder
    && prev.createFolderAndStartRename === next.createFolderAndStartRename
    && prev.openContextPanelTab === next.openContextPanelTab
    && prev.handleDeleteSession === next.handleDeleteSession
    && prev.handleRestoreSession === next.handleRestoreSession
    && prev.renderSessionNode === next.renderSessionNode;
};

export const SessionNodeItem = React.memo(SessionNodeItemComponent, areSessionNodeItemPropsEqual);
