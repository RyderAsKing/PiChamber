import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '@/lib/chat/types';
import type { SidebarViewMode } from '@/lib/sidebarViewMode';
import type { SessionGroup, SessionNode } from '../types';
import { useArchivedShelfItems } from './useArchivedShelfItems';

// The Archived shelf lists archived sessions grouped like the live list:
// every folder in Threads and By folder, the selected folder or worktree in
// Workspace, most recently archived first.

const archivedSession = (id: string, directory: string, archived: number): Session => ({
  id,
  title: `Title ${id}`,
  directory,
  time: { created: 1, updated: 1, archived },
} as unknown as Session);

const alpha = { id: 'alpha', path: '/work/alpha', normalizedPath: '/work/alpha' };
const beta = { id: 'beta', path: '/work/beta', normalizedPath: '/work/beta' };

const archivedByProject: Record<string, Session[]> = {
  alpha: [
    archivedSession('alpha-root', '/work/alpha', 30),
    archivedSession('alpha-tree', '/work/alpha-feature', 50),
  ],
  beta: [archivedSession('beta-root', '/work/beta', 40)],
};
const homeArchived = archivedSession('home-one', '/home/tester', 10);

// Mirrors useSessionGrouping: one group per directory.
const buildGroupedSessions = (sessions: Session[], projectRoot: string): SessionGroup[] => {
  const byDirectory = new Map<string, SessionNode[]>();
  for (const session of sessions) {
    const directory = session.directory ?? projectRoot;
    byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), { session, children: [] } as unknown as SessionNode]);
  }
  return [...byDirectory].map(([directory, nodes]) => ({
    id: directory,
    label: directory,
    branch: null,
    description: null,
    isMain: directory === projectRoot,
    directory,
    sessions: nodes,
  } as SessionGroup));
};

const shelfIds = (options: {
  viewMode: SidebarViewMode;
  enabled?: boolean;
  selectedSpaceId?: string | null;
  selectedWorktreePath?: string | null;
}): string[] => {
  let ids: string[] = [];
  const Probe = () => {
    const items = useArchivedShelfItems({
      viewMode: options.viewMode,
      enabled: options.enabled ?? true,
      projects: [alpha, beta],
      archivedSessions: [...Object.values(archivedByProject).flat(), homeArchived],
      getArchivedSessionsForProject: (projectId) => archivedByProject[projectId] ?? [],
      isGlobalSession: (session) => session.id === homeArchived.id,
      buildGroupedSessions,
      availableWorktreesByProject: new Map(),
      projectRepoStatus: new Map(),
      projectRootBranches: new Map(),
      lastRepoStatus: false,
      selectedSpaceId: options.selectedSpaceId ?? null,
      selectedWorktreePath: options.selectedWorktreePath ?? null,
      homeDirectory: '/home/tester',
    });
    ids = items.map((item) => (item.globalSession ? `~${item.node.session.id}` : item.node.session.id));
    return null;
  };
  renderToStaticMarkup(React.createElement(Probe));
  return ids;
};

describe('useArchivedShelfItems', () => {
  test('Threads and By folder list every archived session, newest first', () => {
    const all = ['alpha-tree', 'beta-root', 'alpha-root', '~home-one'];
    expect(shelfIds({ viewMode: 'threads' })).toEqual(all);
    expect(shelfIds({ viewMode: 'folder', selectedSpaceId: 'beta' })).toEqual(all);
  });

  test('Workspace lists the selected folder, or one of its worktrees', () => {
    expect(shelfIds({ viewMode: 'workspace' })).toEqual(['alpha-tree', 'beta-root', 'alpha-root', '~home-one']);
    expect(shelfIds({ viewMode: 'workspace', selectedSpaceId: 'alpha' })).toEqual(['alpha-root']);
    expect(shelfIds({ viewMode: 'workspace', selectedSpaceId: 'alpha', selectedWorktreePath: '/work/alpha-feature' }))
      .toEqual(['alpha-tree']);
  });

  test('Timeline, a search, and single-workspace mode get no shelf', () => {
    expect(shelfIds({ viewMode: 'timeline' })).toEqual([]);
    expect(shelfIds({ viewMode: 'threads', enabled: false })).toEqual([]);
  });
});
