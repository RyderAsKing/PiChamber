import { describe, expect, test } from 'bun:test';

import type { GitWorktree, ProjectEntry } from '@/lib/api/types';
import { catalogLiveDirectoriesKey, deriveActiveProjectPaths } from './live-project-activity';
import { initialCatalog, type LiveSessionLifecycle, type LiveSessionRecord, type PiSessionCatalogState } from './pi-session-catalog';

const record = (
  id: string,
  directory: string,
  lifecycle: LiveSessionLifecycle,
  archived = false,
): LiveSessionRecord => ({
  id,
  directory,
  parentId: null,
  title: id,
  archived,
  createdAt: 1,
  updatedAt: 1,
  lifecycle,
  hydrated: false,
});

const catalogOf = (...records: LiveSessionRecord[]): PiSessionCatalogState => ({
  ...initialCatalog(),
  byId: new Map(records.map((entry) => [entry.id, entry])),
});

const project = (id: string, path: string): ProjectEntry => ({ id, path } as ProjectEntry);

const worktree = (path: string): GitWorktree => ({
  head: 'abc',
  name: path.split('/').at(-1) ?? path,
  branch: 'feature',
  path,
  isPrimary: false,
  detached: false,
  locked: false,
  prunable: false,
});

const worktreeState = (entries: Record<string, string[]>) => new Map(
  Object.entries(entries).map(([root, paths]) => [
    root,
    { worktrees: paths.map(worktree), status: 'ready' as const, error: null, fetchedAt: 1 },
  ]),
);

describe('catalogLiveDirectoriesKey', () => {
  test('lists the directories of busy and retrying sessions only', () => {
    const catalog = catalogOf(
      record('a', '/repo/web/', 'busy'),
      record('b', '/repo/api', 'retry'),
      record('c', '/repo/docs', 'idle'),
      record('d', '/repo/old', 'busy', true),
      record('e', '/repo/web', 'busy'),
    );
    expect(catalogLiveDirectoriesKey(catalog)).toBe('/repo/api\n/repo/web');
  });

  test('is empty when nothing is running', () => {
    expect(catalogLiveDirectoriesKey(catalogOf(record('a', '/repo', 'idle')))).toBe('');
  });

  test('answers again for a new catalog', () => {
    const idle = catalogOf(record('a', '/repo', 'idle'));
    expect(catalogLiveDirectoriesKey(idle)).toBe('');
    const busy = catalogOf(record('a', '/repo', 'busy'));
    expect(catalogLiveDirectoriesKey(busy)).toBe('/repo');
    expect(catalogLiveDirectoriesKey(idle)).toBe('');
  });
});

describe('deriveActiveProjectPaths', () => {
  const projects = [project('one', '/code/one'), project('two', '/code/two/'), project('nested', '/code/one/packages/web')];

  test('maps working directories to the projects that own them', () => {
    const paths = deriveActiveProjectPaths('/code/one/src\n/code/two', projects, new Map());
    expect([...paths].sort()).toEqual(['/code/one', '/code/two']);
  });

  test('a nested project owns its own tree', () => {
    const paths = deriveActiveProjectPaths('/code/one/packages/web', projects, new Map());
    expect([...paths]).toEqual(['/code/one/packages/web']);
  });

  test('a worktree counts for its project', () => {
    const paths = deriveActiveProjectPaths(
      '/worktrees/two-feature',
      projects,
      worktreeState({ '/code/two': ['/worktrees/two-feature'] }),
    );
    expect([...paths]).toEqual(['/code/two']);
  });

  test('ignores directories no project owns', () => {
    expect(deriveActiveProjectPaths('/elsewhere', projects, new Map()).size).toBe(0);
    expect(deriveActiveProjectPaths('', projects, new Map()).size).toBe(0);
  });
});
