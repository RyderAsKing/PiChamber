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
import { useI18n } from '@/lib/i18n';

type Args = {
  homeDirectory: string | null;
  pinnedSessionIds: Set<string>;
  sessionOrderRanks: ReadonlyMap<string, number>;
  gitBranches: Map<string, string | null>;
};

const isArchivedSession = (session: Session): boolean => Boolean(session.time?.archived);

export const useSessionGrouping = (args: Args) => {
  const { t } = useI18n();
  const buildGroupSearchText = React.useCallback((group: SessionGroup): string => {
    return [group.label, group.branch ?? '', group.description ?? '', group.directory ?? ''].join(' ').toLowerCase();
  }, []);

  const buildSessionSearchText = React.useCallback((session: Session): string => {
    const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null) ?? '';
    const sessionTitle = (session.title || t('sessions.sidebar.session.untitled')).trim();
    return `${sessionTitle} ${sessionDirectory}`.toLowerCase();
  }, [t]);

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
      const childrenMap = new Map<string, Session[]>();
      sortedProjectSessions.forEach((session) => {
        const parentID = (session as Session & { parentID?: string | null }).parentID;
        if (!parentID) return;
        const parentSession = sessionMap.get(parentID);
        if (!parentSession || isArchivedSession(parentSession) !== isArchivedSession(session)) {
          return;
        }
        const collection = childrenMap.get(parentID) ?? [];
        collection.push(session);
        childrenMap.set(parentID, collection);
      });
      childrenMap.forEach((list) => list.sort((a, b) => compareSessionsByLifecycleOrder(a, b, args.pinnedSessionIds, args.sessionOrderRanks)));

      const buildProjectNode = (session: Session): SessionNode => {
        const children = childrenMap.get(session.id) ?? [];
        return { session, children: children.map((child) => buildProjectNode(child)), worktree: null };
      };

      const roots = sortedProjectSessions.filter((session) => {
        const parentID = (session as Session & { parentID?: string | null }).parentID;
        if (!parentID) return true;
        const parentSession = sessionMap.get(parentID);
        if (!parentSession) return true;
        return isArchivedSession(parentSession) !== isArchivedSession(session);
      });

      const activeNodes: SessionNode[] = [];
      const archivedNodes: SessionNode[] = [];

      roots.forEach((session) => {
        const node = buildProjectNode(session);
        if (session.time?.archived) {
          archivedNodes.push(node);
        } else {
          activeNodes.push(node);
        }
      });

      const groups: SessionGroup[] = [{
        id: 'root',
        label: (projectIsRepo && projectRootBranch && projectRootBranch !== 'HEAD')
          ? t('sessions.sidebar.grouping.projectRootWithBranch', { branch: projectRootBranch })
          : t('sessions.sidebar.grouping.projectRoot'),
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
          label: t('sessions.sidebar.grouping.archived'),
          branch: null,
          description: t('sessions.sidebar.grouping.archivedDescription'),
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
    [args.homeDirectory, args.pinnedSessionIds, args.sessionOrderRanks, t],
  );

  return {
    buildGroupSearchText,
    buildSessionSearchText,
    filterSessionNodesForSearch,
    buildGroupedSessions,
  };
};
