/**
 * Pi session bootstrap owner.
 *
 * Bootstrap is the per-directory cold-start sequence:
 *
 *   1. Probe `/api/pi/runtime` to confirm the daemon is `ready`. Failure
 *      here is recorded as `unavailable`; the UI must never conflate that
 *      with an empty session list.
 *   2. List the sessions for the directory.
 *   3. For the selected session, hydrate its messages with the latest
 *      `lastSequence` so the live stream can resume from there.
 *
 * The bootstrap owner is intentionally a plain function that returns a
 * result object. The owning store wraps it in zustand selectors, and the
 * `sync-context.tsx` layer subscribes the directory store to its events.
 * `retry()` lives in the sync layer so the bootstrap path can use the
 * shared retry budget without importing it directly here.
 */

import {
  fetchPiRuntimeHealth,
  type PiStreamHandle,
} from './transport';
import {
  piClient,
  type PiClientScope,
  PiRequestError,
} from './client';
import {
  hydrateSessionFromDetail,
  type PiReducerState,
} from './event-reducer';
import type { PiSessionId } from './types';
import type { PiSessionEvent } from './protocol';

export type PiBootstrapPhase =
  | 'idle'
  | 'runtime-probe'
  | 'session-list'
  | 'session-hydrate'
  | 'stream-attach'
  | 'ready'
  | 'failed';

export interface PiBootstrapResult {
  phase: PiBootstrapPhase;
  /** Reducer state at the end of bootstrap (empty map if anything failed). */
  reducerState: PiReducerState;
  /** Last sequence per session id from the hydrating call. */
  lastSequence: Map<PiSessionId, number>;
  /** Stream handle, when bootstrap reached `stream-attach`. */
  stream: PiStreamHandle | null;
  /** Errors captured during bootstrap; recoverable list/hydrate failures may coexist with `ready`. */
  errors: Array<{ phase: PiBootstrapPhase; error: PiBootstrapError }>;
  /** Daemon health response; `null` if the probe never completed. */
  health: PiBootstrapHealth;
}

export type PiBootstrapHealth =
  | { state: 'pending' }
  | { state: 'ready'; protocolVersion: number; capabilities: string[] }
  | { state: 'unavailable'; protocolVersion: number; error: { code: string; message?: string } };

export interface PiBootstrapError {
  code: string;
  message?: string;
  status?: number;
}

export interface PiBootstrapOptions {
  directory: string;
  scope?: PiClientScope;
  /** Select a session to hydrate on top of the list. */
  selectedSessionId?: PiSessionId;
  /** Reconnect from a previously-known sequence. */
  fromSequence?: number;
  /** Receive events as they arrive; bootstrap returns once the stream is wired. */
  onEvent: (event: PiSessionEvent) => void;
  /** Called when the underlying stream reports a disconnect. */
  onStreamDisconnect?: (reason: string) => void;
  /** Called when the underlying stream reconnects. */
  onStreamReconnect?: () => void;
  /** Called when the underlying stream switches transport. */
  onTransportSwitch?: () => void;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Runtime identity captured by the caller. */
  runtimeKey?: string;
  /** Optional retry helper; defaults to no retry. The caller can pass the
   *  shared `retry()` from `@/sync/retry` to share its budget. */
  retry?: <T>(task: () => Promise<T>) => Promise<T>;
}

const toError = (error: unknown): PiBootstrapError => {
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
 * Run a per-directory bootstrap. The returned handle owns the live stream;
 * callers MUST dispose it on unmount to avoid leaking the WebSocket/SSE
 * reader.
 */
export const bootstrapPiDirectory = async (options: PiBootstrapOptions): Promise<PiBootstrapResult> => {
  const result: PiBootstrapResult = {
    phase: 'idle',
    reducerState: { bySession: new Map(), lastSequence: new Map() },
    lastSequence: new Map(),
    stream: null,
    errors: [],
    health: { state: 'pending' },
  };

  const task = async <T>(work: () => Promise<T>): Promise<T> => (options.retry ? options.retry(work) : work());

  // 1. Probe runtime health.
  result.phase = 'runtime-probe';
  const health = await task(() => fetchPiRuntimeHealth(options.signal, options.runtimeKey));
  if (health.state === 'ready') {
    result.health = {
      state: 'ready',
      protocolVersion: health.protocolVersion,
      capabilities: [...health.capabilities],
    };
  } else {
    result.health = {
      state: 'unavailable',
      protocolVersion: health.protocolVersion,
      error: {
        code: health.error?.code ?? 'DAEMON_UNAVAILABLE',
        ...(health.error?.message ? { message: health.error.message } : {}),
      },
    };
    result.phase = 'failed';
    result.errors.push({
      phase: 'runtime-probe',
      error: result.health.error,
    });
    return result;
  }

  // 2. List sessions. A failed list is recorded but does NOT abort:
  //    the UI can still hydrate a directly selected session id.
  result.phase = 'session-list';
  try {
    const list = await task(() => piClient.listSessions({
      ...options.scope,
      directory: options.directory,
      ...(options.runtimeKey ? { runtimeKey: options.runtimeKey } : {}),
    }));
    for (const item of list.sessions) {
      // Seed the reducer with bare session records so the UI can render
      // titles while waiting for hydration.
      result.lastSequence.set(item.session.id, -1);
    }
  } catch (error) {
    result.errors.push({ phase: 'session-list', error: toError(error) });
  }

  // 3. Hydrate the selected session.
  if (options.selectedSessionId) {
    result.phase = 'session-hydrate';
    try {
      const detail = await task(() => piClient.getSession(options.selectedSessionId as PiSessionId, {
        ...options.scope,
        directory: options.directory,
        ...(options.runtimeKey ? { runtimeKey: options.runtimeKey } : {}),
      }));
      const { state } = hydrateSessionFromDetail({
        session: { id: detail.session.id, directory: detail.session.directory },
        lastSequence: detail.lastSequence,
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
            ...(part.type === 'attachment'
              ? { attachment: part.attachment }
              : {}),
          })),
        })),
      });
      result.reducerState = state;
      result.lastSequence.set(detail.session.id, detail.lastSequence);
    } catch (error) {
      result.errors.push({ phase: 'session-hydrate', error: toError(error) });
    }
  }

  // 4. Attach the live stream. We do not block bootstrap on the stream
  //    attaching — the stream has its own reconnect logic — but we record
  //    the handle so the caller can dispose it later.
  result.phase = 'stream-attach';
  try {
    const { createPiEventStream } = await import('./transport');
    const streamFromSequence = options.selectedSessionId
      ? result.lastSequence.get(options.selectedSessionId)
      : options.fromSequence;
    const handle = createPiEventStream(
      {
        onEvent: options.onEvent,
        onDisconnect: (reason) => options.onStreamDisconnect?.(reason),
        onReconnect: () => options.onStreamReconnect?.(),
        onTransportSwitch: () => options.onTransportSwitch?.(),
      },
      {
        ...(typeof streamFromSequence === 'number' && streamFromSequence >= 0 ? { fromSequence: streamFromSequence } : {}),
        ...(options.selectedSessionId ? { sessionId: options.selectedSessionId } : {}),
        ...(options.runtimeKey ? { runtimeKey: options.runtimeKey } : {}),
        signal: options.signal,
      },
    );
    result.stream = handle;
  } catch (error) {
    result.errors.push({ phase: 'stream-attach', error: toError(error) });
  }

  // Bootstrap is considered ready if the runtime was reachable and the
  // session-list/session-hydrate failures were logged but did not block
  // stream attach. The runtime-probe failure is the only one that flips
  // the overall phase to `failed`.
  const runtimeProbeFailed = result.errors.some((entry) => entry.phase === 'runtime-probe');
  result.phase = runtimeProbeFailed ? 'failed' : 'ready';
  return result;
};

/**
 * The currently-known bootstrap phase names. Useful for diagnostics.
 */
export const PI_BOOTSTRAP_PHASES: readonly PiBootstrapPhase[] = [
  'idle',
  'runtime-probe',
  'session-list',
  'session-hydrate',
  'stream-attach',
  'ready',
  'failed',
] as const;
