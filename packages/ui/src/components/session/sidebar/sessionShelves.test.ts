import { describe, expect, test } from 'bun:test';

import { partitionSessionShelves, sameShelves } from './sessionShelves';
import type { SessionNode } from './types';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 10, 10, 14, 0).getTime();

const item = (id: string, updated: number, isPinned = false) => ({
  node: { session: { id, time: { created: updated, updated } }, children: [] } as unknown as SessionNode,
  isPinned,
});

const context = {
  entries: {},
  working: new Set<string>(),
  needsInput: new Set<string>(),
  now: NOW,
  autoSettleAfterDays: 3,
  workingShelf: true,
};

const ids = (items: Array<{ node: SessionNode }>) => items.map((entry) => entry.node.session.id);

describe('partitionSessionShelves', () => {
  test('sorts each section on its own key', () => {
    const shelves = partitionSessionShelves([
      item('old', NOW - 10 * DAY),
      item('recent', NOW - 1000),
      item('older-active', NOW - DAY),
      item('pinned', NOW - 20 * DAY, true),
      item('running', NOW - 5 * DAY),
      item('snooze-late', NOW - DAY),
      item('snooze-soon', NOW - DAY),
      item('settled-by-hand', NOW - 1000),
    ], {
      ...context,
      working: new Set(['running']),
      entries: {
        'snooze-late': { snoozedUntil: NOW + 5 * DAY, snoozedAt: NOW },
        'snooze-soon': { snoozedUntil: NOW + DAY, snoozedAt: NOW },
        'settled-by-hand': { settled: 'settled', settledAt: NOW - 500 },
      },
    });
    expect(ids(shelves.pinned)).toEqual(['pinned']);
    expect(ids(shelves.active)).toEqual(['recent', 'older-active']);
    expect(ids(shelves.working)).toEqual(['running']);
    expect(ids(shelves.snoozed)).toEqual(['snooze-soon', 'snooze-late']);
    // Settled: by hand 500 ms ago, then auto-settled at its last activity.
    expect(ids(shelves.settled)).toEqual(['settled-by-hand', 'old']);
    expect(shelves.sectionById.get('running')).toBe('working');
  });

  test('a woken snooze sorts by its wake time and is flagged until opened', () => {
    const shelves = partitionSessionShelves([
      item('woke', NOW - 9 * DAY),
      item('fresh', NOW - 2 * 60_000),
    ], {
      ...context,
      entries: { woke: { snoozedUntil: NOW - 60_000, snoozedAt: NOW - 9 * DAY } },
    });
    expect(ids(shelves.active)).toEqual(['woke', 'fresh']);
    expect([...shelves.wokeIds]).toEqual(['woke']);
  });

  test('an identical result compares equal, so a minute tick keeps the old partition', () => {
    const items = [item('a', NOW - 1000), item('b', NOW - 2000)];
    const first = partitionSessionShelves(items, context);
    const second = partitionSessionShelves(items, { ...context, now: NOW + 60_000 });
    expect(sameShelves(first, second)).toBe(true);
    const later = partitionSessionShelves(items, { ...context, now: NOW + 4 * DAY });
    expect(sameShelves(first, later)).toBe(false);
  });
});
