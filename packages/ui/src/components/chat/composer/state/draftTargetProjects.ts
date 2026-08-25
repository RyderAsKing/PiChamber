import type { ProjectEntry } from '@/lib/api/types';
import { normalizePath } from '../attachments/filePaths';

export const GLOBAL_PROJECT_ID = '__home__';
const GLOBAL_PROJECT_LABEL = "Don't work in a folder";

export interface DraftTargetProject {
  id: string;
  ownerProjectId: string;
  kind: 'project' | 'worktree';
  path: string;
  branch?: string | null;
  label?: string;
  icon?: string | null;
  color?: string | null;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
  iconBackground?: string | null;
}

const getGlobalProjectPath = (): string => '~';

export const shouldSyncDraftTargetToActiveProject = (input: {
  enabled: boolean;
  isDraftOpen: boolean;
  activeProjectId: string | null;
  selectedProjectId: string | null | undefined;
}): boolean => {
  return input.enabled
    && input.isDraftOpen
    && Boolean(input.activeProjectId)
    && input.selectedProjectId !== GLOBAL_PROJECT_ID
    && input.selectedProjectId !== input.activeProjectId;
};

export function buildDraftTargetProjects(
  registeredProjects: ProjectEntry[],
  availableWorktreesByProject: ReadonlyMap<string, readonly { path: string; branch?: string | null; detached?: boolean; name?: string }[]>,
): DraftTargetProject[] {
  const base = registeredProjects.flatMap((project) => {
    const root: DraftTargetProject = {
      ...project,
      id: project.id,
      ownerProjectId: project.id,
      kind: 'project',
    };
    const worktrees = availableWorktreesByProject.get(normalizePath(project.path) ?? project.path) ?? [];
    return [
      root,
      ...worktrees.map((worktree): DraftTargetProject => ({
        id: `worktree:${project.id}:${worktree.path}`,
        ownerProjectId: project.id,
        kind: 'worktree',
        path: worktree.path,
        branch: worktree.branch,
        label: worktree.branch || (worktree.detached ? 'Detached HEAD' : worktree.name),
      })),
    ];
  });
  const globalPath = getGlobalProjectPath();
  const globalEntry: DraftTargetProject = {
    id: GLOBAL_PROJECT_ID,
    ownerProjectId: GLOBAL_PROJECT_ID,
    kind: 'project',
    path: globalPath,
    label: GLOBAL_PROJECT_LABEL,
  };
  return [globalEntry, ...base];
}
