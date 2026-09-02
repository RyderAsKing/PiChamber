import React from 'react';
import type { Session } from '@/lib/chat/types';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { selectFolderRootNodes } from './sessionNodeItemUtils';
import {
  getSessionNodesActivityState,
  mergeCollapsedActivityStates,
  type CollapsedActivityState,
} from './collapsedActivityState';
import { normalizePath } from './utils';
import type { SessionGroup, SessionNode } from './types';

export function useSessionGroupFolders({
  group,
  sourceGroupNodes,
  hasSessionSearchQuery,
  normalizedSessionSearchQuery,
  compareSessionNodes,
  activeActivitySessionIds,
  unreadActivitySessionIds,
  notifyOnSubtasks,
  collectGroupSessions,
}: {
  group: SessionGroup;
  sourceGroupNodes: SessionNode[];
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  compareSessionNodes: (a: SessionNode, b: SessionNode) => number;
  activeActivitySessionIds: Set<string>;
  unreadActivitySessionIds: Set<string>;
  notifyOnSubtasks: boolean;
  collectGroupSessions: (nodes: SessionNode[]) => Session[];
}) {
  const foldersMap = useSessionFoldersStore((state) => state.foldersMap);

  const folderScopeKey = group.folderScopeKey ?? normalizePath(group.directory ?? null);
  const folderScopes = React.useMemo<Array<{ scopeKey: string; directory: string | null }>>(() => {
    if (group.folderScopes && group.folderScopes.length > 0) return group.folderScopes;
    return folderScopeKey ? [{ scopeKey: folderScopeKey, directory: group.directory ?? null }] : [];
  }, [folderScopeKey, group.directory, group.folderScopes]);

  const scopeFolders = React.useMemo(
    () =>
      folderScopes.flatMap(({ scopeKey, directory }) =>
        (foldersMap[scopeKey] ?? []).map((folder) => ({ folder, scopeKey, scopeDirectory: directory })),
      ),
    [folderScopes, foldersMap],
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

  const allFoldersForGroupBase = React.useMemo(
    () =>
      scopeFolders.map(({ folder, scopeKey, scopeDirectory }) => {
        const nodes = selectFolderRootNodes(folder.sessionIds, nodeBySessionId).sort(compareSessionNodes);
        return { folder, scopeKey, scopeDirectory, nodes };
      }),
    [scopeFolders, nodeBySessionId, compareSessionNodes],
  );

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

  const sessionIdsInFolders = React.useMemo(
    () => new Set(allFoldersForGroup.flatMap((f) => f.folder.sessionIds)),
    [allFoldersForGroup],
  );

  const ungroupedSessions = React.useMemo(
    () => sourceGroupNodes.filter((node) => !sessionIdsInFolders.has(node.session.id)),
    [sourceGroupNodes, sessionIdsInFolders],
  );

  const rootFolders = React.useMemo(
    () => allFoldersForGroup.filter(({ folder }) => !folder.parentId),
    [allFoldersForGroup],
  );

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

  return {
    folderScopeKey,
    folderScopes,
    allFoldersForGroup,
    rootFolders,
    ungroupedSessions,
    folderActivityStateById,
    folderSessionsForDeleteById,
  };
}
