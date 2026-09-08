import { useCallback } from 'react';
import { create } from 'zustand';
import { toClientTimestamp } from '@/lib/pi/server-clock';
import { getSafeStorage } from '@/stores/utils/safeStorage';

// Per-session turn timing behind the sidebar activity readout.
//
// Pi's lifecycle status remains a bare `busy | retry | idle` union, so a status
// update alone cannot establish a turn boundary. PiChamber session details and
// lifecycle snapshots may additionally carry `runStartedAt`; this module
// adopts that origin when available and otherwise measures the turn on the
// client. It is driven from `PiSessionStore` lifecycle event handling, so a
// row can never count a turn that the catalog calls idle.
//
// Two maps with deliberately different lifetimes:
//
// - `startedAt` — sessions observed active right now. Persisted, so reloading
//   the page resumes the same count instead of restarting it at zero.
// - `settledMs` — how long the turn that just finished took. In memory only:
//   rows show it while the session is unread, and unread state itself does not
//   survive a reload, so persisting it would outlive its only consumer.
//
// A persisted start is a lookup table, never a claim of activity. The daemon
// may provide `runStartedAt` on an active detail or lifecycle/snapshot event;
// first attach and reconnect adopt that authoritative origin. The lifecycle
// status itself still has no boundary: the server calls `SessionStatus.set`
// with `busy` at every step of the agent loop and publishes an event each time,
// so a busy event without `runStartedAt` means "still running", not "just
// started". Reading it as a turn boundary resets every counter on reload.
//
// Turn *ends* are marked: `session.idle` and `session.error` events fire once,
// live, and retire the persisted record.
//
// When the daemon cannot provide that origin, a turn may end and another may
// begin entirely while the tab is gone. Two bounds stand in for the evidence
// the client cannot have:
//
// - a liveness stamp beside the start, refreshed while the session is observed
//   active and stamped precisely as the page hides, compared against this page's
//   navigation start — how long the app was actually absent;
// - an adoption window after load, after which unclaimed records are discarded,
//   which backstops a runtime whose event stream is down, where no live event
//   would ever retire the record.
//
// Nothing else may drop a persisted start. Settles come only from live
// `idle`/`error` events, which fire once; absence of a busy event is not
// evidence of a settled turn. Only the two bounds above expire a record.

type SessionActivityPhase = 'active' | 'settled';


type SessionActivityTimingState = {
  startedAt: ReadonlyMap<string, number>;
  settledMs: ReadonlyMap<string, number>;
};

/** Persisted per session: when this turn began, and when it was last alive. */
type PersistedStart = { start: number; seen: number };

/** Finished turns worth remembering at once; each row only needs its own. */
const SETTLED_LIMIT = 200;
/** A turn running longer than this is treated as a stale record, not a turn. */
const MAX_TURN_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * How long the app may have been gone and still have its counters resumed,
 * measured from the liveness stamp to this page's navigation start — not to
 * "now". Bootstrap latency belongs to this page, not to the absence, and this
 * client has seen 20-second startups; charging those to the gap would refuse
 * a legitimate resume on exactly the slowest machines.
 */
const MAX_AWAY_MS = 30_000;
/** Refresh the persisted stamp at most this often during a long turn. */
const LIVENESS_PERSIST_INTERVAL_MS = 15_000;
/**
 * How long after page load a persisted record may still be adopted. Past this
 * point the app has certainly seen live status, so a record nothing claimed
 * describes a turn that is over — and a turn starting later is a new one that
 * must count from zero.
 */
const RESTORE_ADOPTION_WINDOW_MS = 90_000;
// One key, not one per runtime. These records live for seconds and are keyed by
// instance-unique session IDs, so runtime scoping bought nothing while adding a
// real failure mode: the runtime key is derived from injected globals and is not
// guaranteed stable across early startup, and a read under a key the previous
// page did not write to looks exactly like "no turn was running".
const STORAGE_KEY = 'oc.session-activity.v1';

const EMPTY_ACTIVE: ReadonlySet<string> = new Set();
const EMPTY_RESTORED: ReadonlyMap<string, PersistedStart> = new Map();

export const useSessionActivityTimingStore = create<SessionActivityTimingState>(() => ({
  startedAt: new Map(),
  settledMs: new Map(),
}));

/** Last moment each live start was observed active, for the liveness stamp. */
const liveSeen = new Map<string, number>();
let lastPersistAt = 0;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

let restoredStarts: Map<string, PersistedStart> | null = null;

/** Epoch ms of this page's navigation start; the reference for "how long gone". */
const readPageLoadAt = (): number => {
  if (typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin)) {
    return performance.timeOrigin;
  }
  return Date.now();
};

let pageLoadAt = readPageLoadAt();

const isResumable = (entry: PersistedStart, now: number): boolean => (
  entry.start <= now
  && now - entry.start <= MAX_TURN_AGE_MS
  && entry.seen <= now
  // Negative when this page wrote the stamp itself, which is trivially fresh.
  && pageLoadAt - entry.seen <= MAX_AWAY_MS
);

const parseEntry = (value: unknown): PersistedStart | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { start, seen } = value as { start?: unknown; seen?: unknown };
  if (typeof start !== 'number' || !Number.isFinite(start)) return null;
  if (typeof seen !== 'number' || !Number.isFinite(seen)) return null;
  return { start, seen };
};

const readRestoredStarts = (): Map<string, PersistedStart> => {
  const restored = new Map<string, PersistedStart>();
  let raw: string | null = null;
  try {
    raw = getSafeStorage().getItem(STORAGE_KEY);
  } catch {
    return restored;
  }
  if (!raw) return restored;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed payload is a failed read, not authoritative "no turns were
    // running": live status re-seeds every counter from now either way.
    return restored;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return restored;

  const now = Date.now();
  for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = parseEntry(value);
    // Rejects stale turns, quiet stamps, and clock-skewed futures rather than
    // rendering a counter that reads days long or negative.
    if (entry && isResumable(entry, now)) restored.set(sessionId, entry);
  }
  return restored;
};

const getRestoredStarts = (): Map<string, PersistedStart> => {
  restoredStarts ??= readRestoredStarts();
  return restoredStarts;
};

/**
 * Restored records still eligible to be adopted. Past the adoption window they
 * are dropped for good, so a turn that starts later counts from zero instead of
 * inheriting the start of whatever ran before the reload.
 */
const getAdoptableStarts = (now: number): ReadonlyMap<string, PersistedStart> => {
  if (now - pageLoadAt > RESTORE_ADOPTION_WINDOW_MS) {
    restoredStarts?.clear();
    return EMPTY_RESTORED;
  }
  return getRestoredStarts();
};

// Live starts merged over restored-but-unconfirmed ones, so a reload landing
// before the first live status event does not drop the starts those events are
// about to confirm. Restored entries whose stamp has gone quiet are
// dropped here, which is the only way they leave storage.
const persistStarts = (startedAt: ReadonlyMap<string, number>, now: number): void => {
  const payload: Record<string, PersistedStart> = {};
  for (const [sessionId, entry] of getRestoredStarts()) {
    if (isResumable(entry, now)) payload[sessionId] = entry;
  }
  for (const [sessionId, start] of startedAt) {
    payload[sessionId] = { start, seen: liveSeen.get(sessionId) ?? now };
  }

  lastPersistAt = now;
  try {
    const storage = getSafeStorage();
    if (Object.keys(payload).length === 0) {
      storage.removeItem(STORAGE_KEY);
      return;
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage is unavailable or full; counters simply restart after a reload.
  }
};

// The most accurate liveness stamp available: the page is going away and every
// running turn was still running as of now. Writes are immediate (not deferred)
// so this cannot lose the race against a deferred flush on the same event.
const stampLiveness = (): void => {
  const { startedAt } = useSessionActivityTimingStore.getState();
  if (startedAt.size === 0) return;
  const now = Date.now();
  for (const sessionId of startedAt.keys()) liveSeen.set(sessionId, now);
  persistStarts(startedAt, now);
};

let lifecycleHooked = false;

const ensureLivenessStampOnHide = (): void => {
  if (lifecycleHooked || typeof window === 'undefined') return;
  lifecycleHooked = true;
  try {
    // `pagehide` covers unload and bfcache entry; `visibilitychange`/`freeze`
    // cover backgrounding and are the reliable ones in WKWebView. No
    // `beforeunload` — it would cost bfcache for a stamp the others already
    // wrote.
    window.addEventListener('pagehide', stampLiveness, { capture: true });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') stampLiveness();
      });
      document.addEventListener('freeze', stampLiveness);
    }
  } catch {
    // Restricted environments can reject listeners; the periodic stamp refresh
    // still bounds how quiet a running turn's record can get.
  }
};

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

const trimSettled = (settled: Map<string, number>): void => {
  while (settled.size > SETTLED_LIMIT) {
    const oldest = settled.keys().next();
    if (oldest.done) return;
    settled.delete(oldest.value);
  }
};

/**
 * A live `idle`/`error` event names its session outright: it is a one-shot,
 * unambiguous end of turn.
 */
const applyTransitions = (
  activeSessionIds: ReadonlySet<string>,
  settleSessionId: string | null,
): void => {
  const now = Date.now();
  const restored = getAdoptableStarts(now);
  const state = useSessionActivityTimingStore.getState();

  const next: { started: Map<string, number> | null; settled: Map<string, number> | null } = {
    started: null,
    settled: null,
  };
  let sawActive = false;
  let restoredChanged = false;

  const draftStarted = (): Map<string, number> => (next.started ??= new Map(state.startedAt));
  const draftSettled = (): Map<string, number> => (next.settled ??= new Map(state.settledMs));

  for (const sessionId of activeSessionIds) {
    sawActive = true;
    liveSeen.set(sessionId, now);
    if ((next.started ?? state.startedAt).has(sessionId)) continue;
    // Busy carries no turn boundary: the server re-publishes
    // `session.status: busy` on every step of the agent loop, so a busy event
    // means "still running", not "just started". The active path therefore
    // prefers a persisted start when one survives; only the bounds below
    // expire it.
    draftStarted().set(sessionId, restored.get(sessionId)?.start ?? now);
    if ((next.settled ?? state.settledMs).has(sessionId)) draftSettled().delete(sessionId);
  }

  const settleTurn = (sessionId: string, start: number): void => {
    draftStarted().delete(sessionId);
    liveSeen.delete(sessionId);
    draftSettled().set(sessionId, Math.max(0, now - start));
  };

  if (settleSessionId !== null) {
    // An idle/error event is a live, unambiguous end of turn, so it also retires
    // the persisted record.
    if (getRestoredStarts().delete(settleSessionId)) restoredChanged = true;
    const start = state.startedAt.get(settleSessionId);
    // Only a turn watched from its start yields a duration.
    if (start !== undefined) settleTurn(settleSessionId, start);
  }

  if (next.settled) trimSettled(next.settled);

  if (next.started || next.settled) {
    useSessionActivityTimingStore.setState({
      startedAt: next.started ?? state.startedAt,
      settledMs: next.settled ?? state.settledMs,
    });
  }

  if (next.started) {
    if (next.started.size > 0) ensureLivenessStampOnHide();
    persistStarts(next.started, now);
    return;
  }
  if (restoredChanged) {
    persistStarts(state.startedAt, now);
    return;
  }
  // Nothing structural changed, but a long-running turn still needs its stamp
  // refreshed so a reload can tell it apart from one that ended unobserved.
  if (sawActive && state.startedAt.size > 0 && now - lastPersistAt >= LIVENESS_PERSIST_INTERVAL_MS) {
    persistStarts(state.startedAt, now);
  }
};

/**
 * Event-driven path: one session changed phase, live. Busy repeats throughout a
 * turn and carries no boundary; idle/error fire once and end it, which is why
 * only settling here retires the persisted record.
 */
export const observeSessionActivityTiming = (
  sessionId: string,
  phase: SessionActivityPhase,
): void => {
  if (phase === 'active') {
    applyTransitions(new Set([sessionId]), null);
    return;
  }
  applyTransitions(EMPTY_ACTIVE, sessionId);
};

/**
 * Server authoritative start for an active turn. Uses the server's
 * `runStartedAt` plus the server-now offset so every client, regardless of
 * local clock, shows the same elapsed time. Falls back to the raw server
 * timestamp when no serverNow is available.
 */
export const adoptServerRunTiming = (
  sessionId: string,
  runStartedAt: number,
  serverNow?: number,
): void => {
  if (!Number.isFinite(runStartedAt)) return;
  const now = Date.now();
  const clientStartedAt = toClientTimestamp(runStartedAt, serverNow, now);
  if (clientStartedAt === undefined) return;
  // Adopt only if the adjusted start is recent enough to be a live turn.
  if (now - clientStartedAt > MAX_TURN_AGE_MS || clientStartedAt > now + 60_000) return;
  const state = useSessionActivityTimingStore.getState();
  const existing = state.startedAt.get(sessionId);
  if (existing === clientStartedAt) return;
  const nextStarted = new Map(state.startedAt);
  nextStarted.set(sessionId, clientStartedAt);
  const nextSettled = new Map(state.settledMs);
  nextSettled.delete(sessionId);
  liveSeen.set(sessionId, now);
  useSessionActivityTimingStore.setState({ startedAt: nextStarted, settledMs: nextSettled });
  ensureLivenessStampOnHide();
  persistStarts(nextStarted, now);
};

export const removeSessionActivityTiming = (sessionId: string): void => {
  const restoredChanged = getRestoredStarts().delete(sessionId);
  const state = useSessionActivityTimingStore.getState();
  const hadStart = state.startedAt.has(sessionId);
  const hadSettled = state.settledMs.has(sessionId);
  liveSeen.delete(sessionId);

  if (!hadStart && !hadSettled) {
    if (restoredChanged) persistStarts(state.startedAt, Date.now());
    return;
  }

  let startedAt = state.startedAt;
  if (hadStart) {
    const draft = new Map(state.startedAt);
    draft.delete(sessionId);
    startedAt = draft;
  }
  let settledMs = state.settledMs;
  if (hadSettled) {
    const draft = new Map(state.settledMs);
    draft.delete(sessionId);
    settledMs = draft;
  }

  useSessionActivityTimingStore.setState({ startedAt, settledMs });
  if (hadStart || restoredChanged) persistStarts(startedAt, Date.now());
};

/**
 * Drops in-memory state and the cached restored-start snapshot — i.e. treats
 * what follows as a fresh page load. Called on a runtime switch, where the
 * previous instance's turns are no longer ours, and by tests. `pageLoadAt`
 * overrides the navigation-start reference so tests can place a load in the
 * past (slow bootstrap, expired window).
 */
export const resetSessionActivityTiming = (options: { pageLoadAt?: number } = {}): void => {
  restoredStarts = null;
  liveSeen.clear();
  lastPersistAt = 0;
  pageLoadAt = options.pageLoadAt ?? Date.now();
  useSessionActivityTimingStore.setState({ startedAt: new Map(), settledMs: new Map() });
};

// ---------------------------------------------------------------------------
// Leaf subscriptions
// ---------------------------------------------------------------------------

export const useSessionActivityStartedAt = (sessionId: string): number | undefined => (
  useSessionActivityTimingStore(useCallback((state) => state.startedAt.get(sessionId), [sessionId]))
);

export const useSessionSettledDurationMs = (sessionId: string): number | undefined => (
  useSessionActivityTimingStore(useCallback((state) => state.settledMs.get(sessionId), [sessionId]))
);

/**
 * Whether a duration exists to render, without subscribing the caller to the
 * value itself — a row uses this to decide between the counter and its normal
 * metadata, and must not re-render every tick to do so.
 */
export const useHasSessionActivityDuration = (sessionId: string, running: boolean): boolean => (
  useSessionActivityTimingStore(useCallback((state) => (
    running ? state.startedAt.has(sessionId) : state.settledMs.has(sessionId)
  ), [running, sessionId]))
);
