import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { formatDirectoryName, cn } from '@/lib/utils';
import type { SessionGroup, SessionNode } from './types';
import { formatProjectLabel } from './utils';
import type { ProjectSortOrder } from '@/stores/useSessionDisplayStore';
import { streamPerfCount } from '@/stores/utils/streamDebug';
import type { SortableDragHandleProps } from './sortableItems';
import { ProjectHeaderIdentity } from './sortableItems';
import type { MainTab } from '@/stores/useUIStore';

type ProjectSection = {
  project: {
    id: string;
    label?: string;
    normalizedPath: string;
    icon?: string;
    color?: string;
    iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
    iconBackground?: string;
  };
  groups: SessionGroup[];
};

const TOP_FADE_MAX_SIZE = 48;
const TOP_FADE_MIN_SIZE = 32;
const TOP_FADE_CLEAR_MAX_SIZE = 24;

const getProjectLabel = (project: ProjectSection['project'], homeDirectory: string | null): string => (
  formatProjectLabel(
    project.label?.trim()
    || formatDirectoryName(project.normalizedPath, homeDirectory)
    || project.normalizedPath,
  )
);

type Props = {
  topContent?: React.ReactNode;
  sharedSessionsOnly?: boolean;
  hasSharedSessions?: boolean;
  sectionsForRender: ProjectSection[];
  projectSections: ProjectSection[];
  activeProjectId: string | null;
  showOnlyMainWorkspace: boolean;
  hasSessionSearchQuery: boolean;
  emptyState: React.ReactNode;
  searchEmptyState: React.ReactNode;
  isAllFoldersView?: boolean;
  pinnedSessionIds?: Set<string>;
  renderSessionNode?: (
    node: SessionNode,
    depth?: number,
    groupDirectory?: string | null,
    projectId?: string | null,
    archivedBucket?: boolean,
    secondaryMeta?: { projectLabel?: string | null; branchLabel?: string | null; showFolderLabel?: boolean } | null,
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
  isDesktopShellRuntime: boolean;
  stickyZoneHeaders: boolean;
  stuckProjectHeaders: Set<string>;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  toggleProject: (id: string) => void;
  setActiveProjectIdOnly: (id: string) => void;
  setActiveMainTab: (tab: MainTab) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null }) => void;
  openProjectEditDialog: (id: string) => void;
  removeProject: (id: string) => void;
  projectHeaderSentinelRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
  reorderProjects: (fromIndex: number, toIndex: number) => void;
  projectSortOrder: ProjectSortOrder;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  isInlineEditing: boolean;
};

function SidebarProjectsListComponent(props: Props): React.ReactNode {
  streamPerfCount('ui.sidebar_projects_list.render');
  
  const enableStickyFade = props.isDesktopShellRuntime && props.stickyZoneHeaders;

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
  // Keep per-scroll measurements out of React state so the interaction guard
  // can read the current fade boundary without rerendering the sidebar.
  const topFadeSizeRef = React.useRef(0);
  // Update the compositor-owned mask on every scroll, but cross the React
  // render boundary only when the sticky identity overlay appears or hides.
  const syncTopFade = React.useCallback((scroller: HTMLElement) => {
    const hasTopScroll = scroller.scrollTop > 1;
    const topFadeSize = hasTopScroll
      ? Math.min(TOP_FADE_MIN_SIZE + scroller.scrollTop, TOP_FADE_MAX_SIZE)
      : 0;
    topFadeSizeRef.current = topFadeSize;
    scroller.style.setProperty('--scroll-shadow-top-size', `${topFadeSize}px`);
    scroller.style.setProperty(
      '--scroll-shadow-top-clear-size',
      `${Math.min(Math.max(topFadeSize - 8, 0), TOP_FADE_CLEAR_MAX_SIZE)}px`,
    );
  }, []);
  const blockObscuredInteraction = React.useCallback((
    event: React.MouseEvent<HTMLDivElement> | React.PointerEvent<HTMLDivElement>,
  ) => {
    if ((event.target as Element).closest('[data-overlay-scrollbar-thumb], [data-sidebar-sticky-header]')) return;
    const eventY = event.clientY - event.currentTarget.getBoundingClientRect().top;
    if (eventY >= topFadeSizeRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);
  const hasProjectScroller = props.projectSections.length > 0 && props.sectionsForRender.length > 0;
  React.useLayoutEffect(() => {
    if (enableStickyFade && hasProjectScroller && scrollContainerRef.current) {
      syncTopFade(scrollContainerRef.current);
    }
  }, [enableStickyFade, hasProjectScroller, syncTopFade]);
  let stuckProject: ProjectSection['project'] | null = null;
  for (const section of props.projectSections) {
    if (props.stuckProjectHeaders.has(section.project.id)) {
      stuckProject = section.project;
    }
  }
  // The IntersectionObserver reports the stuck header asynchronously, a frame or
  // two after the (synchronous) mask has already hidden the real header — which
  // otherwise leaves a one-frame gap where the title blinks out with no crisp
  // replacement. Seed the overlay with the topmost rendered project so it is
  // ready in the same frame; the observer then corrects it. When shared sessions
  // lead the list, the Recent fallback below owns the top instead of a project.
  const leadingProject =
    stuckProject ?? (props.hasSharedSessions ? null : props.sectionsForRender[0]?.project ?? null);
  const leadingProjectLabel = leadingProject ? getProjectLabel(leadingProject, props.homeDirectory) : null;

  const allFolderSessions = React.useMemo(() => {
    if (!props.isAllFoldersView) return [];
    const items: Array<{
      node: SessionNode;
      project: ProjectSection['project'];
      projectLabel: string;
      isPinned: boolean;
      timestamp: number;
    }> = [];

    for (const section of props.sectionsForRender) {
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
  }, [props.isAllFoldersView, props.sectionsForRender, props.homeDirectory, props.pinnedSessionIds]);

  const [allFoldersLimit, setAllFoldersLimit] = React.useState(30);

  React.useEffect(() => {
    setAllFoldersLimit(30);
  }, [props.hasSessionSearchQuery]);

  const visibleAllFolderSessions = allFolderSessions.slice(0, allFoldersLimit);
  const remainingAllFoldersCount = allFolderSessions.length - visibleAllFolderSessions.length;

  if (props.sharedSessionsOnly) {
    return (
      <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 pb-1 pr-2', props.mobileVariant ? '' : '')}>
        {props.topContent}
        {!props.hasSharedSessions ? (props.hasSessionSearchQuery ? props.searchEmptyState : props.emptyState) : null}
      </ScrollableOverlay>
    );
  }

  if (props.projectSections.length === 0) {
    return <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 pb-1 pl-2.5 pr-2', props.mobileVariant ? '' : '')}>{props.topContent}{props.emptyState}</ScrollableOverlay>;
  }

  if (props.sectionsForRender.length === 0) {
    return <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 pb-1 pl-2.5 pr-2', props.mobileVariant ? '' : '')}>{props.searchEmptyState}</ScrollableOverlay>;
  }

  return (
    // [overflow-anchor:none] — the browser's native scroll anchoring otherwise
    // latches onto content BELOW a growing session group (e.g. the "Show more"
    // button) and holds it in place, which makes newly revealed sessions look
    // like they insert upward. With anchoring off, scrollTop stays put and new
    // rows appear below naturally.
    <div
      className="oc-sticky-fade-root relative flex min-h-0 flex-1"
      onPointerDownCapture={enableStickyFade ? blockObscuredInteraction : undefined}
      onClickCapture={enableStickyFade ? blockObscuredInteraction : undefined}
      onContextMenuCapture={enableStickyFade ? blockObscuredInteraction : undefined}
    >
    <ScrollableOverlay
      ref={scrollContainerRef}
      useScrollShadow
      hideTopScrollShadow={!enableStickyFade}
      scrollShadowSize={96}
      outerClassName="flex-1 min-h-0"
      className={cn('oc-sidebar-scroller oc-sticky-fade-scroller space-y-1 pb-1 px-2 [overflow-anchor:none]', props.mobileVariant ? '' : '')}
      style={enableStickyFade ? { '--scroll-shadow-top-size': '0px' } as React.CSSProperties : undefined}
      onScroll={enableStickyFade ? (event) => syncTopFade(event.currentTarget) : undefined}
    >
      {props.topContent}
      {props.showOnlyMainWorkspace ? (
        <div className="space-y-[0.6rem] py-1">
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
              return <div className="py-1 text-left typography-micro text-muted-foreground">{"No sessions yet"}</div>;
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
      ) : props.isAllFoldersView && props.renderSessionNode ? (
        <div className="space-y-1 py-1">
          {allFolderSessions.length === 0 ? (
            props.hasSessionSearchQuery ? props.searchEmptyState : props.emptyState
          ) : (
            <>
              {visibleAllFolderSessions.map(({ node, project, projectLabel }) => {
                const groupDirectory = node.session.directory ?? project.normalizedPath;
                return (
                  <React.Fragment key={node.session.id}>
                    {props.renderSessionNode!(
                      node,
                      0,
                      groupDirectory,
                      project.id,
                      false,
                      { projectLabel, showFolderLabel: true },
                      'project',
                    )}
                  </React.Fragment>
                );
              })}
              {remainingAllFoldersCount > 0 ? (
                <button
                  type="button"
                  onClick={() => setAllFoldersLimit((prev) => prev + 30)}
                  className="mt-1 flex items-center justify-start rounded-md pl-[26px] pr-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
                >
                  {"Show more sessions"}
                </button>
              ) : null}
              {allFoldersLimit > 30 && allFolderSessions.length > 30 ? (
                <button
                  type="button"
                  onClick={() => setAllFoldersLimit(30)}
                  className="mt-0.5 flex items-center justify-start rounded-md pl-[26px] pr-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
                >
                  {"Show fewer sessions"}
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : (
        <div className="space-y-1 py-1">
          {props.sectionsForRender.map((section) => {
            const projectKey = section.project.id;
            const orderedGroups = cachedGetOrderedGroups(projectKey, section.groups);
            const rootGroup = orderedGroups.find((group) => group.isMain) ?? null;
            const nestedGroups = rootGroup
              ? orderedGroups.filter((group) => group.id !== rootGroup.id)
              : orderedGroups;

            return (
              <div key={projectKey} className="space-y-1">
                {rootGroup ? props.renderGroupSessions(rootGroup, `${projectKey}:${rootGroup.id}`, projectKey, true, null, undefined, scrollContainerRef) : null}
                {nestedGroups.map((group) => {
                  const groupKey = `${projectKey}:${group.id}`;
                  return (
                    <React.Fragment key={group.id}>
                      {props.renderGroupSessions(group, groupKey, projectKey, false, null, undefined, scrollContainerRef)}
                    </React.Fragment>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </ScrollableOverlay>
      {enableStickyFade && leadingProject && leadingProjectLabel ? (
        <div
          className="oc-sticky-fade-overlay pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center gap-1.5 py-1 pl-4 pr-5"
          aria-hidden="true"
        >
          <ProjectHeaderIdentity
            id={leadingProject.id}
            projectLabel={leadingProjectLabel}
            projectIcon={leadingProject.icon}
            projectColor={leadingProject.color}
            projectIconImage={leadingProject.iconImage}
            projectIconBackground={leadingProject.iconBackground}
          />
        </div>
      ) : null}
    </div>
  );
}

export const SidebarProjectsList = React.memo(SidebarProjectsListComponent);
