import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '@/lib/chat/types';
import type { SessionGroup, SessionNode } from '../types';
import { useSessionSidebarSections } from './useSessionSidebarSections';

// Workspace, By folder and Threads hide archived sessions: with no search
// query the sections carry no archived nodes. A search, or Timeline, brings
// them back in place within their folder.

const session = (id: string, archived = false): Session => ({
  id,
  title: `Title ${id}`,
  directory: '/work/alpha',
  time: { created: 1, updated: 1, ...(archived ? { archived: 2 } : {}) },
} as unknown as Session);

const project = { id: 'alpha', path: '/work/alpha', normalizedPath: '/work/alpha' };

// Mirrors useSessionGrouping: archived sessions stay in their folder group.
const buildGroupedSessions = (sessions: Session[]): SessionGroup[] => [{
  id: 'root', label: 'root', branch: null, description: null, isMain: true,
  directory: '/work/alpha',
  sessions: sessions.map((item) => ({ session: item, children: [] } as unknown as SessionNode)),
} as SessionGroup];

const renderedIds = (query: string, alwaysIncludeArchived = false): string[] => {
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
      alwaysIncludeArchived,
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

  test('Timeline always includes archived sessions', () => {
    expect(renderedIds('', true)).toEqual(['open', 'put-away']);
  });
});
