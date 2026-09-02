import { RelayCloseCode } from './protocol';

// Minimal wire surface the client needs from the relay WebSocket. Injectable
// so tests can substitute an in-memory transport pair.
export interface TunnelWireSocket {
  readonly readyState: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
}

export const wrapNativeWebSocket = (ws: WebSocket): TunnelWireSocket => {
  ws.binaryType = 'arraybuffer';
  const wire: TunnelWireSocket = {
    get readyState() {
      return ws.readyState;
    },
    send(data) {
      ws.send(data);
    },
    close(code, reason) {
      ws.close(code, reason);
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = () => wire.onopen?.();
  ws.onmessage = (event) => wire.onmessage?.({ data: event.data });
  ws.onclose = (event) => wire.onclose?.({ code: event.code, reason: event.reason });
  ws.onerror = () => wire.onerror?.();
  return wire;
};

// Socket-like surface for tunneled WebSockets. Matches exactly what
// packages/ui/src/sync/event-pipeline.ts uses: assignable on* handlers,
// send(), close(), readyState. `wrapBrowserWebSocket` adapts a native
// WebSocket to the same shape so consumers can hold one type for both paths.
export interface RelayTunnelSocketMessageEvent {
  data: string | ArrayBuffer;
}

export interface RelayTunnelSocketCloseEvent {
  code: number;
  reason: string;
}

export interface RelayTunnelWebSocket {
  readonly readyState: number;
  // Native-only hint; the tunnel always delivers binary as ArrayBuffer, so it
  // accepts the setter as a no-op to keep the two socket shapes interchangeable.
  binaryType?: 'blob' | 'arraybuffer';
  onopen: (() => void) | null;
  onmessage: ((event: RelayTunnelSocketMessageEvent) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: RelayTunnelSocketCloseEvent) => void) | null;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export const wrapBrowserWebSocket = (ws: WebSocket): RelayTunnelWebSocket => {
  const socket: RelayTunnelWebSocket = {
    get readyState() {
      return ws.readyState;
    },
    get binaryType() {
      return ws.binaryType;
    },
    set binaryType(value) {
      if (value) ws.binaryType = value;
    },
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send(data) {
      ws.send(data);
    },
    close(code, reason) {
      ws.close(code, reason);
    },
  };
  ws.onopen = () => socket.onopen?.();
  ws.onmessage = (event) => {
    const data: unknown = event.data;
    if (typeof data === 'string' || data instanceof ArrayBuffer) {
      socket.onmessage?.({ data });
    }
  };
  ws.onerror = () => socket.onerror?.();
  ws.onclose = (event) => socket.onclose?.({ code: event.code, reason: event.reason });
  return socket;
};

export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

// Relay close codes that a reconnect can never resolve — surface a terminal error
// instead of looping forever (auth failed, duplicate client, limit exceeded).
export const TERMINAL_RELAY_CLOSE_CODES = new Set<number>([
  RelayCloseCode.AuthFailed,
  RelayCloseCode.DuplicateClient,
  RelayCloseCode.LimitExceeded,
]);

export const RELAY_CLOSE_MESSAGES: Record<number, string> = {
  [RelayCloseCode.AuthFailed]: 'relay authentication failed',
  [RelayCloseCode.DuplicateClient]: 'relay connection replaced by another client',
  [RelayCloseCode.LimitExceeded]: 'relay connection limit reached',
};
