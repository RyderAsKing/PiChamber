import React from 'react';
import { SessionFolderItem } from '../SessionFolderItem';
import { SessionShelfRowContext } from './sessionShelfRowContext';
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
import { getGitHubPrStatusKey, useEnsureGitHubPrStatus, usePrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { CollapsedActivityIndicator } from './collapsedActivityIndicator';
import { getSessionNodesActivityState } from './collapsedActivityState';
import { useSessionsNeedingInput } from '@/sync/sync-context';
import { SessionGroupHeader } from './SessionGroupHeader';
import type { SessionGroupSectionProps } from './sessionGroupTypes';
import { areGroupPropsEqual } from './sessionGroupComparators';
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
    sessionOrderIndex,
    editingId,
    openSidebarMenuKey,
    activeActivitySessionIds,
    unreadActivitySessionIds,
    onToggleCollapsedGroup,
    dragHandleProps,
    compactBodyPadding = false,
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

  const groupPrDirectory = !group.isMain && !hideGroupLabel
    ? normalizePath(group.directory ?? null)
    : null;
  const groupPrBranch = !group.isMain && !hideGroupLabel
    ? group.branch?.trim() || null
    : null;
  const groupPrKey = React.useMemo(() => {
    return groupPrDirectory && groupPrBranch ? getGitHubPrStatusKey(groupPrDirectory, groupPrBranch) : null;
  }, [groupPrDirectory, groupPrBranch]);
  const groupPrSummary = usePrVisualSummary(groupPrKey);
  useEnsureGitHubPrStatus(groupPrDirectory, groupPrBranch);
  const groupPrColor = groupPrSummary ? `var(--pr-${groupPrSummary.visualState})` : undefined;

  const shelvesActive = React.useContext(SessionShelfRowContext) !== null;
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

  // Sessions needing input, computed once per group render from the shared
  // needing list (reference-stable across unrelated catalog commits) rather
  // than once per row. Sidebar rows subscribe narrowly per session instead.
  const sessionsNeedingInput = useSessionsNeedingInput();
  const inputActivitySessionIds = React.useMemo(
    () => new Set(sessionsNeedingInput.map((entry) => entry.sessionId)),
    [sessionsNeedingInput],
  );

  const {
    folderScopeKey,
    folderScopes,
    allFoldersForGroup,
    rootFolders,
    ungroupedSessions,
    folderActivityStateById,
  } = useSessionGroupFolders({
    group,
    sourceGroupNodes,
    hasSessionSearchQuery,
    normalizedSessionSearchQuery,
    compareSessionNodes,
    activeActivitySessionIds,
    unreadActivitySessionIds,
    inputActivitySessionIds,
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
    );
    if (fromSource) return fromSource;
    for (const { nodes } of allFoldersForGroup) {
      const id = resolveMenuOpenSessionId(
        nodes,
        openSidebarMenuKey,
        renderContextForGroup,
      );
      if (id) return id;
    }
    return null;
  }, [openSidebarMenuKey, sourceGroupNodes, allFoldersForGroup]);

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
  // With shelves on, settled sessions already left the folder, so it lists
  // everything left instead of paging.
  const visibleSessions = shelvesActive
    ? ungroupedSessions
    : hasSessionSearchQuery
      ? ungroupedSessions
      : ungroupedSessions.slice(0, nonArchivedVisibleCount);
  const remainingCount = totalSessions - visibleSessions.length;
  const canShowLess = !shelvesActive && !hasSessionSearchQuery && totalSessions > maxVisible && remainingCount === 0;

  if (hasSessionSearchQuery && !groupMatchesSearch && rootFolders.length === 0 && ungroupedSessions.length === 0) {
    return null;
  }

  const showBranchSubtitle = !group.isMain && Boolean(group.branch);
  const statusLine =
    group.branch && isBranchDifferentFromLabel(group.branch, group.label)
      ? { label: group.branch, color: null as string | null }
      : null;
  const groupActivityState = isCollapsed
    ? getSessionNodesActivityState(sourceGroupNodes, activeActivitySessionIds, unreadActivitySessionIds, inputActivitySessionIds)
    : null;
  const groupActivityIndicator = groupActivityState ? (
    <CollapsedActivityIndicator state={groupActivityState} activeLabel={'Session active'} unreadLabel={'Unread updates'} inputLabel={'Needs input'} />
  ) : null;

  type FolderEntry = (typeof allFoldersForGroup)[number];

  const renderOneFolderItem = (entry: FolderEntry, displayName: string): React.ReactNode => {
    const { folder, scopeKey, scopeDirectory, nodes } = entry;

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
      {visibleSessions.map((node) => (
          <React.Fragment key={node.session.id}>
            {renderSessionNode(node, 0, group.directory, projectId, false, undefined, 'project', {
              subtreeContainsEditing,
              menuOpenSessionId,
              nodeStructureKey: resolveNodeStructureKey(node),
              childRenderExtrasFor,
            })}
          </React.Fragment>
        ))}
      {/* With shelves, a folder whose sessions are all snoozed
          shows only its header; the header keeps its new-session action. */}
      {totalSessions === 0 && allFoldersForGroup.length === 0 && !shelvesActive ? (
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
