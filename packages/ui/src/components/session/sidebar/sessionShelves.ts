import type { PiSessionShelfEntry } from '@/lib/pi/protocol';
import {
  hasWokeFromSnooze,
  resolveSessionShelfSection,
  sessionActivityAt,
  settledAtFor,
  type SessionShelfSection,
} from '@/lib/sessionShelf';
import type { SessionNode } from './types';

/**
 * Splits the sidebar's root sessions into the shelf sections used by the
 * Threads and By folder views. The rules for one session live in
 * `lib/sessionShelf.ts`; this module applies them to a list and sorts each
 * section.
 */

export interface ShelfListItem {
  node: SessionNode;
  isPinned: boolean;
}

interface SessionShelfContext {
  entries: Readonly<Record<string, PiSessionShelfEntry>>;
  working: ReadonlySet<string>;
  needsInput: ReadonlySet<string>;
  now: number;
  autoSettleAfterDays: number | null;
  /** Threads moves working sessions to their own shelf; By folder keeps them in place. */
  workingShelf: boolean;
}

export interface SessionShelves<T extends ShelfListItem> {
  pinned: T[];
  active: T[];
  working: T[];
  snoozed: T[];
  settled: T[];
  /** Section per root session id, for rows that show their shelf state. */
  sectionById: ReadonlyMap<string, SessionShelfSection>;
  /** Sessions whose snooze ran out and that the user has not opened since. */
  wokeIds: ReadonlySet<string>;
}

const updatedAtOf = (node: SessionNode): number =>
  node.session.time?.updated || node.session.time?.created || 0;

export const partitionSessionShelves = <T extends ShelfListItem>(
  items: readonly T[],
  context: SessionShelfContext,
): SessionShelves<T> => {
  const sections: Record<SessionShelfSection, Array<{ item: T; key: number }>> = {
    pinned: [],
    active: [],
    working: [],
    snoozed: [],
    settled: [],
  };
  const sectionById = new Map<string, SessionShelfSection>();
  const wokeIds = new Set<string>();

  for (const item of items) {
    const id = item.node.session.id;
    const entry = context.entries[id];
    const input = {
      entry,
      pinned: item.isPinned,
      working: context.working.has(id),
      needsInput: context.needsInput.has(id),
      updatedAt: updatedAtOf(item.node),
      now: context.now,
      autoSettleAfterDays: context.autoSettleAfterDays,
      workingShelf: context.workingShelf,
    };
    const section = resolveSessionShelfSection(input);
    sectionById.set(id, section);
    if (section !== 'snoozed' && hasWokeFromSnooze(entry, context.now)) wokeIds.add(id);
    // Each section sorts on one number: soonest wake for Snoozed, latest
    // settle for Settled, latest activity (a wake counts) everywhere else.
    const key = section === 'snoozed'
      ? -(entry?.snoozedUntil ?? 0)
      : section === 'settled'
        ? settledAtFor(input)
        : sessionActivityAt(input);
    sections[section].push({ item, key });
  }

  const sorted = (section: SessionShelfSection): T[] =>
    sections[section]
      .sort((left, right) => right.key - left.key)
      .map(({ item }) => item);

  return {
    pinned: sorted('pinned'),
    active: sorted('active'),
    working: sorted('working'),
    snoozed: sorted('snoozed'),
    settled: sorted('settled'),
    sectionById,
    wokeIds,
  };
};

/** Same membership and order: lets a minute tick keep the previous partition. */
export const sameShelves = <T extends ShelfListItem>(left: SessionShelves<T>, right: SessionShelves<T>): boolean => {
  const sameList = (a: T[], b: T[]) => a.length === b.length && a.every((item, index) => item === b[index]);
  if (left.wokeIds.size !== right.wokeIds.size) return false;
  for (const id of left.wokeIds) if (!right.wokeIds.has(id)) return false;
  return sameList(left.pinned, right.pinned)
    && sameList(left.active, right.active)
    && sameList(left.working, right.working)
    && sameList(left.snoozed, right.snoozed)
    && sameList(left.settled, right.settled);
};
