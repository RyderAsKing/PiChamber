import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { getSafeStorage } from '@/stores/utils/safeStorage';
import {
  adoptServerRunTiming,
  observeSessionActivityTiming,
  removeSessionActivityTiming,
  resetSessionActivityTiming,
  useSessionActivityTimingStore,
} from './session-activity-timing';

const STORAGE_KEY = 'oc.session-activity.v1';

const startedAt = (sessionId: string): number | undefined =>
  useSessionActivityTimingStore.getState().startedAt.get(sessionId);

const settledMs = (sessionId: string): number | undefined =>
  useSessionActivityTimingStore.getState().settledMs.get(sessionId);

type PersistedStart = { start: number; seen: number };

const readPersisted = (): Record<string, PersistedStart> | null => {
  const raw = getSafeStorage().getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Record<string, PersistedStart>) : null;
};

/**
 * Seed a previous page session's record, then simulate the reload.
 * `loadedAgoMs` places this page's navigation start in the past, which is how a
 * slow bootstrap or an expired adoption window is expressed.
 */
const seedReload = (payload: unknown, loadedAgoMs = 0): void => {
  getSafeStorage().setItem(STORAGE_KEY, JSON.stringify(payload));
  resetSessionActivityTiming({ pageLoadAt: Date.now() - loadedAgoMs });
};

/** A record for a turn that began `ageMs` ago and was alive until the reload. */
const runningUntilReload = (ageMs: number, loadedAgoMs = 0, quietFor = 1_000): PersistedStart => ({
  start: Date.now() - ageMs,
  seen: Date.now() - loadedAgoMs - quietFor,
});

beforeEach(() => {
  getSafeStorage().removeItem(STORAGE_KEY);
  resetSessionActivityTiming();
});

afterEach(() => {
  getSafeStorage().removeItem(STORAGE_KEY);
  resetSessionActivityTiming();
});

describe('session activity timing', () => {
  test('starts a turn on the first active observation and keeps it stable', () => {
    observeSessionActivityTiming('ses_a', 'active');
    const first = startedAt('ses_a');
    expect(first).toBeGreaterThan(0);

    // Repeated busy/retry status events must not restart the counter.
    observeSessionActivityTiming('ses_a', 'active');
    expect(startedAt('ses_a')).toBe(first);
  });

  test('settling converts the start into a duration', () => {
    observeSessionActivityTiming('ses_a', 'active');
    observeSessionActivityTiming('ses_a', 'settled');

    expect(startedAt('ses_a')).toBe(undefined);
    expect(settledMs('ses_a')).toBeGreaterThanOrEqual(0);
  });

  test('a new turn clears the previous settled duration', () => {
    observeSessionActivityTiming('ses_a', 'active');
    observeSessionActivityTiming('ses_a', 'settled');
    expect(settledMs('ses_a')).toBeDefined();

    observeSessionActivityTiming('ses_a', 'active');
    expect(settledMs('ses_a')).toBe(undefined);
    expect(startedAt('ses_a')).toBeDefined();
  });

  test('settling a session that was never observed active yields no duration', () => {
    observeSessionActivityTiming('ses_a', 'settled');

    expect(startedAt('ses_a')).toBe(undefined);
    expect(settledMs('ses_a')).toBe(undefined);
  });

  test('an unrelated session\'s settle does not touch a running turn', () => {
    observeSessionActivityTiming('ses_other_directory', 'active');
    observeSessionActivityTiming('ses_a', 'active');
    const start = startedAt('ses_a');

    observeSessionActivityTiming('ses_other_directory', 'settled');

    expect(startedAt('ses_other_directory')).toBe(undefined);
    expect(startedAt('ses_a')).toBe(start);
  });

  test('persists the start and a liveness stamp for a running turn', () => {
    observeSessionActivityTiming('ses_a', 'active');

    const persisted = readPersisted();
    expect(persisted?.ses_a.start).toBe(startedAt('ses_a') as number);
    expect(persisted?.ses_a.seen).toBeGreaterThanOrEqual(persisted?.ses_a.start as number);
  });

  test('clears the persisted record when the turn ends', () => {
    observeSessionActivityTiming('ses_a', 'active');
    observeSessionActivityTiming('ses_a', 'settled');

    expect(readPersisted()).toBeNull();
  });

  // Regression: the server re-publishes `session.status: busy` at every step of
  // the agent loop, so after a reload one of those repeats arrives on the live
  // event stream. Reading a busy event as "a turn just started" therefore reset
  // the counter on almost every refresh.
  test('resumes a persisted start when a live event reports the session active', () => {
    const record = runningUntilReload(90_000);
    seedReload({ ses_a: record });

    observeSessionActivityTiming('ses_a', 'active');

    expect(startedAt('ses_a')).toBe(record.start);
  });

  test('the turn after a resumed one still counts from zero', () => {
    const record = runningUntilReload(90_000);
    seedReload({ ses_a: record });

    // Reload lands mid-turn: the live active event resumes it…
    observeSessionActivityTiming('ses_a', 'active');
    expect(startedAt('ses_a')).toBe(record.start);

    // …it finishes, which retires the record, so the next turn starts fresh.
    observeSessionActivityTiming('ses_a', 'settled');
    const before = Date.now();
    observeSessionActivityTiming('ses_a', 'active');

    expect(startedAt('ses_a')).toBeGreaterThanOrEqual(before);
  });

  test('a live idle event retires the persisted record', () => {
    const record = runningUntilReload(90_000);
    seedReload({ ses_a: record });

    // The turn ended while the tab was gone; the event arrives on reconnect.
    observeSessionActivityTiming('ses_a', 'settled');
    // A later active event must not resurrect the retired start.
    const before = Date.now();
    observeSessionActivityTiming('ses_a', 'active');

    expect(startedAt('ses_a')).toBeGreaterThanOrEqual(before);
  });

  // The absence is measured from navigation start, not from "now", so a slow
  // bootstrap on a slow machine cannot spend the whole allowance before the
  // first live status event arrives.
  test('resumes even when bootstrap takes most of a minute', () => {
    const loadedAgoMs = 45_000;
    const record = runningUntilReload(300_000, loadedAgoMs);
    seedReload({ ses_a: record }, loadedAgoMs);

    observeSessionActivityTiming('ses_a', 'active');

    expect(startedAt('ses_a')).toBe(record.start);
  });

  test('does not adopt a record once the adoption window has passed', () => {
    const loadedAgoMs = 5 * 60_000;
    const record = runningUntilReload(300_000, loadedAgoMs);
    seedReload({ ses_a: record }, loadedAgoMs);

    // A turn starting this long after load is a new turn, not the one that was
    // running before the reload.
    const before = Date.now();
    observeSessionActivityTiming('ses_a', 'active');

    expect(startedAt('ses_a')).toBeGreaterThanOrEqual(before);
  });

  test('does not resume a record whose liveness stamp has gone quiet', () => {
    const before = Date.now();
    seedReload({ ses_a: { start: before - 300_000, seen: before - 240_000 } });

    observeSessionActivityTiming('ses_a', 'active');

    expect(startedAt('ses_a')).toBeGreaterThanOrEqual(before);
  });

  test('does not resume a turn older than the maximum turn age', () => {
    const before = Date.now();
    seedReload({ ses_a: { start: before - 48 * 60 * 60 * 1000, seen: before - 1_000 } });

    observeSessionActivityTiming('ses_a', 'active');

    expect(startedAt('ses_a')).toBeGreaterThanOrEqual(before);
  });

  test('ignores malformed persisted payloads', () => {
    getSafeStorage().setItem(STORAGE_KEY, 'not json');
    resetSessionActivityTiming();

    const before = Date.now();
    observeSessionActivityTiming('ses_a', 'active');

    expect(startedAt('ses_a')).toBeGreaterThanOrEqual(before);
  });

  test('ignores entries of the wrong shape or dated in the future', () => {
    const before = Date.now();
    seedReload({
      ses_a: before - 5_000,
      ses_b: { start: 'nope', seen: before },
      ses_c: { start: before + 60_000, seen: before },
      ses_d: { start: before - 5_000, seen: before + 60_000 },
    });

    for (const sessionId of ['ses_a', 'ses_b', 'ses_c', 'ses_d']) {
      observeSessionActivityTiming(sessionId, 'active');
      expect(startedAt(sessionId)).toBeGreaterThanOrEqual(before);
    }
  });

  test('a quiet record ages out of storage on the next write', () => {
    const before = Date.now();
    seedReload({ ses_quiet: { start: before - 300_000, seen: before - 240_000 } });

    observeSessionActivityTiming('ses_a', 'active');

    expect(readPersisted()?.ses_quiet).toBe(undefined);
    expect(readPersisted()?.ses_a.start).toBeDefined();
  });

  test('deleting a session clears live, settled, and persisted timing', () => {
    observeSessionActivityTiming('ses_a', 'active');
    observeSessionActivityTiming('ses_b', 'active');
    observeSessionActivityTiming('ses_b', 'settled');

    removeSessionActivityTiming('ses_a');
    removeSessionActivityTiming('ses_b');

    expect(startedAt('ses_a')).toBe(undefined);
    expect(settledMs('ses_b')).toBe(undefined);
    expect(readPersisted()).toBeNull();
  });

  test('unrelated sessions keep their map references across a no-op update', () => {
    observeSessionActivityTiming('ses_a', 'active');
    const before = useSessionActivityTimingStore.getState();

    observeSessionActivityTiming('ses_a', 'active');
    observeSessionActivityTiming('ses_unknown', 'settled');

    const after = useSessionActivityTimingStore.getState();
    expect(after.startedAt).toBe(before.startedAt);
    expect(after.settledMs).toBe(before.settledMs);
  });

  test('adopting server run timing yields identical elapsed across clients with different clocks', () => {
    const serverRunStartedAt = Date.now() - 42_000;
    const serverNow = Date.now();
    adoptServerRunTiming('ses_a', serverRunStartedAt, serverNow);
    const firstStart = startedAt('ses_a') as number;
    const firstElapsed = Date.now() - firstStart;
    // Simulate second client with clock skewed by +5s: serverNow offset should compensate.
    const skewedNow = Date.now() + 5_000;
    const originalNow = Date.now;
    try {
      (Date as unknown as { now: () => number }).now = () => skewedNow;
      resetSessionActivityTiming();
      adoptServerRunTiming('ses_a', serverRunStartedAt, serverNow);
      const secondStart = startedAt('ses_a') as number;
      const secondElapsed = Date.now() - secondStart;
      // Both clients should report ~42s elapsed (allow 200ms tolerance for call overhead).
      expect(Math.abs(firstElapsed - 42_000)).toBeLessThan(500);
      expect(Math.abs(secondElapsed - 42_000)).toBeLessThan(500);
      expect(Math.abs(firstElapsed - secondElapsed)).toBeLessThan(200);
    } finally {
      Date.now = originalNow;
    }
  });

  test('does not move an active turn start forward on a repeated busy event', () => {
    const serverNow = Date.now();
    adoptServerRunTiming('ses_a', serverNow - 30_000, serverNow);
    const first = startedAt('ses_a');

    adoptServerRunTiming('ses_a', serverNow - 100, serverNow);

    expect(startedAt('ses_a')).toBe(first);
  });

  test('a reload that re-adopts the same server start does not reset the counter', () => {
    const serverRunStartedAt = Date.now() - 15_000;
    const serverNow = Date.now();
    adoptServerRunTiming('ses_a', serverRunStartedAt, serverNow);
    const first = startedAt('ses_a');
    // Simulate reload: clear in-memory but keep server values available via the adopt path.
    const before = Date.now();
    resetSessionActivityTiming();
    adoptServerRunTiming('ses_a', serverRunStartedAt, serverNow);
    expect((startedAt('ses_a') as number) >= before - 15_500).toBe(true);
    expect((startedAt('ses_a') as number) <= before).toBe(true);
    // Must still be considered the same logical start, not a fresh local start.
    expect(Math.abs((startedAt('ses_a') as number) - (first as number))).toBeLessThan(600);
  });
});
