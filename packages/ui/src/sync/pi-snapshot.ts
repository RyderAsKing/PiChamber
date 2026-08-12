/**
 * Pi sync-layer snapshot owner.
 *
 * The snapshot owner is a thin zustand-aware wrapper over `pi/snapshot.ts`.
 * The store consumers subscribe to its per-session projection; the live
 * reducer events advance the same projection.
 */

import {
  applySnapshot as applySnapshotReducer,
  createSnapshotReducerState as createSnapshotState,
  projectSnapshot,
  resetSnapshot,
  type PiSessionSnapshotView,
  type PiSnapshotReducerState,
} from '@/lib/pi/snapshot';
import type { PiSessionSnapshot } from '@/lib/pi/types';

export {
  applySnapshotReducer,
  createSnapshotState,
  projectSnapshot,
  resetSnapshot,
};
export type { PiSessionSnapshotView, PiSnapshotReducerState };

/**
 * Convenience helper for stores that hold an immutable snapshot map.
 * Returns a new map only when the snapshot's sequence is strictly greater
 * than the previously accepted sequence.
 */
export const upsertSnapshot = (
  state: PiSnapshotReducerState,
  snapshot: PiSessionSnapshot,
): PiSnapshotReducerState => applySnapshotReducer(state, snapshot).state;

/** Return the snapshot view for a single session id, or `undefined`. */
export const getSnapshotView = (
  state: PiSnapshotReducerState,
  sessionId: string,
): PiSessionSnapshotView | undefined => state.bySession.get(sessionId);

/** Last accepted sequence per session id; `-1` for sessions with no snapshot. */
export const getLastSequence = (
  state: PiSnapshotReducerState,
  sessionId: string,
): number => state.lastSequence.get(sessionId) ?? -1;
