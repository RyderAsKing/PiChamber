import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SidebarProjectsList, type ProjectSection } from './SidebarProjectsList';
import { getTimelineBoundaries } from './timelineBuckets';
import type { SessionNode } from './types';

const project = {
  id: 'root',
  label: 'Root',
  normalizedPath: '/root',
};
const section: ProjectSection = { project, groups: [] };
const noop = () => undefined;

const renderWithProviders = (element: React.ReactElement): string =>
  renderToStaticMarkup(React.createElement(TooltipProvider, null, element));

/** The sprite reference an `Icon` renders, closed by its quote so `folder` does not match `folder-add`. */
const iconHref = (name: string): string => `#oc-${name}"`;

const renderList = (isAllFoldersView: boolean): string =>
  renderWithProviders(
    React.createElement(SidebarProjectsList, {
      sectionsForRender: [section],
      projectSections: [section],
      activeProjectId: null,
      showOnlyMainWorkspace: false,
      hasSessionSearchQuery: false,
      emptyState: null,
      searchEmptyState: null,
      isAllFoldersView,
      renderSessionNode: () => null,
      renderGroupSessions: () => null,
      getOrderedGroups: (_projectId, groups) => groups,
      setGroupOrderByProject: noop,
      homeDirectory: null,
      collapsedProjects: new Set<string>(),
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
    }),
  );

const globalSection: ProjectSection = {
  project: {
    id: '__home__',
    label: 'No folder',
    normalizedPath: '~',
  },
  groups: [
    {
      id: 'global',
      label: 'No folder',
      branch: null,
      description: null,
      isMain: true,
      directory: '~',
      sessions: [
        {
          session: {
            id: 'global-session',
            directory: '~',
            title: 'Global session',
            time: { created: 1, updated: 1 },
          },
          children: [],
        },
      ],
    },
  ],
};

const renderGlobalSection = (isAllFoldersView: boolean): string =>
  renderWithProviders(
    React.createElement(SidebarProjectsList, {
      sectionsForRender: [],
      allFoldersOnlySection: globalSection,
      projectSections: [],
      activeProjectId: null,
      showOnlyMainWorkspace: false,
      hasSessionSearchQuery: false,
      emptyState: null,
      searchEmptyState: null,
      isAllFoldersView,
      renderSessionNode: (node, _depth, _directory, _projectId, _archived, secondaryMeta) =>
        React.createElement(
          'span',
          {
            'data-session-id': node.session.id,
            'data-global-session': secondaryMeta?.globalSession ? '1' : '0',
          },
          node.session.title,
        ),
      renderGroupSessions: () => null,
      getOrderedGroups: (_projectId, groups) => groups,
      setGroupOrderByProject: noop,
      homeDirectory: '/home/tester',
      collapsedProjects: new Set<string>(),
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
    }),
  );

describe('SidebarProjectsList folder identity placement', () => {
  test('does not show a project identity over the mixed All sessions list', () => {
    expect(renderList(true)).not.toContain('oc-sticky-fade-overlay');
  });

  test('does not duplicate the selected folder over a project session list', () => {
    expect(renderList(false)).not.toContain('oc-sticky-fade-overlay');
  });

  test('renders unowned home sessions only in All sessions and marks them for the global shade', () => {
    expect(renderGlobalSection(true)).toContain('data-session-id="global-session"');
    expect(renderGlobalSection(true)).toContain('data-global-session="1"');
    expect(renderGlobalSection(false)).not.toContain('global-session');
  });
});

describe('SidebarProjectsList view modes', () => {
  test('workspace mode produces identical markup whether viewMode is omitted or "workspace"', () => {
    const baseProps = {
      sectionsForRender: [section],
      projectSections: [section],
      activeProjectId: null,
      showOnlyMainWorkspace: false,
      hasSessionSearchQuery: false,
      emptyState: React.createElement('div', null, 'Empty'),
      searchEmptyState: React.createElement('div', null, 'Search Empty'),
      isAllFoldersView: false,
      renderSessionNode: () => null,
      renderGroupSessions: () => React.createElement('div', null, 'Group Sessions'),
      getOrderedGroups: (_projectId: string, groups: ProjectSection['groups']) => groups,
      setGroupOrderByProject: noop,
      homeDirectory: null,
      collapsedProjects: new Set<string>(),
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
    };

    const markupOmitted = renderWithProviders(React.createElement(SidebarProjectsList, baseProps));
    const markupWorkspace = renderWithProviders(
      React.createElement(SidebarProjectsList, { ...baseProps, viewMode: 'workspace' }),
    );

    expect(markupOmitted).toBe(markupWorkspace);
  });

  test('timeline mode groups sessions by bucket and renders headings in order', () => {
    // Friday Oct 16, 2026 at 14:00:00 local time (weekStart = 1 -> Monday Oct 12)
    const now = new Date(2026, 9, 16, 14, 0, 0, 0).getTime();
    const boundaries = getTimelineBoundaries(now, 1);

    const makeNode = (id: string, title: string, updated: number): SessionNode => ({
      session: {
        id,
        title,
        directory: `/project/${id}`,
        time: { created: updated, updated },
      },
      children: [],
    });

    const nodePinned = makeNode('s-pinned', 'Pinned Session', boundaries.startOfLastWeek - 100_000);
    const nodeToday = makeNode('s-today', 'Today Session', now - 1000);
    const nodeYesterday = makeNode('s-yesterday', 'Yesterday Session', boundaries.startOfYesterday + 1000);
    const nodeThisWeek = makeNode('s-this-week', 'This Week Session', boundaries.startOfThisWeek + 1000);
    const nodeLastWeek = makeNode('s-last-week', 'Last Week Session', boundaries.startOfLastWeek + 1000);
    const nodeOlder = makeNode('s-older', 'Older Session', boundaries.startOfLastWeek - 50_000);

    const projectA: ProjectSection = {
      project: { id: 'proj-a', label: 'Alpha Project', normalizedPath: '/projects/alpha' },
      groups: [
        {
          id: 'main-a',
          label: 'main',
          branch: 'main',
          description: null,
          isMain: true,
          directory: '/projects/alpha',
          sessions: [nodePinned, nodeToday, nodeYesterday],
        },
      ],
    };

    const projectB: ProjectSection = {
      project: { id: 'proj-b', label: 'Beta Project', normalizedPath: '/projects/beta' },
      groups: [
        {
          id: 'main-b',
          label: 'main',
          branch: 'main',
          description: null,
          isMain: true,
          directory: '/projects/beta',
          sessions: [nodeThisWeek, nodeLastWeek],
        },
      ],
    };

    const homeSection: ProjectSection = {
      project: { id: '__home__', label: 'No folder', normalizedPath: '~' },
      groups: [
        {
          id: 'home-group',
          label: 'No folder',
          branch: null,
          description: null,
          isMain: true,
          directory: '~',
          sessions: [nodeOlder],
        },
      ],
    };

    const markup = renderWithProviders(
      React.createElement(SidebarProjectsList, {
        viewMode: 'timeline',
        timelineBoundaries: boundaries,
        sectionsForRender: [projectA, projectB],
        allFoldersOnlySection: homeSection,
        projectSections: [projectA, projectB],
        activeProjectId: null,
        showOnlyMainWorkspace: false,
        hasSessionSearchQuery: false,
        emptyState: React.createElement('div', null, 'Empty'),
        searchEmptyState: React.createElement('div', null, 'Search Empty'),
        pinnedSessionIds: new Set(['s-pinned']),
        renderSessionNode: (node, _depth, groupDirectory, projectId, _archived, secondaryMeta) =>
          React.createElement(
            'div',
            {
              'data-session-id': node.session.id,
              'data-project-id': projectId,
              'data-project-label': secondaryMeta?.projectLabel,
              'data-show-folder-label': secondaryMeta?.showFolderLabel ? '1' : '0',
            },
            node.session.title,
          ),
        renderGroupSessions: () => null,
        getOrderedGroups: (_projectId, groups) => groups,
        setGroupOrderByProject: noop,
        homeDirectory: '/home/tester',
        collapsedProjects: new Set<string>(),
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
      }),
    );

    // Headings appear in order
    const pinnedIdx = markup.indexOf('Pinned');
    const todayIdx = markup.indexOf('Today');
    const yesterdayIdx = markup.indexOf('Yesterday');
    const thisWeekIdx = markup.indexOf('This week');
    const lastWeekIdx = markup.indexOf('Last week');
    const olderIdx = markup.indexOf('Older');

    expect(pinnedIdx).toBeGreaterThanOrEqual(0);
    expect(todayIdx).toBeGreaterThan(pinnedIdx);
    expect(yesterdayIdx).toBeGreaterThan(todayIdx);
    expect(thisWeekIdx).toBeGreaterThan(yesterdayIdx);
    expect(lastWeekIdx).toBeGreaterThan(thisWeekIdx);
    expect(olderIdx).toBeGreaterThan(lastWeekIdx);

    // Sessions under their respective buckets
    expect(markup).toContain('data-timeline-bucket="pinned"');
    expect(markup).toContain('data-timeline-bucket="today"');
    expect(markup).toContain('data-timeline-bucket="yesterday"');
    expect(markup).toContain('data-timeline-bucket="thisWeek"');
    expect(markup).toContain('data-timeline-bucket="lastWeek"');
    expect(markup).toContain('data-timeline-bucket="older"');

    // Folder labels passed
    expect(markup).toContain('data-project-label="Alpha Project"');
    expect(markup).toContain('data-project-label="Beta Project"');
    expect(markup).toContain('data-project-label="No Folder"');
    expect(markup).toContain('data-show-folder-label="1"');
  });

  test('timeline pagination/perf guard: 5000 sessions renders 30 and shows remaining count', () => {
    const now = new Date(2026, 9, 16, 14, 0, 0, 0).getTime();
    const boundaries = getTimelineBoundaries(now, 1);

    const manySessions: SessionNode[] = Array.from({ length: 5000 }, (_, i) => ({
      session: {
        id: `s-${i}`,
        title: `Session ${i}`,
        directory: '/projects/big',
        time: { created: now - i * 1000, updated: now - i * 1000 },
      },
      children: [],
    }));

    const bigSection: ProjectSection = {
      project: { id: 'big-proj', label: 'Big Project', normalizedPath: '/projects/big' },
      groups: [
        {
          id: 'main-big',
          label: 'main',
          branch: 'main',
          description: null,
          isMain: true,
          directory: '/projects/big',
          sessions: manySessions,
        },
      ],
    };

    let renderSessionNodeCalls = 0;
    const markup = renderWithProviders(
      React.createElement(SidebarProjectsList, {
        viewMode: 'timeline',
        timelineBoundaries: boundaries,
        sectionsForRender: [bigSection],
        projectSections: [bigSection],
        activeProjectId: null,
        showOnlyMainWorkspace: false,
        hasSessionSearchQuery: false,
        emptyState: null,
        searchEmptyState: null,
        renderSessionNode: (node) => {
          renderSessionNodeCalls++;
          return React.createElement('div', { key: node.session.id }, node.session.title);
        },
        renderGroupSessions: () => null,
        getOrderedGroups: (_projectId, groups) => groups,
        setGroupOrderByProject: noop,
        homeDirectory: '/home/tester',
        collapsedProjects: new Set<string>(),
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
      }),
    );

    expect(renderSessionNodeCalls).toBe(30);
    expect(markup).toContain('Show 4970 more sessions');
  });

  test('timeline empty states: renders emptyState and searchEmptyState', () => {
    const renderEmpty = (hasSearch: boolean) =>
      renderWithProviders(
        React.createElement(SidebarProjectsList, {
          viewMode: 'timeline',
          sectionsForRender: [section],
          projectSections: [section],
          allFoldersOnlySection: null,
          activeProjectId: null,
          showOnlyMainWorkspace: false,
          hasSessionSearchQuery: hasSearch,
          emptyState: React.createElement('div', { 'data-testid': 'empty-state' }, 'No sessions'),
          searchEmptyState: React.createElement(
            'div',
            { 'data-testid': 'search-empty-state' },
            'No matching sessions',
          ),
          renderSessionNode: () => null,
          renderGroupSessions: () => null,
          getOrderedGroups: (_projectId, groups) => groups,
          setGroupOrderByProject: noop,
          homeDirectory: null,
          collapsedProjects: new Set<string>(),
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
        }),
      );

    expect(renderEmpty(false)).toContain('data-testid="empty-state"');
    expect(renderEmpty(true)).toContain('data-testid="search-empty-state"');
  });

  test('folder mode renders folder tree, handles collapse and search expansion, and "Add folder"', () => {
    const makeProjectSection = (id: string, label: string): ProjectSection => ({
      project: { id, label, normalizedPath: `/projects/${id}` },
      groups: [
        {
          id: `group-${id}`,
          label: 'main',
          branch: 'main',
          description: null,
          isMain: true,
          directory: `/projects/${id}`,
          sessions: [
            {
              session: {
                id: `sess-${id}`,
                title: `Session in ${label}`,
                directory: `/projects/${id}`,
                time: { created: 1, updated: 1 },
              },
              children: [],
            },
          ],
        },
      ],
    });

    const folder1 = makeProjectSection('f1', 'Folder One');
    const folder2 = makeProjectSection('f2', 'Folder Two');
    const folder3 = makeProjectSection('f3', 'Folder Three');

    const homeSec: ProjectSection = {
      project: { id: '__home__', label: 'No folder', normalizedPath: '~' },
      groups: [
        {
          id: 'home-group',
          label: 'No folder',
          branch: null,
          description: null,
          isMain: true,
          directory: '~',
          sessions: [
            {
              session: {
                id: 'home-sess-1',
                title: 'Home Session',
                directory: '~',
                time: { created: 1, updated: 1 },
              },
              children: [],
            },
          ],
        },
      ],
    };

    const renderedGroupKeys: string[] = [];
    const renderFolderTree = (collapsedSet: Set<string>, hasSearch: boolean, hideDir: boolean) =>
      renderWithProviders(
        React.createElement(SidebarProjectsList, {
          viewMode: 'folder',
          sectionsForRender: [folder1, folder2, folder3],
          projectSections: [folder1, folder2, folder3],
          allFoldersOnlySection: homeSec,
          activeProjectId: 'f1',
          showOnlyMainWorkspace: false,
          hasSessionSearchQuery: hasSearch,
          emptyState: React.createElement('div', null, 'Empty'),
          searchEmptyState: React.createElement('div', null, 'Search Empty'),
          renderSessionNode: (node) =>
            React.createElement('div', { key: node.session.id, 'data-session': node.session.id }, node.session.title),
          renderGroupSessions: (group, groupKey, projectId) => {
            renderedGroupKeys.push(`${projectId}|${groupKey}`);
            return React.createElement('div', { key: groupKey, 'data-group-key': groupKey }, group.label);
          },
          getOrderedGroups: (_projectId, groups) => groups,
          setGroupOrderByProject: noop,
          homeDirectory: '/home/tester',
          collapsedProjects: collapsedSet,
          hideDirectoryControls: hideDir,
          stickyFolderHeaders: true,
          onOpenDirectoryDialog: noop,
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
        }),
      );

    // Initial render: folder2 is collapsed
    renderedGroupKeys.length = 0;
    const markupCollapsed = renderFolderTree(new Set(['f2']), false, false);

    // All folders visible simultaneously in order
    const f1Idx = markupCollapsed.indexOf('Folder One');
    const f2Idx = markupCollapsed.indexOf('Folder Two');
    const f3Idx = markupCollapsed.indexOf('Folder Three');
    const homeIdx = markupCollapsed.indexOf('No folder');
    expect(f1Idx).toBeGreaterThanOrEqual(0);
    expect(f2Idx).toBeGreaterThan(f1Idx);
    expect(f3Idx).toBeGreaterThan(f2Idx);
    expect(homeIdx).toBeGreaterThan(f3Idx);

    // Group sessions rendered for expanded folders, NOT for collapsed folder2
    expect(renderedGroupKeys).toContain('f1|f1:group-f1');
    expect(renderedGroupKeys).toContain('f3|f3:group-f3');
    expect(renderedGroupKeys).not.toContain('f2|f2:group-f2');

    // Folder 2 header has aria-expanded="false"
    expect(markupCollapsed).toContain('aria-expanded="false"');

    // Only the expanded folders (f1, f3) get a sticky header: a collapsed one has nothing to stick over
    expect(markupCollapsed.split('data-sidebar-sticky-header="true"').length - 1).toBe(2);

    // The folder icon stays on every header and the collapse chevron is a separate, always-rendered marker
    expect(markupCollapsed.split(iconHref('folder')).length - 1).toBe(4);
    expect(markupCollapsed.split(iconHref('arrow-down-s')).length - 1).toBe(3);
    expect(markupCollapsed.split(iconHref('arrow-right-s')).length - 1).toBe(1);

    // "No folder" sessions are rendered
    expect(markupCollapsed).toContain('data-session="home-sess-1"');

    // "Add folder" button is present
    expect(markupCollapsed).toContain('Add folder');

    // When searching: collapsed folder is rendered expanded
    renderedGroupKeys.length = 0;
    const markupSearching = renderFolderTree(new Set(['f2']), true, false);
    expect(markupSearching).toContain('Folder Two');
    expect(renderedGroupKeys).toContain('f2|f2:group-f2');
    expect(markupSearching.split('data-sidebar-sticky-header="true"').length - 1).toBe(3);

    // When hideDirectoryControls is true: "Add folder" is hidden
    const markupHideControls = renderFolderTree(new Set(), false, true);
    expect(markupHideControls).not.toContain('Add folder');
  });

  test('folder scale guard: 200 collapsed folders mount 0 group sessions', () => {
    const folders200: ProjectSection[] = Array.from({ length: 200 }, (_, i) => ({
      project: { id: `p-${i}`, label: `Project ${i}`, normalizedPath: `/projects/p-${i}` },
      groups: [
        {
          id: `g-${i}`,
          label: 'main',
          branch: 'main',
          description: null,
          isMain: true,
          directory: `/projects/p-${i}`,
          sessions: [
            {
              session: {
                id: `s-${i}`,
                title: `Session ${i}`,
                directory: `/projects/p-${i}`,
                time: { created: 1, updated: 1 },
              },
              children: [],
            },
          ],
        },
      ],
    }));

    const allCollapsed = new Set(folders200.map((f) => f.project.id));
    let renderGroupSessionsCalls = 0;

    const markup = renderWithProviders(
      React.createElement(SidebarProjectsList, {
        viewMode: 'folder',
        sectionsForRender: folders200,
        projectSections: folders200,
        activeProjectId: null,
        showOnlyMainWorkspace: false,
        hasSessionSearchQuery: false,
        emptyState: null,
        searchEmptyState: null,
        renderSessionNode: () => null,
        renderGroupSessions: () => {
          renderGroupSessionsCalls++;
          return null;
        },
        getOrderedGroups: (_projectId, groups) => groups,
        setGroupOrderByProject: noop,
        homeDirectory: '/home/tester',
        collapsedProjects: allCollapsed,
        hideDirectoryControls: false,
        stickyFolderHeaders: true,
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
      }),
    );

    expect(renderGroupSessionsCalls).toBe(0);
    // Collapsed folders must not become sticky boxes or scroll-state containers:
    // the scroller tracks each of those on every scroll frame.
    expect(markup).not.toContain('data-sidebar-sticky-header');
    expect(markup).not.toContain('oc-sidebar-sticky-header');
    for (let i = 0; i < 200; i++) {
      expect(markup).toContain(`Project ${i}`);
    }
  });
});
