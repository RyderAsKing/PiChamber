import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { cn } from '@/lib/utils';
import type { SessionGroup, SessionNode, ProjectSection } from './types';
import { getProjectLabel } from './utils';
import { SidebarSessionLikeButton } from './sidebarRowChrome';
import { streamPerfCount } from '@/stores/utils/streamDebug';
import type { SortableDragHandleProps } from './sortableItems';
import type { MainTab } from '@/stores/useUIStore';
import type { SidebarViewMode } from '@/lib/sidebarViewMode';
import {
  type TimelineBoundaries,
  TIMELINE_BUCKET_LABELS,
  getTimelineBoundaries,
  groupTimelineItems,
} from './timelineBuckets';
import { SidebarFolderTree } from './SidebarFolderTree';
import { SessionRowVariantContext } from './sessionRowVariant';

export type { ProjectSection };

type Props = {
  topContent?: React.ReactNode;
  sharedSessionsOnly?: boolean;
  hasSharedSessions?: boolean;
  sectionsForRender: ProjectSection[];
  allFoldersOnlySection?: ProjectSection | null;
  projectSections: ProjectSection[];
  activeProjectId: string | null;
  showOnlyMainWorkspace: boolean;
  hasSessionSearchQuery: boolean;
  emptyState: React.ReactNode;
  searchEmptyState: React.ReactNode;
  isAllFoldersView?: boolean;
  pinnedSessionIds?: Set<string>;
  viewMode?: SidebarViewMode;
  timelineBoundaries?: TimelineBoundaries | null;
  onOpenDirectoryDialog?: () => void;
  stickyFolderHeaders?: boolean;
  renderSessionNode?: (
    node: SessionNode,
    depth?: number,
    groupDirectory?: string | null,
    projectId?: string | null,
    archivedBucket?: boolean,
    secondaryMeta?: { projectLabel?: string | null; branchLabel?: string | null; showFolderLabel?: boolean; globalSession?: boolean } | null,
    renderContext?: 'project' | 'recent',
  ) => React.ReactNode;
  renderGroupSessions: (
    group: SessionGroup,
    groupKey: string,
    projectId?: string | null,
    hideGroupLabel?: boolean,
    dragHandleProps?: SortableDragHandleProps | null,
    compactBodyPadding?: boolean,
    scrollContainerRef?: React.RefObject<HTMLElement | null>,
  ) => React.ReactNode;
  getOrderedGroups: (projectId: string, groups: SessionGroup[]) => SessionGroup[];
  setGroupOrderByProject: React.Dispatch<React.SetStateAction<Map<string, string[]>>>;
  renderProjectStatusIndicator?: (projectId: string, groups: SessionGroup[]) => React.ReactNode;
  homeDirectory: string | null;
  collapsedProjects: Set<string>;
  hideDirectoryControls: boolean;
  projectRepoStatus: Map<string, boolean | null>;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  toggleProject: (id: string) => void;
  setActiveProjectIdOnly: (id: string) => void;
  setActiveMainTab: (tab: MainTab) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null }) => void;
  openProjectEditDialog: (id: string) => void;
  removeProject: (id: string) => void;
  reorderProjects: (fromIndex: number, toIndex: number) => void;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  isInlineEditing: boolean;
};

function SidebarProjectsListComponent(props: Props): React.ReactNode {
  streamPerfCount('ui.sidebar_projects_list.render');

  const viewMode = props.viewMode ?? 'workspace';
  const isTimeline = viewMode === 'timeline';

  // Memoize getOrderedGroups per project so downstream consumers see a stable
  // array reference while inputs are unchanged (avoids O(P) fresh arrays per
  // list render invalidating the memoized group subtrees).
  const orderedGroupsCacheRef = React.useRef<Map<string, { groups: SessionGroup[]; ordered: SessionGroup[] }>>(new Map());
  const orderedGroupsCacheGetOrderedGroupsRef = React.useRef<typeof props.getOrderedGroups>(props.getOrderedGroups);
  if (orderedGroupsCacheGetOrderedGroupsRef.current !== props.getOrderedGroups) {
    orderedGroupsCacheGetOrderedGroupsRef.current = props.getOrderedGroups;
    orderedGroupsCacheRef.current.clear();
  }
  const cachedGetOrderedGroups = (projectId: string, groups: SessionGroup[]): SessionGroup[] => {
    const cache = orderedGroupsCacheRef.current;
    const hit = cache.get(projectId);
    if (hit && hit.groups === groups) {
      return hit.ordered;
    }
    const ordered = props.getOrderedGroups(projectId, groups);
    cache.set(projectId, { groups, ordered });
    if (cache.size > 256) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    return ordered;
  };

  // Threaded into SessionGroupSection so the archived-bucket virtualizer
  // can resolve the scrolling ancestor synchronously (no getComputedStyle
  // walk) and skip the cost of a style recalc on every render.
  const scrollContainerRef = React.useRef<HTMLElement | null>(null);

  const shouldComputeAllFolderSessions = Boolean(props.isAllFoldersView || isTimeline);

  const allFolderSessions = React.useMemo(() => {
    if (!shouldComputeAllFolderSessions) return [];
    const items: Array<{
      node: SessionNode;
      project: ProjectSection['project'];
      projectLabel: string;
      isPinned: boolean;
      timestamp: number;
      globalSession: boolean;
    }> = [];

    const sections = props.allFoldersOnlySection
      ? [props.allFoldersOnlySection, ...props.sectionsForRender]
      : props.sectionsForRender;
    for (const section of sections) {
      const projectLabel = getProjectLabel(section.project, props.homeDirectory);
      for (const group of section.groups) {
        if (group.isArchivedBucket) continue;
        for (const node of group.sessions) {
          const isPinned = Boolean(props.pinnedSessionIds?.has(node.session.id));
          const timestamp = node.session.time?.updated || node.session.time?.created || 0;
          items.push({
            node,
            project: section.project,
            projectLabel,
            isPinned,
            timestamp,
            globalSession: section === props.allFoldersOnlySection,
          });
        }
      }
    }

    // Purely order based on time, keeping pinned sessions at top
    items.sort((a, b) => {
      if (a.isPinned !== b.isPinned) {
        return a.isPinned ? -1 : 1;
      }
      return b.timestamp - a.timestamp;
    });

    return items;
  }, [
    props.allFoldersOnlySection,
    shouldComputeAllFolderSessions,
    props.sectionsForRender,
    props.homeDirectory,
    props.pinnedSessionIds,
  ]);

  const [allFoldersLimit, setAllFoldersLimit] = React.useState(30);

  React.useEffect(() => {
    setAllFoldersLimit(30);
  }, [props.hasSessionSearchQuery]);

  const visibleAllFolderSessions = React.useMemo(
    () => allFolderSessions.slice(0, allFoldersLimit),
    [allFolderSessions, allFoldersLimit],
  );

  // `SessionSidebar` passes live boundaries (current day, week-start
  // preference) whenever the timeline is shown, and `null` while the sidebar
  // is hidden. The fallback only keeps hidden rows bucketed: it is read once,
  // is not refreshed at midnight, and assumes a Monday week start.
  const resolvedTimelineBoundaries = React.useMemo(
    () => props.timelineBoundaries ?? getTimelineBoundaries(Date.now(), 1),
    [props.timelineBoundaries],
  );

  const timelineGroups = React.useMemo(() => {
    if (!isTimeline) return [];
    return groupTimelineItems(visibleAllFolderSessions, {
      getTimestamp: (item) => item.timestamp,
      isPinned: (item) => item.isPinned,
      boundaries: resolvedTimelineBoundaries,
    });
  }, [isTimeline, visibleAllFolderSessions, resolvedTimelineBoundaries]);

  if (props.sharedSessionsOnly) {
    return (
      <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('pt-2 pb-1', props.mobileVariant && 'pb-32')}>
        <div className="space-y-1 px-2">
        {props.topContent}
        {!props.hasSharedSessions ? (props.hasSessionSearchQuery ? props.searchEmptyState : props.emptyState) : null}
        </div>
      </ScrollableOverlay>
    );
  }

  const hasAllFoldersOnlySection = (props.isAllFoldersView || viewMode === 'timeline' || viewMode === 'folder') && Boolean(props.allFoldersOnlySection);
  if (props.projectSections.length === 0 && !hasAllFoldersOnlySection) {
    return <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('pt-2 pb-1', props.mobileVariant && 'pb-32')}><div className="space-y-1 px-2">{props.topContent}{props.emptyState}</div></ScrollableOverlay>;
  }

  if (props.sectionsForRender.length === 0 && !hasAllFoldersOnlySection) {
    return <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('pt-2 pb-1', props.mobileVariant && 'pb-32')}><div className="space-y-1 px-2">{props.searchEmptyState}</div></ScrollableOverlay>;
  }

  const renderPaginationButtons = () => {
    const remainingAllFoldersCount = allFolderSessions.length - visibleAllFolderSessions.length;
    return (
      <>
        {remainingAllFoldersCount > 0 ? (
          <SidebarSessionLikeButton
            icon="arrow-down-s"
            onClick={() => setAllFoldersLimit((prev) => prev + 30)}
          >
            {remainingAllFoldersCount === 1
              ? "Show 1 more session"
              : `Show ${remainingAllFoldersCount} more sessions`}
          </SidebarSessionLikeButton>
        ) : null}
        {allFoldersLimit > 30 && allFolderSessions.length > 30 ? (
          <SidebarSessionLikeButton
            icon="arrow-up-s"
            onClick={() => setAllFoldersLimit(30)}
          >
            {"Show fewer sessions"}
          </SidebarSessionLikeButton>
        ) : null}
      </>
    );
  };

  return (
    // [overflow-anchor:none] — the browser's native scroll anchoring otherwise
    // latches onto content BELOW a growing session group (e.g. the "Show more"
    // button) and holds it in place, which makes newly revealed sessions look
    // like they insert upward. With anchoring off, scrollTop stays put and new
    // rows appear below naturally.
    <div className="relative flex min-h-0 flex-1">
    <ScrollableOverlay
      ref={scrollContainerRef}
      useScrollShadow
      hideTopScrollShadow
      scrollShadowSize={96}
      outerClassName="flex-1 min-h-0"
      className={cn('oc-sidebar-scroller pt-2 pb-1 [overflow-anchor:none]', props.mobileVariant && 'pb-32')}
    >
      <div className="space-y-1 px-2">
      {props.topContent}
      {props.showOnlyMainWorkspace ? (
        <div className="space-y-[0.6rem]">
          {(() => {
            const activeSection = props.sectionsForRender.find((section) => section.project.id === props.activeProjectId) ?? props.sectionsForRender[0];
            if (!activeSection) {
              return props.hasSessionSearchQuery ? props.searchEmptyState : props.emptyState;
            }
            const primaryGroup =
              activeSection.groups.find((candidate) => candidate.isMain && candidate.sessions.length > 0)
              ?? activeSection.groups.find((candidate) => candidate.sessions.length > 0)
              ?? activeSection.groups.find((candidate) => candidate.isMain)
              ?? activeSection.groups[0];
            if (!primaryGroup) {
              return (
                <SidebarSessionLikeButton
                  icon="chat-new"
                  onClick={() => props.openNewSessionDraft({
                    selectedProjectId: activeSection.project.id,
                    directoryOverride: activeSection.project.normalizedPath,
                  })}
                >
                  {"New session"}
                </SidebarSessionLikeButton>
              );
            }
            const archivedGroup = activeSection.groups.find((candidate) => candidate.isArchivedBucket);
            const groupsToRender = [
              primaryGroup,
              ...(archivedGroup && archivedGroup.id !== primaryGroup.id ? [archivedGroup] : []),
            ];

            return groupsToRender.map((group) => {
              const groupKey = `${activeSection.project.id}:${group.id}`;
              const hideGroupLabel = group.id === primaryGroup.id;
              return (
                <React.Fragment key={groupKey}>
                  {props.renderGroupSessions(group, groupKey, activeSection.project.id, hideGroupLabel, null, true, scrollContainerRef)}
                </React.Fragment>
              );
            });
          })()}
        </div>
      ) : viewMode === 'folder' ? (
        <SessionRowVariantContext.Provider value="tree">
        <SidebarFolderTree
          sections={props.sectionsForRender}
          homeSection={props.allFoldersOnlySection}
          homeDirectory={props.homeDirectory}
          collapsedProjects={props.collapsedProjects}
          toggleProject={props.toggleProject}
          hasSessionSearchQuery={props.hasSessionSearchQuery}
          activeProjectId={props.activeProjectId}
          hideDirectoryControls={props.hideDirectoryControls}
          mobileVariant={props.mobileVariant}
          alwaysShowActions={props.alwaysShowActions}
          isInlineEditing={props.isInlineEditing}
          stickyFolderHeaders={props.stickyFolderHeaders}
          renderGroupSessions={props.renderGroupSessions}
          renderSessionNode={props.renderSessionNode}
          getOrderedGroups={cachedGetOrderedGroups}
          renderProjectStatusIndicator={props.renderProjectStatusIndicator}
          scrollContainerRef={scrollContainerRef}
          setActiveProjectIdOnly={props.setActiveProjectIdOnly}
          setActiveMainTab={props.setActiveMainTab}
          setSessionSwitcherOpen={props.setSessionSwitcherOpen}
          openNewSessionDraft={props.openNewSessionDraft}
          openProjectEditDialog={props.openProjectEditDialog}
          removeProject={props.removeProject}
          reorderProjects={props.reorderProjects}
          openSidebarMenuKey={props.openSidebarMenuKey}
          setOpenSidebarMenuKey={props.setOpenSidebarMenuKey}
          onOpenDirectoryDialog={props.onOpenDirectoryDialog}
          emptyState={props.emptyState}
          searchEmptyState={props.searchEmptyState}
        />
        </SessionRowVariantContext.Provider>
      ) : viewMode === 'timeline' && props.renderSessionNode ? (
        <div>
          {allFolderSessions.length === 0 ? (
            props.hasSessionSearchQuery ? props.searchEmptyState : props.emptyState
          ) : (
            <>
              {timelineGroups.map((group, index) => {
                const label = TIMELINE_BUCKET_LABELS[group.id];
                return (
                  <section
                    key={group.id}
                    aria-label={label}
                    data-timeline-bucket={group.id}
                  >
                    <div
                      role="heading"
                      aria-level={3}
                      className={cn(
                        'select-none px-3 pb-1 text-xs leading-4 font-medium text-muted-foreground',
                        index === 0 ? 'pt-1' : 'pt-3',
                      )}
                    >
                      {label}
                    </div>
                    {group.items.map(({ node, project, projectLabel, globalSession }) => {
                      const groupDirectory = node.session.directory ?? project.normalizedPath;
                      return (
                        <React.Fragment key={node.session.id}>
                          {props.renderSessionNode!(
                            node,
                            0,
                            groupDirectory,
                            project.id,
                            false,
                            { projectLabel, showFolderLabel: true, globalSession },
                            'project',
                          )}
                        </React.Fragment>
                      );
                    })}
                  </section>
                );
              })}
              {renderPaginationButtons()}
            </>
          )}
        </div>
      ) : props.isAllFoldersView && props.renderSessionNode ? (
        <div>
          {allFolderSessions.length === 0 ? (
            props.hasSessionSearchQuery ? props.searchEmptyState : props.emptyState
          ) : (
            <>
              {visibleAllFolderSessions.map(({ node, project, projectLabel, globalSession }) => {
                const groupDirectory = node.session.directory ?? project.normalizedPath;
                return (
                  <React.Fragment key={node.session.id}>
                    {props.renderSessionNode!(
                      node,
                      0,
                      groupDirectory,
                      project.id,
                      false,
                      { projectLabel, showFolderLabel: true, globalSession },
                      'project',
                    )}
                  </React.Fragment>
                );
              })}
              {renderPaginationButtons()}
            </>
          )}
        </div>
      ) : (
        <div>
          {props.sectionsForRender.map((section) => {
            const projectKey = section.project.id;
            const orderedGroups = cachedGetOrderedGroups(projectKey, section.groups);
            const rootGroup = orderedGroups.find((group) => group.isMain) ?? null;
            const nestedGroups = rootGroup
              ? orderedGroups.filter((group) => group.id !== rootGroup.id)
              : orderedGroups;

            return (
              <div key={projectKey}>
                {rootGroup ? props.renderGroupSessions(rootGroup, `${projectKey}:${rootGroup.id}`, projectKey, true, null, undefined, scrollContainerRef) : null}
                {nestedGroups.map((group) => {
                  const groupKey = `${projectKey}:${group.id}`;
                  const hideGroupLabel = orderedGroups.length === 1;
                  return (
                    <React.Fragment key={group.id}>
                      {props.renderGroupSessions(group, groupKey, projectKey, hideGroupLabel, null, undefined, scrollContainerRef)}
                    </React.Fragment>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
      </div>
    </ScrollableOverlay>
    </div>
  );
}

export const SidebarProjectsList = React.memo(SidebarProjectsListComponent);
