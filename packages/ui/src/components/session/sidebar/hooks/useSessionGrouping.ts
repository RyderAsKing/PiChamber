import React from 'react';
import type { GitWorktree } from '@/lib/api/types';
import type { Session } from '@/lib/chat/types';
import type { SessionGroup, SessionNode } from '../types';
import {
  dedupeSessionsById,
  getArchivedScopeKey,
  normalizePath,
} from '../utils';
import { compareSessionsByLifecycleOrder } from '@/sync/session-ordering';
import { formatPathForDisplay } from '@/lib/utils';
import { getSessionDisplayTitle } from '@/lib/chat/sessionTitle';
import { getForkColorIdForSession } from '../forkColor';

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
    const sessionTitle = getSessionDisplayTitle(session);
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
      availableWorktrees: readonly GitWorktree[] = [],
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
        const parentSession = parentID ? sessionMap.get(parentID) : null;
        const validParentID = parentSession && isArchivedSession(parentSession) === isArchivedSession(session)
          ? parentID
          : null;
        parentById.set(session.id, validParentID);
        if (validParentID) {
          childrenCountById.set(validParentID, (childrenCountById.get(validParentID) ?? 0) + 1);
        }
      });
      const normalizedWorktrees = availableWorktrees
        .map((worktree) => ({ worktree, directory: normalizePath(worktree.path) }))
        .filter((entry): entry is { worktree: GitWorktree; directory: string } => Boolean(entry.directory) && !entry.worktree.isPrimary)
        .sort((left, right) => right.directory.length - left.directory.length);
      const containsDirectory = (root: string, candidate: string): boolean => (
        candidate === root || candidate.startsWith(`${root}/`)
      );
      const worktreeForSession = (session: Session): GitWorktree | null => {
        const directory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
        if (!directory) return null;
        return normalizedWorktrees.find((entry) => containsDirectory(entry.directory, directory))?.worktree ?? null;
      };
      const toFlatNode = (session: Session, worktree: GitWorktree | null): SessionNode => {
        const forkColorId = getForkColorIdForSession(session.id, parentById, childrenCountById);
        return { session, children: [], worktree, forkColorId };
      };

      const activeNodes: SessionNode[] = [];
      const activeNodesByWorktree = new Map<string, SessionNode[]>();
      const archivedNodes: SessionNode[] = [];
      for (const entry of normalizedWorktrees) activeNodesByWorktree.set(entry.directory, []);

      sortedProjectSessions.forEach((session) => {
        const worktree = worktreeForSession(session);
        const node = toFlatNode(session, worktree);
        if (session.time?.archived) {
          archivedNodes.push(node);
        } else if (worktree) {
          activeNodesByWorktree.get(normalizePath(worktree.path) ?? '')?.push(node);
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

      for (const { worktree, directory } of normalizedWorktrees) {
        groups.push({
          id: `worktree:${directory}`,
          label: worktree.branch || (worktree.detached ? 'Detached HEAD' : worktree.name),
          branch: worktree.branch,
          description: formatPathForDisplay(directory, args.homeDirectory),
          isMain: false,
          isArchivedBucket: false,
          worktree,
          directory,
          folderScopeKey: directory,
          sessions: activeNodesByWorktree.get(directory) ?? [],
        });
      }

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
