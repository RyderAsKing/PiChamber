import React from 'react';
import type { Session } from '@/lib/chat/types';
import type { SessionGroup, SessionNode } from '../types';
import {
  dedupeSessionsById,
  getArchivedScopeKey,
  normalizePath,
} from '../utils';
import { compareSessionsByLifecycleOrder } from '@/sync/session-ordering';
import { formatPathForDisplay } from '@/lib/utils';

type Args = {
  homeDirectory: string | null;
  pinnedSessionIds: Set<string>;
  sessionOrderRanks: ReadonlyMap<string, number>;
  gitBranches: Map<string, string | null>;
};

const isArchivedSession = (session: Session): boolean => Boolean(session.time?.archived);

export const useSessionGrouping = (args: Args) => {
  const buildGroupSearchText = React.useCallback((group: SessionGroup): string => {
    return [group.label, group.branch ?? '', group.description ?? '', group.directory ?? ''].join(' ').toLowerCase();
  }, []);

  const buildSessionSearchText = React.useCallback((session: Session): string => {
    const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null) ?? '';
    const sessionTitle = (session.title || "Untitled Session").trim();
    return `${sessionTitle} ${sessionDirectory}`.toLowerCase();
  }, []);

  const filterSessionNodesForSearch = React.useCallback(
    (nodes: SessionNode[], query: string): SessionNode[] => {
      if (!query) {
        return nodes;
      }

      return nodes.flatMap((node) => {
        const nodeMatches = buildSessionSearchText(node.session).includes(query);
        if (nodeMatches) {
          return [node];
        }

        const filteredChildren = filterSessionNodesForSearch(node.children, query);
        if (filteredChildren.length === 0) {
          return [];
        }

        return [{ ...node, children: filteredChildren }];
      });
    },
    [buildSessionSearchText],
  );

  const buildGroupedSessions = React.useCallback(
    (
      projectSessions: Session[],
      projectRoot: string,
      _availableWorktrees?: unknown,
      projectRootBranch?: string | null,
      projectIsRepo?: boolean,
    ) => {
      const normalizedProjectRoot = normalizePath(projectRoot ?? null);
      const sortedProjectSessions = dedupeSessionsById(projectSessions)
        .sort((a, b) => compareSessionsByLifecycleOrder(a, b, args.pinnedSessionIds, args.sessionOrderRanks));

      const sessionMap = new Map(sortedProjectSessions.map((session) => [session.id, session]));
      const parentById = new Map<string, string | null>();
      const childrenCountById = new Map<string, number>();
      sortedProjectSessions.forEach((session) => {
        const parentID = (session as Session & { parentID?: string | null }).parentID ?? null;
        parentById.set(session.id, parentID);
        if (parentID) {
          const parentSession = sessionMap.get(parentID);
          if (parentSession && isArchivedSession(parentSession) === isArchivedSession(session)) {
            childrenCountById.set(parentID, (childrenCountById.get(parentID) ?? 0) + 1);
          }
        }
      });
      const getFamilyId = (sessionId: string): string | null => {
        let current: string | null | undefined = sessionId;
        const visited = new Set<string>();
        let root: string | null = null;
        while (current) {
          if (visited.has(current)) break;
          visited.add(current);
          const parentIdForCurrent: string | null = parentById.get(current) ?? null;
          if (!parentIdForCurrent) {
            root = current;
            break;
          }
          const parentSession = sessionMap.get(parentIdForCurrent);
          const currentSession = sessionMap.get(current);
          if (!parentSession || !currentSession || isArchivedSession(parentSession) !== isArchivedSession(currentSession)) {
            root = current;
            break;
          }
          current = parentIdForCurrent;
        }
        return root;
      };
      const toFlatNode = (session: Session): SessionNode => {
        const parentID = (session as Session & { parentID?: string | null }).parentID ?? null;
        const hasParent = Boolean(parentID && sessionMap.has(parentID) && isArchivedSession(sessionMap.get(parentID)!) === isArchivedSession(session));
        const hasChildren = (childrenCountById.get(session.id) ?? 0) > 0;
        const participates = hasParent || hasChildren;
        const familyId = participates ? getFamilyId(session.id) : null;
        return { session, children: [], worktree: null, forkFamilyId: familyId };
      };

      const activeNodes: SessionNode[] = [];
      const archivedNodes: SessionNode[] = [];

      sortedProjectSessions.forEach((session) => {
        const node = toFlatNode(session);
        if (session.time?.archived) {
          archivedNodes.push(node);
        } else {
          activeNodes.push(node);
        }
      });

      const groups: SessionGroup[] = [{
        id: 'root',
        label: (projectIsRepo && projectRootBranch && projectRootBranch !== 'HEAD')
          ? `project root: ${projectRootBranch}`
          : "project root",
        branch: projectRootBranch ?? null,
        description: normalizedProjectRoot ? formatPathForDisplay(normalizedProjectRoot, args.homeDirectory) : null,
        isMain: true,
        isArchivedBucket: false,
        worktree: null,
        directory: normalizedProjectRoot,
        folderScopeKey: normalizedProjectRoot,
        sessions: activeNodes,
      }];

      if (archivedNodes.length > 0) {
        groups.push({
          id: 'archived',
          label: "archived",
          branch: null,
          description: "Archived and unassigned sessions",
          isMain: false,
          isArchivedBucket: true,
          worktree: null,
          directory: null,
          folderScopeKey: normalizedProjectRoot ? getArchivedScopeKey(normalizedProjectRoot) : null,
          sessions: archivedNodes,
        });
      }

      return groups;
    },
    [args.homeDirectory, args.pinnedSessionIds, args.sessionOrderRanks],
  );

  return {
    buildGroupSearchText,
    buildSessionSearchText,
    filterSessionNodesForSearch,
    buildGroupedSessions,
  };
};
