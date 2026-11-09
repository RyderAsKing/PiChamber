import React from 'react';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { formatPathForDisplay } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { MainTab } from '@/stores/useUIStore';
import type { SessionGroup, SessionNode, ProjectSection } from './types';
import { ProjectHeaderIdentity, ProjectHeaderChevron, SortableProjectItem, type SortableDragHandleProps } from './sortableItems';
import { SidebarSectionHeading, SidebarSessionLikeButton } from './sidebarRowChrome';
import { getProjectLabel } from './utils';
import { treeRowGapClassName } from './sessionRowVariant';
import type { SessionShelves } from './sessionShelves';
import { SessionShelfRowContext, type SessionShelfRowState } from './sessionShelfRowContext';
import { SessionShelfStack, type ShelfId, type ThreadsListItem } from './SidebarThreadsList';

const FOLDER_SHELVES: readonly ShelfId[] = ['snoozed', 'settled'];

/**
 * Takes pinned, snoozed, and settled sessions out of their folders; they show
 * once, above or below the folder list. Archived groups are left alone.
 */
const withoutShelvedSessions = (section: ProjectSection, hidden: ReadonlySet<string>): ProjectSection => {
  let changed = false;
  const groups = section.groups.map((group) => {
    if (group.isArchivedBucket) return group;
    const sessions = group.sessions.filter((node) => !hidden.has(node.session.id));
    if (sessions.length === group.sessions.length) return group;
    changed = true;
    return { ...group, sessions };
  });
  return changed ? { ...section, groups } : section;
};

const countSessions = (section: ProjectSection): number =>
  section.groups.reduce((total, group) => (group.isArchivedBucket ? total : total + group.sessions.length), 0);

// Rows keep the full sidebar width; the `tree` session row variant indents
// its own content under the folder label.
const folderBodyClassName = 'pt-0.5 pb-1';

interface SidebarFolderTreeProps {
  /** Shelf partition; null while searching, when sessions stay in their folders. */
  shelves?: SessionShelves<ThreadsListItem> | null;
  sections: ProjectSection[];
  homeSection?: ProjectSection | null;
  homeDirectory: string | null;
  collapsedProjects: Set<string>;
  toggleProject: (id: string) => void;
  hasSessionSearchQuery: boolean;
  activeProjectId: string | null;
  hideDirectoryControls: boolean;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  isInlineEditing: boolean;
  stickyFolderHeaders?: boolean;
  renderGroupSessions: (
    group: SessionGroup,
    groupKey: string,
    projectId?: string | null,
    hideGroupLabel?: boolean,
    dragHandleProps?: SortableDragHandleProps | null,
    compactBodyPadding?: boolean,
    scrollContainerRef?: React.RefObject<HTMLElement | null>,
  ) => React.ReactNode;
  renderSessionNode?: (
    node: SessionNode,
    depth?: number,
    groupDirectory?: string | null,
    projectId?: string | null,
    archivedBucket?: boolean,
    secondaryMeta?: { projectLabel?: string | null; branchLabel?: string | null; showFolderLabel?: boolean; globalSession?: boolean } | null,
    renderContext?: 'project' | 'recent',
  ) => React.ReactNode;
  getOrderedGroups: (projectId: string, groups: SessionGroup[]) => SessionGroup[];
  renderProjectStatusIndicator?: (projectId: string, groups: SessionGroup[]) => React.ReactNode;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  setActiveProjectIdOnly: (id: string) => void;
  setActiveMainTab: (tab: MainTab) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null }) => void;
  openProjectEditDialog: (id: string) => void;
  removeProject: (id: string) => void;
  reorderProjects: (fromIndex: number, toIndex: number) => void;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  onOpenDirectoryDialog?: () => void;
  emptyState: React.ReactNode;
  searchEmptyState: React.ReactNode;
}

const SidebarFolderTreeComponent: React.FC<SidebarFolderTreeProps> = ({
  shelves = null,
  sections: allSections,
  homeSection: allHomeSection,
  homeDirectory,
  collapsedProjects,
  toggleProject,
  hasSessionSearchQuery,
  activeProjectId,
  hideDirectoryControls,
  mobileVariant,
  alwaysShowActions,
  isInlineEditing,
  stickyFolderHeaders,
  renderGroupSessions,
  renderSessionNode,
  getOrderedGroups,
  renderProjectStatusIndicator,
  scrollContainerRef,
  setActiveProjectIdOnly,
  setActiveMainTab,
  setSessionSwitcherOpen,
  openNewSessionDraft,
  openProjectEditDialog,
  removeProject,
  reorderProjects,
  openSidebarMenuKey,
  setOpenSidebarMenuKey,
  onOpenDirectoryDialog,
  emptyState,
  searchEmptyState,
}) => {
  const hiddenIds = React.useMemo(() => {
    if (!shelves) return null;
    const ids = new Set<string>();
    for (const item of [...shelves.pinned, ...shelves.snoozed, ...shelves.settled]) ids.add(item.node.session.id);
    return ids;
  }, [shelves]);
  const sections = React.useMemo(
    () => (hiddenIds ? allSections.map((section) => withoutShelvedSessions(section, hiddenIds)) : allSections),
    [allSections, hiddenIds],
  );
  const homeSection = React.useMemo(
    () => (hiddenIds && allHomeSection ? withoutShelvedSessions(allHomeSection, hiddenIds) : allHomeSection),
    [allHomeSection, hiddenIds],
  );
  const rowState = React.useMemo<SessionShelfRowState | null>(
    () => (shelves ? { sectionById: shelves.sectionById, wokeIds: shelves.wokeIds } : null),
    [shelves],
  );
  const renderShelfItem = (item: ThreadsListItem) => (
    <React.Fragment key={item.node.session.id}>
      {renderSessionNode?.(
        item.node,
        0,
        item.node.session.directory ?? item.project.normalizedPath,
        item.project.id,
        false,
        { projectLabel: item.projectLabel, globalSession: item.globalSession },
        'project',
      )}
    </React.Fragment>
  );

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );

  const canSort = sections.length > 1 && !hasSessionSearchQuery && !isInlineEditing;

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      if (isInlineEditing || hasSessionSearchQuery) return;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const storeProjects = useProjectsStore.getState().projects;
      const fromIndex = storeProjects.findIndex((project) => project.id === active.id);
      const toIndex = storeProjects.findIndex((project) => project.id === over.id);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
      reorderProjects(fromIndex, toIndex);
    },
    [isInlineEditing, hasSessionSearchQuery, reorderProjects],
  );

  const [homeLimit, setHomeLimit] = React.useState(5);
  React.useEffect(() => {
    setHomeLimit(5);
  }, [hasSessionSearchQuery]);

  const allHomeSessions = React.useMemo(() => {
    if (!homeSection) return [];
    return homeSection.groups
      .filter((group) => !group.isArchivedBucket)
      .flatMap((group) => group.sessions);
  }, [homeSection]);

  const visibleHomeSessions = hasSessionSearchQuery || shelves
    ? allHomeSessions
    : allHomeSessions.slice(0, homeLimit);

  const remainingHomeCount = allHomeSessions.length - visibleHomeSessions.length;
  const isHomeCollapsed = hasSessionSearchQuery ? false : collapsedProjects.has('__home__');

  if (sections.length === 0 && !homeSection) {
    return hasSessionSearchQuery ? searchEmptyState : emptyState;
  }

  return (
    <SessionShelfRowContext.Provider value={rowState}>
    <div className="space-y-2">
      {shelves && shelves.pinned.length > 0 ? (
        <section aria-label={'Pinned'} data-session-shelf="pinned">
          <SidebarSectionHeading label={'Pinned'} first />
          {shelves.pinned.map(renderShelfItem)}
        </section>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={sections.map((s) => s.project.id)}
          strategy={verticalListSortingStrategy}
        >
          {sections.map((section) => {
            const project = section.project;
            const projectKey = project.id;
            const projectLabel = getProjectLabel(project, homeDirectory);
            const projectDescription = formatPathForDisplay(project.normalizedPath, homeDirectory);
            const isCollapsed = hasSessionSearchQuery ? false : collapsedProjects.has(projectKey);

            const orderedGroups = isCollapsed ? [] : getOrderedGroups(projectKey, section.groups);
            const rootGroup = isCollapsed ? null : (orderedGroups.find((group) => group.isMain) ?? null);
            const nestedGroups = isCollapsed
              ? []
              : rootGroup
                ? orderedGroups.filter((group) => group.id !== rootGroup.id)
                : orderedGroups;

            return (
              <SortableProjectItem
                key={projectKey}
                id={projectKey}
                disabled={!canSort}
                projectLabel={projectLabel}
                projectPath={project.normalizedPath}
                projectDescription={projectDescription}
                isCollapsed={isCollapsed}
                hideDirectoryControls={hideDirectoryControls}
                mobileVariant={mobileVariant}
                alwaysShowActions={alwaysShowActions}
                stickyHeader={stickyFolderHeaders}
                statusIndicator={isCollapsed ? renderProjectStatusIndicator?.(projectKey, section.groups) : null}
                sessionCount={isCollapsed ? countSessions(section) : null}
                onToggle={() => toggleProject(projectKey)}
                onNewSession={() => {
                  if (projectKey !== activeProjectId) {
                    setActiveProjectIdOnly(projectKey);
                  }
                  setActiveMainTab('chat');
                  if (mobileVariant) {
                    setSessionSwitcherOpen(false);
                  }
                  openNewSessionDraft({
                    selectedProjectId: projectKey,
                    directoryOverride: project.normalizedPath,
                  });
                }}
                onRenameStart={() => openProjectEditDialog(projectKey)}
                onClose={() => removeProject(projectKey)}
                openSidebarMenuKey={openSidebarMenuKey}
                setOpenSidebarMenuKey={setOpenSidebarMenuKey}
              >
                {!isCollapsed ? (
                  <div className={folderBodyClassName}>
                    {rootGroup
                      ? renderGroupSessions(
                          rootGroup,
                          `${projectKey}:${rootGroup.id}`,
                          projectKey,
                          true,
                          null,
                          undefined,
                          scrollContainerRef,
                        )
                      : null}
                    {nestedGroups.map((group) => {
                      const groupKey = `${projectKey}:${group.id}`;
                      const hideGroupLabel = orderedGroups.length === 1;
                      return (
                        <React.Fragment key={group.id}>
                          {renderGroupSessions(
                            group,
                            groupKey,
                            projectKey,
                            hideGroupLabel,
                            null,
                            undefined,
                            scrollContainerRef,
                          )}
                        </React.Fragment>
                      );
                    })}
                  </div>
                ) : null}
              </SortableProjectItem>
            );
          })}
        </SortableContext>
      </DndContext>

      {homeSection ? (
        <div>
          <div data-sidebar-tree-row="" className="relative flex items-center gap-1 py-1.5 px-3 rounded-xl transition-colors hover:bg-interactive-hover">
            <button
              type="button"
              aria-expanded={!isHomeCollapsed}
              style={{ touchAction: 'manipulation' }}
              onClick={() => toggleProject('__home__')}
              className={`${treeRowGapClassName} flex-1 min-w-0 flex items-center text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 rounded-md`}
            >
              <ProjectHeaderIdentity
                id="__home__"
                projectLabel="No folder"
                mobileVariant={mobileVariant}
              />
              <ProjectHeaderChevron isCollapsed={isHomeCollapsed} mobileVariant={mobileVariant} />
            </button>
          </div>

          {!isHomeCollapsed ? (
            <div className={folderBodyClassName}>
              {visibleHomeSessions.map((node) => (
                <React.Fragment key={node.session.id}>
                  {renderSessionNode?.(
                    node,
                    0,
                    node.session.directory ?? '~',
                    '__home__',
                    false,
                    { globalSession: true },
                    'project',
                  )}
                </React.Fragment>
              ))}
              {!hasSessionSearchQuery && remainingHomeCount > 0 ? (
                <SidebarSessionLikeButton
                  icon="arrow-down-s"
                  mobileVariant={mobileVariant}
                  onClick={() => setHomeLimit((prev) => prev + 7)}
                >
                  {remainingHomeCount === 1
                    ? "Show 1 more session"
                    : `Show ${remainingHomeCount} more sessions`}
                </SidebarSessionLikeButton>
              ) : null}
              {!hasSessionSearchQuery && homeLimit > 5 && allHomeSessions.length > 5 ? (
                <SidebarSessionLikeButton
                  icon="arrow-up-s"
                  mobileVariant={mobileVariant}
                  onClick={() => setHomeLimit(5)}
                >
                  {"Show fewer sessions"}
                </SidebarSessionLikeButton>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {!hideDirectoryControls && onOpenDirectoryDialog ? (
        <SidebarSessionLikeButton
          icon="add"
          mobileVariant={mobileVariant}
          onClick={onOpenDirectoryDialog}
        >
          {"Add folder"}
        </SidebarSessionLikeButton>
      ) : null}

      {shelves ? (
        <SessionShelfStack
          shelfIds={FOLDER_SHELVES}
          shelves={shelves}
          renderItem={renderShelfItem}
          hasSessionSearchQuery={hasSessionSearchQuery}
          mobileVariant={mobileVariant}
        />
      ) : null}
    </div>
    </SessionShelfRowContext.Provider>
  );
};

export const SidebarFolderTree = React.memo(SidebarFolderTreeComponent);
