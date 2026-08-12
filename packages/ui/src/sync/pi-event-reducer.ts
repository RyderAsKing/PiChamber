/**
 * Pi session sync owners — the sync-layer wrappers for the pi/ helpers.
 *
 * These modules translate between the Pi-native bootstrap/reducer helpers in
 * `packages/ui/src/lib/pi/` and the existing sync-layer zustand stores. The
 * sync-context layer subscribes its directory stores to events emitted by
 * these owners.
 *
 * The split keeps the pi/ helpers pure and easy to test, while the
 * zustand-aware wrappers live next to the existing sync code that already
 * consumes Zustand stores.
 */

import {
  applyPiEvent,
  applyPiEvents,
  createReducerState,
  projectSession,
  type PiReducerState,
} from '@/lib/pi/event-reducer';
import type { PiSessionEvent } from '@/lib/pi/protocol';
import type { PiSessionId } from '@/lib/pi/types';

/** A self-contained reducer over a list of events. Pure; no zustand. */
export const reduceEvents = (
  state: PiReducerState,
  events: readonly PiSessionEvent[],
): PiReducerState => applyPiEvents(state, events).state;

/** Convenience reducer for a single event. */
export const reduceEvent = (
  state: PiReducerState,
  event: PiSessionEvent,
): PiReducerState => applyPiEvent(state, event).state;

/** Project a single session id from the reducer. */
export const projectReducerSession = (state: PiReducerState, sessionId: PiSessionId) => {
  const session = state.bySession.get(sessionId);
  return session ? projectSession(session) : undefined;
};

/** Project every session known to the reducer. */
export const projectReducerSessions = (state: PiReducerState) => {
  const projections = new Map<PiSessionId, ReturnType<typeof projectSession>>();
  for (const [id, session] of state.bySession.entries()) {
    projections.set(id, projectSession(session));
  }
  return projections;
};

/** Initialize a fresh reducer state. */
export const createPiReducerState = createReducerState;
