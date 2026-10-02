import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { SidebarViewMode } from '@/lib/sidebarViewMode';
import { SidebarProjectsList, type ProjectSection } from './SidebarProjectsList';
import { getTimelineBoundaries } from './timelineBuckets';
import type { SessionGroup, SessionNode } from './types';

// One dataset rendered through every sidebar view: switching the view changes
// the arrangement only, and a folder or session that disappears from the data
// disappears from every view without disturbing the rest.

const noop = () => undefined;
const NOW = new Date(2026, 4, 14, 15, 0).getTime();
const HOUR = 60 * 60 * 1000;

const makeNode = (id: string, directory: string, updated: number): SessionNode => ({
  session: { id, title: `Title ${id}`, directory, time: { created: updated, updated } },
  children: [],
} as unknown as SessionNode);

const makeSection = (id: string, label: string, nodes: SessionNode[]): ProjectSection => ({
  project: { id, label, normalizedPath: `/work/${id}` },
  groups: [{
    id: `${id}-root`,
    label: 'main',
    branch: 'main',
    description: null,
    isMain: true,
    directory: `/work/${id}`,
    sessions: nodes,
  } as SessionGroup],
});

const alpha = makeSection('alpha', 'Alpha', [
  makeNode('alpha-today', '/work/alpha', NOW - HOUR),
  makeNode('alpha-old', '/work/alpha', NOW - 90 * 24 * HOUR),
]);
const beta = makeSection('beta', 'Beta', [
  makeNode('beta-yesterday', '/work/beta', NOW - 24 * HOUR),
]);
const home = makeSection('__home__', 'No folder', [
  makeNode('home-today', '~', NOW - 2 * HOUR),
]);

type RenderOptions = {
  viewMode?: SidebarViewMode;
  sections: ProjectSection[];
  selected?: ProjectSection | null;
  homeSection?: ProjectSection | null;
  collapsed?: string[];
};

const render = ({ viewMode, sections, selected = null, homeSection = home, collapsed = [] }: RenderOptions): string => {
  const workspace = viewMode === undefined || viewMode === 'workspace';
  return renderToStaticMarkup(
    React.createElement(TooltipProvider, null, React.createElement(SidebarProjectsList, {
      viewMode,
      timelineBoundaries: getTimelineBoundaries(NOW, 1),
      // Mirrors SessionSidebar: workspace scopes to the selected folder (or the
      // mixed list when none is selected); the other views see every folder.
      sectionsForRender: workspace && selected ? [selected] : sections,
      allFoldersOnlySection: workspace && selected ? null : homeSection,
      isAllFoldersView: workspace ? selected === null : viewMode === 'timeline',
      projectSections: sections,
      activeProjectId: selected?.project.id ?? null,
      showOnlyMainWorkspace: false,
      hasSessionSearchQuery: false,
      emptyState: React.createElement('div', { 'data-testid': 'empty' }),
      searchEmptyState: React.createElement('div', { 'data-testid': 'search-empty' }),
      renderSessionNode: (node, _depth, _directory, projectId, _archived, secondaryMeta) =>
        React.createElement('span', {
          'data-session-id': node.session.id,
          'data-project-id': projectId ?? '',
          'data-folder-label': secondaryMeta?.showFolderLabel ? secondaryMeta.projectLabel ?? '' : '',
        }),
      renderGroupSessions: (group, groupKey, projectId) =>
        React.createElement('div', { 'data-group-key': groupKey },
          group.sessions.map((node) => React.createElement('span', {
            key: node.session.id,
            'data-session-id': node.session.id,
            'data-project-id': projectId ?? '',
          }))),
      getOrderedGroups: (_projectId, groups) => groups,
      setGroupOrderByProject: noop,
      homeDirectory: '/home/tester',
      collapsedProjects: new Set(collapsed),
      hideDirectoryControls: false,
      projectRepoStatus: new Map(),
      mobileVariant: false,
      alwaysShowActions: false,
      toggleProject: noop,
      setActiveProjectIdOnly: noop,
      setActiveMainTab: noop,
      setSessionSwitcherOpen: noop,
      openNewSessionDraft: noop,
      openProjectEditDialog: noop,
      removeProject: noop,
      reorderProjects: noop,
      openSidebarMenuKey: null,
      setOpenSidebarMenuKey: noop,
      isInlineEditing: false,
    })),
  );
};

const sessionIds = (markup: string): string[] =>
  [...markup.matchAll(/data-session-id="([^"]+)"/g)].map((match) => match[1]!);

const projectOf = (markup: string, sessionId: string): string | undefined =>
  new RegExp(`data-session-id="${sessionId}" data-project-id="([^"]*)"`).exec(markup)?.[1];

describe('sidebar view modes over one dataset', () => {
  test('every view shows the same sessions and switching back restores the first view', () => {
    const sections = [alpha, beta];
    const workspace = render({ viewMode: 'workspace', sections });
    const folder = render({ viewMode: 'folder', sections });
    const timeline = render({ viewMode: 'timeline', sections });

    const expected = ['alpha-old', 'alpha-today', 'beta-yesterday', 'home-today'];
    expect([...sessionIds(workspace)].sort()).toEqual(expected);
    expect([...sessionIds(folder)].sort()).toEqual(expected);
    expect([...sessionIds(timeline)].sort()).toEqual(expected);

    expect(render({ viewMode: 'workspace', sections })).toBe(workspace);
    expect(render({ sections })).toBe(workspace);
  });

  test('workspace keeps scoping to the selected folder while the other views show all folders', () => {
    const sections = [alpha, beta];
    expect(sessionIds(render({ viewMode: 'workspace', sections, selected: beta }))).toEqual(['beta-yesterday']);
    expect(sessionIds(render({ viewMode: 'folder', sections, selected: beta }))).toHaveLength(4);
    expect(sessionIds(render({ viewMode: 'timeline', sections, selected: beta }))).toHaveLength(4);
  });

  test('by folder nests each session under its own folder, in folder order', () => {
    const markup = render({ viewMode: 'folder', sections: [beta, alpha] });

    expect(markup.indexOf('Beta')).toBeLessThan(markup.indexOf('Alpha'));
    expect(markup.indexOf('Alpha')).toBeLessThan(markup.indexOf('No folder'));
    expect(markup).toContain('data-group-key="alpha:alpha-root"');
    expect(markup).toContain('data-group-key="beta:beta-root"');
    expect(projectOf(markup, 'alpha-today')).toBe('alpha');
    expect(projectOf(markup, 'alpha-old')).toBe('alpha');
    expect(projectOf(markup, 'beta-yesterday')).toBe('beta');
    expect(projectOf(markup, 'home-today')).toBe('__home__');
    // Sessions sit between their folder header and the next one.
    expect(markup.indexOf('data-session-id="beta-yesterday"')).toBeLessThan(markup.indexOf('Alpha'));
    expect(markup.indexOf('data-session-id="alpha-today"')).toBeGreaterThan(markup.indexOf('Alpha'));
  });

  test('timeline orders by recency across folders and keeps each folder label', () => {
    const markup = render({ viewMode: 'timeline', sections: [alpha, beta] });

    expect(sessionIds(markup)).toEqual(['alpha-today', 'home-today', 'beta-yesterday', 'alpha-old']);
    expect([...markup.matchAll(/data-timeline-bucket="([^"]+)"/g)].map((match) => match[1]))
      .toEqual(['today', 'yesterday', 'older']);
    expect(markup).toContain('data-session-id="alpha-today" data-project-id="alpha" data-folder-label="Alpha"');
    expect(markup).toContain('data-session-id="beta-yesterday" data-project-id="beta" data-folder-label="Beta"');
  });

  test('a closed folder leaves every view and takes only its own sessions', () => {
    for (const viewMode of ['workspace', 'folder', 'timeline'] as const) {
      const markup = render({ viewMode, sections: [alpha] });
      expect([...sessionIds(markup)].sort()).toEqual(['alpha-old', 'alpha-today', 'home-today']);
      expect(markup).not.toContain('Beta');
    }
  });

  test('a deleted session leaves every view and an emptied folder stays listed by folder', () => {
    const alphaAfterDelete = makeSection('alpha', 'Alpha', [alpha.groups[0]!.sessions[1]!]);
    const betaEmptied = makeSection('beta', 'Beta', []);
    const sections = [alphaAfterDelete, betaEmptied];

    for (const viewMode of ['workspace', 'folder', 'timeline'] as const) {
      expect([...sessionIds(render({ viewMode, sections }))].sort()).toEqual(['alpha-old', 'home-today']);
    }
    expect(render({ viewMode: 'folder', sections })).toContain('Beta');
    expect([...render({ viewMode: 'timeline', sections }).matchAll(/data-timeline-bucket="([^"]+)"/g)].map((match) => match[1]))
      .toEqual(['today', 'older']);
  });

  test('empty data renders the empty state in every view', () => {
    for (const viewMode of ['workspace', 'folder', 'timeline'] as const) {
      const markup = render({ viewMode, sections: [], homeSection: null });
      expect(markup).toContain('data-testid="empty"');
      expect(sessionIds(markup)).toEqual([]);
    }
  });

  test('folders without sessions still list in the by-folder view and timeline shows the empty state', () => {
    const sections = [makeSection('alpha', 'Alpha', []), makeSection('beta', 'Beta', [])];

    const folder = render({ viewMode: 'folder', sections, homeSection: null });
    expect(folder).toContain('Alpha');
    expect(folder).toContain('Beta');

    const timeline = render({ viewMode: 'timeline', sections, homeSection: null });
    expect(timeline).toContain('data-testid="empty"');
    expect(timeline).not.toContain('data-timeline-bucket');
  });

  test('collapsing a folder hides only that folder\'s sessions', () => {
    const markup = render({ viewMode: 'folder', sections: [alpha, beta], collapsed: ['alpha'] });

    expect(markup).toContain('Alpha');
    expect([...sessionIds(markup)].sort()).toEqual(['beta-yesterday', 'home-today']);
  });
});
