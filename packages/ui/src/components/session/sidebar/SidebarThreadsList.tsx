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
import { useSessionUIStore } from '@/sync/session-ui-store';
import { settleSession, updateSessionShelf } from './hooks/useSessionShelves';
import type { SessionShelves, ShelfListItem } from './sessionShelves';
import { SessionShelfRowContext, type SessionShelfRowState } from './sessionShelfRowContext';
import { SidebarSectionHeading, SidebarSessionLikeButton } from './sidebarRowChrome';
import type { ProjectSection, SessionNode } from './types';

export interface ThreadsListItem {
  node: SessionNode;
  project: ProjectSection['project'];
  projectLabel: string;
  isPinned: boolean;
  timestamp: number;
  globalSession: boolean;
}

export type ShelfId = 'snoozed' | 'settled';
type DropTarget = 'pinned' | 'active' | 'settled';

const SHELF_LABELS: Record<ShelfId, string> = {
  snoozed: 'Snoozed',
  settled: 'Settled',
};

const SETTLED_FIRST_PAGE = 10;
const SETTLED_PAGE = 25;
const EXPANDED_SHELVES_STORAGE_KEY = 'oc.sidebar.shelves.expanded';

const readExpandedShelves = (): Set<ShelfId> => {
  try {
    const raw = getDeferredSafeStorage().getItem(EXPANDED_SHELVES_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is ShelfId => id === 'snoozed' || id === 'settled'));
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

const THREADS_SHELVES: readonly ShelfId[] = ['snoozed', 'settled'];

/**
 * The collapsible Snoozed and Settled sections below the Threads list and the
 * By folder tree. A collapsed section shows only its heading, even when it
 * holds the open session; Settled pages its rows.
 */
export const SessionShelfStack = <T extends ShelfListItem>({
  shelfIds,
  shelves,
  renderItem,
  hasSessionSearchQuery,
  mobileVariant,
  dragging = false,
  droppable = false,
  className,
}: {
  shelfIds: readonly ShelfId[];
  shelves: SessionShelves<T>;
  renderItem: (item: T) => React.ReactNode;
  hasSessionSearchQuery: boolean;
  mobileVariant: boolean;
  /** A session drag is in progress; Settled shows as a drop target even when empty. */
  dragging?: boolean;
  /** Settled accepts dropped sessions; needs an enclosing `DndContext`. */
  droppable?: boolean;
  className?: string;
}): React.ReactNode => {
  const { expanded, toggle } = useExpandedShelves();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const [settledLimit, setSettledLimit] = React.useState(SETTLED_FIRST_PAGE);

  // While searching, every match shows; shelves open so results are not hidden.
  const isExpanded = (id: ShelfId) => hasSessionSearchQuery || expanded.has(id);
  const shelfRows = (id: ShelfId, rows: T[]) => {
    if (isExpanded(id)) {
      if (id !== 'settled' || hasSessionSearchQuery) return rows;
      const visible = rows.slice(0, settledLimit);
      // The open session stays visible even past the page.
      const current = rows.find((item) => item.node.session.id === currentSessionId);
      return current && !visible.includes(current) ? [...visible, current] : visible;
    }
    return [];
  };
  const settledRemaining = shelves.settled.length - Math.min(settledLimit, shelves.settled.length);
  const visibleIds = shelfIds.filter((id) => shelves[id].length > 0 || (id === 'settled' && dragging));
  if (visibleIds.length === 0) return null;

  return (
    <div className={className}>
      {visibleIds.map((id) => {
        const rows = shelves[id];
        const shelfExpanded = isExpanded(id);
        const body = (
          <>
            <SidebarSectionHeading
              label={SHELF_LABELS[id]}
              count={rows.length}
              expanded={shelfExpanded}
              onToggle={() => {
                if (id === 'settled') setSettledLimit(SETTLED_FIRST_PAGE);
                toggle(id);
              }}
            />
            {shelfRows(id, rows).map(renderItem)}
            {id === 'settled' && shelfExpanded && !hasSessionSearchQuery && settledRemaining > 0 ? (
              <SidebarSessionLikeButton
                icon="arrow-down-s"
                mobileVariant={mobileVariant}
                onClick={() => setSettledLimit((limit) => limit + SETTLED_PAGE)}
              >
                {`Show ${Math.min(SETTLED_PAGE, settledRemaining)} more`}
              </SidebarSessionLikeButton>
            ) : null}
          </>
        );
        return (
          <section key={id} aria-label={SHELF_LABELS[id]} data-session-shelf={id}>
            {id === 'settled' && droppable ? (
              <DropZone target="settled" dragging={dragging}>{body}</DropZone>
            ) : body}
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
 * session by when it was last active, with the collapsible Snoozed and
 * Settled sections anchored at the bottom of the sidebar. On desktop a session can be dragged to Pinned, back to
 * the list, or to Settled.
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
    moveSession(sessionId, directory, from, over.target, dragging?.title ?? 'Session');
  };

  if (items.length === 0) {
    return <>{hasSessionSearchQuery ? searchEmptyState : emptyState}</>;
  }

  const isDragging = Boolean(dragging);
  const showPinned = shelves.pinned.length > 0 || isDragging;
  const showWorking = shelves.working.length > 0;
  // "Recent" only needs a name when another section sits beside it.
  const showRecentHeading = showPinned || showWorking
    || shelves.snoozed.length > 0 || shelves.settled.length > 0;

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
            {isDragging ? 'Drop here to keep it in the list' : 'Nothing recent. Settled sessions are below.'}
          </div>
        ) : null}
      </DropZone>

      <SessionShelfStack
        shelfIds={THREADS_SHELVES}
        shelves={shelves}
        renderItem={renderItem}
        hasSessionSearchQuery={hasSessionSearchQuery}
        mobileVariant={mobileVariant}
        dragging={isDragging}
        droppable={!mobileVariant}
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
 * What a drop means. Pinning and un-pinning use the pin store; settling and
 * waking use the shelf store. A settled session dropped back into the list
 * stays out of Settled until its next activity; settling unpins.
 */
const moveSession = (
  sessionId: string,
  directory: string | null,
  from: SessionShelfSection,
  to: DropTarget,
  title: string,
) => {
  const pins = useSessionPinnedStore.getState();
  const isPinned = isSessionPinned(pins.ids, directory, sessionId);
  const setPinned = (pinned: boolean) => {
    if (!directory || isPinned === pinned) return;
    pins.toggle({ directory, sessionId });
  };
  if (to === 'settled') {
    if (from === 'settled') return;
    settleSession(sessionId, directory, title);
    return;
  }
  if (from === 'snoozed') {
    updateSessionShelf(sessionId, { snoozedUntil: null }, directory, 'Could not wake the session');
  }
  if (from === 'settled') {
    updateSessionShelf(sessionId, { settled: 'active' }, directory, 'Could not un-settle the session');
  }
  setPinned(to === 'pinned');
};

export const SidebarThreadsList = React.memo(SidebarThreadsListComponent);
