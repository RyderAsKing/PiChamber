import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';

import type { ServerBrowserSocketOpener } from './api';
import {
  RECONNECT_DELAYS_MS,
  closeAction,
  decodeFrame,
  parseServerBrowserMessage,
  type FrameHeader,
  type ServerBrowserMessage,
} from './protocol';

/** `closed`: the page closed itself, or the popup it was opened for is gone. */
export type ServerBrowserConnectionPhase = 'connecting' | 'open' | 'reconnecting' | 'unavailable' | 'failed' | 'closed' | 'idle';

/** Where a connection opens the tab: its address, and a popup to claim. */
export type ServerBrowserStart = { url: string; popup?: string | null };

export type ServerBrowserConnectionListener = {
  onPhase(phase: ServerBrowserConnectionPhase): void;
  /** The socket opened; send the viewport and anything else the tab needs. */
  onOpen(): void;
  onMessage(message: ServerBrowserMessage): void;
  /** Call `ack()` once the frame is on screen. */
  onFrame(header: FrameHeader, jpeg: Uint8Array): void;
};

type Dependencies = {
  open: ServerBrowserSocketOpener;
  forgetToken: (urlAuthToken: string) => void;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

/**
 * One viewer's socket to a server browser tab. Reconnects after drops,
 * restarts, and Chrome exits (the server reopens the tab at its last
 * address); stops when the browser is unavailable or the request is bad.
 * A popup is claimed only until the first socket opens: after that the
 * server has the tab under its key, or reopens it at its last address.
 */
export class ServerBrowserConnection {
  private socket: RelayTunnelWebSocket | null = null;
  private active = false;
  private disposed = false;
  private failures = 0;
  private retryTimer: unknown = null;
  private generation = 0;
  private claimed = false;

  constructor(
    private readonly tab: string,
    private readonly start: () => ServerBrowserStart,
    private readonly listener: ServerBrowserConnectionListener,
    private readonly deps: Dependencies,
  ) {}

  /** Connect while the tab is on screen; disconnect while it is hidden. */
  setActive(active: boolean): void {
    if (this.disposed || active === this.active) return;
    this.active = active;
    if (active) {
      this.failures = 0;
      void this.connect();
      return;
    }
    this.clearRetry();
    this.closeSocket();
    this.listener.onPhase('idle');
  }

  /** Try again after the browser was unavailable or failed. */
  retry(): void {
    if (this.disposed || !this.active) return;
    this.clearRetry();
    this.closeSocket();
    this.failures = 0;
    void this.connect();
  }

  send(message: Record<string, unknown>): boolean {
    if (this.socket?.readyState !== 1) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  ack(): void {
    this.send({ type: 'ack' });
  }

  dispose(): void {
    this.disposed = true;
    this.active = false;
    this.clearRetry();
    this.closeSocket();
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) this.deps.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private closeSocket(): void {
    this.generation += 1;
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try { socket.close(1000); } catch { /* already closed */ }
  }

  private scheduleReconnect(): void {
    if (this.disposed || !this.active || this.retryTimer !== null) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.failures, RECONNECT_DELAYS_MS.length - 1)];
    this.failures += 1;
    this.listener.onPhase('reconnecting');
    this.retryTimer = this.deps.setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private async connect(): Promise<void> {
    if (this.disposed || !this.active) return;
    const generation = ++this.generation;
    this.listener.onPhase(this.failures > 0 ? 'reconnecting' : 'connecting');
    let opened: Awaited<ReturnType<ServerBrowserSocketOpener>>;
    try {
      const { url, popup } = this.start();
      opened = await this.deps.open(this.tab, url, this.claimed ? null : popup ?? null);
    } catch {
      if (generation === this.generation) this.scheduleReconnect();
      return;
    }
    const { socket, urlAuthToken } = opened;
    if (generation !== this.generation || this.disposed || !this.active) {
      try { socket.close(1000); } catch { /* ignore */ }
      return;
    }
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    let didOpen = false;
    socket.onopen = () => {
      didOpen = true;
      this.claimed = true;
      this.failures = 0;
      this.listener.onPhase('open');
      this.listener.onOpen();
    };
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const message = parseServerBrowserMessage(event.data);
        if (message) this.listener.onMessage(message);
        return;
      }
      const frame = decodeFrame(event.data);
      if (frame) this.listener.onFrame(frame.header, frame.jpeg);
      else this.ack();
    };
    socket.onerror = () => {};
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      // A rejected upgrade usually means the cached URL token went stale.
      if (!didOpen) this.deps.forgetToken(urlAuthToken);
      const action = didOpen ? closeAction(event.code) : 'reconnect';
      if (action === 'unavailable') {
        this.listener.onPhase('unavailable');
        return;
      }
      if (action === 'stop') {
        this.listener.onPhase('failed');
        return;
      }
      if (action === 'closed') {
        this.listener.onPhase('closed');
        return;
      }
      this.scheduleReconnect();
    };
  }
}
