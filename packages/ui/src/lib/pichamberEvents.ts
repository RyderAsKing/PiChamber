import { getRuntimeUrlResolver } from './runtime-url';
import { subscribeRuntimeEndpointChanged } from './runtime-switch';

type SessionCreatedEvent = {
  type: 'session-created';
  sessionId: string;
  directory: string;
  projectId?: string;
  createdAt: number;
  promptDispatched: boolean;
  dispatchedAsCommand: boolean;
};

type Listener = (event: SessionCreatedEvent) => void;

let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let runtimeChangeUnsubscribe: (() => void) | null = null;
const listeners = new Set<Listener>();

const MAX_RECONNECT_DELAY_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

const clearHeartbeatTimer = () => {
  if (!heartbeatTimer) return;
  clearTimeout(heartbeatTimer);
  heartbeatTimer = null;
};

const cleanupSource = () => {
  clearHeartbeatTimer();
  eventSource?.close();
  eventSource = null;
};

const scheduleReconnect = () => {
  if (reconnectTimer || listeners.size === 0) return;
  const delay = Math.min(1_000 * 2 ** Math.min(reconnectAttempt, 5), MAX_RECONNECT_DELAY_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAttempt += 1;
    connect();
  }, delay);
};

const resetHeartbeatTimer = () => {
  clearHeartbeatTimer();
  if (listeners.size === 0) return;
  heartbeatTimer = setTimeout(() => {
    cleanupSource();
    scheduleReconnect();
  }, HEARTBEAT_TIMEOUT_MS);
};

const dispatch = (raw: string) => {
  try {
    const envelope = JSON.parse(raw);
    if (envelope?.type === 'openchamber:event-stream-ready') {
      reconnectAttempt = 0;
      return;
    }
    if (envelope?.type !== 'openchamber:session-created' || !envelope.properties || typeof envelope.properties !== 'object') return;
    const properties = envelope.properties as Record<string, unknown>;
    const sessionId = typeof properties.sessionId === 'string' ? properties.sessionId : '';
    const directory = typeof properties.directory === 'string' ? properties.directory : '';
    if (!sessionId || !directory) return;
    const event: SessionCreatedEvent = {
      type: 'session-created',
      sessionId,
      directory,
      createdAt: typeof properties.createdAt === 'number' ? properties.createdAt : Date.now(),
      promptDispatched: properties.promptDispatched === true,
      dispatchedAsCommand: properties.dispatchedAsCommand === true,
      ...(typeof properties.projectId === 'string' && properties.projectId.length > 0 ? { projectId: properties.projectId } : {}),
    };
    for (const listener of listeners) listener(event);
  } catch {
    // Ignore malformed events: the next authoritative directory refresh remains safe.
  }
};

const connect = () => {
  if (typeof window === 'undefined' || typeof EventSource !== 'function' || listeners.size === 0) return;
  if (eventSource && eventSource.readyState !== EventSource.CLOSED) return;
  cleanupSource();
  const source = new EventSource(getRuntimeUrlResolver().sse('/api/openchamber/events'));
  source.onopen = resetHeartbeatTimer;
  source.onmessage = (event) => {
    resetHeartbeatTimer();
    dispatch(event.data);
  };
  source.onerror = () => {
    cleanupSource();
    scheduleReconnect();
  };
  eventSource = source;
};

export const subscribeOpenchamberEvents = (listener: Listener): (() => void) => {
  listeners.add(listener);
  if (!runtimeChangeUnsubscribe && typeof window !== 'undefined') {
    runtimeChangeUnsubscribe = subscribeRuntimeEndpointChanged(() => {
      cleanupSource();
      reconnectAttempt = 0;
      connect();
    });
  }
  connect();

  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempt = 0;
    cleanupSource();
    runtimeChangeUnsubscribe?.();
    runtimeChangeUnsubscribe = null;
  };
};
