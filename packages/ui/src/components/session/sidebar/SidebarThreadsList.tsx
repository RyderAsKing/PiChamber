import React from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';

import type { SessionShelfSection } from '@/lib/sessionShelf';
import { cn } from '@/lib/utils';
import { isSessionPinned, useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { updateSessionShelf } from './hooks/useSessionShelves';
import type { SessionShelves, ShelfListItem } from './sessionShelves';
import { SessionShelfRowContext, type SessionShelfRowState } from './sessionShelfRowContext';
import { SidebarSectionHeading } from './sidebarRowChrome';
import type { ProjectSection, SessionNode } from './types';

export interface ThreadsListItem {
  node: SessionNode;
  project: ProjectSection['project'];
  projectLabel: string;
  isPinned: boolean;
  timestamp: number;
  globalSession: boolean;
}

export type ShelfId = 'snoozed';
type DropTarget = 'pinned' | 'active';

const SHELF_LABELS: Record<ShelfId, string> = {
  snoozed: 'Snoozed',
};

const EXPANDED_SHELVES_STORAGE_KEY = 'oc.sidebar.shelves.expanded';

const readExpandedShelves = (): Set<ShelfId> => {
  try {
    const raw = getDeferredSafeStorage().getItem(EXPANDED_SHELVES_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return new Set();
    // Values from retired shelves (`settled`) are ignored.
    return new Set(parsed.filter((id): id is ShelfId => id === 'snoozed'));
  } catch {
    return new Set();
  }
};

/** Shelves start collapsed; which ones are open is remembered per device. */
const useExpandedShelves = () => {
  const [expanded, setExpanded] = React.useState<Set<ShelfId>>(readExpandedShelves);
  const toggle = React.useCallback((id: ShelfId) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        getDeferredSafeStorage().setItem(EXPANDED_SHELVES_STORAGE_KEY, JSON.stringify([...next]));
      } catch { /* ignored */ }
      return next;
    });
  }, []);
  return { expanded, toggle };
};

type RenderSessionNode = (
  node: SessionNode,
  depth?: number,
  groupDirectory?: string | null,
  projectId?: string | null,
  archivedBucket?: boolean,
  secondaryMeta?: { projectLabel?: string | null; branchLabel?: string | null; showFolderLabel?: boolean; globalSession?: boolean } | null,
  renderContext?: 'project' | 'recent',
) => React.ReactNode;

const DropZone: React.FC<{
  target: DropTarget;
  dragging: boolean;
  className?: string;
  children: React.ReactNode;
}> = ({ target, dragging, className, children }) => {
  const { setNodeRef, isOver } = useDroppable({ id: `shelf-drop:${target}`, data: { type: 'shelf', target } });
  return (
    <div
      ref={setNodeRef}
      data-shelf-drop={target}
      className={cn(
        'rounded-xl transition-colors',
        dragging && 'outline outline-1 -outline-offset-1 outline-transparent',
        dragging && isOver && 'bg-interactive-hover outline-[var(--interactive-border)]',
        className,
      )}
    >
      {children}
    </div>
  );
};

const THREADS_SHELVES: readonly ShelfId[] = ['snoozed'];

/**
 * The collapsible Snoozed section below the Threads list and the By folder
 * tree. A collapsed section shows only its heading, even when it holds the
 * open session.
 */
export const SessionShelfStack = <T extends ShelfListItem>({
  shelfIds,
  shelves,
  renderItem,
  hasSessionSearchQuery,
  className,
}: {
  shelfIds: readonly ShelfId[];
  shelves: SessionShelves<T>;
  renderItem: (item: T) => React.ReactNode;
  hasSessionSearchQuery: boolean;
  className?: string;
}): React.ReactNode => {
  const { expanded, toggle } = useExpandedShelves();

  // While searching, every match shows; shelves open so results are not hidden.
  const isExpanded = (id: ShelfId) => hasSessionSearchQuery || expanded.has(id);
  const visibleIds = shelfIds.filter((id) => shelves[id].length > 0);
  if (visibleIds.length === 0) return null;

  return (
    <div className={className}>
      {visibleIds.map((id) => {
        const rows = shelves[id];
        const shelfExpanded = isExpanded(id);
        return (
          <section key={id} aria-label={SHELF_LABELS[id]} data-session-shelf={id}>
            <SidebarSectionHeading
              label={SHELF_LABELS[id]}
              count={rows.length}
              expanded={shelfExpanded}
              onToggle={() => toggle(id)}
            />
            {shelfExpanded ? rows.map(renderItem) : null}
          </section>
        );
      })}
    </div>
  );
};

interface SidebarThreadsListProps {
  items: readonly ThreadsListItem[];
  shelves: SessionShelves<ThreadsListItem>;
  renderSessionNode: RenderSessionNode;
  hasSessionSearchQuery: boolean;
  mobileVariant: boolean;
  emptyState: React.ReactNode;
  searchEmptyState: React.ReactNode;
}

/**
 * The Threads view: Pinned, then sessions running now, then every other
 * session by when it was last active, with the collapsible Snoozed section
 * anchored at the bottom of the sidebar. On desktop a session can be dragged
 * to Pinned or back to the list. Archived sessions are not listed.
 */
const SidebarThreadsListComponent: React.FC<SidebarThreadsListProps> = ({
  items,
  shelves,
  renderSessionNode,
  hasSessionSearchQuery,
  mobileVariant,
  emptyState,
  searchEmptyState,
}) => {
  const [dragging, setDragging] = React.useState<{ sessionId: string; title: string; width: number | null } | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const rowState = React.useMemo<SessionShelfRowState>(
    () => ({ sectionById: shelves.sectionById, wokeIds: shelves.wokeIds }),
    [shelves.sectionById, shelves.wokeIds],
  );

  const renderItem = (item: ThreadsListItem) => (
    <React.Fragment key={item.node.session.id}>
      {renderSessionNode(
        item.node,
        0,
        item.node.session.directory ?? item.project.normalizedPath,
        item.project.id,
        false,
        { projectLabel: item.projectLabel, showFolderLabel: true, globalSession: item.globalSession },
        'project',
      )}
    </React.Fragment>
  );

  const handleDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as { type?: string; sessionId?: string; sessionTitle?: string } | undefined;
    if (data?.type !== 'session' || !data.sessionId) return;
    const width = event.active.rect.current.initial?.width;
    setDragging({ sessionId: data.sessionId, title: data.sessionTitle ?? 'Session', width: typeof width === 'number' ? width : null });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDragging(null);
    const active = event.active.data.current as { type?: string; sessionId?: string; sessionDirectory?: string | null } | undefined;
    const over = event.over?.data.current as { type?: string; target?: DropTarget } | undefined;
    if (active?.type !== 'session' || !active.sessionId || over?.type !== 'shelf' || !over.target) return;
    const sessionId = active.sessionId;
    const directory = active.sessionDirectory ?? null;
    const from = shelves.sectionById.get(sessionId);
    if (!from) return;
    moveSession(sessionId, directory, from, over.target);
  };

  if (items.length === 0) {
    return <>{hasSessionSearchQuery ? searchEmptyState : emptyState}</>;
  }

  const isDragging = Boolean(dragging);
  const showPinned = shelves.pinned.length > 0 || isDragging;
  const showWorking = shelves.working.length > 0;
  // "Recent" only needs a name when another section sits beside it.
  const showRecentHeading = showPinned || showWorking
    || shelves.snoozed.length > 0;

  const list = (
    <div className="flex min-h-full flex-1 flex-col" data-sidebar-threads="">
      {showPinned ? (
        <DropZone target="pinned" dragging={isDragging}>
          <SidebarSectionHeading label={'Pinned'} first />
          {shelves.pinned.map(renderItem)}
          {isDragging && shelves.pinned.length === 0 ? (
            <div className="px-3 py-2 typography-micro text-subtle-foreground">{'Drop here to pin'}</div>
          ) : null}
        </DropZone>
      ) : null}

      {showWorking ? (
        <section aria-label={'Working'} data-session-shelf="working">
          <SidebarSectionHeading label={'Working'} first={!showPinned} />
          {shelves.working.map(renderItem)}
        </section>
      ) : null}

      <DropZone target="active" dragging={isDragging}>
        {showRecentHeading ? <SidebarSectionHeading label={'Recent'} first={!showPinned && !showWorking} /> : null}
        {shelves.active.map(renderItem)}
        {shelves.active.length === 0 && !hasSessionSearchQuery ? (
          <div className="px-3 py-1.5 typography-micro text-subtle-foreground">
            {isDragging
              ? 'Drop here to keep it in the list'
              : shelves.snoozed.length > 0 ? 'Nothing recent. Snoozed sessions are below.' : 'Nothing recent.'}
          </div>
        ) : null}
      </DropZone>

      <SessionShelfStack
        shelfIds={THREADS_SHELVES}
        shelves={shelves}
        renderItem={renderItem}
        hasSessionSearchQuery={hasSessionSearchQuery}
        className="mt-auto border-t border-border pt-1"
      />
    </div>
  );

  return (
    <SessionShelfRowContext.Provider value={rowState}>
      {mobileVariant ? list : (
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={handleDragStart}
          onDragCancel={() => setDragging(null)}
          onDragEnd={handleDragEnd}
        >
          {list}
          <DragOverlay>
            {dragging ? (
              <div
                style={{ width: dragging.width ? `${dragging.width}px` : 'auto' }}
                className="pointer-events-none flex items-center rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-3 py-2"
              >
                <div className="min-w-0 flex-1 truncate typography-ui-label text-foreground">{dragging.title}</div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </SessionShelfRowContext.Provider>
  );
};

/**
 * What a drop means. Pinning and un-pinning use the pin store; waking a
 * snoozed session uses the shelf store.
 */
const moveSession = (
  sessionId: string,
  directory: string | null,
  from: SessionShelfSection,
  to: DropTarget,
) => {
  const pins = useSessionPinnedStore.getState();
  const isPinned = isSessionPinned(pins.ids, directory, sessionId);
  const setPinned = (pinned: boolean) => {
    if (!directory || isPinned === pinned) return;
    pins.toggle({ directory, sessionId });
  };
  if (from === 'snoozed') {
    updateSessionShelf(sessionId, { snoozedUntil: null }, directory, 'Could not wake the session');
  }
  setPinned(to === 'pinned');
};

export const SidebarThreadsList = React.memo(SidebarThreadsListComponent);
