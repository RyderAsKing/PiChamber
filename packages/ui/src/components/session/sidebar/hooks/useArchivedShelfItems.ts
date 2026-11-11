import React from 'react';
import type { GitWorktree } from '@/lib/api/types';
import type { Session } from '@/lib/chat/types';
import type { SidebarViewMode } from '@/lib/sidebarViewMode';
import type { ThreadsListItem } from '../SidebarThreadsList';
import type { SessionGroup } from '../types';
import type { ProjectSection } from './useSessionSidebarSections';
import { getProjectLabel } from '../utils';
import { deriveFilteredSectionsForSidebarRender } from './useSidebarProjectMetadata';

type ProjectItem = ProjectSection['project'];

const NO_ITEMS: ThreadsListItem[] = [];

const HOME_PROJECT: ProjectItem = {
  id: '__home__',
  path: '~',
  normalizedPath: '~',
  label: 'No folder',
};

/**
 * The root sessions of archived-only sections as shelf rows, most recently
 * archived first. A session listed by two sections keeps its first row.
 */
const buildArchivedShelfItems = (
  sections: readonly ProjectSection[],
  homeSection: ProjectSection | null,
  homeDirectory: string | null,
): ThreadsListItem[] => {
  const items: ThreadsListItem[] = [];
  const seen = new Set<string>();
  const collect = (section: ProjectSection, globalSession: boolean) => {
    const projectLabel = getProjectLabel(section.project, homeDirectory);
    for (const group of section.groups) {
      for (const node of group.sessions) {
        if (seen.has(node.session.id)) continue;
        seen.add(node.session.id);
        const time = node.session.time;
        items.push({
          node,
          project: section.project,
          projectLabel,
          isPinned: false,
          timestamp: time?.archived || time?.updated || time?.created || 0,
          globalSession,
        });
      }
    }
  };
  if (homeSection) collect(homeSection, true);
  for (const section of sections) collect(section, false);
  return items.sort((left, right) => right.timestamp - left.timestamp);
};

type Args = {
  viewMode: SidebarViewMode;
  /** Off while searching (archived sessions then show in place) and in single-workspace mode. */
  enabled: boolean;
  projects: readonly ProjectItem[];
  archivedSessions: readonly Session[];
  getArchivedSessionsForProject: (projectId: string) => Session[];
  isGlobalSession: (session: Session) => boolean;
  buildGroupedSessions: (
    sessions: Session[],
    projectRoot: string,
    worktrees: readonly GitWorktree[],
    rootBranch: string | null,
    isRepo: boolean,
  ) => SessionGroup[];
  availableWorktreesByProject: ReadonlyMap<string, readonly GitWorktree[]>;
  projectRepoStatus: Map<string, boolean | null>;
  projectRootBranches: Map<string, string | null>;
  lastRepoStatus: boolean;
  selectedSpaceId: string | null;
  selectedWorktreePath: string | null;
  homeDirectory: string | null;
};

/**
 * Rows for the Archived shelf. Threads and By folder list every archived
 * session; Workspace lists those of the selected folder or worktree, or all of
 * them when no folder is selected. Sessions are grouped the same way as the
 * live list, so a worktree's archived sessions belong to that worktree.
 */
export const useArchivedShelfItems = ({
  viewMode,
  enabled,
  projects,
  archivedSessions,
  getArchivedSessionsForProject,
  isGlobalSession,
  buildGroupedSessions,
  availableWorktreesByProject,
  projectRepoStatus,
  projectRootBranches,
  lastRepoStatus,
  selectedSpaceId,
  selectedWorktreePath,
  homeDirectory,
}: Args): ThreadsListItem[] => {
  const shelfView = viewMode === 'threads' || viewMode === 'folder' || viewMode === 'workspace';
  const active = enabled && shelfView;
  const scopedSpaceId = viewMode === 'workspace' ? selectedSpaceId : null;

  const projectSections = React.useMemo<ProjectSection[]>(() => {
    if (!active) return [];
    const sections: ProjectSection[] = [];
    for (const project of projects) {
      if (scopedSpaceId !== null && project.id !== scopedSpaceId) continue;
      const archived = getArchivedSessionsForProject(project.id);
      if (archived.length === 0) continue;
      const isRepo = projectRepoStatus.has(project.id)
        ? Boolean(projectRepoStatus.get(project.id))
        : lastRepoStatus;
      sections.push({
        project,
        groups: buildGroupedSessions(
          archived,
          project.normalizedPath,
          availableWorktreesByProject.get(project.normalizedPath) ?? [],
          projectRootBranches.get(project.id) ?? null,
          isRepo,
        ),
      });
    }
    return sections;
  }, [
    active,
    availableWorktreesByProject,
    buildGroupedSessions,
    getArchivedSessionsForProject,
    lastRepoStatus,
    projectRepoStatus,
    projectRootBranches,
    projects,
    scopedSpaceId,
  ]);

  const homeSection = React.useMemo<ProjectSection | null>(() => {
    if (!active || scopedSpaceId !== null) return null;
    const globalSessions = archivedSessions.filter(isGlobalSession);
    if (globalSessions.length === 0) return null;
    return { project: HOME_PROJECT, groups: buildGroupedSessions(globalSessions, '~', [], null, false) };
  }, [active, archivedSessions, buildGroupedSessions, isGlobalSession, scopedSpaceId]);

  return React.useMemo(() => {
    if (!active) return NO_ITEMS;
    const sections = scopedSpaceId !== null
      ? deriveFilteredSectionsForSidebarRender(projectSections, projectSections, scopedSpaceId, selectedWorktreePath)
      : projectSections;
    const items = buildArchivedShelfItems(sections, homeSection, homeDirectory);
    return items.length > 0 ? items : NO_ITEMS;
  }, [active, homeDirectory, homeSection, projectSections, scopedSpaceId, selectedWorktreePath]);
};
