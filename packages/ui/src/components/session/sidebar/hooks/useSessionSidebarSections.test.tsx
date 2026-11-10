import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '@/lib/chat/types';
import type { SessionGroup, SessionNode } from '../types';
import { useSessionSidebarSections } from './useSessionSidebarSections';

// Workspace and By folder hide archived sessions: with no search query the
// sections carry no archived nodes, so neither view lists or buckets them.

const session = (id: string, archived = false): Session => ({
  id,
  title: `Title ${id}`,
  directory: '/work/alpha',
  time: { created: 1, updated: 1, ...(archived ? { archived: 2 } : {}) },
} as unknown as Session);

const project = { id: 'alpha', path: '/work/alpha', normalizedPath: '/work/alpha' };

// Mirrors useSessionGrouping: archived sessions go to their own bucket group.
const buildGroupedSessions = (sessions: Session[]): SessionGroup[] => {
  const node = (item: Session): SessionNode => ({ session: item, children: [] } as unknown as SessionNode);
  const groups: SessionGroup[] = [{
    id: 'root', label: 'root', branch: null, description: null, isMain: true, isArchivedBucket: false,
    directory: '/work/alpha', sessions: sessions.filter((item) => !item.time?.archived).map(node),
  } as SessionGroup];
  const archived = sessions.filter((item) => item.time?.archived);
  if (archived.length > 0) {
    groups.push({
      id: 'archived', label: 'archived', branch: null, description: null, isMain: false, isArchivedBucket: true,
      directory: null, sessions: archived.map(node),
    } as SessionGroup);
  }
  return groups;
};

const renderedIds = (query: string): string[] => {
  let ids: string[] = [];
  const Probe = () => {
    const { sectionsForRender, flatSectionsForRender } = useSessionSidebarSections({
      normalizedProjects: [project],
      getSessionsForProject: () => [session('open')],
      getArchivedSessionsForProject: () => [session('put-away', true)],
      availableWorktreesByProject: new Map(),
      projectRepoStatus: new Map(),
      projectRootBranches: new Map(),
      lastRepoStatus: false,
      buildGroupedSessions,
      hasSessionSearchQuery: query.length > 0,
      normalizedSessionSearchQuery: query,
      filterSessionNodesForSearch: (nodes, q) => nodes.filter((node) => node.session.title?.toLowerCase().includes(q)),
      buildGroupSearchText: () => '',
      foldersMap: {},
    });
    ids = [...sectionsForRender, ...flatSectionsForRender]
      .flatMap((section) => section.groups)
      .flatMap((group) => group.sessions.map((node) => node.session.id));
    return null;
  };
  renderToStaticMarkup(React.createElement(Probe));
  return [...new Set(ids)].sort();
};

describe('useSessionSidebarSections', () => {
  test('archived sessions are left out of the folder sections', () => {
    expect(renderedIds('')).toEqual(['open']);
  });

  test('a search still reaches archived matches', () => {
    expect(renderedIds('title')).toEqual(['open', 'put-away']);
  });
});
