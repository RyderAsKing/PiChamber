import React from 'react';
import {
  type TimelineBoundaries,
  type TimelineWeekStart,
  getTimelineBoundaries,
  getNextLocalMidnight,
} from '../timelineBuckets';

/**
 * Local-calendar boundaries for the timeline sidebar view, or `null` while the
 * view is not shown (no timer or listener is installed then).
 *
 * Boundaries are read from the clock whenever the view is (re)enabled, and
 * again when the local day changes: one timer armed for the next local
 * midnight, plus a visibility check for timers that were throttled or slept
 * through while the page was hidden.
 */
export const useTimelineBoundaries = (
  enabled: boolean,
  weekStart: TimelineWeekStart,
): TimelineBoundaries | null => {
  const [dayTick, setDayTick] = React.useState(0);

  const boundaries = React.useMemo(() => {
    if (!enabled) return null;
    return getTimelineBoundaries(Date.now(), weekStart);
    // `dayTick` re-reads the clock after a day change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, weekStart, dayTick]);

  const startOfToday = boundaries?.startOfToday ?? null;

  React.useEffect(() => {
    if (startOfToday === null) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const now = Date.now();
    const timer = window.setTimeout(() => {
      setDayTick((tick) => tick + 1);
    }, Math.max(50, getNextLocalMidnight(now) - now + 50));

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (getTimelineBoundaries(Date.now(), weekStart).startOfToday !== startOfToday) {
        setDayTick((tick) => tick + 1);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [startOfToday, weekStart, dayTick]);

  return boundaries;
};
