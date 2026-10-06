import React from 'react';
import { useTranslation } from 'react-i18next';
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
import { SidebarSessionLikeButton } from './sidebarRowChrome';
import { getProjectLabel } from './utils';
import { treeRowGapClassName } from './sessionRowVariant';

// Rows keep the full sidebar width; the `tree` session row variant indents
// its own content under the folder label.
const folderBodyClassName = 'pt-0.5 pb-1';

interface SidebarFolderTreeProps {
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
  sections,
  homeSection,
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
  const { t } = useTranslation();

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

  const visibleHomeSessions = hasSessionSearchQuery
    ? allHomeSessions
    : allHomeSessions.slice(0, homeLimit);

  const remainingHomeCount = allHomeSessions.length - visibleHomeSessions.length;
  const isHomeCollapsed = hasSessionSearchQuery ? false : collapsedProjects.has('__home__');

  if (sections.length === 0 && !homeSection) {
    return hasSessionSearchQuery ? searchEmptyState : emptyState;
  }

  return (
    <div className="space-y-2">
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
                projectDescription={projectDescription}
                isCollapsed={isCollapsed}
                hideDirectoryControls={hideDirectoryControls}
                mobileVariant={mobileVariant}
                alwaysShowActions={alwaysShowActions}
                stickyHeader={stickyFolderHeaders}
                statusIndicator={isCollapsed ? renderProjectStatusIndicator?.(projectKey, section.groups) : null}
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
                projectLabel={t("No folder")}
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
                    ? t("Show 1 more session")
                    : t('Show {{count}} more sessions', { count: remainingHomeCount })}
                </SidebarSessionLikeButton>
              ) : null}
              {!hasSessionSearchQuery && homeLimit > 5 && allHomeSessions.length > 5 ? (
                <SidebarSessionLikeButton
                  icon="arrow-up-s"
                  mobileVariant={mobileVariant}
                  onClick={() => setHomeLimit(5)}
                >
                  {t("Show fewer sessions")}
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
          {t("Add folder")}
        </SidebarSessionLikeButton>
      ) : null}
    </div>
  );
};

export const SidebarFolderTree = React.memo(SidebarFolderTreeComponent);
