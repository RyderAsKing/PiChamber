/**
 * Pi sync-layer reconnect owner.
 *
 * The reconnect owner is the sync-context glue for the pi/ helpers:
 *
 * - It runs the reconnect sequence (health probe → snapshot fetch → stream
 *   attach) and surfaces the hydrated snapshot to the store.
 * - It then forwards live events through the same store setter as the
 *   bootstrap path.
 * - It reports stream disconnects through the transport owner without
 *   inventing a daemon sequence number or authoritative session event.
 *
 * The store contract is the same as the bootstrap owner.
 */

import { reconnectPiSession, type PiReconnectResult } from '@/lib/pi/reconnect';
import type { PiSessionEvent } from '@/lib/pi/protocol';
import type { PiSessionId } from '@/lib/pi/types';
import type { PiReducerState } from '@/lib/pi/event-reducer';

export interface PiSyncReconnectController {
  dispose: () => void;
  result: PiReconnectResult | null;
}

export interface PiSyncReconnectInput {
  directory: string;
  sessionId: PiSessionId;
  runtimeKey?: string;
  lastKnownSequence?: number;
  store: {
    setReducerState: (state: PiReducerState) => void;
    applyEvent: (event: PiSessionEvent) => void;
    applyEvents: (events: readonly PiSessionEvent[]) => void;
  };
  signal?: AbortSignal;
  retry?: <T>(task: () => Promise<T>) => Promise<T>;
}

export const reconnectPiSessionForStore = async (
  input: PiSyncReconnectInput,
): Promise<PiSyncReconnectController> => {
  let stream: PiReconnectResult['stream'] = null;
  let result: PiReconnectResult | null = null;
  try {
    result = await reconnectPiSession({
      directory: input.directory,
      sessionId: input.sessionId,
      runtimeKey: input.runtimeKey,
      lastKnownSequence: input.lastKnownSequence,
      signal: input.signal,
      retry: input.retry,
      onEvent: (event: PiSessionEvent) => input.store.applyEvent(event),
      // A transport disconnect is not an authoritative Pi session event.
      // Do not advance the daemon sequence watermark with a fabricated event;
      // the UI can show transport-unavailable state through its connection
      // owner and the daemon's sequenced `session.interrupted` event remains
      // authoritative after reconnect.
      onStreamDisconnect: () => undefined,
    });

    if (result.phase === 'ready' && result.stream) {
      stream = result.stream;
      // Apply the hydrated transcript plus its sequence watermark. The
      // snapshot sidecar remains available for lifecycle-only projections,
      // but the main reducer must retain the authoritative message records.
      input.store.setReducerState(result.reducerState);
    }
  } catch {
    // reconnect records its own errors; nothing to do here.
  }

  return {
    dispose: () => {
      stream?.dispose();
    },
    result,
  };
};
