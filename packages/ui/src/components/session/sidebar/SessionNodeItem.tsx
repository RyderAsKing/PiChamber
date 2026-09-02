/* eslint-disable */
import React from 'react';
import type { Session } from '@/lib/chat/types';
import { ContextMenu } from '@base-ui/react/context-menu';
import { cn } from '@/lib/utils';
import { canUseElectronDesktopIPC, invokeDesktop } from '@/lib/desktop';
import { Icon } from '@/components/icon/Icon';
import { AgentThinkingLoader } from '@/components/chat/AgentThinkingLoader';
import { DraggableSessionRow } from './sessionFolderDnd';
import type { SessionNodeChildRenderExtras } from './sessionNodeItemUtils';
import { renderHighlightedText } from './highlightedText';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { SessionUnreadDot } from './SessionUnreadDot';
import { getRuntimeBearerTokenSync } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { streamPerfCount } from '@/stores/utils/streamDebug';
import { QuickSessionAction } from './QuickSessionAction';
import { SessionNodeExportDialog } from './SessionNodeExportDialog';
import { SessionNodeContextMenuContent, SessionNodeDropdownMenuContent } from './SessionNodeContextMenu';
import { holdSessionRowPosition } from './sessionRowAnchor';
import { collectNodeDescendantIds, useSessionExport } from './useSessionExport';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import type { SessionNodeItemProps } from './sessionNodeTypes';
import { areSessionNodeItemPropsEqual } from './sessionNodeComparators';
import { useSessionNodeItemMetadata } from './useSessionNodeItemMetadata';

export type { Folder, SecondaryMeta, SessionNodeItemProps } from './sessionNodeTypes';

function SessionNodeItemComponent(props: SessionNodeItemProps): React.ReactNode {
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
    handleDeleteSession,
    handleRestoreSession,
    mobileVariant,
    alwaysShowActions,
    allowQuickArchiveAction,
    renderSessionNode,
    secondaryMeta,
    renderContext = 'project',
    subtreeContainsEditing,
    menuOpenSessionId,
    childRenderExtrasFor,
  } = props;

  const isElectron = React.useMemo(() => canUseElectronDesktopIPC(), []);
  const showQuickArchiveAction = !archivedBucket && allowQuickArchiveAction;
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

  const menuInstanceKey = `${renderContext}:${archivedBucket ? 'archived' : 'active'}:${node.session.id}`;
  const expansionKey = menuInstanceKey;

  const {
    session,
    sessionDirectory,
    isActive,
    tooltipProjectLabel,
    tooltipBranchLabel,
    isGitRepo,
    subtaskCount,
    agentName,
    prSummary,
    prIconColor,
    selectionScopeKey,
    selectionModeEnabled,
    isRowSelected,
    toggleRowSelected,
    setRowRange,
    isZombie,
    isStreaming,
    hasActivityDuration,
    sessionPermissions,
    sessionTitle,
    hasChildren,
    isPinnedSession,
    isExpanded,
    pendingQuestionCount,
    needsAttention,
    sessionCompactUpdatedLabel,
    forkSolid,
    rowBackground,
  } = useSessionNodeItemMetadata({
    node,
    groupDirectory,
    projectId,
    secondaryMeta,
    pinnedSessionIds,
    expandedParents,
    expansionKey,
    hasSessionSearchQuery,
    notifyOnSubtasks,
  });

  const {
    exportDialogOpen,
    setExportDialogOpen,
    exportIncludeSubtasks,
    setExportIncludeSubtasks,
    descendantCount,
    handleExportSession,
    doExportSession,
  } = useSessionExport(node, sessionDirectory);

  const [isContextMenuOpen, setIsContextMenuOpen] = React.useState(false);

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

  React.useEffect(() => {
    if (editingId !== session.id) return;
    const handleDocMouseDown = (e: MouseEvent) => {
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
  const pendingQuestionLabel =
    pendingQuestionCount === 1 ? '1 pending question' : `${pendingQuestionCount} pending questions`;
  const showUnreadCompleteDot = !isStreaming && needsAttention && !isActive;
  const showActivityDuration = isStreaming && hasActivityDuration;
  const showPinnedMarker = isPinnedSession;
  const pinnedMarkerContent = (
    <Icon name="pushpin" className="h-3 w-3 flex-shrink-0 text-primary" aria-label={'Pinned session'} />
  );
  const leadingIndicators = showPinnedMarker ? (
    <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">{pinnedMarkerContent}</span>
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
      aria-label={isExpanded ? 'Collapse subsessions' : 'Expand subsessions'}
    >
      {isExpanded ? <Icon name="arrow-down-s" className="h-3 w-3" /> : <Icon name="arrow-right-s" className="h-3 w-3" />}
    </button>
  ) : null;

  const streamingIndicator = isZombie ? (
    <Icon name="error-warning" className="h-4 w-4 text-status-warning" />
  ) : null;

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
        const rows =
          typeof document !== 'undefined'
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

  const menuItemsProps = {
    session,
    sessionTitle,
    sessionDirectory,
    isPinnedSession,
    archivedBucket,
    isElectron,
    renamingFolderId,
    editingIdRef,
    pendingRenameRef,
    handleCopySessionId,
    togglePinnedSession,
    handleExportSession,
    handleOpenMiniChatWindow,
    handleDeleteSession,
    handleRestoreSession,
  };

  const contextMenuContent = <SessionNodeContextMenuContent {...menuItemsProps} />;

  return (
    <React.Fragment key={session.id}>
      <DraggableSessionRow sessionId={session.id} sessionDirectory={sessionDirectory ?? null} sessionTitle={sessionTitle}>
        <ContextMenu.Root
          open={isContextMenuOpen}
          onOpenChange={handleContextMenuOpenChange}
          onOpenChangeComplete={handleMenuOpenChangeComplete}
        >
          <ContextMenu.Trigger
            render={
              <div
                data-session-row={session.id}
                data-session-scope={selectionScopeKey ?? ''}
                data-session-archived={archivedBucket ? '1' : '0'}
                data-fork-color={forkSolid ? node.forkColorId : undefined}
                data-global-session={secondaryMeta?.globalSession ? '1' : undefined}
                onClick={handleRowBackgroundClick}
                style={{
                  ...(depth > 0 ? { marginLeft: `${depth * 14}px` } : undefined),
                  ...(rowBackground ? { backgroundColor: rowBackground } : undefined),
                }}
                className={cn(
                  'group relative my-0.5 flex cursor-pointer items-center rounded-xl px-3 py-2 transition-colors',
                  !rowBackground && depth > 0
                    ? 'bg-secondary/30 hover:bg-interactive-hover'
                    : !rowBackground
                      ? 'hover:bg-interactive-hover'
                      : 'hover:brightness-[1.07] dark:hover:brightness-[1.18]',
                  !rowBackground && isActive && !isRowSelected && 'bg-interactive-selection',
                  !rowBackground && isRowSelected && 'bg-interactive-selection',
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
                    placeholder={'Rename'}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === 'Escape') {
                        handleCancelEdit();
                      }
                    }}
                  />
                  <button
                    type="submit"
                    aria-label={'Save session name'}
                    title={'Save session name'}
                    className="shrink-0 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  >
                    <Icon name="check" className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelEdit}
                    aria-label={'Cancel renaming session'}
                    title={'Cancel renaming session'}
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
                    <div
                      className={cn(
                        'block min-w-0 flex-1 truncate font-normal typography-ui-label',
                        needsAttention ? 'text-foreground' : 'text-foreground/90',
                      )}
                    >
                      {renderHighlightedText(sessionTitle, normalizedSessionSearchQuery)}
                    </div>
                  </div>

                  {(secondaryMeta?.showFolderLabel && tooltipProjectLabel) ||
                  tooltipBranchLabel ||
                  isGitRepo ||
                  prSummary ||
                  subtaskCount > 0 ||
                  (agentName && agentName !== 'default') ||
                  showActivityDuration ||
                  pendingPermissionCount > 0 ||
                  pendingQuestionCount > 0 ? (
                    <div className="flex w-full min-w-0 items-center gap-2 overflow-hidden pt-0.5 typography-ui-label font-normal text-muted-foreground">
                      {secondaryMeta?.showFolderLabel && tooltipProjectLabel ? (
                        <span className="min-w-0 max-w-[110px] shrink-0 truncate">{tooltipProjectLabel}</span>
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
                        <span className="min-w-0 max-w-[80px] shrink-0 truncate">{agentName}</span>
                      ) : null}

                      {showActivityDuration ? (
                        <SessionActivityDuration
                          sessionId={session.id}
                          running={isStreaming}
                          className="text-muted-foreground/70"
                        />
                      ) : null}

                      {pendingPermissionCount > 0 ? (
                        <span
                          className="inline-flex items-center gap-0.5 text-destructive shrink-0"
                          aria-label={'Permission required'}
                        >
                          <Icon name="shield" className="size-3.5" />
                          <span>{pendingPermissionCount}</span>
                        </span>
                      ) : null}

                      {pendingQuestionCount > 0 ? (
                        <span
                          className="inline-flex items-center gap-0.5 text-status-info shrink-0"
                          aria-label={pendingQuestionLabel}
                        >
                          <Icon name="question" className="size-3.5" />
                          <span>{pendingQuestionCount}</span>
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </button>
              )}
            </div>

            {isPinnedSession ? <Icon name="star-fill" className="h-3 w-3 text-primary shrink-0" /> : null}

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
                  <SessionUnreadDot label={'Session complete'} />
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
                    archiveLabel={'Archive'}
                    deleteLabel={'Delete'}
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
              <div className="absolute right-0 top-1/2 -translate-y-1/2 z-10">{streamingIndicator}</div>
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
                  secondaryMeta?.globalSession ? { globalSession: true } : undefined,
                  renderContext,
                  childRenderExtras,
                )}
              </React.Fragment>
            );
          })
        : null}
      <SessionNodeExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        descendantCount={descendantCount}
        exportIncludeSubtasks={exportIncludeSubtasks}
        setExportIncludeSubtasks={setExportIncludeSubtasks}
        onExport={doExportSession}
      />
    </React.Fragment>
  );
}

export const SessionNodeItem = React.memo(SessionNodeItemComponent, areSessionNodeItemPropsEqual);
