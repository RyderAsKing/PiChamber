import { create } from 'zustand';

import type { GitAPI, GitWorktree } from '@/lib/api/types';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey } from '@/lib/runtime-switch';

type WorktreeLoadStatus = 'idle' | 'loading' | 'ready' | 'failed';

type ProjectWorktreeState = {
  worktrees: GitWorktree[];
  status: WorktreeLoadStatus;
  error: string | null;
  fetchedAt: number;
};

type WorktreeStore = {
  runtimeKey: string;
  projects: Map<string, ProjectWorktreeState>;
  refreshProject: (projectRoot: string, git: GitAPI) => Promise<GitWorktree[] | null>;
  resetForRuntimeSwitch: (runtimeKey: string) => void;
};

const inFlightByProject = new Map<string, Promise<GitWorktree[] | null>>();
const linkedWorktreeCache = new WeakMap<GitWorktree[], GitWorktree[]>();
let runtimeGeneration = 0;

const projectKey = (runtimeKey: string, projectRoot: string): string =>
  JSON.stringify([runtimeKey, normalizePath(projectRoot) ?? projectRoot]);

const sameWorktrees = (left: readonly GitWorktree[], right: readonly GitWorktree[]): boolean => (
  left.length === right.length
  && left.every((entry, index) => {
    const candidate = right[index];
    return candidate
      && entry.path === candidate.path
      && entry.head === candidate.head
      && entry.branch === candidate.branch
      && entry.name === candidate.name
      && entry.isPrimary === candidate.isPrimary
      && entry.detached === candidate.detached
      && entry.locked === candidate.locked
      && entry.prunable === candidate.prunable;
  })
);

const initialProjectState = (): ProjectWorktreeState => ({
  worktrees: [],
  status: 'idle',
  error: null,
  fetchedAt: 0,
});

export const useWorktreeStore = create<WorktreeStore>()((set, get) => ({
  runtimeKey: getRuntimeKey(),
  projects: new Map(),

  refreshProject: async (projectRoot, git) => {
    const normalizedRoot = normalizePath(projectRoot);
    if (!normalizedRoot) return null;
    const runtimeKey = getRuntimeKey();
    const requestGeneration = runtimeGeneration;
    const key = projectKey(runtimeKey, normalizedRoot);
    const existingTask = inFlightByProject.get(key);
    if (existingTask) return existingTask;

    const previous = get().projects.get(normalizedRoot) ?? initialProjectState();
    if (previous.status === 'idle') {
      set((state) => {
        const projects = new Map(state.projects);
        projects.set(normalizedRoot, { ...previous, status: 'loading' });
        return { projects };
      });
    }

    const task = (async (): Promise<GitWorktree[] | null> => {
      try {
        const isRepository = await git.checkIsGitRepository(normalizedRoot);
        const worktrees = isRepository
          ? await (() => {
              if (!git.listGitWorktrees) throw new Error('Git worktrees are unavailable for this runtime.');
              return git.listGitWorktrees(normalizedRoot);
            })()
          : [];
        if (
          requestGeneration !== runtimeGeneration
          || runtimeKey !== getRuntimeKey()
          || get().runtimeKey !== runtimeKey
        ) return null;

        set((state) => {
          const current = state.projects.get(normalizedRoot) ?? initialProjectState();
          const topologyUnchanged = sameWorktrees(current.worktrees, worktrees);
          if (topologyUnchanged && current.status === 'ready' && current.error === null) return state;
          const projects = new Map(state.projects);
          projects.set(normalizedRoot, {
            worktrees: topologyUnchanged ? current.worktrees : worktrees,
            status: 'ready',
            error: null,
            fetchedAt: Date.now(),
          });
          return { projects };
        });
        return worktrees;
      } catch (error) {
        if (
          requestGeneration !== runtimeGeneration
          || runtimeKey !== getRuntimeKey()
          || get().runtimeKey !== runtimeKey
        ) return null;
        const message = error instanceof Error ? error.message : 'Failed to discover Git worktrees.';
        set((state) => {
          const current = state.projects.get(normalizedRoot) ?? previous;
          const projects = new Map(state.projects);
          projects.set(normalizedRoot, { ...current, status: 'failed', error: message });
          return { projects };
        });
        return null;
      } finally {
        inFlightByProject.delete(key);
      }
    })();

    inFlightByProject.set(key, task);
    return task;
  },

  resetForRuntimeSwitch: (runtimeKey) => {
    runtimeGeneration += 1;
    inFlightByProject.clear();
    set({ runtimeKey, projects: new Map() });
  },
}));

const linkedWorktreesForProject = (
  state: Pick<WorktreeStore, 'projects'>,
  projectRoot: string | null | undefined,
): GitWorktree[] => {
  const normalizedRoot = normalizePath(projectRoot ?? null);
  if (!normalizedRoot) return [];
  const worktrees = state.projects.get(normalizedRoot)?.worktrees;
  if (!worktrees) return [];
  const cached = linkedWorktreeCache.get(worktrees);
  if (cached) return cached;
  const linked = worktrees.filter((worktree) => !worktree.isPrimary && !worktree.prunable);
  linkedWorktreeCache.set(worktrees, linked);
  return linked;
};

export const buildAvailableWorktreesByProject = (
  projects: ReadonlyArray<{ path?: string | null }>,
  state: Pick<WorktreeStore, 'projects'>,
): Map<string, GitWorktree[]> => {
  const result = new Map<string, GitWorktree[]>();
  for (const project of projects) {
    const normalizedRoot = normalizePath(project.path ?? null);
    if (!normalizedRoot) continue;
    result.set(normalizedRoot, linkedWorktreesForProject(state, normalizedRoot));
  }
  return result;
};
