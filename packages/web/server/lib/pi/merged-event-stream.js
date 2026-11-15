/**
 * One public `/api/pi/events` subscription over every live session daemon.
 *
 * The main daemon is subscribed exactly as before: same options, same
 * frames, and its failure still ends the connection so the client
 * reconnects. Its resume position keeps travelling as `fromSequence` +
 * `streamEpoch`.
 *
 * Project daemons (sandboxed projects) are subscribed alongside it. Their
 * frames gain `stream` (an opaque id per daemon) and `cursor` (an opaque
 * value carrying every project daemon's epoch and sequence). A client
 * resumes by sending the newest `cursor` it accepted next to its main
 * position. Each project daemon is resumed from its own entry; a daemon
 * whose lifetime changed answers that cursor with a resync snapshot, the
 * same as the main daemon after a restart.
 *
 * Only the affected daemon's sessions resync:
 * - a daemon appearing is subscribed without a cursor (snapshot baseline);
 * - a daemon restarting (its runtime replaced in the pool) or stopping is
 *   unsubscribed, and every session this connection saw from it is
 *   announced with `session.moved` so clients refetch it from its owner;
 * - a project daemon's subscription failing is the same as a stop, then a
 *   bounded retry while it stays registered; it never ends the connection.
 *
 * A session whose frames arrive from a different daemon than before, or
 * one the pool announces (`announceMove`), is also announced with
 * `session.moved`, before any frame from its new owner.
 */

import { MAIN_DAEMON_KEY, publicDaemonStreamId } from './session-daemon/daemon-pool.js';

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 4096;
const MAX_CURSOR_STREAMS = 64;
const MAX_TRACKED_SESSIONS = 4096;
const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 30_000;

const isEpoch = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128;
const isStreamId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);

/** Decode a client cursor into `Map<streamId, { epoch, sequence }>`, or
 *  null when it is malformed. */
export const decodePiEventCursor = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.v !== CURSOR_VERSION || !parsed.d || typeof parsed.d !== 'object' || Array.isArray(parsed.d)) return null;
  const entries = Object.entries(parsed.d);
  if (entries.length > MAX_CURSOR_STREAMS) return null;
  const positions = new Map();
  for (const [id, position] of entries) {
    if (!isStreamId(id) || !Array.isArray(position) || position.length !== 2) return null;
    const [epoch, sequence] = position;
    if (!isEpoch(epoch) || !Number.isSafeInteger(sequence) || sequence < 0) return null;
    positions.set(id, { epoch, sequence });
  }
  return positions;
};

const encodeCursor = (positions) => {
  const d = {};
  for (const [id, { epoch, sequence }] of positions) d[id] = [epoch, sequence];
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, d }), 'utf8').toString('base64url');
};

const movedFrame = (sessionId, directory) => ({
  protocolVersion: 1, kind: 'event', name: 'session.moved', sequence: 0, sessionId, directory, payload: {},
});

/**
 * Subscribe to every live daemon in `pool`. Same contract as a daemon
 * runtime's `subscribe`: resolves to a close function; `onEvent` receives
 * public (already projected) events; `onError` ends the connection.
 */
export const subscribeMergedPiEvents = async ({
  pool,
  projectFrame,
  sessionId,
  directory,
  fromSequence,
  streamEpoch,
  cursor,
  onEvent,
  onError,
  signal,
  retryBaseMs = RETRY_BASE_MS,
}) => {
  const main = pool.main();
  let closed = false;
  // Project daemon positions by public stream id, seeded from the client's
  // cursor so a daemon registering after this connection opened still
  // resumes from where the client left it.
  const positions = new Map(cursor ?? []);
  // key -> { runtime, id, close?, failures, retryTimer? }
  const attached = new Map();
  // sessionId -> { key, directory }: the daemon whose frame this
  // connection last delivered for the session.
  const sessions = new Map();

  const deliver = (event) => {
    if (!closed) onEvent(event);
  };

  const announce = (sessionIdToMove, sessionDirectory) => {
    sessions.delete(sessionIdToMove);
    deliver(movedFrame(sessionIdToMove, sessionDirectory));
  };

  const track = (key, event) => {
    const previous = sessions.get(event.sessionId);
    if (previous && previous.key !== key) announce(event.sessionId, event.directory);
    sessions.delete(event.sessionId);
    sessions.set(event.sessionId, { key, directory: event.directory });
    if (sessions.size > MAX_TRACKED_SESSIONS) sessions.delete(sessions.keys().next().value);
  };

  const announceSessionsOf = (key) => {
    for (const [id, entry] of [...sessions]) if (entry.key === key) announce(id, entry.directory);
  };

  const onMainFrame = (frame) => {
    if (closed) return;
    const event = projectFrame(frame);
    if (!event) return;
    track(MAIN_DAEMON_KEY, event);
    deliver(event);
  };

  const onProjectFrame = (key, entry, frame) => {
    if (closed || attached.get(key) !== entry) return;
    const event = projectFrame(frame);
    if (!event) return;
    if (isEpoch(event.streamEpoch)) {
      const known = positions.get(entry.id);
      if (!known || known.epoch !== event.streamEpoch || event.sequence > known.sequence) {
        positions.set(entry.id, { epoch: event.streamEpoch, sequence: event.sequence });
      }
    }
    track(key, event);
    deliver({ ...event, stream: entry.id, cursor: encodeCursor(positions) });
  };

  const detach = (key) => {
    const entry = attached.get(key);
    if (!entry) return;
    attached.delete(key);
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    try {
      entry.close?.();
    } catch {
      // A subscription that throws on close must not break the others.
    }
    announceSessionsOf(key);
  };

  const scheduleRetry = (key, runtime, failures) => {
    if (closed) return;
    const entry = { runtime, id: publicDaemonStreamId(key), failures, close: undefined, retryTimer: undefined };
    entry.retryTimer = setTimeout(() => {
      if (attached.get(key) !== entry) return;
      attached.delete(key);
      void attach(key, runtime, failures);
    }, Math.min(RETRY_CAP_MS, retryBaseMs * 2 ** Math.min(failures, 6)));
    entry.retryTimer.unref?.();
    attached.set(key, entry);
  };

  const fail = (key, entry) => {
    if (closed || attached.get(key) !== entry) return;
    detach(key);
    scheduleRetry(key, entry.runtime, entry.failures + 1);
  };

  const attach = async (key, runtime, failures = 0) => {
    if (closed || typeof runtime?.subscribe !== 'function') return;
    const entry = { runtime, id: publicDaemonStreamId(key), failures, close: undefined, retryTimer: undefined };
    attached.set(key, entry);
    const position = positions.get(entry.id);
    try {
      const close = await runtime.subscribe({
        sessionId,
        directory,
        ...(position ? { fromSequence: position.sequence, streamEpoch: position.epoch } : {}),
        onEvent: (frame) => onProjectFrame(key, entry, frame),
        onError: () => fail(key, entry),
        signal,
      });
      if (closed || attached.get(key) !== entry) {
        close?.();
        return;
      }
      entry.close = close;
      entry.failures = 0;
    } catch {
      if (closed || attached.get(key) !== entry) return;
      attached.delete(key);
      scheduleRetry(key, runtime, failures + 1);
    }
  };

  const reconcile = () => {
    if (closed) return;
    const live = new Map(pool.live().filter((item) => item.key !== MAIN_DAEMON_KEY).map((item) => [item.key, item.runtime]));
    for (const [key, entry] of [...attached]) {
      if (live.get(key) === entry.runtime) continue;
      detach(key);
      // A stopped daemon's position is dead; a restarted one keeps it so the
      // new process answers with a resync snapshot.
      if (!live.has(key)) positions.delete(entry.id);
    }
    for (const [key, runtime] of live) {
      if (!attached.has(key)) void attach(key, runtime);
    }
  };

  let closeMain;
  let stopPoolListener = () => {};
  let stopMoveListener = () => {};

  const close = () => {
    if (closed) return;
    closed = true;
    stopPoolListener();
    stopMoveListener();
    for (const entry of attached.values()) {
      if (entry.retryTimer) clearTimeout(entry.retryTimer);
      try {
        entry.close?.();
      } catch {
        // Teardown continues for every other daemon.
      }
    }
    attached.clear();
    try {
      closeMain?.();
    } catch {
      // Teardown continues.
    }
  };

  try {
    closeMain = await main.subscribe({ sessionId, directory, fromSequence, streamEpoch, onEvent: onMainFrame, onError, signal });
  } catch (error) {
    close();
    throw error;
  }
  if (closed) return close;
  stopPoolListener = pool.onChange(reconcile);
  stopMoveListener = pool.onMove((movedSessionId, movedDirectory) => {
    if (!closed) announce(movedSessionId, movedDirectory);
  });
  reconcile();
  return close;
};
