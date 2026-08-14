/**
 * Browser transport for the public Pi event stream.
 *
 * The browser only talks to the PiChamber server. HTTP uses `runtimeFetch`,
 * while realtime URLs are resolved through the shared runtime URL helpers and
 * WebSockets are opened through `openRuntimeWebSocket` so relay mode remains
 * transparent to this module.
 */

import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { isPiEvent, PI_PUBLIC_PROTOCOL_VERSION, type PiSessionEvent } from './protocol';

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
const RECONNECT_BACKOFF_BASE_MS = 250;
const RECONNECT_BACKOFF_CAP_VISIBLE_MS = 5_000;
const RECONNECT_BACKOFF_CAP_HIDDEN_OR_OFFLINE_MS = 60_000;
const RECONNECT_BACKOFF_MAX_EXPONENT = 8;
const WS_READY_TIMEOUT_MS = 2_000;

const debug = (..._args: unknown[]): void => {
  // Keep diagnostics payload-free by default. A caller can observe lifecycle
  // callbacks without making the hot path retain prompt or transcript data.
  void _args;
};

const resolveStreamQuery = (query: { fromSequence?: number; sessionId?: string }): Record<string, string> => {
  const params: Record<string, string> = {};
  if (typeof query.fromSequence === 'number' && Number.isFinite(query.fromSequence)) {
    params.fromSequence = String(Math.max(0, Math.floor(query.fromSequence)));
  }
  if (typeof query.sessionId === 'string' && query.sessionId.length > 0) {
    params.sessionId = query.sessionId;
  }
  return params;
};

const resolveStreamUrl = (
  transport: 'ws' | 'sse',
  query: { fromSequence?: number; sessionId?: string },
): string => {
  const resolver = getRuntimeUrlResolver();
  const params = resolveStreamQuery(query);
  return transport === 'ws'
    ? resolver.websocket('/api/pi/events', params)
    : resolver.sse('/api/pi/events', params);
};

const resolveHealthPath = (): string => '/api/pi/runtime';

export interface PiStreamHandlers {
  onEvent: (event: PiSessionEvent) => void;
  onReconnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onTransportSwitch?: () => void;
}

export interface PiStreamOptions {
  fromSequence?: number;
  sessionId?: string;
  transport?: 'auto' | 'ws' | 'sse';
  heartbeatTimeoutMs?: number;
  reconnectDelayMs?: number;
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
  error?: { code: string; message?: string };
}> => {
  let response: Response;
  try {
    response = await runtimeFetch(resolveHealthPath(), signal ? { signal } : {});
  } catch (error) {
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
    | { state?: unknown; protocolVersion?: unknown; capabilities?: unknown; error?: { code?: unknown; message?: unknown } }
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
  return {
    state: payload.state === 'ready' ? 'ready' : 'unavailable',
    protocolVersion: typeof payload.protocolVersion === 'number' ? payload.protocolVersion : PI_PUBLIC_PROTOCOL_VERSION,
    capabilities: Array.isArray(payload.capabilities)
      ? payload.capabilities.filter((value): value is string => typeof value === 'string')
      : [],
    ...(errorCode
      ? { error: { code: errorCode, ...(typeof payload.error?.message === 'string' ? { message: payload.error.message } : {}) } }
      : {}),
  };
};

type ConnectionCleanup = () => void;

const createSseConnection = (
  query: Record<string, string>,
  signal: AbortSignal,
  onReady: () => void,
  onActivity: () => void,
  onEvent: (event: PiSessionEvent) => void,
  onDisconnect: (reason: string) => void,
): ConnectionCleanup => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', abort, { once: true });

  void runtimeFetch('/api/pi/events', {
    headers: { Accept: 'text/event-stream' },
    query,
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok || !response.body) {
        onDisconnect(`sse-status-${response.status}`);
        return;
      }

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
      onDisconnect(`sse-error:${message}`);
    })
    .finally(() => signal.removeEventListener('abort', abort));

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
  if (externalSignal) {
    if (externalSignal.aborted) internalController.abort();
    else externalSignal.addEventListener('abort', () => internalController.abort(), { once: true });
  }
  const signal = internalController.signal;
  const expectedRuntimeKey = options.runtimeKey;
  const isCurrentRuntime = () => !expectedRuntimeKey || expectedRuntimeKey === getRuntimeKey();

  let disposed = false;
  let attempt = 0;
  let lastSequence = typeof options.fromSequence === 'number' && Number.isFinite(options.fromSequence)
    ? Math.max(0, Math.floor(options.fromSequence))
    : 0;
  // The Pi event endpoint is SSE-only. WebSocket remains available only when
  // explicitly requested by a runtime that provides a matching upgrade path.
  let mode: 'ws' | 'sse' = options.transport === 'ws' ? 'ws' : 'sse';
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let activeAbort: ConnectionCleanup | null = null;
  let generation = 0;
  let healthyConnection = false;

  const clearTimers = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    reconnectTimer = null;
    heartbeatTimer = null;
  };

  const invalidateConnection = () => {
    generation += 1;
    activeAbort?.();
    activeAbort = null;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  };

  const resetHeartbeat = (connectionId: number) => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      if (connectionId === generation) handleDisconnect('heartbeat-timeout', connectionId);
    }, options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS);
  };

  const markReady = (connectionId: number) => {
    if (disposed || signal.aborted || connectionId !== generation) return;
    attempt = 0;
    healthyConnection = true;
    resetHeartbeat(connectionId);
    handlers.onReconnect?.();
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

  const scheduleReconnect = (reason: string) => {
    if (disposed || signal.aborted || reconnectTimer) return;
    handlers.onDisconnect?.(reason);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      attempt += 1;
      void connect();
    }, computeBackoff());
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
    scheduleReconnect(reason);
  };

  const handleEvent = (event: PiSessionEvent, connectionId: number) => {
    if (disposed || signal.aborted || connectionId !== generation) return;
    if (!isCurrentRuntime()) {
      handleDisconnect('runtime-change', connectionId);
      return;
    }
    if (event.sequence > lastSequence) lastSequence = event.sequence;
    resetHeartbeat(connectionId);
    handlers.onEvent(event);
  };

  const connect = async (): Promise<void> => {
    if (disposed || signal.aborted) return;
    if (!isCurrentRuntime()) {
      handlers.onDisconnect?.('runtime-change');
      return;
    }
    const connectionId = generation + 1;
    generation = connectionId;

    if (mode === 'ws') {
      try {
        await refreshRuntimeUrlAuthToken();
      } catch {
        if (connectionId !== generation || disposed || signal.aborted) return;
        if (options.transport !== 'ws') {
          mode = 'sse';
          handlers.onTransportSwitch?.();
          invalidateConnection();
          void connect();
          return;
        }
        handleDisconnect('ws-auth-token-unavailable', connectionId);
        return;
      }
    }

    if (connectionId !== generation || disposed || signal.aborted) return;
    if (!isCurrentRuntime()) {
      handleDisconnect('runtime-change', connectionId);
      return;
    }
    const url = resolveStreamUrl(mode, {
      fromSequence: lastSequence,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    });
    const onReady = () => markReady(connectionId);
    const onEvent = (event: PiSessionEvent) => handleEvent(event, connectionId);
    const onDisconnect = (reason: string) => handleDisconnect(reason, connectionId);
    activeAbort = mode === 'ws'
      ? createWsConnection(url, signal, onReady, onEvent, onDisconnect, WS_READY_TIMEOUT_MS)
      : createSseConnection(resolveStreamQuery({
          fromSequence: lastSequence,
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        }), signal, onReady, () => resetHeartbeat(connectionId), onEvent, onDisconnect);
  };

  void connect();

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimers();
      invalidateConnection();
      internalController.abort();
    },
    reconnect: (reason = 'manual') => {
      if (disposed || signal.aborted) return;
      clearTimers();
      invalidateConnection();
      scheduleReconnect(reason);
    },
    get eventsUrl() {
      return resolveStreamUrl(mode, {
        fromSequence: lastSequence,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      });
    },
  };
};
