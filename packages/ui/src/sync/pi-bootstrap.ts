/**
 * Pi sync-layer bootstrap owner.
 *
 * This module is the sync-context glue that ties the pi-bootstrap helpers
 * to the existing per-directory zustand store. It exposes a single function
 * (`bootstrapPiDirectoryForStore`) that runs the bootstrap, applies the
 * initial events to the store, and returns a controller the sync-context
 * can use to dispose the live stream.
 *
 * The store contract here is intentionally minimal: the function only
 * needs a `setEvents` setter so we can apply events as they arrive. The
 * sync-context layer owns the actual store reference; this owner owns
 * the lifecycle of the stream.
 */

import { bootstrapPiDirectory, type PiBootstrapResult } from '@/lib/pi/bootstrap';
import type { PiSessionEvent } from '@/lib/pi/protocol';
import type { PiSessionId } from '@/lib/pi/types';
import type { PiReducerState } from '@/lib/pi/event-reducer';

export interface PiSyncBootstrapController {
  /** Dispose the live stream and cancel any pending work. */
  dispose: () => void;
  /** The bootstrap result, retained for diagnostics. */
  result: PiBootstrapResult | null;
}

export interface PiSyncBootstrapStore {
  /** Replace the reducer state with the bootstrap snapshot. */
  setReducerState: (state: PiReducerState) => void;
  /** Apply a sequenced event to the running state. */
  applyEvent: (event: PiSessionEvent) => void;
  /** Apply a batch of sequenced events. */
  applyEvents: (events: readonly PiSessionEvent[]) => void;
  /** Optional accessor for the current reducer state (used by stores that
   *  keep it outside of zustand). */
  getReducerState?: () => PiReducerState;
}

export interface PiSyncBootstrapInput {
  directory: string;
  store: PiSyncBootstrapStore;
  selectedSessionId?: PiSessionId;
  lastKnownSequence?: number;
  runtimeKey?: string;
  signal?: AbortSignal;
  retry?: <T>(task: () => Promise<T>) => Promise<T>;
}

/**
 * Run a bootstrap and wire the resulting stream into the supplied store.
 * The returned controller exposes `dispose`; sync-context calls it when
 * the directory unmounts or the runtime changes.
 */
export const bootstrapPiDirectoryForStore = async (
  input: PiSyncBootstrapInput,
): Promise<PiSyncBootstrapController> => {
  let stream: PiBootstrapResult['stream'] = null;
  let result: PiBootstrapResult | null = null;

  try {
    result = await bootstrapPiDirectory({
      directory: input.directory,
      selectedSessionId: input.selectedSessionId,
      fromSequence: input.lastKnownSequence,
      runtimeKey: input.runtimeKey,
      signal: input.signal,
      retry: input.retry,
      onEvent: (event: PiSessionEvent) => input.store.applyEvent(event),
    });
    stream = result.stream;
    if (result.reducerState.bySession.size > 0 || result.lastSequence.size > 0) {
      input.store.setReducerState(result.reducerState);
    }
  } catch {
    // bootstrap already records its own errors; nothing to do here.
  }

  return {
    dispose: () => {
      stream?.dispose();
    },
    result,
  };
};
