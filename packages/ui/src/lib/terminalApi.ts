import type { CreateTerminalOptions, TerminalError, TerminalHandlers, TerminalSession, TerminalShellOption, TerminalStreamEvent } from './api/types';
import { openRuntimeWebSocket } from './relay/runtime-socket';
import type { RelayTunnelWebSocket } from './relay/tunnel-client';
import { runtimeFetch } from './runtime-fetch';
import { getRuntimeUrlResolver } from './runtime-url';
import { clearRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken } from './runtime-auth';
import { isTerminalShell } from './terminalShell';
import i18n from '@/i18n';

type Message = Record<string, unknown> & { t: string; s?: string; q?: number };
type Subscriber = { handlers: TerminalHandlers; lastSequence: number };
type TerminalProjection = {
  sequence: number;
  history: string;
  status: TerminalStreamEvent['status'];
  exitCode?: number;
  signal?: number | null;
  runtime?: TerminalStreamEvent['runtime'];
  ptyBackend?: string;
};
const TAG = 1;
const MAX_PROJECTION_BYTES = 512 * 1024;
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const TERMINAL_KEEPALIVE_INTERVAL_MS = 45_000;
const TERMINAL_PONG_TIMEOUT_MS = 10_000;
/**
 * Switching terminal tabs detaches the old terminal before attaching the new one,
 * which momentarily leaves zero subscribers. Closing the socket there forced a
 * token refresh, a fresh upgrade and a full snapshot replay on every switch, so
 * hold the idle socket briefly and reuse it instead.
 */
const IDLE_SOCKET_GRACE_MS = 15_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const isHiddenOrOffline = (): boolean => (
  (typeof document !== 'undefined' && document.visibilityState === 'hidden') ||
  (typeof navigator !== 'undefined' && !navigator.onLine)
);

const encode = (message: Message): Uint8Array => {
  const payload = encoder.encode(JSON.stringify(message));
  const frame = new Uint8Array(payload.length + 1);
  frame[0] = TAG;
  frame.set(payload, 1);
  return frame;
};

const decode = async (data: unknown): Promise<Message | null> => {
  let bytes: Uint8Array;
  if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (data instanceof Uint8Array) bytes = data;
  else if (typeof Blob !== 'undefined' && data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
  else if (typeof data === 'string') bytes = encoder.encode(data);
  else return null;
  if (bytes[0] === TAG) bytes = bytes.subarray(1);
  try { return JSON.parse(decoder.decode(bytes)) as Message; } catch { return null; }
};

const responseError = async (response: Response, fallback: string): Promise<Error> => {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return new Error(typeof body?.error === 'string' ? body.error : fallback);
};

const trimProjection = (value: string): string => {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= MAX_PROJECTION_BYTES) return value;
  let start = bytes.byteLength - MAX_PROJECTION_BYTES;
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start += 1;
  return decoder.decode(bytes.subarray(start));
};

type TerminalTransportDependencies = {
  refreshAuth: () => Promise<string>;
  openSocket: (urlAuthToken: string) => RelayTunnelWebSocket;
  clearUrlAuthToken?: (expectedToken?: string) => void;
};

export class TerminalTransport {
  private socket: RelayTunnelWebSocket | null = null;
  private opening: Promise<void> | null = null;
  private subscribers = new Map<string, Set<Subscriber>>();
  private projections = new Map<string, TerminalProjection>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private pongDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private idleCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private persistentListenersInstalled = false;
  private generation = 0;
  private disposed = false;

  constructor(private readonly dependencies: TerminalTransportDependencies = {
    refreshAuth: refreshRuntimeUrlAuthToken,
    openSocket: (urlAuthToken) => openRuntimeWebSocket(getRuntimeUrlResolver().websocket('/api/terminal/ws', undefined, urlAuthToken)),
    clearUrlAuthToken: clearRuntimeUrlAuthToken,
  }) {
    this.installPersistentListeners();
  }

  subscribe(sessionId: string, handlers: TerminalHandlers): () => void {
    this.cancelIdleClose();
    const subscriber = { handlers, lastSequence: -1 };
    const set = this.subscribers.get(sessionId) ?? new Set<Subscriber>();
    const first = set.size === 0;
    set.add(subscriber);
    this.subscribers.set(sessionId, set);
    const projection = this.projections.get(sessionId);
    if (projection) {
      subscriber.lastSequence = projection.sequence;
      handlers.onEvent({ type: 'snapshot', sequence: projection.sequence, data: projection.history, status: projection.status, exitCode: projection.exitCode, signal: projection.signal, runtime: projection.runtime, ptyBackend: projection.ptyBackend });
    }
    const socketWasOpen = this.socket?.readyState === SOCKET_OPEN;
    this.ensureConnected().then(() => {
      const current = this.subscribers.get(sessionId);
      if (first && socketWasOpen && current === set && current.size > 0) {
        this.send({ t: 'attach', v: 3, s: sessionId });
      }
    }).catch((error) => {
      if (!set.has(subscriber)) return;
      handlers.onError?.(error, false);
      this.scheduleReconnect();
    });
    return () => {
      const current = this.subscribers.get(sessionId);
      current?.delete(subscriber);
      if (current?.size === 0) {
        this.subscribers.delete(sessionId);
        this.projections.delete(sessionId);
        this.send({ t: 'detach', v: 3, s: sessionId });
      }
      if (this.subscribers.size === 0) {
        this.cancelReconnect();
        this.failures = 0;
        if (this.socket?.readyState === SOCKET_OPEN) {
          // Healthy socket: hold it briefly so a tab switch can reattach to it.
          this.scheduleIdleClose();
          return;
        }
        // Nothing to reuse, so abandon any dial that is still in flight.
        this.generation += 1;
        this.opening = null;
        this.closeSocket();
      }
    };
  }

  async write(sessionId: string, data: string): Promise<void> {
    if (!data) return;
    // Never replay input when a transport replacement interrupts the write.
    const writeGeneration = this.generation;
    const isReplaced = (): boolean => this.disposed || writeGeneration !== this.generation;
    await this.ensureConnected();
    if (isReplaced()) throw new Error('Terminal runtime changed');
    if (this.send({ t: 'write', v: 3, s: sessionId, d: data })) return;
    this.closeSocket();
    await this.ensureConnected();
    if (isReplaced()) throw new Error('Terminal runtime changed');
    if (!this.send({ t: 'write', v: 3, s: sessionId, d: data })) throw new Error(i18n.t('Terminal connection is unavailable'));
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.opening = null;
    this.subscribers.clear();
    this.projections.clear();
    this.cancelReconnect();
    this.cancelIdleClose();
    this.removePersistentListeners();
    this.closeSocket();
  }

  forget(sessionId: string): void {
    this.projections.delete(sessionId);
  }

  private installPersistentListeners(): void {
    if (this.persistentListenersInstalled) return;
    this.persistentListenersInstalled = true;
    if (typeof window !== 'undefined') {
      window.addEventListener('pichamber:system-resume', this.handleWakeSignal);
      window.addEventListener('online', this.handleWakeSignal);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleWakeSignal);
    }
  }

  private removePersistentListeners(): void {
    if (!this.persistentListenersInstalled) return;
    this.persistentListenersInstalled = false;
    if (typeof window !== 'undefined') {
      window.removeEventListener('pichamber:system-resume', this.handleWakeSignal);
      window.removeEventListener('online', this.handleWakeSignal);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleWakeSignal);
    }
  }

  private handleWakeSignal = (): void => {
    if (this.disposed || isHiddenOrOffline()) return;
    if (this.reconnectTimer !== null) {
      this.wakeReconnect();
      return;
    }
    if (this.socket?.readyState === SOCKET_OPEN) {
      this.sendPing();
    }
  };

  private async ensureConnected(): Promise<void> {
    if (this.disposed) throw new Error('Terminal runtime changed');
    if (this.socket?.readyState === SOCKET_OPEN) return;
    if (this.opening) {
      await this.opening;
      if (this.socket?.readyState === SOCKET_OPEN) return;
      return this.ensureConnected();
    }
    const generation = this.generation;
    const opening = (async () => {
      const urlAuthToken = await this.dependencies.refreshAuth();
      if (generation !== this.generation || this.disposed) throw new Error('Terminal runtime changed');
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let opened = false;
        let authInvalidated = false;
        let pendingSocket: RelayTunnelWebSocket | null = null;
        const isCurrentSocket = () => (
          generation === this.generation &&
          !this.disposed &&
          pendingSocket !== null &&
          this.socket === pendingSocket
        );
        const invalidatePreOpenAuth = () => {
          if (authInvalidated || opened || !isCurrentSocket()) return;
          authInvalidated = true;
          this.dependencies.clearUrlAuthToken?.(urlAuthToken);
        };
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (error) reject(error);
          else resolve();
        };
        const timeout = setTimeout(() => {
          invalidatePreOpenAuth();
          pendingSocket?.close();
          finish(new Error(i18n.t('Terminal connection timed out')));
        }, 10_000);
        try {
          const socket = this.dependencies.openSocket(urlAuthToken);
          pendingSocket = socket;
          socket.binaryType = 'arraybuffer';
          this.socket = socket;
          socket.onopen = () => {
            if (!isCurrentSocket()) { socket.close(); finish(new Error('Terminal runtime changed')); return; }
            opened = true;
            this.failures = 0;
            this.send({ t: 'hello', v: 3 });
            for (const sessionId of this.subscribers.keys()) this.send({ t: 'attach', v: 3, s: sessionId });
            this.startKeepalive();
            finish();
          };
          socket.onmessage = (event) => void this.handleMessage(event.data);
          socket.onerror = () => {
            const current = isCurrentSocket();
            if (current) invalidatePreOpenAuth();
            finish(new Error(i18n.t('Terminal WebSocket failed')));
            if (current && this.subscribers.size > 0) this.scheduleReconnect();
          };
          socket.onclose = () => {
            const current = isCurrentSocket();
            if (current) {
              this.stopKeepalive();
              // An upgrade rejected before `open` commonly means the cached
              // URL-scoped auth token is stale. Retrying it reaches the 8s
              // backoff cap instead of minting a fresh token.
              invalidatePreOpenAuth();
            }
            if (this.socket === socket) this.socket = null;
            finish(new Error(i18n.t('Terminal WebSocket closed')));
            if (current && this.subscribers.size > 0) this.scheduleReconnect();
          };
        } catch (error) {
          finish(error instanceof Error ? error : new Error(i18n.t('Terminal WebSocket failed')));
          if (!this.disposed && this.subscribers.size > 0) this.scheduleReconnect();
        }
      });
    })();
    this.opening = opening;
    try {
      await opening;
    } finally {
      if (this.opening === opening) {
        this.opening = null;
      }
    }
  }

  private async handleMessage(raw: unknown): Promise<void> {
    this.clearPongDeadline();
    const message = await decode(raw);
    if (!message || message.t === 'hello' || message.t === 'pong') return;
    if (message.t === 'error') {
      const error = new Error(typeof message.message === 'string' ? message.message : i18n.t('Terminal error')) as TerminalError;
      if (typeof message.code === 'string') error.code = message.code;
      const targets = message.s ? [message.s] : [...this.subscribers.keys()];
      for (const id of targets) for (const sub of this.subscribers.get(id) ?? []) sub.handlers.onError?.(error, message.fatal === true);
      return;
    }
    if (!message.s) return;
    const subscribers = this.subscribers.get(message.s);
    if (!subscribers) return;
    if (message.t === 'snapshot') {
      const projection: TerminalProjection = {
        sequence: typeof message.q === 'number' ? message.q : 0,
        history: typeof message.history === 'string' ? message.history : '',
        status: message.status as TerminalStreamEvent['status'],
        exitCode: typeof message.exitCode === 'number' ? message.exitCode : undefined,
        signal: typeof message.signal === 'number' ? message.signal : null,
        runtime: message.runtime as TerminalStreamEvent['runtime'],
        ptyBackend: typeof message.ptyBackend === 'string' ? message.ptyBackend : undefined,
      };
      this.projections.set(message.s, projection);
      for (const sub of subscribers) {
        sub.lastSequence = projection.sequence;
        sub.handlers.onEvent({ type: 'snapshot', sequence: projection.sequence, data: projection.history, status: projection.status, exitCode: projection.exitCode, signal: projection.signal, runtime: projection.runtime, ptyBackend: projection.ptyBackend });
      }
      return;
    }
    if (typeof message.q !== 'number') return;
    const previous = this.projections.get(message.s);
    if (previous && message.q > previous.sequence) {
      if (message.t === 'output') this.projections.set(message.s, { ...previous, sequence: message.q, history: trimProjection(previous.history + (typeof message.r === 'string' ? message.r : (typeof message.d === 'string' ? message.d : ''))) });
      else if (message.t === 'exit') this.projections.set(message.s, { ...previous, sequence: message.q, status: 'exited', exitCode: typeof message.exitCode === 'number' ? message.exitCode : undefined, signal: typeof message.signal === 'number' ? message.signal : null });
      else if (message.t === 'restarted') this.projections.set(message.s, { ...previous, sequence: message.q, history: typeof message.history === 'string' ? message.history : '', status: 'running', exitCode: undefined, signal: null });
    }
    for (const sub of subscribers) {
      if (message.q <= sub.lastSequence) continue;
      sub.lastSequence = message.q;
      if (message.t === 'output') sub.handlers.onEvent({ type: 'data', sequence: message.q, data: typeof message.d === 'string' ? message.d : '', replayData: typeof message.r === 'string' ? message.r : undefined });
      else if (message.t === 'exit') sub.handlers.onEvent({ type: 'exit', sequence: message.q, exitCode: typeof message.exitCode === 'number' ? message.exitCode : undefined, signal: typeof message.signal === 'number' ? message.signal : null });
      else if (message.t === 'restarted') sub.handlers.onEvent({ type: 'snapshot', sequence: message.q, data: typeof message.history === 'string' ? message.history : '', status: 'running' });
    }
  }

  private send(message: Message): boolean {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) return false;
    try { this.socket.send(encode(message)); return true; } catch { return false; }
  }

  private sendPing(): void {
    if (this.disposed || !this.socket || this.socket.readyState !== SOCKET_OPEN) return;
    if (isHiddenOrOffline()) return;
    if (this.pongDeadlineTimer !== null) return;
    if (!this.send({ t: 'ping', v: 3 })) return;
    this.armPongDeadline();
  }

  private armPongDeadline(): void {
    this.clearPongDeadline();
    this.pongDeadlineTimer = setTimeout(() => {
      this.handlePongTimeout();
    }, TERMINAL_PONG_TIMEOUT_MS);
  }

  private clearPongDeadline(): void {
    if (this.pongDeadlineTimer) {
      clearTimeout(this.pongDeadlineTimer);
      this.pongDeadlineTimer = null;
    }
  }

  private handlePongTimeout(): void {
    this.clearPongDeadline();
    const socket = this.socket;
    if (!socket) return;
    // A half-open socket may not deliver `close` until the closing handshake
    // times out. Detach it and run its close path now so reconnect starts
    // immediately; the late native close event is then ignored.
    const onclose = socket.onclose;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try { socket.close(); } catch { /* already closing */ }
    onclose?.({ code: 4000, reason: 'terminal keepalive timeout' });
  }

  private wakeReconnect(): void {
    if (this.disposed || isHiddenOrOffline()) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    void this.ensureConnected().catch(() => this.scheduleReconnect());
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.disposed || this.subscribers.size === 0) return;
    this.failures += 1;
    const delay = isHiddenOrOffline() ? 60_000 : Math.min(500 * 2 ** Math.min(this.failures - 1, 10), 8_000);
    for (const set of this.subscribers.values()) for (const sub of set) sub.handlers.onEvent({ type: 'reconnecting', attempt: this.failures, maxAttempts: Number.POSITIVE_INFINITY });
    // The persistent resume/online/visibility listeners cut this wait short.
    this.reconnectTimer = setTimeout(() => this.wakeReconnect(), delay);
  }

  private scheduleIdleClose(): void {
    if (this.idleCloseTimer || this.disposed) return;
    this.idleCloseTimer = setTimeout(() => {
      this.idleCloseTimer = null;
      if (this.disposed || this.subscribers.size > 0) return;
      this.generation += 1;
      this.opening = null;
      this.closeSocket();
    }, IDLE_SOCKET_GRACE_MS);
  }

  private cancelIdleClose(): void {
    if (!this.idleCloseTimer) return;
    clearTimeout(this.idleCloseTimer);
    this.idleCloseTimer = null;
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => this.sendPing(), TERMINAL_KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.clearPongDeadline();
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private closeSocket(): void {
    this.stopKeepalive();
    const socket = this.socket;
    this.socket = null;
    if (socket && (socket.readyState === SOCKET_CONNECTING || socket.readyState === SOCKET_OPEN)) socket.close();
  }
}

let transport = new TerminalTransport();

// Mounted terminal views use this generation to reject stale callbacks and
// reattach PTYs after the singleton transport is replaced.
let terminalTransportGeneration = 0;
const terminalGenerationListeners = new Set<() => void>();

export const getTerminalTransportGeneration = (): number => terminalTransportGeneration;

export const subscribeTerminalTransportGeneration = (listener: () => void): (() => void) => {
  terminalGenerationListeners.add(listener);
  return () => {
    terminalGenerationListeners.delete(listener);
  };
};

const bumpTerminalTransportGeneration = (): void => {
  terminalTransportGeneration += 1;
  for (const listener of [...terminalGenerationListeners]) {
    try {
      listener();
    } catch {
      // A listener throwing must not break transport replacement.
    }
  }
};

export async function createTerminalSession(options: CreateTerminalOptions): Promise<TerminalSession> {
  const response = await runtimeFetch('/api/terminal/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options) });
  if (!response.ok) throw await responseError(response, i18n.t('Failed to create terminal session'));
  return response.json() as Promise<TerminalSession>;
}
export async function listTerminalShells(): Promise<TerminalShellOption[]> {
  const response = await runtimeFetch('/api/terminal/shells');
  if (!response.ok) throw await responseError(response, i18n.t('Failed to list terminal shells'));
  const payload = await response.json().catch(() => []);
  return Array.isArray(payload)
    ? payload.filter((entry): entry is TerminalShellOption => (
        entry && typeof entry === 'object' && isTerminalShell(entry.id) && typeof entry.name === 'string' && typeof entry.supportsLogin === 'boolean'
      ))
    : [];
}
export function connectTerminalStream(sessionId: string, onEvent: TerminalHandlers['onEvent'], onError?: TerminalHandlers['onError']): () => void { return transport.subscribe(sessionId, { onEvent, onError }); }
export async function sendTerminalInput(sessionId: string, data: string): Promise<void> { await transport.write(sessionId, data); }

async function command(path: string, method: string, body?: unknown): Promise<Response> {
  const options: RequestInit = { method };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const response = await runtimeFetch(path, options);
  if (!response.ok) throw await responseError(response, i18n.t('Terminal command failed'));
  return response;
}
export async function resizeTerminal(sessionId: string, cols: number, rows: number): Promise<void> { await command(`/api/terminal/${sessionId}/resize`, 'POST', { cols, rows }); }
export async function updateTerminalAppearance(sessionId: string, appearance: Pick<CreateTerminalOptions, 'themeMode' | 'terminalBackground' | 'terminalForeground'>): Promise<void> { await command(`/api/terminal/${sessionId}/appearance`, 'POST', appearance); }
export async function closeTerminal(sessionId: string): Promise<void> { await command(`/api/terminal/${sessionId}`, 'DELETE'); transport.forget(sessionId); }
export async function restartTerminalSession(currentSessionId: string, options: CreateTerminalOptions): Promise<TerminalSession> { return (await command(`/api/terminal/${currentSessionId}/restart`, 'POST', options)).json() as Promise<TerminalSession>; }
export async function forceKillTerminal(options: { sessionId?: string; cwd?: string }): Promise<void> {
  const response = await command('/api/terminal/force-kill', 'POST', options);
  const result = await response.json().catch(() => null) as { killedSessionIds?: unknown } | null;
  if (Array.isArray(result?.killedSessionIds)) {
    for (const sessionId of result.killedSessionIds) if (typeof sessionId === 'string') transport.forget(sessionId);
  } else if (options.sessionId) transport.forget(options.sessionId);
}
export function resetTerminalTransport(): void {
  transport.dispose();
  transport = new TerminalTransport();
  bumpTerminalTransportGeneration();
}
