/**
 * Snapshot reducer helpers — apply a `session.snapshot` event to the running
 * per-session state.
 *
 * Snapshots are the reconnect baseline. The reducer here is intentionally
 * minimal: it replaces the running state with the snapshot's projection
 * when the snapshot's `lastSequence` is greater than the current watermark,
 * and is otherwise a no-op.
 *
 * The reducer keeps its own mutable scratch object so callers do not
 * accidentally share state between sessions. Components consume the
 * returned `PiSessionSnapshotView` instead of the raw snapshot, so they
 * cannot read `lastSequence` or `lifecycle` from a stale baseline.
 */

import type { PiSessionSnapshot } from './types';

export interface PiSessionSnapshotView {
  sessionId: string;
  directory: string;
  isStreaming: boolean;
  lastSequence: number;
  queue: { steering: number; followUp: number };
  model?: PiSessionSnapshot['model'];
  thinking?: PiSessionSnapshot['thinking'];
  compaction?: PiSessionSnapshot['compaction'];
  lastText?: string;
  lastThinking?: string;
  lastToolPart?: PiSessionSnapshot['lastToolPart'];
  lifecycle: PiSessionSnapshot['lifecycle'];
}

export const projectSnapshot = (snapshot: PiSessionSnapshot): PiSessionSnapshotView => ({
  sessionId: snapshot.sessionId,
  directory: snapshot.directory,
  isStreaming: snapshot.isStreaming,
  lastSequence: snapshot.lastSequence,
  queue: snapshot.queue ?? { steering: 0, followUp: 0 },
  ...(snapshot.model ? { model: snapshot.model } : {}),
  ...(snapshot.thinking ? { thinking: snapshot.thinking } : {}),
  ...(snapshot.compaction ? { compaction: snapshot.compaction } : {}),
  ...(snapshot.lastText ? { lastText: snapshot.lastText } : {}),
  ...(snapshot.lastThinking ? { lastThinking: snapshot.lastThinking } : {}),
  ...(snapshot.lastToolPart ? { lastToolPart: snapshot.lastToolPart } : {}),
  lifecycle: snapshot.lifecycle,
});

export interface PiSnapshotReducerState {
  /** Last snapshot the reducer has accepted, by session id. */
  bySession: Map<string, PiSessionSnapshotView>;
  /** Last sequence per session; `-1` means "no snapshot yet". */
  lastSequence: Map<string, number>;
}

export const createSnapshotReducerState = (): PiSnapshotReducerState => ({
  bySession: new Map(),
  lastSequence: new Map(),
});

/**
 * Apply a snapshot. Returns the new state and a `didUpdate` flag. When
 * `didUpdate` is `false`, the caller MUST NOT touch subscribers because the
 * reference would be the same and the reducer rejected a stale or
 * out-of-order snapshot.
 */
export const applySnapshot = (
  state: PiSnapshotReducerState,
  snapshot: PiSessionSnapshot,
): { state: PiSnapshotReducerState; didUpdate: boolean } => {
  const previous = state.lastSequence.get(snapshot.sessionId) ?? -1;
  if (snapshot.lastSequence <= previous) {
    return { state, didUpdate: false };
  }
  const next: PiSnapshotReducerState = {
    bySession: new Map(state.bySession),
    lastSequence: new Map(state.lastSequence),
  };
  next.bySession.set(snapshot.sessionId, projectSnapshot(snapshot));
  next.lastSequence.set(snapshot.sessionId, snapshot.lastSequence);
  return { state: next, didUpdate: true };
};

/**
 * Replace the snapshot for a session (e.g. on a forced disconnect). Unlike
 * `applySnapshot` this accepts the replacement unconditionally because the
 * caller has the authority to do so.
 */
export const resetSnapshot = (
  state: PiSnapshotReducerState,
  sessionId: string,
): PiSnapshotReducerState => {
  if (!state.bySession.has(sessionId) && !state.lastSequence.has(sessionId)) {
    return state;
  }
  const next: PiSnapshotReducerState = {
    bySession: new Map(state.bySession),
    lastSequence: new Map(state.lastSequence),
  };
  next.bySession.delete(sessionId);
  next.lastSequence.delete(sessionId);
  return next;
};
