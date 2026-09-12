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
 * Callers may inject a bounded retry policy without hiding failures.
 */

import {
  createPiEventStream,
  fetchPiRuntimeHealth,
  type PiStreamHandle,
} from './transport';
import {
  piClient,
  type PiClientScope,
  PiRequestError,
} from './client';
import { PI_STREAM_EPOCH_CAPABILITY } from './protocol';
import {
  hydrateSessionFromDetail,
  type PiReducerState,
} from './event-reducer';
import type { PiSessionId, PiSessionLifecycleState } from './types';
import type { PiSessionEvent, PiSessionListItem } from './protocol';

export type PiBootstrapPhase =
  | 'idle'
  | 'runtime-probe'
  | 'session-list'
  | 'session-hydrate'
  | 'stream-attach'
  | 'ready'
  | 'failed';

interface PiBootstrapSessionTiming {
  sessionId: PiSessionId;
  isStreaming: boolean;
  lifecycle: PiSessionLifecycleState;
  runStartedAt?: number;
  serverNow?: number;
}

export interface PiBootstrapResult {
  phase: PiBootstrapPhase;
  /** Reducer state at the end of bootstrap (empty map if anything failed). */
  reducerState: PiReducerState;
  /** Last sequence per session id from the hydrating call. */
  lastSequence: Map<PiSessionId, number>;
  /**
   * Timing authority from the selected session detail. The reducer projection
   * intentionally does not carry transport metadata, so keep this alongside
   * it for the first-attach path.
   */
  selectedSessionTiming?: PiBootstrapSessionTiming;
  /** Stream handle, when bootstrap reached `stream-attach`. */
  stream: PiStreamHandle | null;
  /** Opaque stream-lifetime id of the verified daemon, when it advertises
   *  `events.streamEpoch`. The owning store adopts this as its epoch. */
  streamEpoch?: string;
  /** Errors captured during bootstrap; recoverable list/hydrate failures may coexist with `ready`. */
  errors: Array<{ phase: PiBootstrapPhase; error: PiBootstrapError }>;
  /** Daemon health response; `null` if the probe never completed. */
  health: PiBootstrapHealth;
}

export type PiBootstrapHealth =
  | { state: 'pending' }
  | { state: 'ready'; protocolVersion: number; capabilities: string[]; streamEpoch?: string }
  | { state: 'unavailable'; protocolVersion: number; error: { code: string; message?: string } };

export interface PiBootstrapError {
  code: string;
  message?: string;
  status?: number;
}

interface PiBootstrapDependencies {
  fetchHealth: typeof fetchPiRuntimeHealth;
  createStream: typeof createPiEventStream;
}

const defaultDependencies: PiBootstrapDependencies = {
  fetchHealth: fetchPiRuntimeHealth,
  createStream: createPiEventStream,
};

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
  /** A known authorization failure stopped the underlying stream. */
  onAuthRequired?: () => void;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Runtime identity captured by the caller. */
  runtimeKey?: string;
  /** Reuse a health result already obtained by the first-attach caller. */
  initialHealth?: Extract<PiBootstrapHealth, { state: 'ready' }>;
  /** Reuse a session list already obtained by the first-attach caller. */
  initialSessions?: readonly PiSessionListItem[];
  /** Optional bounded retry helper; defaults to no retry. */
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
export const bootstrapPiDirectory = async (
  options: PiBootstrapOptions,
  dependencies: PiBootstrapDependencies = defaultDependencies,
): Promise<PiBootstrapResult> => {
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
  const health = options.initialHealth ?? await task(() => dependencies.fetchHealth(options.signal, options.runtimeKey));
  if (health.state === 'ready') {
    // Fail-visible compatibility gate: a runtime without the restart-safe
    // stream epoch cannot keep cursors meaningful across a daemon restart.
    // Refuse to attach with an explicit protocol mismatch instead of silently
    // running with a cursor that a restart would invalidate.
    const epochSupported = health.capabilities.includes(PI_STREAM_EPOCH_CAPABILITY)
      && typeof health.streamEpoch === 'string'
      && health.streamEpoch.length > 0;
    if (!epochSupported) {
      const error = {
        code: 'DAEMON_PROTOCOL_MISMATCH' as const,
        message: 'The Pi runtime does not advertise a restart-safe event stream (events.streamEpoch). Update the server.',
      };
      result.health = {
        state: 'unavailable',
        protocolVersion: health.protocolVersion,
        error,
      };
      result.phase = 'failed';
      result.errors.push({ phase: 'runtime-probe', error });
      return result;
    }
    result.health = {
      state: 'ready',
      protocolVersion: health.protocolVersion,
      capabilities: [...health.capabilities],
      streamEpoch: health.streamEpoch,
    };
    result.streamEpoch = health.streamEpoch;
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
  const seedSessionList = (sessions: readonly PiSessionListItem[]): void => {
    for (const item of sessions) {
      // Seed the reducer with bare session records so the UI can render
      // titles while waiting for hydration.
      result.lastSequence.set(item.session.id, -1);
    }
  };
  if (options.initialSessions) {
    seedSessionList(options.initialSessions);
  } else {
    try {
      const list = await task(() => piClient.listSessions({
        ...options.scope,
        directory: options.directory,
        ...(options.runtimeKey ? { runtimeKey: options.runtimeKey } : {}),
      }));
      seedSessionList(list.sessions);
    } catch (error) {
      result.errors.push({ phase: 'session-list', error: toError(error) });
    }
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
      result.selectedSessionTiming = {
        sessionId: detail.session.id,
        isStreaming: detail.isStreaming,
        lifecycle: detail.lifecycle,
        ...(Number.isFinite(detail.runStartedAt) ? { runStartedAt: detail.runStartedAt } : {}),
        ...(Number.isFinite(detail.serverNow) ? { serverNow: detail.serverNow } : {}),
      };
      const { state } = hydrateSessionFromDetail(detail);
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
    const streamFromSequence = options.selectedSessionId
      ? result.lastSequence.get(options.selectedSessionId)
      : options.fromSequence;
    const handle = dependencies.createStream(
      {
        onEvent: options.onEvent,
        onDisconnect: (reason) => options.onStreamDisconnect?.(reason),
        onReconnect: () => options.onStreamReconnect?.(),
        onTransportSwitch: () => options.onTransportSwitch?.(),
        onAuthRequired: () => options.onAuthRequired?.(),
      },
      {
        ...(typeof streamFromSequence === 'number' && streamFromSequence >= 0 ? { fromSequence: streamFromSequence } : {}),
        ...(result.streamEpoch ? { streamEpoch: result.streamEpoch } : {}),
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
