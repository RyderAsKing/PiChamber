import type { SessionGroup, SessionNode } from './types';
import {
  nodeContainsSessionId,
  nodeHasPinnedMembershipChange,
  resolveMenuOpenSessionId,
} from './sessionNodeItemUtils';
import type { SessionGroupSectionProps } from './sessionGroupTypes';

export const groupContainsSessionId = (group: SessionGroup, sessionId: string | null): boolean => {
  if (!sessionId) return false;
  return group.sessions.some((node) => nodeContainsSessionId(node, sessionId));
};

export const groupHasPinnedMembershipChange = (
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

export const groupHasSessionOrderChange = (
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

export const groupHasActivityMembershipChange = (
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

export const groupHasAnyActivityMembership = (group: SessionGroup, sessionIds: Set<string>): boolean => {
  const visit = (node: SessionNode): boolean => {
    if (sessionIds.has(node.session.id)) return true;
    return node.children.some(visit);
  };
  return group.sessions.some(visit);
};

export const groupHasExpansionMembershipChange = (
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

export const areGroupPropsEqual = (
  prev: SessionGroupSectionProps,
  next: SessionGroupSectionProps,
): boolean => {
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
