import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GitWorktree } from '@/lib/api/types';
import type { Session } from '@/lib/chat/types';
import type { SessionGroup } from '../types';
import { useSessionGrouping } from './useSessionGrouping';

// Archived sessions that reach the grouping (a search, or Timeline) sit in
// place with their folder or worktree; there is no separate archived group.

const session = (id: string, directory: string, archived = false): Session => ({
  id,
  title: `Title ${id}`,
  directory,
  time: { created: 1, updated: 1, ...(archived ? { archived: 2 } : {}) },
} as unknown as Session);

const worktree = { path: '/work/alpha-wt', branch: 'feature', name: 'alpha-wt', isPrimary: false } as unknown as GitWorktree;

const group = (sessions: Session[]): SessionGroup[] => {
  let groups: SessionGroup[] = [];
  const Probe = () => {
    const { buildGroupedSessions } = useSessionGrouping({
      homeDirectory: '/home/tester',
      pinnedSessionIds: new Set(),
      sessionOrderRanks: new Map(),
      gitBranches: new Map(),
    });
    groups = buildGroupedSessions(sessions, '/work/alpha', [worktree], 'main', true);
    return null;
  };
  renderToStaticMarkup(React.createElement(Probe));
  return groups;
};

describe('useSessionGrouping', () => {
  test('archived sessions stay in their own folder and worktree groups', () => {
    const groups = group([
      session('open', '/work/alpha'),
      session('root-archived', '/work/alpha', true),
      session('wt-archived', '/work/alpha-wt', true),
    ]);
    expect(groups.map((item) => item.id)).toEqual(['root', 'worktree:/work/alpha-wt']);
    expect(groups[0]!.sessions.map((node) => node.session.id).sort()).toEqual(['open', 'root-archived']);
    expect(groups[1]!.sessions.map((node) => node.session.id)).toEqual(['wt-archived']);
  });
});
