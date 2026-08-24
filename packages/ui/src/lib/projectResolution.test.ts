import { describe, expect, test } from 'bun:test';

import type { ProjectEntry } from './api/types';
import { resolveProjectForSessionDirectory } from './projectResolution';

const projects: ProjectEntry[] = [
  { id: 'app', path: '/projects/app' },
  { id: 'nested', path: '/external/app-task/packages/admin' },
];

describe('resolveProjectForSessionDirectory', () => {
  test('resolves a sibling worktree to its registered owning project', () => {
    const worktrees = new Map([
      ['/projects/app', [{ path: '/external/app-task' }]],
    ]);
    expect(resolveProjectForSessionDirectory(projects, worktrees, '/external/app-task/src')?.id).toBe('app');
  });

  test('gives an explicitly registered nested project precedence over worktree ownership', () => {
    const worktrees = new Map([
      ['/projects/app', [{ path: '/external/app-task' }]],
    ]);
    expect(resolveProjectForSessionDirectory(projects, worktrees, '/external/app-task/packages/admin/src')?.id).toBe('nested');
  });

  test('preserves the legacy two-argument directory form', () => {
    expect(resolveProjectForSessionDirectory(projects, '/projects/app/src')?.id).toBe('app');
  });
});
