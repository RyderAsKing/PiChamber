/* eslint-disable */
import React from 'react';
import type { Session } from '@/lib/chat/types';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { sessionEvents } from '@/lib/sessionEvents';
import type { MainTab } from '@/stores/useUIStore';
import { SessionFolderItem } from '../SessionFolderItem';
import type { SortableDragHandleProps } from './sortableItems';
import { DroppableFolderWrapper, SessionFolderDndScope } from './sessionFolderDnd';
import type { GroupSearchData, SessionGroup, SessionNode } from './types';
import { isBranchDifferentFromLabel, normalizePath } from './utils';
import { renderHighlightedText } from './highlightedText';
import { SidebarSessionLikeButton } from './sidebarRowChrome';
import { compareSessionsByLifecycleOrder, EMPTY_SESSION_ORDER_RANKS } from '@/sync/session-ordering';
import {
  collectSubtreeContainingId,
  computeNodeStructureKey,
  nodeHasPinnedMembershipChange,
  nodeContainsSessionId,
  resolveMenuOpenSessionId,
  selectFolderRootNodes,
} from './sessionNodeItemUtils';
import type { SessionNodeRenderExtras } from './sessionNodeItemUtils';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { getGitHubPrStatusKey, usePrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { useChildStoreManager } from '@/sync/sync-context';
import { canRequestNativeDirectoryAccess, requestDirectoryAccess } from '@/lib/desktop';
import { CollapsedActivityIndicator } from './collapsedActivityIndicator';
import {
  getSessionNodesActivityState,
  mergeCollapsedActivityStates,
  type CollapsedActivityState,
} from './collapsedActivityState';
import {
  VirtualArchivedSessionList,
  ARCHIVED_VIRTUALIZE_THRESHOLD,
} from './VirtualArchivedSessionList';
import { SessionGroupHeader } from './SessionGroupHeader';

type DeleteFolderConfirm = {
  scopeKey: string;
  folderId: string;
  folderName: string;
  subFolderCount: number;
  sessionCount: number;
} | null;

type Props = {
  group: SessionGroup;
  groupKey: string;
  projectId?: string | null;
  hideGroupLabel?: boolean;
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  groupSearchDataByGroup: WeakMap<SessionGroup, GroupSearchData>;
  visibleSessionCount?: number;
  collapsedGroups: Set<string>;
  hideDirectoryControls: boolean;
  collapsedFolderIds: Set<string>;
  toggleFolderCollapse: (folderId: string) => void;
  renameFolder: (scopeKey: string, folderId: string, name: string) => void;
  deleteFolder: (scopeKey: string, folderId: string) => void;
  showDeletionDialog: boolean;
  setDeleteFolderConfirm: React.Dispatch<React.SetStateAction<DeleteFolderConfirm>>;
  renderSessionNode: (
    node: SessionNode,
    depth?: number,
    groupDirectory?: string | null,
    projectId?: string | null,
    archivedBucket?: boolean,
    secondaryMeta?: { projectLabel?: string | null; branchLabel?: string | null } | null,
    renderContext?: 'project' | 'recent',
    renderExtras?: SessionNodeRenderExtras,
  ) => React.ReactNode;
  showMoreGroupSessions: (groupKey: string, currentVisibleCount: number) => void;
  resetGroupSessionLimit: (groupKey: string) => void;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  activeProjectId: string | null;
  setActiveProjectIdOnly: (id: string) => void;
  setActiveMainTab: (tab: MainTab) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null; targetFolderId?: string }) => void;
  addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string) => void;
  createFolderAndStartRename: (scopeKey: string, parentId?: string | null) => { id: string } | null;
  renamingFolderId: string | null;
  renameFolderDraft: string;
  setRenameFolderDraft: React.Dispatch<React.SetStateAction<string>>;
  setRenamingFolderId: React.Dispatch<React.SetStateAction<string | null>>;
  pinnedSessionIds: Set<string>;
  expandedParents: Set<string>;
  sessionOrderIndex: Map<string, number>;
  editingId: string | null;
  editTitle: string;
  openSidebarMenuKey: string | null;
  activeActivitySessionIds: Set<string>;
  unreadActivitySessionIds: Set<string>;
  notifyOnSubtasks: boolean;
  onToggleCollapsedGroup: (groupKey: string) => void;
  dragHandleProps?: SortableDragHandleProps | null;
  compactBodyPadding?: boolean;
  /**
   * Optional scroll container ref threaded from the outer ScrollableOverlay.
   * When provided, the virtualization effect can resolve the scrolling
   * ancestor synchronously and skip the getComputedStyle walk on every
   * render of an expanded archived bucket.
   */
  scrollContainerRef?: React.RefObject<HTMLElement | null>;
};

const groupContainsSessionId = (group: SessionGroup, sessionId: string | null): boolean => {
  if (!sessionId) return false;
  return group.sessions.some((node) => nodeContainsSessionId(node, sessionId));
};

const groupHasPinnedMembershipChange = (
  group: SessionGroup,
  prevPinnedSessionIds: Set<string>,
  nextPinnedSessionIds: Set<string>,
): boolean => {
  return group.sessions.some((node) => nodeHasPinnedMembershipChange(
    node,
    node,
    prevPinnedSessionIds,
    nextPinnedSessionIds,
    group.directory,
    group.directory,
  ));
};

const groupHasSessionOrderChange = (
  group: SessionGroup,
  prevSessionOrderIndex: Map<string, number>,
  nextSessionOrderIndex: Map<string, number>,
): boolean => {
  const visit = (node: SessionNode): boolean => {
    const sessionId = node.session.id;
    if (prevSessionOrderIndex.get(sessionId) !== nextSessionOrderIndex.get(sessionId)) return true;
    return node.children.some(visit);
  };
  return group.sessions.some(visit);
};

const groupHasActivityMembershipChange = (
  group: SessionGroup,
  prevSessionIds: Set<string>,
  nextSessionIds: Set<string>,
): boolean => {
  const visit = (node: SessionNode): boolean => {
    if (prevSessionIds.has(node.session.id) !== nextSessionIds.has(node.session.id)) return true;
    return node.children.some(visit);
  };
  return group.sessions.some(visit);
};

const groupHasAnyActivityMembership = (group: SessionGroup, sessionIds: Set<string>): boolean => {
  const visit = (node: SessionNode): boolean => {
    if (sessionIds.has(node.session.id)) return true;
    return node.children.some(visit);
  };
  return group.sessions.some(visit);
};

const groupHasExpansionMembershipChange = (
  group: SessionGroup,
  prevExpandedParents: Set<string>,
  nextExpandedParents: Set<string>,
): boolean => {
  const bucketTag = group.isArchivedBucket ? 'archived' : 'active';
  const visit = (node: SessionNode): boolean => {
    const key = `project:${bucketTag}:${node.session.id}`;
    if (prevExpandedParents.has(key) !== nextExpandedParents.has(key)) return true;
    return node.children.some(visit);
  };
  return group.sessions.some(visit);
};

const areGroupPropsEqual = (prev: Props, next: Props): boolean => {
  // Bail on Object.is for the props that drive the most work: the group
  // itself, its key, and the group-level chrome. These change rarely and
  // any change should force a re-render of this group.
  if (prev.group !== next.group) return false;
  if (prev.groupKey !== next.groupKey) return false;
  if (prev.projectId !== next.projectId) return false;
  if (prev.hideGroupLabel !== next.hideGroupLabel) return false;
  if (prev.compactBodyPadding !== next.compactBodyPadding) return false;
  if (prev.groupSearchDataByGroup !== next.groupSearchDataByGroup) return false;
  if (prev.visibleSessionCount !== next.visibleSessionCount) return false;

  if (prev.collapsedGroups !== next.collapsedGroups
    && prev.collapsedGroups.has(prev.groupKey) !== next.collapsedGroups.has(next.groupKey)) {
    return false;
  }

  if (prev.pinnedSessionIds !== next.pinnedSessionIds
    && groupHasPinnedMembershipChange(next.group, prev.pinnedSessionIds, next.pinnedSessionIds)) {
    return false;
  }

  if (prev.expandedParents !== next.expandedParents
    && groupHasExpansionMembershipChange(next.group, prev.expandedParents, next.expandedParents)) {
    return false;
  }

  if (prev.sessionOrderIndex !== next.sessionOrderIndex
    && groupHasSessionOrderChange(next.group, prev.sessionOrderIndex, next.sessionOrderIndex)) {
    return false;
  }

  if (prev.editingId !== next.editingId
    && (groupContainsSessionId(prev.group, prev.editingId) || groupContainsSessionId(next.group, next.editingId))) {
    return false;
  }

  if (prev.editTitle !== next.editTitle
    && (groupContainsSessionId(prev.group, prev.editingId) || groupContainsSessionId(next.group, next.editingId))) {
    return false;
  }

  if (prev.openSidebarMenuKey !== next.openSidebarMenuKey) {
    const prevMenuSessionId = resolveMenuOpenSessionId(prev.group.sessions, prev.openSidebarMenuKey, 'project', Boolean(prev.group.isArchivedBucket));
    const nextMenuSessionId = resolveMenuOpenSessionId(next.group.sessions, next.openSidebarMenuKey, 'project', Boolean(next.group.isArchivedBucket));
    if (prevMenuSessionId || nextMenuSessionId) return false;
  }

  if (prev.activeActivitySessionIds !== next.activeActivitySessionIds
    && groupHasActivityMembershipChange(next.group, prev.activeActivitySessionIds, next.activeActivitySessionIds)) {
    return false;
  }

  if (prev.unreadActivitySessionIds !== next.unreadActivitySessionIds
    && groupHasActivityMembershipChange(next.group, prev.unreadActivitySessionIds, next.unreadActivitySessionIds)) {
    return false;
  }

  if (prev.notifyOnSubtasks !== next.notifyOnSubtasks
    && groupHasAnyActivityMembership(next.group, next.unreadActivitySessionIds)) {
    return false;
  }

  // Other props are typically stable references from the parent. Default
  // to reference equality (the cheap path) and only re-render when the
  // parent actually swapped something.
  return (
    prev.hasSessionSearchQuery === next.hasSessionSearchQuery
    && prev.normalizedSessionSearchQuery === next.normalizedSessionSearchQuery
    && prev.hideDirectoryControls === next.hideDirectoryControls
    && prev.collapsedFolderIds === next.collapsedFolderIds
    && prev.toggleFolderCollapse === next.toggleFolderCollapse
    && prev.renameFolder === next.renameFolder
    && prev.deleteFolder === next.deleteFolder
    && prev.showDeletionDialog === next.showDeletionDialog
    && prev.setDeleteFolderConfirm === next.setDeleteFolderConfirm
    && prev.renderSessionNode === next.renderSessionNode
    && prev.showMoreGroupSessions === next.showMoreGroupSessions
    && prev.resetGroupSessionLimit === next.resetGroupSessionLimit
    && prev.mobileVariant === next.mobileVariant
    && prev.alwaysShowActions === next.alwaysShowActions
    && prev.activeProjectId === next.activeProjectId
    && prev.setActiveProjectIdOnly === next.setActiveProjectIdOnly
    && prev.setActiveMainTab === next.setActiveMainTab
    && prev.setSessionSwitcherOpen === next.setSessionSwitcherOpen
    && prev.openNewSessionDraft === next.openNewSessionDraft
    && prev.addSessionToFolder === next.addSessionToFolder
    && prev.createFolderAndStartRename === next.createFolderAndStartRename
    && prev.renamingFolderId === next.renamingFolderId
    && prev.renameFolderDraft === next.renameFolderDraft
    && prev.setRenameFolderDraft === next.setRenameFolderDraft
    && prev.setRenamingFolderId === next.setRenamingFolderId
    && prev.onToggleCollapsedGroup === next.onToggleCollapsedGroup
    && prev.dragHandleProps === next.dragHandleProps
    && prev.scrollContainerRef === next.scrollContainerRef
  );
};

function SessionGroupSectionBase(props: Props): React.ReactNode {
  
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

  const compareSessionNodes = React.useCallback((a: SessionNode, b: SessionNode) => {
    const aIndex = sessionOrderIndex.get(a.session.id);
    const bIndex = sessionOrderIndex.get(b.session.id);
    if (aIndex !== undefined || bIndex !== undefined) {
      if (aIndex === undefined) return 1;
      if (bIndex === undefined) return -1;
      if (aIndex !== bIndex) return aIndex - bIndex;
    }
    return compareSessionsByLifecycleOrder(a.session, b.session, pinnedSessionIds, EMPTY_SESSION_ORDER_RANKS);
  }, [pinnedSessionIds, sessionOrderIndex]);

  const searchData = hasSessionSearchQuery ? groupSearchDataByGroup.get(group) : null;
  const foldersMap = useSessionFoldersStore((state) => state.foldersMap);
  const isCollapsed = hasSessionSearchQuery ? false : collapsedGroups.has(groupKey);
  // PR state for the worktree sub-header (grouped display mode).
  const groupPrKey = React.useMemo(() => {
    if (group.isMain || group.isArchivedBucket || hideGroupLabel) return null;
    const directory = normalizePath(group.directory ?? null);
    const branch = group.branch?.trim();
    return directory && branch ? getGitHubPrStatusKey() : null;
  }, [group.branch, group.directory, group.isArchivedBucket, group.isMain, hideGroupLabel]);
  const groupPrSummary = usePrVisualSummary(groupPrKey);
  const groupPrColor = groupPrSummary ? `var(--pr-${groupPrSummary.visualState})` : undefined;
  const childStores = useChildStoreManager();
  const bootstrapDirectories = React.useMemo(() => {
    const directories = group.folderScopes?.map((scope) => normalizePath(scope.directory))
      ?? [normalizePath(group.directory ?? null)];
    return [...new Set(directories.filter((directory): directory is string => Boolean(directory)))];
  }, [group.directory, group.folderScopes]);
  React.useSyncExternalStore(
    React.useCallback(
      (notify) => bootstrapDirectories.length > 0 ? childStores.subscribeBootstrap(notify) : () => undefined,
      [bootstrapDirectories.length, childStores],
    ),
    React.useCallback(
      () => bootstrapDirectories.map((directory) => (
        `${directory}\u0000${childStores.getBootstrapState(directory) ?? ''}\u0000${childStores.getBootstrapFailure(directory) ?? ''}`
      )).join('\u0001'),
      [bootstrapDirectories, childStores],
    ),
    React.useCallback(() => '', []),
  );
  const bootstrapLoading = bootstrapDirectories.some((directory) => {
    const state = childStores.getBootstrapState(directory) as string;
    return state === 'queued' || state === 'running';
  });
  const failedBootstrapDirectory = bootstrapDirectories.find(
    (directory) => (childStores.getBootstrapState(directory) as string) === 'failed',
  ) ?? null;
  const bootstrapFailure = failedBootstrapDirectory
    ? childStores.getBootstrapFailure(failedBootstrapDirectory)
    : undefined;
  const canGrantBootstrapAccess = bootstrapFailure === 'os-permission' && canRequestNativeDirectoryAccess();
  const [isRequestingBootstrapAccess, setIsRequestingBootstrapAccess] = React.useState(false);

  const retryFailedBootstrap = React.useCallback(() => {
    if (!failedBootstrapDirectory) return;
    childStores.requestBootstrap({
      directory: failedBootstrapDirectory,
      priority: isCollapsed ? 'visible' : 'expanded',
      reason: group.isMain ? 'project-expanded' : 'worktree-expanded',
      force: true,
    });
  }, [childStores, failedBootstrapDirectory, group.isMain, isCollapsed]);

  const grantFailedBootstrapAccess = React.useCallback(async () => {
    if (!failedBootstrapDirectory || !canGrantBootstrapAccess || isRequestingBootstrapAccess) return;
    setIsRequestingBootstrapAccess(true);
    try {
      const result = await requestDirectoryAccess(failedBootstrapDirectory);
      if (result.success) retryFailedBootstrap();
    } finally {
      setIsRequestingBootstrapAccess(false);
    }
  }, [canGrantBootstrapAccess, failedBootstrapDirectory, isRequestingBootstrapAccess, retryFailedBootstrap]);
  const maxVisible = hideDirectoryControls ? 10 : 5;
  const nonArchivedVisibleCount = Math.max(maxVisible, visibleSessionCount ?? maxVisible);
  const groupMatchesSearch = hasSessionSearchQuery ? searchData?.groupMatches === true : false;
  const shouldFilterGroupContents = hasSessionSearchQuery;
  const sourceGroupNodes = React.useMemo(
    () => [...(shouldFilterGroupContents ? (searchData?.filteredNodes ?? []) : group.sessions)]
      .sort(compareSessionNodes),
    [compareSessionNodes, group.sessions, searchData?.filteredNodes, shouldFilterGroupContents],
  );
  const folderScopeKey = group.folderScopeKey ?? normalizePath(group.directory ?? null);
  // Merged flat groups list every contributing scope; single-scope groups
  // (archived buckets, VS Code workspaces) fall back to folderScopeKey.
  const folderScopes = React.useMemo<Array<{ scopeKey: string; directory: string | null }>>(() => {
    if (group.folderScopes && group.folderScopes.length > 0) return group.folderScopes;
    return folderScopeKey ? [{ scopeKey: folderScopeKey, directory: group.directory ?? null }] : [];
  }, [folderScopeKey, group.directory, group.folderScopes]);
  const scopeFolders = React.useMemo(
    () => folderScopes.flatMap(({ scopeKey, directory }) =>
      (foldersMap[scopeKey] ?? []).map((folder) => ({ folder, scopeKey, scopeDirectory: directory }))),
    [folderScopes, foldersMap]
  );

  const nodeBySessionId = React.useMemo(() => {
    const map = new Map<string, SessionNode>();
    const collectNodeLookup = (nodes: SessionNode[]) => {
      nodes.forEach((node) => {
        map.set(node.session.id, node);
        if (node.children.length > 0) {
          collectNodeLookup(node.children);
        }
      });
    };
    collectNodeLookup(sourceGroupNodes);
    return map;
  }, [sourceGroupNodes]);

  const allFoldersForGroupBase = React.useMemo(() => scopeFolders.map(({ folder, scopeKey, scopeDirectory }) => {
    const nodes = selectFolderRootNodes(folder.sessionIds, nodeBySessionId).sort(compareSessionNodes);
    return { folder, scopeKey, scopeDirectory, nodes };
  }), [scopeFolders, nodeBySessionId, compareSessionNodes]);

  const allFoldersForGroup = React.useMemo(() => {
    const folderMapById = new Map(allFoldersForGroupBase.map((entry) => [entry.folder.id, entry]));
    const childFolderIdsByParentId = new Map<string, string[]>();
    for (const { folder } of allFoldersForGroupBase) {
      if (!folder.parentId) continue;
      const existing = childFolderIdsByParentId.get(folder.parentId);
      if (existing) {
        existing.push(folder.id);
      } else {
        childFolderIdsByParentId.set(folder.parentId, [folder.id]);
      }
    }

    const keepByFolderId = new Map<string, boolean>();
    const shouldKeepFolder = (folderId: string): boolean => {
      const cached = keepByFolderId.get(folderId);
      if (cached !== undefined) return cached;

      const entry = folderMapById.get(folderId);
      if (!entry) {
        keepByFolderId.set(folderId, false);
        return false;
      }

      const childFolderIds = childFolderIdsByParentId.get(folderId) ?? [];

      // For archived buckets, hide folders with no sessions unless descendants have content.
      if (group.isArchivedBucket && entry.nodes.length === 0) {
        const hasContentInChildren = childFolderIds.some((childId) => shouldKeepFolder(childId));
        keepByFolderId.set(folderId, hasContentInChildren);
        return hasContentInChildren;
      }

      if (!hasSessionSearchQuery) {
        keepByFolderId.set(folderId, true);
        return true;
      }

      const folderMatches = entry.folder.name.toLowerCase().includes(normalizedSessionSearchQuery);
      if (folderMatches || entry.nodes.length > 0) {
        keepByFolderId.set(folderId, true);
        return true;
      }

      const hasMatchingChildren = childFolderIds.some((childId) => shouldKeepFolder(childId));
      keepByFolderId.set(folderId, hasMatchingChildren);
      return hasMatchingChildren;
    };

    return allFoldersForGroupBase.filter(({ folder }) => shouldKeepFolder(folder.id));
  }, [allFoldersForGroupBase, group.isArchivedBucket, hasSessionSearchQuery, normalizedSessionSearchQuery]);

  const sessionIdsInFolders = React.useMemo(() => new Set(allFoldersForGroup.flatMap((f) => f.folder.sessionIds)), [allFoldersForGroup]);
  const ungroupedSessions = React.useMemo(() => sourceGroupNodes.filter((node) => !sessionIdsInFolders.has(node.session.id)), [sourceGroupNodes, sessionIdsInFolders]);
  const rootFolders = React.useMemo(() => allFoldersForGroup.filter(({ folder }) => !folder.parentId), [allFoldersForGroup]);
  const childFoldersByParentId = React.useMemo(() => {
    const map = new Map<string, typeof allFoldersForGroup>();
    allFoldersForGroup.forEach((entry) => {
      if (!entry.folder.parentId) return;
      const children = map.get(entry.folder.parentId) ?? [];
      children.push(entry);
      map.set(entry.folder.parentId, children);
    });
    return map;
  }, [allFoldersForGroup]);
  const folderActivityStateById = React.useMemo(() => {
    const foldersById = new Map(allFoldersForGroup.map((entry) => [entry.folder.id, entry] as const));
    const result = new Map<string, CollapsedActivityState>();
    const visit = (folderId: string, seen: Set<string>): CollapsedActivityState => {
      const cached = result.get(folderId);
      if (cached !== undefined) return cached;
      if (seen.has(folderId)) return null;
      seen.add(folderId);

      const entry = foldersById.get(folderId);
      let state = entry
        ? getSessionNodesActivityState(entry.nodes, activeActivitySessionIds, unreadActivitySessionIds, notifyOnSubtasks)
        : null;
      for (const child of childFoldersByParentId.get(folderId) ?? []) {
        state = mergeCollapsedActivityStates(state, visit(child.folder.id, seen));
        if (state === 'active') break;
      }
      result.set(folderId, state);
      return state;
    };

    allFoldersForGroup.forEach(({ folder }) => visit(folder.id, new Set()));
    return result;
  }, [activeActivitySessionIds, allFoldersForGroup, childFoldersByParentId, notifyOnSubtasks, unreadActivitySessionIds]);

  // Precompute the per-row "subtree contains editing session" lookup once per
  // render. The previous design walked the
  // node tree inside SessionNodeItem.areEqual for every row, which is O(M^2)
  // across the whole sidebar. These sets let areEqual answer with a single
  // Set.has lookup, so the cost is O(M) once per SessionGroupSection render.
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
    const fromSource = resolveMenuOpenSessionId(sourceGroupNodes, openSidebarMenuKey, renderContextForGroup, Boolean(group.isArchivedBucket));
    if (fromSource) return fromSource;
    for (const { nodes } of allFoldersForGroup) {
      const id = resolveMenuOpenSessionId(nodes, openSidebarMenuKey, renderContextForGroup, Boolean(group.isArchivedBucket));
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
  const nodeStructureKeyByFolderNode = React.useMemo(
    () => {
      const map = new WeakMap<SessionNode, string>();
      allFoldersForGroup.forEach(({ nodes }) => {
        nodes.forEach((node) => map.set(node, computeNodeStructureKey(node)));
      });
      return map;
    },
    [allFoldersForGroup],
  );

  const resolveNodeStructureKey = React.useCallback((node: SessionNode): string => {
    return nodeStructureKeyBySourceNode.get(node) ?? nodeStructureKeyByFolderNode.get(node) ?? '';
  }, [nodeStructureKeyBySourceNode, nodeStructureKeyByFolderNode]);

  const childRenderExtrasFor = React.useCallback((child: SessionNode) => ({
    subtreeContainsEditing,
    menuOpenSessionId,
    nodeStructureKey: resolveNodeStructureKey(child),
  }), [subtreeContainsEditing, menuOpenSessionId, resolveNodeStructureKey]);

  const totalSessions = ungroupedSessions.length;
  const visibleSessions = group.isArchivedBucket
    ? ungroupedSessions
    : hasSessionSearchQuery
      ? ungroupedSessions
      : ungroupedSessions.slice(0, nonArchivedVisibleCount);
  const remainingCount = totalSessions - visibleSessions.length;
  const canShowLess = !group.isArchivedBucket && !hasSessionSearchQuery && totalSessions > maxVisible && remainingCount === 0;

  // Virtualize archived buckets, which can grow into the thousands. Active
  // groups retain normal flow because their incremental Show more control and
  // the shared ancestor scroller cannot expose an unmounted virtual tail.
  // Hooks below MUST stay above the search-empty early-return so they fire in
  // the same order every render — rules-of-hooks.
  const shouldVirtualize = group.isArchivedBucket === true
    && !hasSessionSearchQuery
    && visibleSessions.length >= ARCHIVED_VIRTUALIZE_THRESHOLD;

  // Check if any parent node is expanded - expanded parents render their
  // children inline, making them much taller than the fixed estimate.
  // When expanded parents exist, increase bufferSize to cover the extra height.
  const bucketTag = group.isArchivedBucket ? 'archived' : 'active';
  const hasExpandedParent = shouldVirtualize && visibleSessions.some((node) => {
    if (node.children.length === 0) return false;
    const expansionKey = `project:${bucketTag}:${node.session.id}`;
    return expandedParents.has(expansionKey);
  });

  // Hooks below MUST stay above the search-empty early-return so they
  // fire in the same order every render — rules-of-hooks.
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

  // Flat list of all sessions in this group (including nested children).
  // Used by both the "delete all archived" button and the "delete worktree"
  // button. Memoize so the recursive flatten only runs when the underlying
  // source group nodes change, not on every render.
  const allGroupSessions = React.useMemo(
    () => collectGroupSessions(sourceGroupNodes),
    [collectGroupSessions, sourceGroupNodes],
  );

  // Precompute the per-folder "delete all sessions in folder" list once
  // per render. The previous design ran a recursive `collectFolderSessions`
  // walk inside each folder's render, which is O(F × (S + F)) per group
  // render. With F=50 folders and S=200 archived sessions this is
  // significant; the precompute makes it O(F + S) once.
  const folderSessionsForDeleteById = React.useMemo(() => {
    if (!group.isArchivedBucket) return new Map<string, Session[]>();
    const result = new Map<string, Session[]>();
    const childIdsByParentId = new Map<string, string[]>();
    for (const { folder } of allFoldersForGroup) {
      if (!folder.parentId) continue;
      const existing = childIdsByParentId.get(folder.parentId) ?? [];
      existing.push(folder.id);
      childIdsByParentId.set(folder.parentId, existing);
    }
    const visit = (targetFolderId: string, seen: Set<string>): Session[] => {
      if (seen.has(targetFolderId)) return [];
      seen.add(targetFolderId);
      const directEntry = allFoldersForGroup.find(({ folder: candidate }) => candidate.id === targetFolderId);
      const collected: Session[] = directEntry ? collectGroupSessions(directEntry.nodes) : [];
      const childIds = childIdsByParentId.get(targetFolderId) ?? [];
      for (const childId of childIds) {
        collected.push(...visit(childId, seen));
      }
      return collected;
    };
    for (const { folder } of allFoldersForGroup) {
      result.set(folder.id, visit(folder.id, new Set()));
    }
    return result;
  }, [allFoldersForGroup, collectGroupSessions, group.isArchivedBucket]);

  if (hasSessionSearchQuery && !groupMatchesSearch && rootFolders.length === 0 && ungroupedSessions.length === 0) {
    return null;
  }

  const showBranchSubtitle = !group.isMain && Boolean(group.branch);
  const statusLine = group.branch && isBranchDifferentFromLabel(group.branch, group.label)
    ? { label: group.branch, color: null as string | null }
    : null;
  const groupActivityState = isCollapsed
    ? getSessionNodesActivityState(sourceGroupNodes, activeActivitySessionIds, unreadActivitySessionIds, notifyOnSubtasks)
    : null;
  const groupActivityIndicator = groupActivityState ? (
    <CollapsedActivityIndicator
      state={groupActivityState}
      activeLabel={"Session active"}
      unreadLabel={"Unread updates"}
    />
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
                // Delete sessions in the folder
                // Empty folders are auto-hidden by useArchivedAutoFolders
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
            getRenderExtras={resolveNodeStructureKey
              ? (node) => ({
                subtreeContainsEditing,
                menuOpenSessionId,
                nodeStructureKey: resolveNodeStructureKey(node),
                childRenderExtrasFor,
              })
              : undefined}
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
              openNewSessionDraft({ selectedProjectId: projectId, directoryOverride: scopeDirectory ?? group.directory, targetFolderId: folder.id });
            }}
            hideActions={false}
            archivedBucket={group.isArchivedBucket === true}
          />
        )}
      </DroppableFolderWrapper>
    );
  };

  // Folders render flat: nested folders keep their data-model parent link but
  // display at the same level with a "Parent / Child" path label, so sessions
  // never gain extra indentation. Collapsing a folder hides its whole subtree.
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
      {bootstrapFailure === 'os-permission'
        ? "Folder access is required."
        : "Could not refresh sessions."}
      {canGrantBootstrapAccess ? (
        <Button
          variant="link"
          size="xs"
          className="h-auto p-0 typography-micro"
          disabled={isRequestingBootstrapAccess}
          onClick={() => void grantFailedBootstrapAccess()}
        >
          {"Grant access"}
        </Button>
      ) : null}
      <Button
        variant="link"
        size="xs"
        className="h-auto p-0 typography-micro"
        onClick={retryFailedBootstrap}
      >
        {"Try again"}
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
        // Clear membership in other scopes first — the store only dedupes
        // within one scope, and a session must live in a single folder.
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
        group.isArchivedBucket
          ? (
            <div className="py-1 px-3 text-left typography-ui-label text-muted-foreground">
              {"No archived sessions yet."}
            </div>
          )
          : bootstrapLoading
            ? (
              <div className="py-1 px-3 text-left typography-ui-label text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Icon name="loader-4" className="size-4 animate-spin" />
                  {"Loading sessions…"}
                </span>
              </div>
            )
            : bootstrapFailureNotice
              ? (
                <div className="py-1 px-3 text-left typography-ui-label text-muted-foreground">
                  {bootstrapFailureNotice}
                </div>
              )
              : (
                <SidebarSessionLikeButton
                  icon="chat-new"
                  onClick={() => {
                    openNewSessionDraft({
                      selectedProjectId: projectId,
                      directoryOverride: group.directory,
                    });
                  }}
                >
                  {"New session"}
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
          {remainingCount === 1 ? "Show 1 more session" : `Show ${remainingCount} more sessions`}
        </SidebarSessionLikeButton>
      ) : null}
      {canShowLess ? (
        <SidebarSessionLikeButton
          icon="arrow-up-s"
          onClick={() => resetGroupSessionLimit(groupKey)}
        >
          {"Show fewer sessions"}
        </SidebarSessionLikeButton>
      ) : null}
    </SessionFolderDndScope>
  );

  // Rows own their left gutter (aligned with the zone-header text), so the
  // group body adds no extra indentation. Keep top spacing identical between
  // All sessions and a single folder — session rows already use my-0.5.
  void compactBodyPadding;
  void createFolderAndStartRename;

  if (hideGroupLabel) {
    return <div className="oc-group"><div className="oc-group-body">{body}</div></div>;
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
