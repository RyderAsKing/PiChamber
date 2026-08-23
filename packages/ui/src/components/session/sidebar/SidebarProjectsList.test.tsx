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

describe('SidebarProjectsList folder identity placement', () => {
  test('does not show a project identity over the mixed All Folders session list', () => {
    expect(renderList(true)).not.toContain('oc-sticky-fade-overlay');
  });

  test('does not duplicate the selected folder over a project session list', () => {
    expect(renderList(false)).not.toContain('oc-sticky-fade-overlay');
  });
});
