export type TimelineBucketId = 'pinned' | 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'older';

export const TIMELINE_BUCKET_ORDER: readonly TimelineBucketId[] = [
  'pinned',
  'today',
  'yesterday',
  'thisWeek',
  'lastWeek',
  'older',
] as const;

export const TIMELINE_BUCKET_LABELS: Record<TimelineBucketId, string> = {
  pinned: 'Pinned',
  today: 'Today',
  yesterday: 'Yesterday',
  thisWeek: 'This week',
  lastWeek: 'Last week',
  older: 'Older',
};

export type TimelineWeekStart = 0 | 1; // 0 = Sunday, 1 = Monday

export type TimelineBoundaries = {
  startOfToday: number;
  startOfYesterday: number;
  startOfThisWeek: number;
  startOfLastWeek: number;
};

type LocaleWithWeekInfo = Intl.Locale & {
  getWeekInfo?: () => { firstDay?: number };
  weekInfo?: { firstDay?: number };
};

export const resolveTimelineWeekStart = (
  preference: 'auto' | 'sunday' | 'monday',
  locale?: string,
): TimelineWeekStart => {
  if (preference === 'sunday') return 0;
  if (preference === 'monday') return 1;

  try {
    const tag =
      locale ||
      (typeof Intl !== 'undefined' && Intl.DateTimeFormat
        ? Intl.DateTimeFormat().resolvedOptions().locale
        : 'en-US');
    if (typeof Intl !== 'undefined' && typeof Intl.Locale === 'function') {
      const loc = new Intl.Locale(tag) as LocaleWithWeekInfo;
      const weekInfo = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
      const firstDay = weekInfo?.firstDay;
      if (firstDay === 7 || firstDay === 0) {
        return 0;
      }
      if (firstDay !== undefined) {
        return 1;
      }
    }
  } catch {
    // Fall back to Monday on error or unsupported API
  }
  return 1;
};

export const getTimelineBoundaries = (
  nowMs: number,
  weekStart: TimelineWeekStart,
): TimelineBoundaries => {
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  const startOfToday = today.getTime();

  const yesterday = new Date(startOfToday);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);
  const startOfYesterday = yesterday.getTime();

  const currentDay = today.getDay();
  const diffDays = (currentDay - weekStart + 7) % 7;
  const thisWeek = new Date(startOfToday);
  thisWeek.setDate(thisWeek.getDate() - diffDays);
  thisWeek.setHours(0, 0, 0, 0);
  const startOfThisWeek = thisWeek.getTime();

  const lastWeek = new Date(startOfThisWeek);
  lastWeek.setDate(lastWeek.getDate() - 7);
  lastWeek.setHours(0, 0, 0, 0);
  const startOfLastWeek = lastWeek.getTime();

  return {
    startOfToday,
    startOfYesterday,
    startOfThisWeek,
    startOfLastWeek,
  };
};

export const resolveTimelineBucket = (
  timestampMs: number,
  boundaries: TimelineBoundaries,
): Exclude<TimelineBucketId, 'pinned'> => {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return 'older';
  }
  if (timestampMs >= boundaries.startOfToday) {
    return 'today';
  }
  if (timestampMs >= boundaries.startOfYesterday) {
    return 'yesterday';
  }
  if (timestampMs >= boundaries.startOfThisWeek) {
    return 'thisWeek';
  }
  if (timestampMs >= boundaries.startOfLastWeek) {
    return 'lastWeek';
  }
  return 'older';
};

export type TimelineGroup<T> = { id: TimelineBucketId; items: T[] };

export const groupTimelineItems = <T>(
  items: readonly T[],
  options: {
    getTimestamp: (item: T) => number;
    isPinned: (item: T) => boolean;
    boundaries: TimelineBoundaries;
  },
): TimelineGroup<T>[] => {
  const buckets: Record<TimelineBucketId, T[]> = {
    pinned: [],
    today: [],
    yesterday: [],
    thisWeek: [],
    lastWeek: [],
    older: [],
  };

  const { getTimestamp, isPinned, boundaries } = options;
  const len = items.length;
  for (let i = 0; i < len; i++) {
    const item = items[i];
    if (isPinned(item)) {
      buckets.pinned.push(item);
    } else {
      const ts = getTimestamp(item);
      const bucketId = resolveTimelineBucket(ts, boundaries);
      buckets[bucketId].push(item);
    }
  }

  const result: TimelineGroup<T>[] = [];
  for (const id of TIMELINE_BUCKET_ORDER) {
    const bucketItems = buckets[id];
    if (bucketItems.length > 0) {
      result.push({ id, items: bucketItems });
    }
  }

  return result;
};

export const getNextLocalMidnight = (nowMs: number): number => {
  const next = new Date(nowMs);
  next.setDate(next.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  return next.getTime();
};
