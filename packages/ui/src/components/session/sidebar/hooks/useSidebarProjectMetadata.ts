import React from 'react';

import { formatDirectoryName } from '@/lib/utils';
import type { SessionNode } from '../types';
import { formatProjectLabel, normalizePath } from '../utils';
import type { ProjectSection } from './useSessionSidebarSections';

export const deriveTotalSessionCount = (projectSections: ProjectSection[]): number => {
  let count = 0;
  for (const section of projectSections) {
    for (const group of section.groups) {
      if (!group.isArchivedBucket) {
        count += group.sessions.length;
      }
    }
  }
  return count;
};

export const deriveSessionCountByProject = (
  projectSections: ProjectSection[]
): Map<string, number> => {
  const map = new Map<string, number>();
  for (const section of projectSections) {
    let count = 0;
    for (const group of section.groups) {
      if (!group.isArchivedBucket) {
        count += group.sessions.length;
      }
    }
    map.set(section.project.id, count);
  }
  return map;
};

export const hasActiveSessionInProject = (
  section: ProjectSection,
  activeSessionIdSet: ReadonlySet<string>
): boolean => {
  return section.groups.some((group) => {
    if (group.isArchivedBucket) return false;
    return group.sessions.some((node) => activeSessionIdSet.has(node.session.id));
  });
};

export const hasUnseenInProject = (
  section: ProjectSection,
  unreadSessionIdSet: ReadonlySet<string>
): boolean => {
  return section.groups.some((group) => {
    if (group.isArchivedBucket) return false;
    return group.sessions.some((node) => unreadSessionIdSet.has(node.session.id));
  });
};

export const deriveActiveDirectoriesByProject = (
  projectSections: ProjectSection[],
  activeSessionIdSet: ReadonlySet<string>
): ReadonlyMap<string, ReadonlySet<string>> => {
  const map = new Map<string, Set<string>>();
  for (const section of projectSections) {
    const dirs = new Set<string>();
    for (const group of section.groups) {
      if (group.isArchivedBucket) continue;
      const hasActive = group.sessions.some((node) =>
        activeSessionIdSet.has(node.session.id)
      );
      if (hasActive && group.directory) {
        const normalized = normalizePath(group.directory)?.toLowerCase();
        if (normalized) dirs.add(normalized);
      }
    }
    if (dirs.size > 0) map.set(section.project.id, dirs);
  }
  return map as ReadonlyMap<string, ReadonlySet<string>>;
};

export const deriveSectionsForSidebarRender = (
  flatSectionsForRender: ProjectSection[]
): ProjectSection[] => {
  return flatSectionsForRender.map((section) =>
    section.groups.some((group) => group.isArchivedBucket)
      ? {
          ...section,
          groups: section.groups.filter((group) => !group.isArchivedBucket),
        }
      : section
  );
};

export const deriveFilteredSectionsForSidebarRender = (
  sectionsForRender: ProjectSection[],
  sectionsForSidebarRender: ProjectSection[],
  selectedSpaceId: string | null,
  selectedWorktreePath: string | null
): ProjectSection[] => {
  if (!selectedSpaceId) return sectionsForSidebarRender;
  const section = sectionsForRender.find(
    (candidate) => candidate.project.id === selectedSpaceId
  );
  if (!section) return [];
  const targetDirectory = normalizePath(
    selectedWorktreePath ?? section.project.normalizedPath
  );
  const selectedGroup = section.groups.find(
    (group) =>
      !group.isArchivedBucket && normalizePath(group.directory) === targetDirectory
  );
  return selectedGroup ? [{ ...section, groups: [selectedGroup] }] : [];
};

export const deriveSessionSidebarMetaById = (
  projectSections: ProjectSection[],
  homeDirectory: string | null
) => {
  const meta = new Map<
    string,
    {
      node: SessionNode;
      projectId: string | null;
      groupDirectory: string | null;
      secondaryMeta: {
        projectLabel?: string | null;
        branchLabel?: string | null;
      } | null;
    }
  >();
  const projectPathLengthBySessionId = new Map<string, number>();

  projectSections.forEach((section) => {
    const projectLabel = formatProjectLabel(
      section.project.label?.trim() ||
        formatDirectoryName(section.project.normalizedPath, homeDirectory) ||
        section.project.normalizedPath
    );
    section.groups.forEach((group) => {
      const branchCandidate =
        group.branch && group.branch !== 'HEAD' && group.branch !== projectLabel
          ? group.branch
          : null;
      const secondaryMeta = { projectLabel, branchLabel: branchCandidate };

      const visit = (nodes: SessionNode[]) => {
        nodes.forEach((node) => {
          const nextProjectPathLength = section.project.normalizedPath.length;
          const currentProjectPathLength =
            projectPathLengthBySessionId.get(node.session.id) ?? -1;
          if (nextProjectPathLength < currentProjectPathLength) {
            return;
          }

          meta.set(node.session.id, {
            node,
            projectId: section.project.id,
            groupDirectory: group.directory,
            secondaryMeta,
          });
          projectPathLengthBySessionId.set(node.session.id, nextProjectPathLength);
          if (node.children.length > 0) {
            visit(node.children);
          }
        });
      };

      visit(group.sessions);
    });
  });

  return meta;
};

export interface UseSidebarProjectMetadataParams {
  projectSections: ProjectSection[];
  flatSectionsForRender: ProjectSection[];
  sectionsForRender: ProjectSection[];
  selectedSpaceId: string | null;
  selectedWorktreePath: string | null;
  homeDirectory: string | null;
  activeSessionIdSet: ReadonlySet<string>;
  unreadSessionIdSet: ReadonlySet<string>;
}

export function useSidebarProjectMetadata({
  projectSections,
  flatSectionsForRender,
  sectionsForRender,
  selectedSpaceId,
  selectedWorktreePath,
  homeDirectory,
  activeSessionIdSet,
  unreadSessionIdSet,
}: UseSidebarProjectMetadataParams) {
  const sessionSidebarMetaById = React.useMemo(
    () => deriveSessionSidebarMetaById(projectSections, homeDirectory),
    [projectSections, homeDirectory]
  );

  const sectionsForSidebarRender = React.useMemo(
    () => deriveSectionsForSidebarRender(flatSectionsForRender),
    [flatSectionsForRender]
  );

  const filteredSectionsForSidebarRender = React.useMemo(
    () =>
      deriveFilteredSectionsForSidebarRender(
        sectionsForRender,
        sectionsForSidebarRender,
        selectedSpaceId,
        selectedWorktreePath
      ),
    [
      sectionsForRender,
      sectionsForSidebarRender,
      selectedSpaceId,
      selectedWorktreePath,
    ]
  );

  const totalSessionCount = React.useMemo(
    () => deriveTotalSessionCount(projectSections),
    [projectSections]
  );

  const sessionCountByProject = React.useMemo(
    () => deriveSessionCountByProject(projectSections),
    [projectSections]
  );

  const hasActiveSessionByProject = React.useCallback(
    (projectId: string) => {
      const section = projectSections.find((s) => s.project.id === projectId);
      if (!section) return false;
      return hasActiveSessionInProject(section, activeSessionIdSet);
    },
    [activeSessionIdSet, projectSections]
  );

  const activeDirectoriesByProject = React.useMemo(
    () => deriveActiveDirectoriesByProject(projectSections, activeSessionIdSet),
    [activeSessionIdSet, projectSections]
  );

  const hasUnseenByProject = React.useCallback(
    (projectId: string) => {
      const section = projectSections.find((s) => s.project.id === projectId);
      if (!section) return false;
      return hasUnseenInProject(section, unreadSessionIdSet);
    },
    [projectSections, unreadSessionIdSet]
  );

  return {
    sessionSidebarMetaById,
    sectionsForSidebarRender,
    filteredSectionsForSidebarRender,
    totalSessionCount,
    sessionCountByProject,
    hasActiveSessionByProject,
    activeDirectoriesByProject,
    hasUnseenByProject,
  };
}
