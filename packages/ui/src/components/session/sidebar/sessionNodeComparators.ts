import type { Session } from '@/lib/chat/types';
import type { SessionNode } from './types';
import { nodeContainsSessionId, nodeHasPinnedMembershipChange } from './sessionNodeItemUtils';
import { normalizePath } from './utils';
import type { SecondaryMeta, SessionNodeItemProps } from './sessionNodeTypes';

export const getNodeSessionDirectory = (node: SessionNode): string | null => {
  return normalizePath((node.session as Session & { directory?: string | null }).directory ?? null);
};

export const isSecondaryMetaEqual = (prev?: SecondaryMeta | null, next?: SecondaryMeta | null): boolean => {
  return (
    (prev?.projectLabel ?? null) === (next?.projectLabel ?? null) &&
    (prev?.branchLabel ?? null) === (next?.branchLabel ?? null) &&
    (prev?.showFolderLabel ?? false) === (next?.showFolderLabel ?? false)
  );
};

export const getMenuSessionIdFromKey = (props: SessionNodeItemProps): string | null => {
  if (!props.openSidebarMenuKey) return null;
  const bucketTag = props.archivedBucket ? 'archived' : 'active';
  const prefix = `${props.renderContext ?? 'project'}:${bucketTag}:`;
  return props.openSidebarMenuKey.startsWith(prefix) ? props.openSidebarMenuKey.slice(prefix.length) : null;
};

export const getRelevantMenuSessionId = (props: SessionNodeItemProps): string | null => {
  return props.menuOpenSessionId ?? getMenuSessionIdFromKey(props);
};

export const subtreeContainsSession = (
  props: SessionNodeItemProps,
  sessionId: string | null,
  precomputed: Set<string>,
): boolean => {
  if (!sessionId) return false;
  if (precomputed.has(props.node.session.id)) return true;
  return nodeContainsSessionId(props.node, sessionId);
};

export const hasSetMembershipChangeInNode = (
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

export const hasExpansionMembershipChange = (prev: SessionNodeItemProps, next: SessionNodeItemProps): boolean => {
  if (prev.hasSessionSearchQuery || next.hasSessionSearchQuery) return false;
  const prevBucketTag = prev.archivedBucket ? 'archived' : 'active';
  const nextBucketTag = next.archivedBucket ? 'archived' : 'active';
  return (
    hasSetMembershipChangeInNode(
      prev.node,
      next.node,
      prev.expandedParents,
      next.expandedParents,
      (node) => `${prev.renderContext ?? 'project'}:${prevBucketTag}:${node.session.id}`,
    ) ||
    hasSetMembershipChangeInNode(
      prev.node,
      next.node,
      prev.expandedParents,
      next.expandedParents,
      (node) => `${next.renderContext ?? 'project'}:${nextBucketTag}:${node.session.id}`,
    )
  );
};

export const areSessionNodeItemPropsEqual = (prev: SessionNodeItemProps, next: SessionNodeItemProps): boolean => {
  if (prev.node.session.id !== next.node.session.id) return false;
  if (prev.node.session !== next.node.session) return false;
  if (prev.depth !== next.depth) return false;
  if (prev.groupDirectory !== next.groupDirectory) return false;
  if (prev.projectId !== next.projectId) return false;
  if (prev.archivedBucket !== next.archivedBucket) return false;
  if ((prev.renderContext ?? 'project') !== (next.renderContext ?? 'project')) return false;
  if (prev.mobileVariant !== next.mobileVariant) return false;
  if (prev.alwaysShowActions !== next.alwaysShowActions) return false;
  if (prev.allowQuickArchiveAction !== next.allowQuickArchiveAction) return false;
  if (prev.hasSessionSearchQuery !== next.hasSessionSearchQuery) return false;
  if (prev.normalizedSessionSearchQuery !== next.normalizedSessionSearchQuery) return false;
  if (prev.notifyOnSubtasks !== next.notifyOnSubtasks) return false;
  if (prev.nodeStructureKey !== next.nodeStructureKey) return false;
  if (getNodeSessionDirectory(prev.node) !== getNodeSessionDirectory(next.node)) return false;
  if (!isSecondaryMetaEqual(prev.secondaryMeta, next.secondaryMeta)) return false;

  if (
    prev.pinnedSessionIds !== next.pinnedSessionIds &&
    nodeHasPinnedMembershipChange(
      prev.node,
      next.node,
      prev.pinnedSessionIds,
      next.pinnedSessionIds,
      prev.groupDirectory,
      next.groupDirectory,
    )
  ) {
    return false;
  }

  if (prev.expandedParents !== next.expandedParents && hasExpansionMembershipChange(prev, next)) {
    return false;
  }

  if (
    prev.editingId !== next.editingId &&
    (subtreeContainsSession(prev, prev.editingId, prev.subtreeContainsEditing) ||
      subtreeContainsSession(next, next.editingId, next.subtreeContainsEditing))
  ) {
    return false;
  }

  if (
    prev.editTitle !== next.editTitle &&
    (subtreeContainsSession(prev, prev.editingId, prev.subtreeContainsEditing) ||
      subtreeContainsSession(next, next.editingId, next.subtreeContainsEditing))
  ) {
    return false;
  }

  if (
    prev.copiedSessionId !== next.copiedSessionId &&
    (nodeContainsSessionId(prev.node, prev.copiedSessionId) ||
      nodeContainsSessionId(next.node, next.copiedSessionId))
  ) {
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

  return (
    prev.setEditingId === next.setEditingId &&
    prev.setEditTitle === next.setEditTitle &&
    prev.handleSaveEdit === next.handleSaveEdit &&
    prev.handleCancelEdit === next.handleCancelEdit &&
    prev.toggleParent === next.toggleParent &&
    prev.handleSessionSelect === next.handleSessionSelect &&
    prev.handleSessionDoubleClick === next.handleSessionDoubleClick &&
    prev.togglePinnedSession === next.togglePinnedSession &&
    prev.handleShareSession === next.handleShareSession &&
    prev.handleCopyShareUrl === next.handleCopyShareUrl &&
    prev.handleCopySessionId === next.handleCopySessionId &&
    prev.handleUnshareSession === next.handleUnshareSession &&
    prev.setOpenSidebarMenuKey === next.setOpenSidebarMenuKey &&
    prev.getFoldersForScope === next.getFoldersForScope &&
    prev.getSessionFolderId === next.getSessionFolderId &&
    prev.removeSessionFromFolder === next.removeSessionFromFolder &&
    prev.addSessionToFolder === next.addSessionToFolder &&
    prev.createFolderAndStartRename === next.createFolderAndStartRename &&
    prev.handleDeleteSession === next.handleDeleteSession &&
    prev.handleRestoreSession === next.handleRestoreSession &&
    prev.renderSessionNode === next.renderSessionNode
  );
};
