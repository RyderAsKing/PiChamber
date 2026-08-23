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
import type { PiSessionEvent } from './protocol';
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

  // 2. Fetch the freshest snapshot the daemon has for the session. A
  //    404 means the daemon has not yet indexed this session, which is
  //    treated as `failed` so the UI can choose to navigate away.
  result.phase = 'snapshot-fetch';
  try {
    const detail = await task(() => piClient.getSession(options.sessionId, {
      directory: options.directory,
      ...(options.runtimeKey ? { runtimeKey: options.runtimeKey } : {}),
    }));
    const hydrated = hydrateSessionFromDetail({
      session: detail.session,
      lastSequence: detail.lastSequence,
      ...(detail.isStreaming !== undefined ? { isStreaming: detail.isStreaming } : {}),
      ...(detail.lifecycle ? { lifecycle: detail.lifecycle } : {}),
      ...(detail.retry ? { retry: detail.retry } : {}),
      ...(detail.compaction ? { compaction: detail.compaction } : {}),
      messages: detail.messages.map((entry) => ({
        message: entry.message,
        parts: entry.parts.map((part) => ({
          id: part.id,
          index: part.index,
          type: part.type,
          text: part.type === 'text' || part.type === 'thinking' ? part.text : undefined,
          ...(part.type === 'tool'
            ? {
                toolCallId: part.toolCallId,
                name: part.name,
                ...(part.input !== undefined ? { input: part.input } : {}),
                ...(part.output !== undefined ? { output: part.output } : {}),
                ...(part.isError !== undefined ? { isError: part.isError } : {}),
                state: part.state,
                ...(part.startedAt !== undefined ? { startedAt: part.startedAt } : {}),
                ...(part.endedAt !== undefined ? { endedAt: part.endedAt } : {}),
              }
            : {}),
          ...(part.type === 'attachment' ? { attachment: part.attachment } : {}),
        })),
      })),
    });
    result.reducerState = hydrated.state;
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
          ...(detail.session.model ? { model: detail.session.model } : {}),
          ...(detail.session.thinking ? { thinking: detail.session.thinking } : {}),
        },
      },
    };
    const applied = applySnapshot(result.snapshotState, snapshotEvent.payload.snapshot);
    result.snapshotState = applied.state;
    // Daemon sequences are global. Resume from the higher of the snapshot
    // cursor and the client's already-applied max so a quieter session's
    // getSession cannot rewind the directory stream into the retained log.
    result.lastSequence = Math.max(options.lastKnownSequence ?? -1, detail.lastSequence);
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
      },
      {
        fromSequence: result.lastSequence,
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
