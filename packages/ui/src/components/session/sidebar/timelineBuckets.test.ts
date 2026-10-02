import { describe, expect, test } from 'bun:test';
import {
  TIMELINE_BUCKET_ORDER,
  TIMELINE_BUCKET_LABELS,
  resolveTimelineWeekStart,
  getTimelineBoundaries,
  resolveTimelineBucket,
  groupTimelineItems,
  getNextLocalMidnight,
  type TimelineGroup,
} from './timelineBuckets';

describe('timelineBuckets', () => {
  test('constants define expected order and labels', () => {
    expect(TIMELINE_BUCKET_ORDER).toEqual([
      'pinned',
      'today',
      'yesterday',
      'thisWeek',
      'lastWeek',
      'older',
    ]);
    expect(TIMELINE_BUCKET_LABELS.pinned).toBe('Pinned');
    expect(TIMELINE_BUCKET_LABELS.today).toBe('Today');
    expect(TIMELINE_BUCKET_LABELS.yesterday).toBe('Yesterday');
    expect(TIMELINE_BUCKET_LABELS.thisWeek).toBe('This week');
    expect(TIMELINE_BUCKET_LABELS.lastWeek).toBe('Last week');
    expect(TIMELINE_BUCKET_LABELS.older).toBe('Older');
  });

  test('resolveTimelineWeekStart handles sunday, monday, and auto', () => {
    expect(resolveTimelineWeekStart('sunday')).toBe(0);
    expect(resolveTimelineWeekStart('monday')).toBe(1);

    type LocaleWithWeekInfo = Intl.Locale & {
      getWeekInfo?: () => { firstDay?: number };
      weekInfo?: { firstDay?: number };
    };

    const hasWeekInfo = (() => {
      try {
        if (typeof Intl !== 'undefined' && typeof Intl.Locale === 'function') {
          const loc = new Intl.Locale('en-US') as LocaleWithWeekInfo;
          return Boolean(typeof loc.getWeekInfo === 'function' || loc.weekInfo);
        }
      } catch {
        return false;
      }
      return false;
    })();

    if (hasWeekInfo) {
      expect(resolveTimelineWeekStart('auto', 'en-US')).toBe(0);
      expect(resolveTimelineWeekStart('auto', 'en-GB')).toBe(1);
    } else {
      expect(resolveTimelineWeekStart('auto', 'en-US')).toBe(1);
      expect(resolveTimelineWeekStart('auto', 'en-GB')).toBe(1);
    }
  });

  test('getTimelineBoundaries for mid-week instant with Monday and Sunday week start', () => {
    // Wednesday Oct 14, 2026 at 15:30:00 local time
    const now = new Date(2026, 9, 14, 15, 30, 0, 0).getTime();

    // Monday start: this week begins Monday Oct 12, last week begins Monday Oct 5
    const mondayBoundaries = getTimelineBoundaries(now, 1);
    expect(new Date(mondayBoundaries.startOfToday).getTime()).toBe(new Date(2026, 9, 14, 0, 0, 0, 0).getTime());
    expect(new Date(mondayBoundaries.startOfYesterday).getTime()).toBe(new Date(2026, 9, 13, 0, 0, 0, 0).getTime());
    expect(new Date(mondayBoundaries.startOfThisWeek).getTime()).toBe(new Date(2026, 9, 12, 0, 0, 0, 0).getTime());
    expect(new Date(mondayBoundaries.startOfLastWeek).getTime()).toBe(new Date(2026, 9, 5, 0, 0, 0, 0).getTime());

    // Sunday start: this week begins Sunday Oct 11, last week begins Sunday Oct 4
    const sundayBoundaries = getTimelineBoundaries(now, 0);
    expect(new Date(sundayBoundaries.startOfToday).getTime()).toBe(new Date(2026, 9, 14, 0, 0, 0, 0).getTime());
    expect(new Date(sundayBoundaries.startOfYesterday).getTime()).toBe(new Date(2026, 9, 13, 0, 0, 0, 0).getTime());
    expect(new Date(sundayBoundaries.startOfThisWeek).getTime()).toBe(new Date(2026, 9, 11, 0, 0, 0, 0).getTime());
    expect(new Date(sundayBoundaries.startOfLastWeek).getTime()).toBe(new Date(2026, 9, 4, 0, 0, 0, 0).getTime());
  });

  test('boundary transitions: 1ms before vs exactly at local midnight', () => {
    const now = new Date(2026, 9, 14, 12, 0, 0, 0).getTime();
    const b = getTimelineBoundaries(now, 1);

    expect(resolveTimelineBucket(b.startOfToday, b)).toBe('today');
    expect(resolveTimelineBucket(b.startOfToday - 1, b)).toBe('yesterday');
    expect(resolveTimelineBucket(b.startOfYesterday, b)).toBe('yesterday');
  });

  test('when today is first day of the week, yesterday is "yesterday" and nothing is "thisWeek"', () => {
    // Monday Oct 12, 2026 with weekStart = 1 (Monday)
    const now = new Date(2026, 9, 12, 10, 0, 0, 0).getTime();
    const b = getTimelineBoundaries(now, 1);

    expect(b.startOfThisWeek).toBe(b.startOfToday);

    const yesterdayItem = new Date(2026, 9, 11, 23, 59, 59, 999).getTime();
    expect(resolveTimelineBucket(yesterdayItem, b)).toBe('yesterday');

    const items = [
      { id: '1', ts: now, pinned: false },
      { id: '2', ts: yesterdayItem, pinned: false },
      { id: '3', ts: b.startOfLastWeek + 1000, pinned: false },
    ];
    const grouped = groupTimelineItems(items, {
      getTimestamp: (i) => i.ts,
      isPinned: (i) => i.pinned,
      boundaries: b,
    });
    const groupIds = grouped.map((g) => g.id);
    expect(groupIds).not.toContain('thisWeek');
    expect(groupIds).toContain('today');
    expect(groupIds).toContain('yesterday');
    expect(groupIds).toContain('lastWeek');
  });

  test('item exactly at startOfThisWeek is thisWeek and 1ms earlier is lastWeek', () => {
    // Friday Oct 16, 2026 with weekStart = 1 (Monday Oct 12)
    const now = new Date(2026, 9, 16, 14, 0, 0, 0).getTime();
    const b = getTimelineBoundaries(now, 1);

    expect(resolveTimelineBucket(b.startOfThisWeek, b)).toBe('thisWeek');
    expect(resolveTimelineBucket(b.startOfThisWeek - 1, b)).toBe('lastWeek');
  });

  test('item exactly at startOfLastWeek is lastWeek, 1ms earlier is older', () => {
    const now = new Date(2026, 9, 16, 14, 0, 0, 0).getTime();
    const b = getTimelineBoundaries(now, 1);

    expect(resolveTimelineBucket(b.startOfLastWeek, b)).toBe('lastWeek');
    expect(resolveTimelineBucket(b.startOfLastWeek - 1, b)).toBe('older');
  });

  test('invalid, non-finite, 0, and negative timestamps map to older', () => {
    const now = new Date(2026, 9, 16, 14, 0, 0, 0).getTime();
    const b = getTimelineBoundaries(now, 1);

    expect(resolveTimelineBucket(0, b)).toBe('older');
    expect(resolveTimelineBucket(-1000, b)).toBe('older');
    expect(resolveTimelineBucket(Number.NaN, b)).toBe('older');
    expect(resolveTimelineBucket(Number.POSITIVE_INFINITY, b)).toBe('older');
    expect(resolveTimelineBucket(Number.NEGATIVE_INFINITY, b)).toBe('older');
  });

  test('future timestamp resolves to today', () => {
    const now = new Date(2026, 9, 16, 14, 0, 0, 0).getTime();
    const b = getTimelineBoundaries(now, 1);

    const futureTs = now + 1000 * 60 * 60 * 24 * 5;
    expect(resolveTimelineBucket(futureTs, b)).toBe('today');
  });

  test('month and year boundary (Jan 1) calculates correctly', () => {
    // Jan 1, 2027 (Friday) at 09:00:00
    const now = new Date(2027, 0, 1, 9, 0, 0, 0).getTime();
    const b = getTimelineBoundaries(now, 1);

    expect(new Date(b.startOfToday).getTime()).toBe(new Date(2027, 0, 1, 0, 0, 0, 0).getTime());
    expect(new Date(b.startOfYesterday).getTime()).toBe(new Date(2026, 11, 31, 0, 0, 0, 0).getTime());
    expect(new Date(b.startOfThisWeek).getTime()).toBe(new Date(2026, 11, 28, 0, 0, 0, 0).getTime());
    expect(new Date(b.startOfLastWeek).getTime()).toBe(new Date(2026, 11, 21, 0, 0, 0, 0).getTime());
  });

  test('all boundaries are exact local midnights', () => {
    const dates = [
      new Date(2026, 2, 29, 12, 0, 0, 0), // European spring DST transition week
      new Date(2026, 9, 25, 12, 0, 0, 0), // European autumn DST transition week
      new Date(2026, 10, 1, 12, 0, 0, 0), // US autumn DST transition week
      new Date(2026, 2, 8, 12, 0, 0, 0),  // US spring DST transition week
    ];

    for (const d of dates) {
      const b = getTimelineBoundaries(d.getTime(), 1);
      expect(new Date(b.startOfToday).getHours()).toBe(0);
      expect(new Date(b.startOfToday).getMinutes()).toBe(0);
      expect(new Date(b.startOfYesterday).getHours()).toBe(0);
      expect(new Date(b.startOfYesterday).getMinutes()).toBe(0);
      expect(new Date(b.startOfThisWeek).getHours()).toBe(0);
      expect(new Date(b.startOfThisWeek).getMinutes()).toBe(0);
      expect(new Date(b.startOfLastWeek).getHours()).toBe(0);
      expect(new Date(b.startOfLastWeek).getMinutes()).toBe(0);
    }
  });

  test('groupTimelineItems handles ordering, omission of empty groups, pinned extraction, order preservation, and determinism', () => {
    const now = new Date(2026, 9, 16, 14, 0, 0, 0).getTime();
    const b = getTimelineBoundaries(now, 1);

    type Item = { id: string; ts: number; pinned: boolean };
    const items: Item[] = [
      { id: 'p1', ts: b.startOfLastWeek - 1000, pinned: true },
      { id: 't1', ts: now, pinned: false },
      { id: 't2', ts: b.startOfToday + 100, pinned: false },
      { id: 'y1', ts: b.startOfYesterday + 100, pinned: false },
      { id: 'w1', ts: b.startOfThisWeek + 100, pinned: false },
      { id: 'p2', ts: now + 1000, pinned: true },
      { id: 'o1', ts: b.startOfLastWeek - 5000, pinned: false },
    ];

    const group = (data: Item[]): TimelineGroup<Item>[] =>
      groupTimelineItems(data, {
        getTimestamp: (i) => i.ts,
        isPinned: (i) => i.pinned,
        boundaries: b,
      });

    const result1 = group(items);
    const result2 = group(items);

    expect(result1).toEqual(result2);

    const ids = result1.map((g) => g.id);
    expect(ids).toEqual(['pinned', 'today', 'yesterday', 'thisWeek', 'older']); // 'lastWeek' is empty, so omitted

    // Pinned group contains p1 and p2 in incoming order
    expect(result1[0].items.map((i) => i.id)).toEqual(['p1', 'p2']);
    // Today group contains t1, t2 in incoming order
    expect(result1[1].items.map((i) => i.id)).toEqual(['t1', 't2']);
    // Yesterday group contains y1
    expect(result1[2].items.map((i) => i.id)).toEqual(['y1']);
    // This week group contains w1
    expect(result1[3].items.map((i) => i.id)).toEqual(['w1']);
    // Older group contains o1
    expect(result1[4].items.map((i) => i.id)).toEqual(['o1']);
  });

  test('operation-count assertion with 10,000 items', () => {
    const now = new Date(2026, 9, 16, 14, 0, 0, 0).getTime();
    const b = getTimelineBoundaries(now, 1);

    type Item = { id: number; ts: number; pinned: boolean };
    const items: Item[] = Array.from({ length: 10_000 }, (_, i) => ({
      id: i,
      ts: now - (i % 30) * 86_400_000,
      pinned: i % 10 === 0,
    }));

    let getTimestampCallCount = 0;
    let isPinnedCallCount = 0;

    const grouped = groupTimelineItems(items, {
      getTimestamp: (item) => {
        getTimestampCallCount++;
        return item.ts;
      },
      isPinned: (item) => {
        isPinnedCallCount++;
        return item.pinned;
      },
      boundaries: b,
    });

    expect(isPinnedCallCount).toBe(10_000);
    expect(getTimestampCallCount <= 10_000).toBe(true);
    // 1000 items are pinned, so getTimestamp is called 9,000 times
    expect(getTimestampCallCount).toBe(9_000);
    expect(grouped.length > 0).toBe(true);
  });

  test('getNextLocalMidnight returns value > now with local hours/minutes 0', () => {
    const now = new Date(2026, 9, 16, 14, 25, 30, 500).getTime();
    const nextMidnight = getNextLocalMidnight(now);

    expect(nextMidnight).toBeGreaterThan(now);
    const date = new Date(nextMidnight);
    expect(date.getHours()).toBe(0);
    expect(date.getMinutes()).toBe(0);
    expect(date.getSeconds()).toBe(0);
    expect(date.getMilliseconds()).toBe(0);
    expect(date.getDate()).toBe(17);
  });
});
