/**
 * Browser transport for the public Pi event stream.
 *
 * The browser only talks to the PiChamber server. HTTP uses `runtimeFetch`,
 * while realtime URLs are resolved through the shared runtime URL helpers and
 * WebSockets are opened through `openRuntimeWebSocket` so relay mode remains
 * transparent to this module.
 */

import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { isCapacitorApp } from '@/lib/platform';
import { recordMobileDiagnostic } from '@/lib/mobile-error-log';
import { isPiEvent, PI_PUBLIC_PROTOCOL_VERSION, PI_STREAM_EPOCH_CAPABILITY, type PiSessionEvent } from './protocol';

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
const RECONNECT_BACKOFF_BASE_MS = 250;
const RECONNECT_BACKOFF_CAP_VISIBLE_MS = 5_000;
const RECONNECT_BACKOFF_CAP_HIDDEN_OR_OFFLINE_MS = 60_000;
const RECONNECT_BACKOFF_MAX_EXPONENT = 8;
const WS_READY_TIMEOUT_MS = 2_000;
/** SSE connections that never produce a response (or a ready signal) within
 *  this window are torn down; a late response is rejected by the generation
 *  guard instead of adopting a stale attempt. */
const DEFAULT_SETUP_TIMEOUT_MS = 10_000;
/** Bounded window for minting the short-lived URL auth token before a
 *  native EventSource or WebSocket connect. */
const DEFAULT_AUTH_TOKEN_TIMEOUT_MS = 5_000;
/** The consecutive-failure count only resets after a connection stayed
 *  healthy this long, so a flapping link cannot keep resetting its own
 *  backoff to the base delay. */
const DEFAULT_HEALTH_RESET_MS = 30_000;
/** Bounded authoritative health probe used to verify a foreign stream epoch
 *  observed on the wire (and to classify native EventSource errors). */
const DEFAULT_EPOCH_PROBE_TIMEOUT_MS = 5_000;

const debug = (..._args: unknown[]): void => {
  // Keep diagnostics payload-free by default. A caller can observe lifecycle
  // callbacks without making the hot path retain prompt or transcript data.
  void _args;
};

const resolveStreamQuery = (query: {
  fromSequence?: number;
  sessionId?: string;
  streamEpoch?: string;
}): Record<string, string> => {
  const params: Record<string, string> = {};
  if (typeof query.fromSequence === 'number' && Number.isFinite(query.fromSequence)) {
    params.fromSequence = String(Math.max(0, Math.floor(query.fromSequence)));
  }
  if (typeof query.sessionId === 'string' && query.sessionId.length > 0) {
    params.sessionId = query.sessionId;
  }
  if (typeof query.streamEpoch === 'string' && query.streamEpoch.length > 0) {
    // The epoch the replay cursor belongs to. The daemon compares it with its
    // own stream lifetime: a cursor from a retired epoch can never be
    // replayed, even when the new daemon's sequence numerically overtook it.
    params.streamEpoch = query.streamEpoch;
  }
  // Capability negotiation. This client understands the restart-safe stream
  // epoch; a server treats a subscriber without this marker as a legacy
  // client and falls back to a snapshot baseline instead of replaying a
  // cursor it cannot epoch-verify. The marker alone is non-secret and stable.
  params.capabilities = PI_STREAM_EPOCH_CAPABILITY;
  return params;
};

const resolveStreamUrl = (
  transport: 'ws' | 'sse',
  query: { fromSequence?: number; sessionId?: string; streamEpoch?: string },
  urlAuthToken?: string,
): string => {
  const resolver = getRuntimeUrlResolver();
  const params = resolveStreamQuery(query);
  return transport === 'ws'
    ? resolver.websocket('/api/pi/events', params, urlAuthToken)
    : resolver.sse('/api/pi/events', params);
};

const resolveHealthPath = (): string => '/api/pi/runtime';

/**
 * CapacitorHttp patches `fetch` on native mobile. That is correct for ordinary
 * API calls, especially plain-http LAN servers, but its response is buffered
 * rather than exposed as a long-lived ReadableStream. Using it for SSE makes a
 * live event stream appear to work briefly and then stall. Native direct
 * connections use EventSource instead; relay connections must stay on
 * runtimeFetch because the relay is not addressable by the browser.
 */
const shouldUseCapacitorEventSource = (): boolean => (
  isCapacitorApp()
  && !isRelayModeActive()
  && typeof EventSource !== 'undefined'
);

export interface PiStreamHandlers {
  onEvent: (event: PiSessionEvent) => void;
  onReconnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onTransportSwitch?: () => void;
  /** The stream observed a stream-epoch transition that an authoritative
   *  health probe verified against the live daemon. The transport has
   *  already reset its own replay cursor and retired the previous epoch
   *  when this fires; unverified foreign epochs never reach it. */
  onEpochChange?: (epoch: string) => void;
  /** A known authorization failure (401/403 on the stream, or confirmed by
   *  a bounded authoritative probe for native EventSource). The transport
   *  stops retrying; the existing auth flow owns recovery. Local work is
   *  never cleared by this callback. */
  onAuthRequired?: () => void;
}

export interface PiStreamOptions {
  fromSequence?: number;
  sessionId?: string;
  transport?: 'auto' | 'ws' | 'sse';
  heartbeatTimeoutMs?: number;
  reconnectDelayMs?: number;
  /** Stream-lifetime id the replay cursor was established under. Sent as the
   *  `streamEpoch` subscribe parameter so the daemon can refuse to replay a
   *  cursor from a retired epoch. When the transport itself verifies an epoch
   *  transition, its own adopted epoch takes precedence. */
  streamEpoch?: string;
  /** Deadline for a connect attempt to produce a ready stream. */
  setupTimeoutMs?: number;
  /** Deadline for minting the short-lived URL auth token. */
  authTokenTimeoutMs?: number;
  /** Healthy duration required before the consecutive-failure count resets. */
  healthResetMs?: number;
  /** Deadline for the authoritative probe that verifies a foreign epoch. */
  epochProbeTimeoutMs?: number;
  signal?: AbortSignal;
  /** Runtime identity captured by the owner; old-runtime events are rejected. */
  runtimeKey?: string;
}

export interface PiStreamHandle {
  dispose: () => void;
  reconnect: (reason?: string) => void;
  readonly eventsUrl: string;
}

export const fetchPiRuntimeHealth = async (
  signal?: AbortSignal,
  runtimeKey?: string,
): Promise<{
  state: 'ready' | 'unavailable';
  protocolVersion: number;
  capabilities: string[];
  /** Opaque stream-lifetime id of the live daemon process, when the runtime
   *  advertises `events.streamEpoch`. */
  streamEpoch?: string;
  error?: { code: string; message?: string };
}> => {
  let response: Response;
  try {
    response = await runtimeFetch(resolveHealthPath(), signal ? { signal } : {});
  } catch (error) {
    recordMobileDiagnostic('runtime-health', { code: error instanceof DOMException && error.name === 'AbortError' ? 'timeout' : 'unreachable' });
    return {
      state: 'unavailable',
      protocolVersion: PI_PUBLIC_PROTOCOL_VERSION,
      capabilities: [],
      error: { code: error instanceof DOMException && error.name === 'AbortError' ? 'DAEMON_TIMEOUT' : 'DAEMON_UNAVAILABLE' },
    };
  }

  if (runtimeKey && runtimeKey !== getRuntimeKey()) {
    return {
      state: 'unavailable',
      protocolVersion: PI_PUBLIC_PROTOCOL_VERSION,
      capabilities: [],
      error: { code: 'DAEMON_UNAVAILABLE', message: 'Runtime changed during request' },
    };
  }

  if (!response.ok) {
    recordMobileDiagnostic('runtime-health', { status: response.status, code: response.status === 401 || response.status === 403 ? 'auth' : 'http-error' });
    return {
      state: 'unavailable',
      protocolVersion: PI_PUBLIC_PROTOCOL_VERSION,
      capabilities: [],
      error: {
        code: response.status === 401 || response.status === 403 ? 'DAEMON_AUTH_FAILED' : 'DAEMON_UNAVAILABLE',
      },
    };
  }

  const payload = (await response.json().catch(() => null)) as
    | { state?: unknown; protocolVersion?: unknown; capabilities?: unknown; streamEpoch?: unknown; error?: { code?: unknown; message?: unknown } }
    | null;
  if (!payload || typeof payload !== 'object') {
    return {
      state: 'unavailable',
      protocolVersion: PI_PUBLIC_PROTOCOL_VERSION,
      capabilities: [],
      error: { code: 'DAEMON_PROTOCOL_MISMATCH' },
    };
  }

  const errorCode = typeof payload.error?.code === 'string' ? payload.error.code : undefined;
  const streamEpoch = typeof payload.streamEpoch === 'string' && payload.streamEpoch.length > 0
    ? payload.streamEpoch
    : undefined;
  return {
    state: payload.state === 'ready' ? 'ready' : 'unavailable',
    protocolVersion: typeof payload.protocolVersion === 'number' ? payload.protocolVersion : PI_PUBLIC_PROTOCOL_VERSION,
    capabilities: Array.isArray(payload.capabilities)
      ? payload.capabilities.filter((value): value is string => typeof value === 'string')
      : [],
    ...(streamEpoch ? { streamEpoch } : {}),
    ...(errorCode
      ? { error: { code: errorCode, ...(typeof payload.error?.message === 'string' ? { message: payload.error.message } : {}) } }
      : {}),
  };
};

type ConnectionCleanup = () => void;

/**
 * Bounded authoritative probe used to classify failures the wire cannot
 * describe natively (EventSource errors carry no status). Returns whether
 * the runtime currently rejects the client's authorization. A probe that
 * cannot complete is transient — the transport never invents a 401.
 */
const probeRuntimeAuthFailure = async (
  runtimeKey: string | undefined,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<'auth' | 'transient'> => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', abort, { once: true });
  try {
    const health = await fetchPiRuntimeHealth(controller.signal, runtimeKey);
    return health.state === 'unavailable' && health.error?.code === 'DAEMON_AUTH_FAILED' ? 'auth' : 'transient';
  } catch {
    return 'transient';
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
};

const createSseConnection = (
  query: Record<string, string>,
  signal: AbortSignal,
  onReady: () => void,
  onActivity: () => void,
  onEvent: (event: PiSessionEvent) => void,
  onDisconnect: (reason: string) => void,
  options: {
    setupTimeoutMs: number;
    /** Native EventSource errors carry no status; the owner supplies a
     *  bounded authoritative probe to classify them. */
    classifySourceError?: (signal: AbortSignal) => Promise<'auth' | 'transient'>;
  },
): ConnectionCleanup => {
  if (shouldUseCapacitorEventSource()) {
    const source = new EventSource(getRuntimeUrlResolver().sse('/api/pi/events', query));
    const classificationController = new AbortController();
    let closed = false;
    let readySeen = false;
    let setupTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      setupTimer = null;
      if (readySeen || closed) return;
      recordMobileDiagnostic('stream-connect', { code: 'setup-timeout' });
      abort();
      onDisconnect('sse-setup-timeout');
    }, options.setupTimeoutMs);
    const clearSetupTimer = () => {
      if (setupTimer) clearTimeout(setupTimer);
      setupTimer = null;
    };
    const heartbeat = () => {
      if (!closed) onActivity();
    };
    const abort = () => {
      clearSetupTimer();
      classificationController.abort();
      if (closed) return;
      closed = true;
      source.removeEventListener('heartbeat', heartbeat);
      source.close();
      signal.removeEventListener('abort', abort);
    };
    const dispatchData = (data: string) => {
      try {
        const parsed: unknown = JSON.parse(data);
        if (isPiEvent(parsed)) onEvent(parsed);
      } catch {
        debug('pi-transport:bad-capacitor-sse-frame');
        recordMobileDiagnostic('stream-frame', { code: 'bad-sse-frame' });
      }
    };

    source.onopen = () => {
      if (closed) return;
      readySeen = true;
      clearSetupTimer();
      onReady();
    };
    source.onmessage = (event) => {
      if (closed) return;
      onActivity();
      if (typeof event.data === 'string' && event.data.trim()) {
        dispatchData(event.data);
      }
    };
    source.onerror = () => {
      if (closed) return;
      clearSetupTimer();
      source.removeEventListener('heartbeat', heartbeat);
      source.close();
      signal.removeEventListener('abort', abort);
      closed = true;
      recordMobileDiagnostic('stream-disconnect', { code: 'sse-error' });
      const classify = options.classifySourceError;
      if (!classify) {
        onDisconnect('sse-error');
        return;
      }
      // Bounded authoritative probe: never invent a 401 from a status-less
      // EventSource error, and never treat a transient server failure as
      // an authorization problem.
      void classify(classificationController.signal).then((outcome) => {
        if (!classificationController.signal.aborted) {
          onDisconnect(outcome === 'auth' ? 'sse-auth-probe' : 'sse-error');
        }
      });
    };
    source.addEventListener('heartbeat', heartbeat);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    return abort;
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', abort, { once: true });

  let readySeen = false;
  // Setup deadline: a connect attempt that never produces a usable response
  // must not stall the stream silently. Firing the deadline disconnects and
  // aborts the attempt; a response that arrives afterwards is rejected by
  // the generation guard.
  let setupTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    setupTimer = null;
    if (readySeen || controller.signal.aborted) return;
    recordMobileDiagnostic('stream-connect', { code: 'setup-timeout' });
    onDisconnect('sse-setup-timeout');
    abort();
  }, options.setupTimeoutMs);
  const clearSetupTimer = () => {
    if (setupTimer) clearTimeout(setupTimer);
    setupTimer = null;
  };

  void runtimeFetch('/api/pi/events', {
    headers: { Accept: 'text/event-stream' },
    query,
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok || !response.body) {
        recordMobileDiagnostic('stream-connect', {
          status: response.status,
          code: response.body ? 'http-error' : 'missing-stream-body',
        });
        // Known authorization failures stop the retry loop (handled by the
        // reconnect owner) and surface the existing auth flow instead.
        if (response.status === 401 || response.status === 403) {
          clearSetupTimer();
          onDisconnect(`sse-auth-${response.status}`);
          return;
        }
        onDisconnect(`sse-status-${response.status}`);
        return;
      }

      readySeen = true;
      clearSetupTimer();
      onReady();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let dataLines: string[] = [];

      const dispatchData = () => {
        if (dataLines.length === 0) return;
        const data = dataLines.join('\n').trim();
        dataLines = [];
        if (!data) return;
        try {
          const parsed: unknown = JSON.parse(data);
          if (isPiEvent(parsed)) onEvent(parsed);
        } catch {
          debug('pi-transport:bad-sse-frame');
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          dispatchData();
          clearSetupTimer();
          onDisconnect('sse-eof');
          return;
        }
        onActivity();
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (line.length === 0) dispatchData();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
          newline = buffer.indexOf('\n');
        }
      }
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message.slice(0, 80) : 'fetch-failed';
      recordMobileDiagnostic('stream-connect', { code: 'fetch-failed', detail: message });
      onDisconnect(`sse-error:${message}`);
    })
    .finally(() => {
      clearSetupTimer();
      signal.removeEventListener('abort', abort);
    });

  return abort;
};

const createWsConnection = (
  url: string,
  signal: AbortSignal,
  onReady: () => void,
  onEvent: (event: PiSessionEvent) => void,
  onDisconnect: (reason: string) => void,
  readyTimeoutMs: number,
): ConnectionCleanup => {
  const socket = openRuntimeWebSocket(url);
  let closed = false;
  let ready = false;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  const close = () => {
    if (closed) return;
    closed = true;
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = null;
    try {
      socket.close();
    } catch {
      // The socket may already be closed by the runtime.
    }
  };
  readyTimer = setTimeout(() => {
    if (ready || closed) return;
    onDisconnect('ws-ready-timeout');
    close();
  }, readyTimeoutMs);
  const abort = () => close();
  if (signal.aborted) close();
  else signal.addEventListener('abort', abort, { once: true });

  socket.onopen = () => {
    ready = true;
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = null;
    onReady();
  };
  socket.onmessage = (raw) => {
    const data = typeof raw.data === 'string' ? raw.data : undefined;
    if (!data) return;
    try {
      const parsed: unknown = JSON.parse(data);
      if (isPiEvent(parsed)) onEvent(parsed);
    } catch {
      debug('pi-transport:bad-ws-frame');
    }
  };
  socket.onerror = () => {
    if (!closed) onDisconnect('ws-error');
  };
  socket.onclose = (event) => {
    signal.removeEventListener('abort', abort);
    if (!closed) onDisconnect(`ws-close-${event?.code ?? 0}`);
  };
  return close;
};

const isVisible = (): boolean => typeof document === 'undefined' || document.visibilityState === 'visible';
const isOnline = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false;

export const createPiEventStream = (
  handlers: PiStreamHandlers,
  options: PiStreamOptions = {},
): PiStreamHandle => {
  const internalController = new AbortController();
  const externalSignal = options.signal;
  const forwardExternalAbort = () => internalController.abort();
  if (externalSignal) {
    if (externalSignal.aborted) internalController.abort();
    else externalSignal.addEventListener('abort', forwardExternalAbort, { once: true });
  }
  const signal = internalController.signal;
  const expectedRuntimeKey = options.runtimeKey;
  const isCurrentRuntime = () => !expectedRuntimeKey || expectedRuntimeKey === getRuntimeKey();

  let disposed = false;
  let attempt = 0;
  const ownerEpoch = typeof options.streamEpoch === 'string' && options.streamEpoch.length > 0
    ? options.streamEpoch
    : null;
  // A cursor is meaningful only inside an established stream epoch. The
  // pre-bootstrap recovery stream has neither, so its first request must omit
  // `fromSequence` and let the daemon provide a snapshot baseline.
  let lastSequence = typeof options.fromSequence === 'number' && Number.isFinite(options.fromSequence)
    ? Math.max(0, Math.floor(options.fromSequence))
    : ownerEpoch ? 0 : undefined;
  // The Pi event endpoint is SSE-only. WebSocket remains available only when
  // explicitly requested by a runtime that provides a matching upgrade path.
  let mode: 'ws' | 'sse' = options.transport === 'ws' ? 'ws' : 'sse';
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let healthResetTimer: ReturnType<typeof setTimeout> | null = null;
  let activeAbort: ConnectionCleanup | null = null;
  let generation = 0;
  let healthyConnection = false;
  let resumeRecoveryInFlight = false;
  const setupTimeoutMs = options.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
  const authTokenTimeoutMs = options.authTokenTimeoutMs ?? DEFAULT_AUTH_TOKEN_TIMEOUT_MS;
  const healthResetMs = options.healthResetMs ?? DEFAULT_HEALTH_RESET_MS;
  const epochProbeTimeoutMs = options.epochProbeTimeoutMs ?? DEFAULT_EPOCH_PROBE_TIMEOUT_MS;
  /** Stream lifetime observed on the wire. Resets with the replay cursor
   *  whenever a health-verified epoch transition appears so `fromSequence`
   *  never mixes two sequence spaces. */
  let currentEpoch: string | null = null;
  /** Epochs that a verified transition (or an authoritative rejection)
   *  retired. Frames stamped with a retired epoch are dropped without
   *  further probing — a retired lifetime can never downgrade the cursor. */
  const retiredEpochs = new Set<string>();
  let epochProbeInFlight = false;
  let epochProbeController: AbortController | null = null;
  const clearTimers = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    if (healthResetTimer) clearTimeout(healthResetTimer);
    reconnectTimer = null;
    heartbeatTimer = null;
    healthResetTimer = null;
  };

  const invalidateConnection = () => {
    generation += 1;
    activeAbort?.();
    activeAbort = null;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
    if (healthResetTimer) clearTimeout(healthResetTimer);
    healthResetTimer = null;
  };

  const resetHeartbeat = (connectionId: number) => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      if (connectionId === generation) handleDisconnect('heartbeat-timeout', connectionId);
    }, options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS);
  };

  const markReady = (connectionId: number) => {
    if (disposed || signal.aborted || connectionId !== generation) return;
    resetHeartbeat(connectionId);
  };

  const markActivity = (connectionId: number) => {
    if (disposed || signal.aborted || connectionId !== generation) return;
    const becameHealthy = !healthyConnection;
    healthyConnection = true;
    resumeRecoveryInFlight = false;
    if (becameHealthy) {
      // Sustained health before resetting the failure count: the connection
      // must stay alive (and liveness-verified) for the whole window, so a
      // link that flaps every few seconds keeps its exponential backoff
      // instead of restarting at the base delay on every blip.
      if (healthResetTimer) clearTimeout(healthResetTimer);
      healthResetTimer = setTimeout(() => {
        healthResetTimer = null;
        if (connectionId === generation && healthyConnection) attempt = 0;
      }, healthResetMs);
      recordMobileDiagnostic('stream-ready', { code: mode });
      handlers.onReconnect?.();
    }
    resetHeartbeat(connectionId);
  };

  const computeBackoff = () => {
    const cap = isVisible() && isOnline()
      ? RECONNECT_BACKOFF_CAP_VISIBLE_MS
      : RECONNECT_BACKOFF_CAP_HIDDEN_OR_OFFLINE_MS;
    const exponent = Math.min(RECONNECT_BACKOFF_MAX_EXPONENT, attempt);
    const base = Math.min(cap, RECONNECT_BACKOFF_BASE_MS * 2 ** exponent);
    return (attempt === 0 && options.reconnectDelayMs !== undefined)
      ? Math.max(0, options.reconnectDelayMs)
      : base + Math.floor(Math.random() * 100);
  };

  const scheduleReconnect = (reason: string, notifyDisconnect = true) => {
    if (disposed || signal.aborted || reconnectTimer) return;
    recordMobileDiagnostic('stream-reconnect', { code: reason });
    if (notifyDisconnect) handlers.onDisconnect?.(reason);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      attempt += 1;
      void connect();
    }, computeBackoff());
  };

  /** Wake a pending backoff immediately (online / visible / manual / resume).
   *  Deduplicated: only one wake can act because the pending timer is the
   *  single gate, and the woken attempt still counts as a failure attempt. */
  const wakePendingReconnect = () => {
    if (disposed || signal.aborted || !reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    attempt += 1;
    void connect();
  };

  const handleDisconnect = (reason: string, connectionId: number) => {
    if (disposed || signal.aborted || connectionId !== generation) return;
    invalidateConnection();
    if (!healthyConnection && mode === 'ws' && options.transport !== 'ws') {
      mode = 'sse';
      handlers.onTransportSwitch?.();
    }
    healthyConnection = false;
    if (reason === 'runtime-change') {
      handlers.onDisconnect?.(reason);
      return;
    }
    if (reason === 'sse-auth-401' || reason === 'sse-auth-403' || reason === 'sse-auth-probe') {
      // Known authorization failure. Stop the retry loop: the existing auth
      // flow owns recovery (the owner surfaces it through onAuthRequired and
      // onDisconnect), and a fresh attempt starts only via reconnect().
      recordMobileDiagnostic('stream-auth', { code: reason });
      handlers.onDisconnect?.(reason);
      handlers.onAuthRequired?.();
      return;
    }
    scheduleReconnect(reason);
  };

  const handleEvent = (event: PiSessionEvent, connectionId: number) => {
    if (disposed || signal.aborted || connectionId !== generation) return;
    if (!isCurrentRuntime()) {
      handleDisconnect('runtime-change', connectionId);
      return;
    }
    const eventEpoch = typeof event.streamEpoch === 'string' && event.streamEpoch.length > 0 ? event.streamEpoch : null;
    if (eventEpoch && eventEpoch !== currentEpoch) {
      if (retiredEpochs.has(eventEpoch)) {
        // A retired daemon lifetime re-appeared on the wire: stale or
        // replayed frame. Never deliver it and never downgrade the cursor.
        recordMobileDiagnostic('stream-epoch', { code: 'retired-frame' });
        return;
      }
      const reference = currentEpoch ?? ownerEpoch;
      if (reference !== null && reference !== eventEpoch) {
        // A foreign epoch on an established stream. The wire frame alone is
        // not authoritative: verify it against the runtime health endpoint
        // before resetting the replay cursor or notifying the owner.
        if (epochProbeInFlight) return; // drop frames while the probe runs
        void verifyForeignEpoch(event, eventEpoch, reference, connectionId);
        return;
      }
      // First contact with no established baseline, or the owner-established
      // epoch appearing on the wire (the owner health-verified it at attach).
      // Never rewind: the daemon only replays strictly after the subscribe
      // cursor, so the frame is at or ahead of it.
      currentEpoch = eventEpoch;
      lastSequence = Math.max(lastSequence ?? 0, event.sequence);
      if (reference === null) handlers.onEpochChange?.(eventEpoch);
    }
    if (lastSequence === undefined || event.sequence > lastSequence) lastSequence = event.sequence;
    markActivity(connectionId);
    handlers.onEvent(event);
  };

  /** Authoritatively verify a foreign stream epoch before establishing it as
   *  the new baseline. Only a live daemon health probe can confirm the
   *  transition; anything else is dropped (and retired when contradicted),
   *  and an unverifiable frame re-establishes the stream instead. */
  const verifyForeignEpoch = async (
    event: PiSessionEvent,
    eventEpoch: string,
    reference: string,
    connectionId: number,
  ): Promise<void> => {
    epochProbeInFlight = true;
    epochProbeController = new AbortController();
    const timer = setTimeout(() => epochProbeController?.abort(), epochProbeTimeoutMs);
    try {
      const health = await fetchPiRuntimeHealth(epochProbeController.signal, expectedRuntimeKey);
      if (disposed || signal.aborted || connectionId !== generation) return;
      if (health.state === 'ready' && health.streamEpoch === eventEpoch) {
        // Health verified the transition: retire the previous epoch, reset
        // the replay cursor to the new sequence space, and notify the owner.
        retiredEpochs.add(reference);
        currentEpoch = eventEpoch;
        lastSequence = event.sequence;
        recordMobileDiagnostic('stream-epoch', { code: 'verified' });
        handlers.onEpochChange?.(eventEpoch);
        markActivity(connectionId);
        handlers.onEvent(event);
        return;
      }
      if (health.state === 'unavailable' && health.error?.code === 'DAEMON_AUTH_FAILED') {
        handleDisconnect('sse-auth-probe', connectionId);
        return;
      }
      if (health.state === 'ready') {
        // The live daemon contradicts the frame: it was emitted by a retired
        // lifetime. Reject it without touching the cursor.
        retiredEpochs.add(eventEpoch);
        recordMobileDiagnostic('stream-epoch', { code: 'rejected' });
        return;
      }
      // The probe could not confirm anything (unavailable/timeout). Do not
      // adopt, do not reject wholesale: re-establish the stream under a
      // fresh health gate through the normal reconnect loop.
      recordMobileDiagnostic('stream-epoch', { code: 'unverified' });
      handleDisconnect('epoch-unverified', connectionId);
    } finally {
      clearTimeout(timer);
      epochProbeInFlight = false;
      epochProbeController = null;
    }
  };

  /** Mint the short-lived URL auth token under a bounded deadline so a hung
   *  auth request cannot stall a connect attempt indefinitely. */
  const fetchUrlAuthTokenBounded = async (): Promise<string> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        refreshRuntimeUrlAuthToken(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('url-token-timeout')), authTokenTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const connect = async (): Promise<void> => {
    if (disposed || signal.aborted) return;
    if (!isCurrentRuntime()) {
      handlers.onDisconnect?.('runtime-change');
      return;
    }
    const connectionId = generation + 1;
    generation = connectionId;

    let urlAuthToken: string | undefined;
    if (mode === 'ws') {
      try {
        urlAuthToken = await fetchUrlAuthTokenBounded();
      } catch {
        if (connectionId !== generation || disposed || signal.aborted) return;
        if (options.transport !== 'ws') {
          mode = 'sse';
          handlers.onTransportSwitch?.();
          invalidateConnection();
          void connect();
          return;
        }
        recordMobileDiagnostic('stream-auth', { code: 'url-token-unavailable' });
        handleDisconnect('ws-auth-token-unavailable', connectionId);
        return;
      }
    }

    if (connectionId !== generation || disposed || signal.aborted) return;
    if (!isCurrentRuntime()) {
      handleDisconnect('runtime-change', connectionId);
      return;
    }
    if (mode === 'sse' && shouldUseCapacitorEventSource()) {
      try {
        // EventSource cannot carry the bearer header used by runtimeFetch.
        // Mint the short-lived URL token before constructing the native
        // browser stream, under the same bounded deadline.
        await fetchUrlAuthTokenBounded();
      } catch {
        if (connectionId !== generation || disposed || signal.aborted) return;
        recordMobileDiagnostic('stream-auth', { code: 'url-token-unavailable' });
        handleDisconnect('sse-auth-token-unavailable', connectionId);
        return;
      }
      if (connectionId !== generation || disposed || signal.aborted || !isCurrentRuntime()) return;
    }
    const subscribeEpoch = currentEpoch ?? ownerEpoch ?? undefined;
    const url = resolveStreamUrl(mode, {
      ...(lastSequence !== undefined ? { fromSequence: lastSequence } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(subscribeEpoch ? { streamEpoch: subscribeEpoch } : {}),
    }, urlAuthToken);
    const onReady = () => markReady(connectionId);
    const onEvent = (event: PiSessionEvent) => handleEvent(event, connectionId);
    const onDisconnect = (reason: string) => handleDisconnect(reason, connectionId);
    const subscribeQuery = resolveStreamQuery({
      ...(lastSequence !== undefined ? { fromSequence: lastSequence } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(subscribeEpoch ? { streamEpoch: subscribeEpoch } : {}),
    });
    activeAbort = mode === 'ws'
      ? createWsConnection(url, signal, onReady, onEvent, onDisconnect, WS_READY_TIMEOUT_MS)
      : createSseConnection(subscribeQuery, signal, onReady, () => markActivity(connectionId), onEvent, onDisconnect, {
          setupTimeoutMs,
          ...(shouldUseCapacitorEventSource()
            ? {
                classifySourceError: (probeSignal) => probeRuntimeAuthFailure(expectedRuntimeKey, epochProbeTimeoutMs, probeSignal),
              }
            : {}),
        });
  };

  const handleWakeSignal = () => {
    if (!isVisible() || !isOnline()) return;
    wakePendingReconnect();
  };

  const handleSystemResume = () => {
    if (!shouldUseCapacitorEventSource() || disposed || signal.aborted) return;
    if (resumeRecoveryInFlight) {
      wakePendingReconnect();
      return;
    }
    resumeRecoveryInFlight = true;
    clearTimers();
    invalidateConnection();
    healthyConnection = false;
    // WKWebView can preserve a dead EventSource across suspension without
    // firing `error`. Replace it locally instead of reporting a daemon
    // disconnect: the app may still be waiting for its network resume probe,
    // and the resumed stream already replays from `lastSequence` (or receives
    // a snapshot when the replay window has expired).
    scheduleReconnect('system-resume', false);
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('pichamber:system-resume', handleSystemResume);
    window.addEventListener('online', handleWakeSignal);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleWakeSignal);
  }

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    if (typeof window !== 'undefined') {
      window.removeEventListener('pichamber:system-resume', handleSystemResume);
      window.removeEventListener('online', handleWakeSignal);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleWakeSignal);
    }
    externalSignal?.removeEventListener('abort', forwardExternalAbort);
    signal.removeEventListener('abort', cleanup);
    clearTimers();
    invalidateConnection();
    epochProbeController?.abort();
    epochProbeController = null;
    if (!signal.aborted) internalController.abort();
  };
  if (signal.aborted) cleanup();
  else signal.addEventListener('abort', cleanup, { once: true });

  void connect();

  return {
    dispose: cleanup,
    reconnect: (reason = 'manual') => {
      if (disposed || signal.aborted) return;
      clearTimers();
      invalidateConnection();
      scheduleReconnect(reason);
    },
    get eventsUrl() {
      const subscribeEpoch = currentEpoch ?? ownerEpoch ?? undefined;
      return resolveStreamUrl(mode, {
        ...(lastSequence !== undefined ? { fromSequence: lastSequence } : {}),
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(subscribeEpoch ? { streamEpoch: subscribeEpoch } : {}),
      });
    },
  };
};
