import React from 'react';
import type { Session } from '@/lib/chat/types';
import { useCatalogUiSessions } from '@/sync/sync-context';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { compareSessionsByLifecycleOrder, useSessionOrderingStore } from '@/sync/session-ordering';
import { useGitAllBranches } from '@/stores/useGitStore';
import type { SessionNode } from '../types';

const MAX_PARENT_SESSIONS = 50;

const normalize = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

const isPathWithinProject = (directory: string | null, projectPath: string | null): boolean => {
  const normDir = normalize(directory);
  const normProj = normalize(projectPath);
  if (!normDir || !normProj) return false;
  return normDir === normProj || normDir.startsWith(`${normProj}/`);
};

const formatProjectLabel = (project: { label?: string; path: string } | null): string | null => {
  if (!project) return null;
  const label = project.label?.trim();
  if (label) return label;
  const parts = project.path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? project.path;
};

export type SwitcherItem = {
  node: SessionNode;
  projectId: string | null;
  groupDirectory: string | null;
  secondaryMeta: {
    projectLabel: string | null;
    branchLabel: string | null;
  };
};

type SwitcherItemsOptions = {
  scopeProjectId?: string | null;
  maxParents?: number;
};

export const useSwitcherItems = (enabled: boolean, options: SwitcherItemsOptions = {}): SwitcherItem[] => {
  const { scopeProjectId = null, maxParents = MAX_PARENT_SESSIONS } = options;
  const activeSessions = useCatalogUiSessions({ archived: false });
  const projects = useProjectsStore((state) => state.projects);
  const pinnedSessionIds = useSessionPinnedStore((state) => state.ids);
  const sessionOrderRanks = useSessionOrderingStore((state) => state.rankById);
  const branchesByDirectory = useGitAllBranches();

  const normalizedProjects = React.useMemo(
    () => projects
      .map((project) => ({ ...project, normalizedPath: normalize(project.path) }))
      .filter((project) => project.normalizedPath),
    [projects],
  );

  const findProjectForDirectory = React.useCallback(
    (directory: string | null) => {
      if (!directory) return null;
      const matches = normalizedProjects
        .filter((project) => isPathWithinProject(directory, project.normalizedPath))
        .sort((a, b) => (b.normalizedPath?.length ?? 0) - (a.normalizedPath?.length ?? 0));
      return matches[0] ?? null;
    },
    [normalizedProjects],
  );

  const items = React.useMemo<SwitcherItem[]>(() => {
    if (!enabled) return [];

    const childrenByParent = new Map<string, Session[]>();
    for (const session of activeSessions) {
      const parentId = (session as Session & { parentID?: string | null }).parentID;
      if (!parentId) continue;
      if (session.time?.archived) continue;
      const bucket = childrenByParent.get(parentId);
      if (bucket) {
        bucket.push(session);
      } else {
        childrenByParent.set(parentId, [session]);
      }
    }
    childrenByParent.forEach((list) => {
      list.sort((a, b) => compareSessionsByLifecycleOrder(a, b, pinnedSessionIds, sessionOrderRanks));
    });

    const parents = activeSessions
      .filter((session) => !session.time?.archived)
      .filter((session) => !(session as Session & { parentID?: string | null }).parentID)
      .filter((session) => {
        if (!scopeProjectId) return true;
        const directory = resolveGlobalSessionDirectory(session);
        return findProjectForDirectory(directory)?.id === scopeProjectId;
      })
      .sort((a, b) => compareSessionsByLifecycleOrder(a, b, pinnedSessionIds, sessionOrderRanks))
      .slice(0, maxParents);

    const buildNode = (session: Session): SessionNode => {
      const childSessions = childrenByParent.get(session.id) ?? [];
      return {
        session,
        children: childSessions.map((child) => buildNode(child)),
      };
    };

    return parents.map((session) => {
      const directory = resolveGlobalSessionDirectory(session);
      const matchedProject = findProjectForDirectory(directory);
      const projectLabel = formatProjectLabel(matchedProject);
      const liveBranch = directory ? branchesByDirectory.get(directory) : undefined;
      const branchLabel = liveBranch ?? null;
      return {
        node: buildNode(session),
        projectId: matchedProject?.id ?? null,
        groupDirectory: directory,
        secondaryMeta: {
          projectLabel,
          branchLabel: branchLabel && branchLabel !== projectLabel ? branchLabel : null,
        },
      };
    });
  }, [activeSessions, branchesByDirectory, enabled, findProjectForDirectory, maxParents, pinnedSessionIds, scopeProjectId, sessionOrderRanks]);

  return items;
};
