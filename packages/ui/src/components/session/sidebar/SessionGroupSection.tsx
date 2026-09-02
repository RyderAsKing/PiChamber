import React from 'react';
import type { Session } from '@/lib/chat/types';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { sessionEvents } from '@/lib/sessionEvents';
import { SessionFolderItem } from '../SessionFolderItem';
import { DroppableFolderWrapper, SessionFolderDndScope } from './sessionFolderDnd';
import type { SessionNode } from './types';
import { isBranchDifferentFromLabel, normalizePath } from './utils';
import { SidebarSessionLikeButton } from './sidebarRowChrome';
import { compareSessionsByLifecycleOrder, EMPTY_SESSION_ORDER_RANKS } from '@/sync/session-ordering';
import {
  collectSubtreeContainingId,
  computeNodeStructureKey,
  resolveMenuOpenSessionId,
} from './sessionNodeItemUtils';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { getGitHubPrStatusKey, usePrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { CollapsedActivityIndicator } from './collapsedActivityIndicator';
import { getSessionNodesActivityState } from './collapsedActivityState';
import {
  VirtualArchivedSessionList,
  ARCHIVED_VIRTUALIZE_THRESHOLD,
} from './VirtualArchivedSessionList';
import { SessionGroupHeader } from './SessionGroupHeader';
import type { SessionGroupSectionProps } from './sessionGroupTypes';
import { areGroupPropsEqual } from './sessionGroupComparators';
import { useSessionGroupBootstrap } from './useSessionGroupBootstrap';
import { useSessionGroupFolders } from './useSessionGroupFolders';

export type { SessionGroupSectionProps } from './sessionGroupTypes';

function SessionGroupSectionBase(props: SessionGroupSectionProps): React.ReactNode {
  const {
    group,
    groupKey,
    projectId,
    hideGroupLabel,
    hasSessionSearchQuery,
    normalizedSessionSearchQuery,
    groupSearchDataByGroup,
    visibleSessionCount,
    collapsedGroups,
    hideDirectoryControls,
    collapsedFolderIds,
    toggleFolderCollapse,
    renameFolder,
    deleteFolder,
    showDeletionDialog,
    setDeleteFolderConfirm,
    renderSessionNode,
    showMoreGroupSessions,
    resetGroupSessionLimit,
    mobileVariant,
    alwaysShowActions,
    activeProjectId,
    setActiveProjectIdOnly,
    setActiveMainTab,
    setSessionSwitcherOpen,
    openNewSessionDraft,
    addSessionToFolder,
    createFolderAndStartRename,
    renamingFolderId,
    renameFolderDraft,
    setRenameFolderDraft,
    setRenamingFolderId,
    pinnedSessionIds,
    expandedParents,
    sessionOrderIndex,
    editingId,
    openSidebarMenuKey,
    activeActivitySessionIds,
    unreadActivitySessionIds,
    notifyOnSubtasks,
    onToggleCollapsedGroup,
    dragHandleProps,
    compactBodyPadding = false,
    scrollContainerRef,
  } = props;

  const compareSessionNodes = React.useCallback(
    (a: SessionNode, b: SessionNode) => {
      const aIndex = sessionOrderIndex.get(a.session.id);
      const bIndex = sessionOrderIndex.get(b.session.id);
      if (aIndex !== undefined || bIndex !== undefined) {
        if (aIndex === undefined) return 1;
        if (bIndex === undefined) return -1;
        if (aIndex !== bIndex) return aIndex - bIndex;
      }
      return compareSessionsByLifecycleOrder(a.session, b.session, pinnedSessionIds, EMPTY_SESSION_ORDER_RANKS);
    },
    [pinnedSessionIds, sessionOrderIndex],
  );

  const searchData = hasSessionSearchQuery ? groupSearchDataByGroup.get(group) : null;
  const isCollapsed = hasSessionSearchQuery ? false : collapsedGroups.has(groupKey);

  const groupPrKey = React.useMemo(() => {
    if (group.isMain || group.isArchivedBucket || hideGroupLabel) return null;
    const directory = normalizePath(group.directory ?? null);
    const branch = group.branch?.trim();
    return directory && branch ? getGitHubPrStatusKey() : null;
  }, [group.branch, group.directory, group.isArchivedBucket, group.isMain, hideGroupLabel]);
  const groupPrSummary = usePrVisualSummary(groupPrKey);
  const groupPrColor = groupPrSummary ? `var(--pr-${groupPrSummary.visualState})` : undefined;

  const {
    bootstrapLoading,
    failedBootstrapDirectory,
    bootstrapFailure,
    canGrantBootstrapAccess,
    isRequestingBootstrapAccess,
    retryFailedBootstrap,
    grantFailedBootstrapAccess,
  } = useSessionGroupBootstrap({ group, isCollapsed });

  const maxVisible = hideDirectoryControls ? 10 : 5;
  const nonArchivedVisibleCount = Math.max(maxVisible, visibleSessionCount ?? maxVisible);
  const groupMatchesSearch = hasSessionSearchQuery ? searchData?.groupMatches === true : false;
  const shouldFilterGroupContents = hasSessionSearchQuery;
  const sourceGroupNodes = React.useMemo(
    () =>
      [...(shouldFilterGroupContents ? (searchData?.filteredNodes ?? []) : group.sessions)].sort(
        compareSessionNodes,
      ),
    [compareSessionNodes, group.sessions, searchData?.filteredNodes, shouldFilterGroupContents],
  );

  const collectGroupSessions = React.useCallback((nodes: SessionNode[]): Session[] => {
    const collected: Session[] = [];
    const visit = (list: SessionNode[]) => {
      list.forEach((node) => {
        collected.push(node.session);
        if (node.children.length > 0) visit(node.children);
      });
    };
    visit(nodes);
    return collected;
  }, []);

  const {
    folderScopeKey,
    folderScopes,
    allFoldersForGroup,
    rootFolders,
    ungroupedSessions,
    folderActivityStateById,
    folderSessionsForDeleteById,
  } = useSessionGroupFolders({
    group,
    sourceGroupNodes,
    hasSessionSearchQuery,
    normalizedSessionSearchQuery,
    compareSessionNodes,
    activeActivitySessionIds,
    unreadActivitySessionIds,
    notifyOnSubtasks,
    collectGroupSessions,
  });

  const renderContextForGroup = 'project' as const;
  const subtreeContainsEditing = React.useMemo(() => {
    const set = new Set<string>();
    collectSubtreeContainingId(sourceGroupNodes, editingId, set);
    allFoldersForGroup.forEach(({ nodes }) => {
      collectSubtreeContainingId(nodes, editingId, set);
    });
    return set;
  }, [sourceGroupNodes, allFoldersForGroup, editingId]);

  const menuOpenSessionId = React.useMemo(() => {
    if (!openSidebarMenuKey) return null;
    const fromSource = resolveMenuOpenSessionId(
      sourceGroupNodes,
      openSidebarMenuKey,
      renderContextForGroup,
      Boolean(group.isArchivedBucket),
    );
    if (fromSource) return fromSource;
    for (const { nodes } of allFoldersForGroup) {
      const id = resolveMenuOpenSessionId(
        nodes,
        openSidebarMenuKey,
        renderContextForGroup,
        Boolean(group.isArchivedBucket),
      );
      if (id) return id;
    }
    return null;
  }, [openSidebarMenuKey, sourceGroupNodes, allFoldersForGroup, group.isArchivedBucket]);

  const buildNodeStructureKeyByNode = React.useCallback((nodes: SessionNode[]): WeakMap<SessionNode, string> => {
    const map = new WeakMap<SessionNode, string>();
    const visit = (node: SessionNode): void => {
      map.set(node, computeNodeStructureKey(node));
      for (const child of node.children) {
        visit(child);
      }
    };
    nodes.forEach(visit);
    return map;
  }, []);

  const nodeStructureKeyBySourceNode = React.useMemo(
    () => buildNodeStructureKeyByNode(sourceGroupNodes),
    [buildNodeStructureKeyByNode, sourceGroupNodes],
  );
  const nodeStructureKeyByFolderNode = React.useMemo(() => {
    const map = new WeakMap<SessionNode, string>();
    allFoldersForGroup.forEach(({ nodes }) => {
      nodes.forEach((node) => map.set(node, computeNodeStructureKey(node)));
    });
    return map;
  }, [allFoldersForGroup]);

  const resolveNodeStructureKey = React.useCallback(
    (node: SessionNode): string => {
      return nodeStructureKeyBySourceNode.get(node) ?? nodeStructureKeyByFolderNode.get(node) ?? '';
    },
    [nodeStructureKeyBySourceNode, nodeStructureKeyByFolderNode],
  );

  const childRenderExtrasFor = React.useCallback(
    (child: SessionNode) => ({
      subtreeContainsEditing,
      menuOpenSessionId,
      nodeStructureKey: resolveNodeStructureKey(child),
    }),
    [subtreeContainsEditing, menuOpenSessionId, resolveNodeStructureKey],
  );

  const totalSessions = ungroupedSessions.length;
  const visibleSessions = group.isArchivedBucket
    ? ungroupedSessions
    : hasSessionSearchQuery
      ? ungroupedSessions
      : ungroupedSessions.slice(0, nonArchivedVisibleCount);
  const remainingCount = totalSessions - visibleSessions.length;
  const canShowLess = !group.isArchivedBucket && !hasSessionSearchQuery && totalSessions > maxVisible && remainingCount === 0;

  const shouldVirtualize =
    group.isArchivedBucket === true && !hasSessionSearchQuery && visibleSessions.length >= ARCHIVED_VIRTUALIZE_THRESHOLD;

  const bucketTag = group.isArchivedBucket ? 'archived' : 'active';
  const hasExpandedParent =
    shouldVirtualize &&
    visibleSessions.some((node) => {
      if (node.children.length === 0) return false;
      const expansionKey = `project:${bucketTag}:${node.session.id}`;
      return expandedParents.has(expansionKey);
    });

  const allGroupSessions = React.useMemo(
    () => collectGroupSessions(sourceGroupNodes),
    [collectGroupSessions, sourceGroupNodes],
  );

  if (hasSessionSearchQuery && !groupMatchesSearch && rootFolders.length === 0 && ungroupedSessions.length === 0) {
    return null;
  }

  const showBranchSubtitle = !group.isMain && Boolean(group.branch);
  const statusLine =
    group.branch && isBranchDifferentFromLabel(group.branch, group.label)
      ? { label: group.branch, color: null as string | null }
      : null;
  const groupActivityState = isCollapsed
    ? getSessionNodesActivityState(sourceGroupNodes, activeActivitySessionIds, unreadActivitySessionIds, notifyOnSubtasks)
    : null;
  const groupActivityIndicator = groupActivityState ? (
    <CollapsedActivityIndicator state={groupActivityState} activeLabel={'Session active'} unreadLabel={'Unread updates'} />
  ) : null;

  type FolderEntry = (typeof allFoldersForGroup)[number];

  const renderOneFolderItem = (entry: FolderEntry, displayName: string): React.ReactNode => {
    const { folder, scopeKey, scopeDirectory, nodes } = entry;
    const folderSessionsForDelete = folderSessionsForDeleteById.get(folder.id) ?? [];

    const isFolderCollapsed = hasSessionSearchQuery ? false : collapsedFolderIds.has(folder.id);
    return (
      <DroppableFolderWrapper key={folder.id} folderId={folder.id}>
        {(droppableRef, isDropTarget) => (
          <SessionFolderItem
            folder={folder}
            displayName={displayName}
            sessions={nodes}
            isCollapsed={isFolderCollapsed}
            collapsedActivityState={isFolderCollapsed ? (folderActivityStateById.get(folder.id) ?? null) : null}
            onToggle={() => toggleFolderCollapse(folder.id)}
            onRename={(name) => {
              renameFolder(scopeKey, folder.id, name);
            }}
            onDelete={() => {
              if (group.isArchivedBucket) {
                sessionEvents.requestDelete({
                  sessions: folderSessionsForDelete,
                  mode: 'session',
                });
                return;
              }
              if (!showDeletionDialog) {
                deleteFolder(scopeKey, folder.id);
                return;
              }
              const subFolderCount = allFoldersForGroup.filter(({ folder: f }) => f.parentId === folder.id).length;
              const sessionCount = nodes.length;
              setDeleteFolderConfirm({
                scopeKey,
                folderId: folder.id,
                folderName: folder.name,
                subFolderCount,
                sessionCount,
              });
            }}
            renderSessionNode={renderSessionNode}
            getRenderExtras={
              resolveNodeStructureKey
                ? (node) => ({
                    subtreeContainsEditing,
                    menuOpenSessionId,
                    nodeStructureKey: resolveNodeStructureKey(node),
                    childRenderExtrasFor,
                  })
                : undefined
            }
            groupDirectory={scopeDirectory ?? group.directory}
            projectId={projectId}
            mobileVariant={mobileVariant}
            alwaysShowActions={alwaysShowActions}
            isRenaming={renamingFolderId === folder.id}
            renameDraft={renamingFolderId === folder.id ? renameFolderDraft : undefined}
            onRenameDraftChange={(value) => setRenameFolderDraft(value)}
            onRenameSave={() => {
              const trimmed = renameFolderDraft.trim();
              if (trimmed) {
                renameFolder(scopeKey, folder.id, trimmed);
              }
              setRenamingFolderId(null);
              setRenameFolderDraft('');
            }}
            onRenameCancel={() => {
              setRenamingFolderId(null);
              setRenameFolderDraft('');
            }}
            droppableRef={droppableRef}
            isDropTarget={isDropTarget}
            depth={0}
            onNewSession={() => {
              if (projectId && projectId !== activeProjectId) setActiveProjectIdOnly(projectId);
              setActiveMainTab('chat');
              if (mobileVariant) setSessionSwitcherOpen(false);
              openNewSessionDraft({
                selectedProjectId: projectId,
                directoryOverride: scopeDirectory ?? group.directory,
                targetFolderId: folder.id,
              });
            }}
            hideActions={false}
            archivedBucket={group.isArchivedBucket === true}
          />
        )}
      </DroppableFolderWrapper>
    );
  };

  const renderFolderItems = () => {
    const childEntriesByParentId = new Map<string, FolderEntry[]>();
    for (const entry of allFoldersForGroup) {
      const parentId = entry.folder.parentId;
      if (!parentId) continue;
      const existing = childEntriesByParentId.get(parentId);
      if (existing) existing.push(entry);
      else childEntriesByParentId.set(parentId, [entry]);
    }
    const out: React.ReactNode[] = [];
    const visit = (entry: FolderEntry, parentPath: string) => {
      const displayName = parentPath ? `${parentPath} / ${entry.folder.name}` : entry.folder.name;
      out.push(renderOneFolderItem(entry, displayName));
      const isFolderCollapsed = !hasSessionSearchQuery && collapsedFolderIds.has(entry.folder.id);
      if (isFolderCollapsed) return;
      (childEntriesByParentId.get(entry.folder.id) ?? []).forEach((child) => visit(child, displayName));
    };
    rootFolders.forEach((entry) => visit(entry, ''));
    return out;
  };

  const groupHeaderRightPadding = alwaysShowActions
    ? 'pr-7'
    : 'pr-2 group-hover/gh:pr-7 group-focus-within/gh:pr-7';

  const bootstrapFailureNotice = failedBootstrapDirectory ? (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {bootstrapFailure === 'os-permission' ? 'Folder access is required.' : 'Could not refresh sessions.'}
      {canGrantBootstrapAccess ? (
        <Button
          variant="link"
          size="xs"
          className="h-auto p-0 typography-micro"
          disabled={isRequestingBootstrapAccess}
          onClick={() => void grantFailedBootstrapAccess()}
        >
          {'Grant access'}
        </Button>
      ) : null}
      <Button variant="link" size="xs" className="h-auto p-0 typography-micro" onClick={retryFailedBootstrap}>
        {'Try again'}
      </Button>
    </span>
  ) : null;

  const body = (
    <SessionFolderDndScope
      scopeKey={folderScopes[0]?.scopeKey ?? folderScopeKey}
      hasFolders={allFoldersForGroup.length > 0}
      onSessionDroppedOnFolder={(sessionId, folderId) => {
        const targetEntry = allFoldersForGroup.find(({ folder }) => folder.id === folderId);
        if (!targetEntry) return;
        const foldersStore = useSessionFoldersStore.getState();
        for (const { scopeKey } of folderScopes) {
          if (scopeKey === targetEntry.scopeKey) continue;
          if (foldersStore.getSessionFolderId(scopeKey, sessionId)) {
            foldersStore.removeSessionFromFolder(scopeKey, sessionId);
          }
        }
        addSessionToFolder(targetEntry.scopeKey, folderId, sessionId);
      }}
    >
      {renderFolderItems()}
      {group.isArchivedBucket ? (
        <VirtualArchivedSessionList
          visibleSessions={visibleSessions}
          shouldVirtualize={shouldVirtualize}
          hasExpandedParent={hasExpandedParent}
          scrollContainerRef={scrollContainerRef}
          groupDirectory={group.directory}
          projectId={projectId}
          isArchivedBucket={group.isArchivedBucket === true}
          renderSessionNode={renderSessionNode}
          getRenderExtras={(node) => ({
            subtreeContainsEditing,
            menuOpenSessionId,
            nodeStructureKey: resolveNodeStructureKey(node),
            childRenderExtrasFor,
          })}
        />
      ) : (
        visibleSessions.map((node) => (
          <React.Fragment key={node.session.id}>
            {renderSessionNode(node, 0, group.directory, projectId, group.isArchivedBucket === true, undefined, 'project', {
              subtreeContainsEditing,
              menuOpenSessionId,
              nodeStructureKey: resolveNodeStructureKey(node),
              childRenderExtrasFor,
            })}
          </React.Fragment>
        ))
      )}
      {totalSessions === 0 && allFoldersForGroup.length === 0 ? (
        group.isArchivedBucket ? (
          <div className="py-1 px-3 text-left typography-ui-label text-muted-foreground">
            {'No archived sessions yet.'}
          </div>
        ) : bootstrapLoading ? (
          <div className="py-1 px-3 text-left typography-ui-label text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Icon name="loader-4" className="size-4 animate-spin" />
              {'Loading sessions…'}
            </span>
          </div>
        ) : bootstrapFailureNotice ? (
          <div className="py-1 px-3 text-left typography-ui-label text-muted-foreground">
            {bootstrapFailureNotice}
          </div>
        ) : (
          <SidebarSessionLikeButton
            icon="chat-new"
            onClick={() => {
              openNewSessionDraft({
                selectedProjectId: projectId,
                directoryOverride: group.directory,
              });
            }}
          >
            {'New session'}
          </SidebarSessionLikeButton>
        )
      ) : null}
      {totalSessions > 0 && bootstrapFailureNotice ? (
        <div className="py-1 px-3 text-left typography-micro text-status-error">
          {bootstrapFailureNotice}
        </div>
      ) : null}
      {remainingCount > 0 ? (
        <SidebarSessionLikeButton
          icon="arrow-down-s"
          onClick={() => showMoreGroupSessions(groupKey, visibleSessions.length)}
        >
          {remainingCount === 1 ? 'Show 1 more session' : `Show ${remainingCount} more sessions`}
        </SidebarSessionLikeButton>
      ) : null}
      {canShowLess ? (
        <SidebarSessionLikeButton icon="arrow-up-s" onClick={() => resetGroupSessionLimit(groupKey)}>
          {'Show fewer sessions'}
        </SidebarSessionLikeButton>
      ) : null}
    </SessionFolderDndScope>
  );

  void compactBodyPadding;
  void createFolderAndStartRename;

  if (hideGroupLabel) {
    return (
      <div className="oc-group">
        <div className="oc-group-body">{body}</div>
      </div>
    );
  }

  return (
    <div className="oc-group">
      <SessionGroupHeader
        group={group}
        groupKey={groupKey}
        isCollapsed={isCollapsed}
        onToggleCollapsedGroup={onToggleCollapsedGroup}
        normalizedSessionSearchQuery={normalizedSessionSearchQuery}
        alwaysShowActions={alwaysShowActions}
        groupHeaderRightPadding={groupHeaderRightPadding}
        dragHandleProps={dragHandleProps}
        groupPrColor={groupPrColor}
        groupPrSummary={groupPrSummary}
        groupActivityIndicator={groupActivityIndicator}
        showBranchSubtitle={showBranchSubtitle}
        statusLine={statusLine}
        allGroupSessions={allGroupSessions}
        projectId={projectId}
        activeProjectId={activeProjectId}
        setActiveProjectIdOnly={setActiveProjectIdOnly}
        setActiveMainTab={setActiveMainTab}
        mobileVariant={mobileVariant}
        setSessionSwitcherOpen={setSessionSwitcherOpen}
        openNewSessionDraft={openNewSessionDraft}
      />
      {!isCollapsed ? <div className="oc-group-body">{body}</div> : null}
    </div>
  );
}

export const SessionGroupSection = React.memo(SessionGroupSectionBase, areGroupPropsEqual);
