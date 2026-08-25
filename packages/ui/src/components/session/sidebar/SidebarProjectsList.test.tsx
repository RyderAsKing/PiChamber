import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarProjectsList } from './SidebarProjectsList';

const project = {
  id: 'root',
  label: 'Root',
  normalizedPath: '/root',
};
const section = { project, groups: [] };
const noop = () => undefined;

const renderList = (isAllFoldersView: boolean): string => renderToStaticMarkup(
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

const globalSection = {
  project: {
    id: '__home__',
    label: 'No folder',
    normalizedPath: '~',
  },
  groups: [{
    id: 'global',
    label: 'No folder',
    branch: null,
    description: null,
    isMain: true,
    directory: '~',
    sessions: [{
      session: { id: 'global-session', directory: '~', title: 'Global session', time: { created: 1, updated: 1 } },
      children: [],
    }],
  }],
};

const renderGlobalSection = (isAllFoldersView: boolean): string => renderToStaticMarkup(
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
    renderSessionNode: (node, _depth, _directory, _projectId, _archived, secondaryMeta) => React.createElement(
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
  test('does not show a project identity over the mixed All Folders session list', () => {
    expect(renderList(true)).not.toContain('oc-sticky-fade-overlay');
  });

  test('does not duplicate the selected folder over a project session list', () => {
    expect(renderList(false)).not.toContain('oc-sticky-fade-overlay');
  });

  test('renders unowned home sessions only in All folders and marks them for the global shade', () => {
    expect(renderGlobalSection(true)).toContain('data-session-id="global-session"');
    expect(renderGlobalSection(true)).toContain('data-global-session="1"');
    expect(renderGlobalSection(false)).not.toContain('global-session');
  });
});
