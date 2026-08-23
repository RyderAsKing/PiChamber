import { beforeEach, describe, expect, test } from 'bun:test';

import type { GitAPI, GitWorktree } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { buildAvailableWorktreesByProject, useWorktreeStore } from './useWorktreeStore';

const worktrees: GitWorktree[] = [
  { path: '/repo', branch: 'main', head: 'a', name: 'repo', isPrimary: true, detached: false, locked: false, prunable: false },
  { path: '/worktrees/task', branch: 'pichamber/task', head: 'b', name: 'task', isPrimary: false, detached: false, locked: false, prunable: false },
];

const git = (overrides: Partial<GitAPI> = {}): GitAPI => ({
  checkIsGitRepository: async () => true,
  listGitWorktrees: async () => worktrees,
  ...overrides,
} as GitAPI);

describe('worktree store', () => {
  beforeEach(() => {
    useWorktreeStore.getState().resetForRuntimeSwitch(getRuntimeKey());
  });

  test('discovers worktrees and exposes only valid linked entries', async () => {
    await useWorktreeStore.getState().refreshProject('/repo', git());
    const available = buildAvailableWorktreesByProject([{ path: '/repo' }], useWorktreeStore.getState());
    expect(available.get('/repo')).toEqual([worktrees[1]]);
    expect(useWorktreeStore.getState().projects.get('/repo')?.status).toBe('ready');
  });

  test('preserves the previous authoritative list when refresh fails', async () => {
    await useWorktreeStore.getState().refreshProject('/repo', git());
    await useWorktreeStore.getState().refreshProject('/repo', git({
      listGitWorktrees: async () => { throw new Error('offline'); },
    }));

    const state = useWorktreeStore.getState().projects.get('/repo');
    expect(state?.status).toBe('failed');
    expect(state?.error).toBe('offline');
    expect(state?.worktrees).toEqual(worktrees);
  });

  test('records a successful empty result for a non-repository', async () => {
    await useWorktreeStore.getState().refreshProject('/plain', git({ checkIsGitRepository: async () => false }));
    const state = useWorktreeStore.getState().projects.get('/plain');
    expect(state?.status).toBe('ready');
    expect(state?.worktrees).toEqual([]);
  });
});
