import React from 'react';

import { toast } from '@/components/ui';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { nextSnoozeWakeAt } from '@/lib/sessionShelf';
import { useSessionShelfStore, type SessionShelfPatch } from '@/stores/useSessionShelfStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionShelfLiveState } from '@/sync/sync-context';
import { partitionSessionShelves, sameShelves, type SessionShelves, type ShelfListItem } from '../sessionShelves';

const MINUTE_MS = 60_000;
// A run that starts elsewhere (another device, the Pi CLI) clears its
// session's shelf entry on the server; reread after it starts.
const RELOAD_AFTER_WORK_STARTS_MS = 1_500;

/**
 * Wall-clock time for the shelf rules, refreshed each minute and exactly at
 * the next snooze wake, so snoozes wake without a reload. Stops while the document is hidden and catches up when shown.
 */
const useShelfClock = (enabled: boolean, nextWakeAt: number | null): number => {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;
    let interval: number | null = null;
    const start = () => {
      setNow(Date.now());
      if (interval === null) interval = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    };
    const stop = () => {
      if (interval !== null) window.clearInterval(interval);
      interval = null;
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled]);

  React.useEffect(() => {
    if (!enabled || nextWakeAt === null) return;
    // Timers clamp near 2^31 ms; a far wake is picked up by the minute tick.
    const delay = Math.min(Math.max(0, nextWakeAt - Date.now()) + 50, 2 ** 31 - 1);
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [enabled, nextWakeAt]);

  return now;
};

/**
 * Keeps the shelf store fresh while a shelf view is shown: on mount, when the
 * window comes back, on a runtime switch, and shortly after any session starts
 * working.
 */
const useShelfLoading = (enabled: boolean, working: ReadonlySet<string>) => {
  const load = useSessionShelfStore((state) => state.load);

  React.useEffect(() => {
    if (!enabled) return;
    void load();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const unsubscribe = subscribeRuntimeEndpointChanged(() => void load());
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe();
    };
  }, [enabled, load]);

  const previousWorking = React.useRef(working);
  React.useEffect(() => {
    const before = previousWorking.current;
    previousWorking.current = working;
    if (!enabled) return;
    let started = false;
    for (const id of working) {
      if (!before.has(id)) {
        started = true;
        break;
      }
    }
    if (!started) return;
    const timer = window.setTimeout(() => void load(), RELOAD_AFTER_WORK_STARTS_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, working, load]);
};

interface UseSessionShelvesOptions {
  enabled: boolean;
  workingShelf: boolean;
}

/**
 * The shelf partition for the Threads and By folder views. Returns null while
 * disabled so the other views pay nothing.
 */
export const useSessionShelves = <T extends ShelfListItem>(
  items: readonly T[],
  { enabled, workingShelf }: UseSessionShelvesOptions,
): SessionShelves<T> | null => {
  const entries = useSessionShelfStore((state) => (enabled ? state.entries : EMPTY_ENTRIES));
  const { working, needsInput } = useSessionShelfLiveState(enabled);
  const nextWakeAt = React.useMemo(() => nextSnoozeWakeAt(entries, Date.now()), [entries]);
  const now = useShelfClock(enabled, nextWakeAt);
  useShelfLoading(enabled, working);

  const previous = React.useRef<SessionShelves<T> | null>(null);
  const shelves = React.useMemo(() => {
    if (!enabled) return null;
    const next = partitionSessionShelves(items, {
      entries,
      working,
      needsInput,
      now,
      workingShelf,
    });
    // The minute tick usually changes nothing; keep the old object so rows
    // and memoized sections do not re-render.
    if (previous.current && sameShelves(previous.current, next)) {
      const sameSections = previous.current.sectionById.size === next.sectionById.size
        && [...next.sectionById].every(([id, section]) => previous.current!.sectionById.get(id) === section);
      if (sameSections) return previous.current;
    }
    return next;
  }, [enabled, items, entries, working, needsInput, now, workingShelf]);
  previous.current = shelves;

  // Opening a session that woke from a snooze acknowledges the wake.
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const wokeAndOpen = Boolean(enabled && currentSessionId && shelves?.wokeIds.has(currentSessionId));
  React.useEffect(() => {
    if (!wokeAndOpen || !currentSessionId) return;
    void useSessionShelfStore.getState()
      .update(currentSessionId, { snoozedUntil: null })
      .catch((error) => console.warn('[session-shelf] could not clear a finished snooze', error));
  }, [wokeAndOpen, currentSessionId]);

  return shelves;
};

const EMPTY_ENTRIES: Readonly<Record<string, never>> = Object.freeze({});

/** Snooze or wake a session; reports a failure as a toast. Archive is `sessionArchive.ts`. */
export const updateSessionShelf = (
  sessionId: string,
  patch: SessionShelfPatch,
  directory: string | null | undefined,
  failureMessage: string,
): void => {
  void useSessionShelfStore.getState()
    .update(sessionId, patch, directory ?? undefined)
    .catch((error) => {
      console.warn('[session-shelf] update failed', error);
      toast.error(failureMessage);
    });
};
