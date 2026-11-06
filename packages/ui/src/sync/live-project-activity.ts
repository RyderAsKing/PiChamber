import type { ProjectEntry } from '@/lib/api/types';
import { normalizePath } from '@/lib/pathNormalization';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { buildAvailableWorktreesByProject, useWorktreeStore } from '@/stores/useWorktreeStore';
import type { PiSessionCatalogState } from '@/sync/pi-session-catalog';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';

// Which projects have an agent working right now. Derived only from the live
// catalog lifecycle (busy/retry), never from history, and shared by every
// consumer: the catalog scan runs once per catalog commit and the project
// resolution once per change of working directories, however many icons ask.

const EMPTY_PATHS: ReadonlySet<string> = new Set();

const liveDirectoriesKeyByCatalog = new WeakMap<PiSessionCatalogState, string>();

/** Sorted, newline-joined directories of unarchived busy/retry sessions. */
export const catalogLiveDirectoriesKey = (catalog: PiSessionCatalogState): string => {
  const cached = liveDirectoriesKeyByCatalog.get(catalog);
  if (cached !== undefined) return cached;
  const directories = new Set<string>();
  for (const record of catalog.byId.values()) {
    if (record.archived) continue;
    if (record.lifecycle !== 'busy' && record.lifecycle !== 'retry') continue;
    const directory = normalizePath(record.directory);
    if (directory) directories.add(directory);
  }
  const key = [...directories].sort().join('\n');
  liveDirectoriesKeyByCatalog.set(catalog, key);
  return key;
};

type WorktreeProjects = ReturnType<typeof useWorktreeStore.getState>['projects'];

/** Normalized roots of the projects that own the given live directories. */
export const deriveActiveProjectPaths = (
  liveDirectoriesKey: string,
  projects: ProjectEntry[],
  worktreeProjects: WorktreeProjects,
): ReadonlySet<string> => {
  if (!liveDirectoriesKey) return EMPTY_PATHS;
  const worktreesByProject = buildAvailableWorktreesByProject(projects, { projects: worktreeProjects });
  const paths = new Set<string>();
  for (const directory of liveDirectoriesKey.split('\n')) {
    const project = resolveProjectForSessionDirectory(projects, worktreesByProject, directory);
    const root = normalizePath(project?.path ?? null);
    if (root) paths.add(root);
  }
  return paths.size > 0 ? paths : EMPTY_PATHS;
};

let lastDerivation: {
  liveDirectoriesKey: string;
  projects: ProjectEntry[];
  worktreeProjects: WorktreeProjects;
  paths: ReadonlySet<string>;
} | null = null;

const activeProjectPaths = (
  liveDirectoriesKey: string,
  projects: ProjectEntry[],
  worktreeProjects: WorktreeProjects,
): ReadonlySet<string> => {
  if (
    lastDerivation
    && lastDerivation.liveDirectoriesKey === liveDirectoriesKey
    && lastDerivation.projects === projects
    && lastDerivation.worktreeProjects === worktreeProjects
  ) {
    return lastDerivation.paths;
  }
  const paths = deriveActiveProjectPaths(liveDirectoriesKey, projects, worktreeProjects);
  lastDerivation = { liveDirectoriesKey, projects, worktreeProjects, paths };
  return paths;
};

const selectLiveDirectoriesKey = (state: { catalog: PiSessionCatalogState }) => catalogLiveDirectoriesKey(state.catalog);

/**
 * True while an agent is working in the project, in its root or in any of its
 * worktrees. Re-renders only when the set of working directories changes.
 */
export const useProjectAgentActive = (projectPath: string | null | undefined): boolean => {
  const liveDirectoriesKey = usePiSessionSnapshot(selectLiveDirectoriesKey, undefined, 'catalog');
  const projects = useProjectsStore((state) => state.projects);
  const worktreeProjects = useWorktreeStore((state) => state.projects);
  const root = normalizePath(projectPath ?? null);
  if (!root || !liveDirectoriesKey) return false;
  return activeProjectPaths(liveDirectoriesKey, projects, worktreeProjects).has(root);
};
