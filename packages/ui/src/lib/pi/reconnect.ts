/**
 * Pi directory-stream reconnect owner.
 *
 * The reconnect path owns the recovery sequence for a live session:
 *
 *   1. The stream reports a disconnect (or the user hides/returns the tab
 *      and we miss a heartbeat). We mark the session `interrupted` so the
 *      UI shows the warning instead of an idle spinner.
 *   2. We re-attach the live stream. If the runtime is `ready`, we ask
 *      the daemon for a fresh snapshot of the selected session and resume the
 *      runtime-wide stream from there. The stream must stay runtime-scoped
 *      so a later session switch (or folder focus change) keeps receiving
 *      events for every resident session, not just the one we reconnected
 *      for.
 *   3. If the daemon is `unavailable`, we do NOT fabricate an empty
 *      session — we surface the unavailable state until the daemon
 *      reports ready again.
 *
 * The owner is intentionally explicit about phases; the sync layer uses
 * the result to drive UI states (loading spinner, retry button, etc.).
 */

import { fetchPiRuntimeHealth } from './transport';
import { piClient, PiRequestError } from './client';
import { PI_STREAM_EPOCH_CAPABILITY, type PiSessionEvent } from './protocol';
import {
  applySnapshot,
  createSnapshotReducerState,
  type PiSnapshotReducerState,
} from './snapshot';
import { hydrateSessionFromDetail, type PiReducerState } from './event-reducer';
import {
  createPiEventStream,
  type PiStreamHandle,
} from './transport';
import type { PiSessionId } from './types';

export type PiReconnectPhase =
  | 'idle'
  | 'health-check'
  | 'snapshot-fetch'
  | 'stream-attach'
  | 'ready'
  | 'failed'
  | 'unavailable';

export interface PiReconnectResult {
  phase: PiReconnectPhase;
  snapshotState: PiSnapshotReducerState;
  /** Hydrated transcript state used by the sync-layer store. */
  reducerState: PiReducerState;
  stream: PiStreamHandle | null;
  /** Last sequence the snapshot covered. `-1` if no snapshot was applied. */
  lastSequence: number;
  /** Opaque stream-lifetime id of the verified runtime. The owner compares
   *  it with its established epoch to detect a daemon restart. */
  epoch?: string;
  /** True when the verified runtime epoch differs from the caller's
   *  established epoch (daemon restart). The caller's replay cursor is from
   *  a retired sequence space and must not be merged into the new baseline. */
  epochChanged?: boolean;
  /** Server timing for the selected active turn, when available. */
  runStartedAt?: number;
  serverNow?: number;
  /** Error captured during reconnect, when phase is `failed`. */
  error?: { code: string; message?: string; status?: number };
}

interface PiReconnectDependencies {
  fetchHealth: typeof fetchPiRuntimeHealth;
  createStream: typeof createPiEventStream;
}

const defaultDependencies: PiReconnectDependencies = {
  fetchHealth: fetchPiRuntimeHealth,
  createStream: createPiEventStream,
};

export interface PiReconnectOptions {
  directory: string;
  sessionId: PiSessionId;
  runtimeKey?: string;
  /** Sequence the client last successfully applied. `-1` if unknown. */
  lastKnownSequence?: number;
  /** Caller-supplied event handler. */
  onEvent: (event: PiSessionEvent) => void;
  onStreamDisconnect?: (reason: string) => void;
  onStreamReconnect?: () => void;
  onTransportSwitch?: () => void;
  /** The stream observed a health-verified stream-epoch transition
   *  (daemon restart). */
  onEpochChange?: (epoch: string) => void;
  /** A known authorization failure (401/403) stopped the stream's retry
   *  loop; the existing auth flow owns recovery. */
  onAuthRequired?: () => void;
  /** Stream-lifetime id the caller's replay cursor was established under.
   *  When the verified daemon epoch differs, the cursor belongs to a retired
   *  sequence space and the snapshot's baseline is used verbatim. */
  streamEpoch?: string;
  signal?: AbortSignal;
  retry?: <T>(task: () => Promise<T>) => Promise<T>;
}

const toError = (error: unknown): { code: string; message?: string; status?: number } => {
  if (error instanceof PiRequestError) {
    return {
      code: error.code,
      ...(error.message ? { message: error.message } : {}),
      ...(error.status !== undefined ? { status: error.status } : {}),
    };
  }
  if (error instanceof Error) {
    return { code: 'DAEMON_REQUEST_FAILED', message: error.message };
  }
  return { code: 'DAEMON_REQUEST_FAILED' };
};

/**
 * Run a reconnect. The function returns the snapshot reducer state and
 * a live stream handle. The caller is responsible for wiring the snapshot
 * into the main reducer before applying events from `onEvent`.
 */
export const reconnectPiSession = async (
  options: PiReconnectOptions,
  dependencies: PiReconnectDependencies = defaultDependencies,
): Promise<PiReconnectResult> => {
  const result: PiReconnectResult = {
    phase: 'idle',
    snapshotState: createSnapshotReducerState(),
    reducerState: { bySession: new Map(), lastSequence: new Map() },
    stream: null,
    lastSequence: options.lastKnownSequence ?? -1,
  };

  const task = async <T>(work: () => Promise<T>): Promise<T> => (options.retry ? options.retry(work) : work());

  // 1. Health probe first — a `unavailable` result is not a failure but a
  //    distinct state the UI must render.
  result.phase = 'health-check';
  const health = await task(() => dependencies.fetchHealth(options.signal, options.runtimeKey));
  if (health.state !== 'ready') {
    result.phase = 'unavailable';
    result.error = {
      code: health.error?.code ?? 'DAEMON_UNAVAILABLE',
      ...(health.error?.message ? { message: health.error.message } : {}),
    };
    return result;
  }

  // Fail-visible compatibility gate: without the restart-safe stream epoch
  // the reconnect cursor cannot be trusted across a daemon restart. Refuse
  // with an explicit protocol mismatch instead of resuming blind.
  if (
    !health.capabilities.includes(PI_STREAM_EPOCH_CAPABILITY)
    || typeof health.streamEpoch !== 'string'
    || health.streamEpoch.length === 0
  ) {
    result.phase = 'failed';
    result.error = {
      code: 'DAEMON_PROTOCOL_MISMATCH',
      message: 'The Pi runtime does not advertise a restart-safe event stream (events.streamEpoch). Update the server.',
    };
    return result;
  }
  result.epoch = health.streamEpoch;
  // Sequence comparisons are epoch-scoped. A caller cursor from a different
  // stream lifetime must never be merged (max) into the new daemon's
  // baseline: once the new daemon's sequence numerically overtakes the old
  // cursor, a blind max would skip the head of the new sequence space.
  const establishedEpoch = typeof options.streamEpoch === 'string' && options.streamEpoch.length > 0
    ? options.streamEpoch
    : null;
  const epochChanged = establishedEpoch !== null && establishedEpoch !== result.epoch;
  if (epochChanged) result.epochChanged = true;

  // 2. Fetch the freshest snapshot the daemon has for the session. A
  //    404 means the daemon has not yet indexed this session, which is
  //    treated as `failed` so the UI can choose to navigate away.
  result.phase = 'snapshot-fetch';
  try {
    const detail = await task(() => piClient.getSession(options.sessionId, {
      directory: options.directory,
      ...(options.runtimeKey ? { runtimeKey: options.runtimeKey } : {}),
    }));
    // A detail response generated by a previous daemon process (stale epoch)
    // carries a sequence from a different space; reject it and let the next
    // reconnect attempt re-read from the current daemon.
    if (typeof detail.streamEpoch !== 'string' || detail.streamEpoch.length === 0) {
      throw new PiRequestError('DAEMON_PROTOCOL_MISMATCH', 'Session detail omitted the current stream epoch');
    }
    if (detail.streamEpoch !== result.epoch) {
      throw new PiRequestError('DAEMON_REQUEST_FAILED', 'Session detail predates the current stream epoch');
    }
    const hydrated = hydrateSessionFromDetail(detail);
    result.reducerState = hydrated.state;
    if (
      (detail.lifecycle === 'busy' || detail.lifecycle === 'retry')
      && Number.isFinite(detail.runStartedAt)
    ) {
      result.runStartedAt = detail.runStartedAt;
      if (Number.isFinite(detail.serverNow)) result.serverNow = detail.serverNow;
    }
    // Synthesize a snapshot event from the detail response. We use the
    // event reducer's snapshot path so the reconnect logic stays in one
    // place.
    const snapshotEvent: PiSessionEvent = {
      protocolVersion: 1,
      kind: 'event',
      name: 'session.snapshot',
      sequence: detail.lastSequence,
      sessionId: detail.session.id,
      directory: detail.session.directory,
      payload: {
        snapshot: {
          sessionId: detail.session.id,
          directory: detail.session.directory,
          lastSequence: detail.lastSequence,
          isStreaming: detail.isStreaming === true,
          queue: { steering: 0, followUp: 0 },
          lifecycle: detail.lifecycle ?? (detail.isStreaming ? 'busy' : 'idle'),
          ...(detail.retry ? { retry: detail.retry } : {}),
          ...(detail.compaction ? { compaction: detail.compaction } : {}),
          ...(Number.isFinite(detail.runStartedAt) ? { runStartedAt: detail.runStartedAt } : {}),
          ...(Number.isFinite(detail.serverNow) ? { serverNow: detail.serverNow } : {}),
          ...(detail.session.model ? { model: detail.session.model } : {}),
          ...(detail.session.thinking ? { thinking: detail.session.thinking } : {}),
        },
      },
    };
    const applied = applySnapshot(result.snapshotState, snapshotEvent.payload.snapshot);
    result.snapshotState = applied.state;
    // Daemon sequences are global within one stream lifetime. Resume from
    // the higher of the snapshot cursor and the client's already-applied max
    // so a quieter session's getSession cannot rewind the directory stream
    // into the retained log — unless the epoch changed, in which case the
    // old cursor is meaningless and the snapshot baseline is used verbatim.
    result.lastSequence = epochChanged
      ? detail.lastSequence
      : Math.max(options.lastKnownSequence ?? -1, detail.lastSequence);
  } catch (error) {
    const wrapped = toError(error);
    if (wrapped.code === 'INVALID_SESSION') {
      result.phase = 'failed';
      result.error = wrapped;
      return result;
    }
    // A transient failure during snapshot fetch becomes `failed`; the
    // caller decides whether to retry.
    result.phase = 'failed';
    result.error = wrapped;
    return result;
  }

  // 3. Attach the stream at the resume watermark. Events with a sequence
  //    <= lastSequence are dropped by the reducer.
  result.phase = 'stream-attach';
  try {
    result.stream = dependencies.createStream(
      {
        onEvent: options.onEvent,
        onDisconnect: (reason) => options.onStreamDisconnect?.(reason),
        onReconnect: () => options.onStreamReconnect?.(),
        onTransportSwitch: () => options.onTransportSwitch?.(),
        onEpochChange: (epoch) => options.onEpochChange?.(epoch),
        onAuthRequired: () => options.onAuthRequired?.(),
      },
      {
        fromSequence: result.lastSequence,
        streamEpoch: result.epoch,
        ...(options.runtimeKey ? { runtimeKey: options.runtimeKey } : {}),
        signal: options.signal,
      },
    );
  } catch (error) {
    result.phase = 'failed';
    result.error = toError(error);
    return result;
  }

  result.phase = 'ready';
  return result;
};
