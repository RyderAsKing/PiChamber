import { describe, expect, test } from 'bun:test';
import type { RelayTunnelWebSocket } from './relay/tunnel-client';
import { TerminalTransport } from './terminalApi';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const frame = (message: Record<string, unknown>): Uint8Array => {
  const body = encoder.encode(JSON.stringify(message));
  const result = new Uint8Array(body.length + 1);
  result[0] = 1;
  result.set(body, 1);
  return result;
};

const parseFrame = (value: string | ArrayBuffer | ArrayBufferView): Record<string, unknown> => {
  const bytes = typeof value === 'string'
    ? encoder.encode(value)
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return JSON.parse(decoder.decode(bytes.subarray(1))) as Record<string, unknown>;
};

class FakeSocket implements RelayTunnelWebSocket {
  readyState = 0;
  binaryType: 'blob' | 'arraybuffer' = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: RelayTunnelWebSocket['onmessage'] = null;
  onerror: (() => void) | null = null;
  onclose: RelayTunnelWebSocket['onclose'] = null;
  sent: Record<string, unknown>[] = [];

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emit(message: Record<string, unknown>): void {
    const bytes = frame(message);
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(parseFrame(data));
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '' });
  }
}

class FakeEventTarget {
  listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener !== 'function') return;
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener !== 'function') return;
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: { type: string }): boolean {
    const set = this.listeners.get(event.type);
    if (set) {
      for (const listener of [...set]) {
        listener(event as Event);
      }
    }
    return true;
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class MockTimers {
  private originalSetTimeout = globalThis.setTimeout;
  private originalClearTimeout = globalThis.clearTimeout;
  private originalSetInterval = globalThis.setInterval;
  private originalClearInterval = globalThis.clearInterval;

  private nextId = 1;
  timers = new Map<number, { fn: () => void; delay: number }>();
  intervals = new Map<number, { fn: () => void; interval: number }>();

  install() {
    globalThis.setTimeout = ((fn: () => void, delay = 0, ...args: unknown[]) => {
      const numDelay = Number(delay ?? 0);
      if (numDelay === 0) {
        return this.originalSetTimeout(fn, 0, ...args);
      }
      const id = this.nextId++;
      this.timers.set(id, { fn: () => fn(...args as []), delay: numDelay });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
      if (id !== undefined) {
        this.originalClearTimeout(id);
        this.timers.delete(Number(id));
      }
    }) as typeof clearTimeout;

    globalThis.setInterval = ((fn: () => void, interval = 0, ...args: unknown[]) => {
      const numInterval = Number(interval ?? 0);
      const id = this.nextId++;
      this.intervals.set(id, { fn: () => fn(...args as []), interval: numInterval });
      return id as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;

    globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
      if (id !== undefined) {
        this.originalClearInterval(id);
        this.intervals.delete(Number(id));
      }
    }) as typeof clearInterval;
  }

  restore() {
    globalThis.setTimeout = this.originalSetTimeout;
    globalThis.clearTimeout = this.originalClearTimeout;
    globalThis.setInterval = this.originalSetInterval;
    globalThis.clearInterval = this.originalClearInterval;
    this.timers.clear();
    this.intervals.clear();
  }

  fireTimeout(predicate: (delay: number) => boolean): boolean {
    for (const [id, entry] of [...this.timers.entries()]) {
      if (predicate(entry.delay)) {
        this.timers.delete(id);
        entry.fn();
        return true;
      }
    }
    return false;
  }

  fireInterval(predicate: (interval: number) => boolean): boolean {
    for (const [, entry] of [...this.intervals.entries()]) {
      if (predicate(entry.interval)) {
        entry.fn();
        return true;
      }
    }
    return false;
  }

  hasTimeout(predicate: (delay: number) => boolean): boolean {
    for (const entry of this.timers.values()) {
      if (predicate(entry.delay)) return true;
    }
    return false;
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const withDomAndTimers = async (
  run: (ctx: {
    fakeWindow: FakeEventTarget;
    fakeDocument: FakeEventTarget & { visibilityState: string };
    fakeNavigator: { onLine: boolean };
    timers: MockTimers;
    dispatchResume: () => void;
    dispatchOnline: () => void;
    setVisibility: (state: 'visible' | 'hidden') => void;
  }) => Promise<void>,
) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  const fakeWindow = new FakeEventTarget();
  const fakeDocument = Object.assign(new FakeEventTarget(), { visibilityState: 'visible' });
  const fakeNavigator = { onLine: true };

  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: fakeNavigator });

  const timers = new MockTimers();
  timers.install();

  try {
    await run({
      fakeWindow,
      fakeDocument,
      fakeNavigator,
      timers,
      dispatchResume: () => fakeWindow.dispatchEvent({ type: 'pichamber:system-resume' }),
      dispatchOnline: () => fakeWindow.dispatchEvent({ type: 'online' }),
      setVisibility: (state) => {
        fakeDocument.visibilityState = state;
        fakeDocument.dispatchEvent({ type: 'visibilitychange' });
      },
    });
  } finally {
    timers.restore();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as { window?: unknown }).window;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete (globalThis as { document?: unknown }).document;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
};

describe('terminal transport liveness and keepalive', () => {
  test('no pong within deadline closes socket and schedules reconnect', async () => {
    await withDomAndTimers(async ({ timers }) => {
      const socket = new FakeSocket();
      const events: string[] = [];
      const transport = new TerminalTransport({
        refreshAuth: async () => 'token-1',
        openSocket: () => socket,
      });

      transport.subscribe('term-1', { onEvent: (e) => events.push(e.type) });
      await tick();
      socket.open();
      await tick();

      // Trigger keepalive ping
      expect(timers.fireInterval((interval) => interval === 45_000)).toBe(true);
      expect(socket.sent.some((m) => m.t === 'ping' && m.v === 3)).toBe(true);
      expect(timers.hasTimeout((delay) => delay === 10_000)).toBe(true);

      // Pong deadline expires
      expect(timers.fireTimeout((delay) => delay === 10_000)).toBe(true);

      // Socket should be closed
      expect(socket.readyState).toBe(3);
      expect(events).toContain('reconnecting');
      expect(timers.hasTimeout((delay) => delay === 500)).toBe(true);

      transport.dispose();
    });
  });

  test('a half-open socket that never fires close still reconnects on pong timeout', async () => {
    await withDomAndTimers(async ({ timers }) => {
      const socket = new FakeSocket();
      // Half-open: close() starts the closing handshake but no close event arrives.
      socket.close = () => { socket.readyState = 2; };
      const events: string[] = [];
      const transport = new TerminalTransport({
        refreshAuth: async () => 'token-1',
        openSocket: () => socket,
      });

      transport.subscribe('term-1', { onEvent: (e) => events.push(e.type) });
      await tick();
      socket.open();
      await tick();

      expect(timers.fireInterval((interval) => interval === 45_000)).toBe(true);
      expect(timers.fireTimeout((delay) => delay === 10_000)).toBe(true);

      expect(events).toContain('reconnecting');
      expect(timers.hasTimeout((delay) => delay === 500)).toBe(true);
      // The dead socket is detached: a late native close cannot double-schedule.
      expect(socket.onclose).toBeNull();

      transport.dispose();
    });
  });

  test('pong arrival clears the deadline and leaves socket healthy', async () => {
    await withDomAndTimers(async ({ timers }) => {
      const socket = new FakeSocket();
      const events: string[] = [];
      const transport = new TerminalTransport({
        refreshAuth: async () => 'token-1',
        openSocket: () => socket,
      });

      transport.subscribe('term-1', { onEvent: (e) => events.push(e.type) });
      await tick();
      socket.open();
      await tick();

      timers.fireInterval((interval) => interval === 45_000);
      expect(timers.hasTimeout((delay) => delay === 10_000)).toBe(true);

      // Pong message arrives
      socket.emit({ t: 'pong', v: 3 });
      await tick();

      expect(timers.hasTimeout((delay) => delay === 10_000)).toBe(false);
      expect(socket.readyState).toBe(1);
      expect(events).not.toContain('reconnecting');

      transport.dispose();
    });
  });

  test('inbound output message clears the pong deadline', async () => {
    await withDomAndTimers(async ({ timers }) => {
      const socket = new FakeSocket();
      const transport = new TerminalTransport({
        refreshAuth: async () => 'token-1',
        openSocket: () => socket,
      });

      transport.subscribe('term-1', { onEvent: () => {} });
      await tick();
      socket.open();
      await tick();

      timers.fireInterval((interval) => interval === 45_000);
      expect(timers.hasTimeout((delay) => delay === 10_000)).toBe(true);

      // Regular output frame arrives
      socket.emit({ t: 'output', v: 3, s: 'term-1', q: 1, d: 'hello' });
      await tick();

      expect(timers.hasTimeout((delay) => delay === 10_000)).toBe(false);
      expect(socket.readyState).toBe(1);

      transport.dispose();
    });
  });

  test('resume event while open sends exactly one ping even if fired twice', async () => {
    await withDomAndTimers(async ({ dispatchResume, timers }) => {
      const socket = new FakeSocket();
      const transport = new TerminalTransport({
        refreshAuth: async () => 'token-1',
        openSocket: () => socket,
      });

      transport.subscribe('term-1', { onEvent: () => {} });
      await tick();
      socket.open();
      await tick();
      socket.sent = [];

      // First resume event
      dispatchResume();
      expect(socket.sent).toEqual([{ t: 'ping', v: 3 }]);
      expect(timers.hasTimeout((delay) => delay === 10_000)).toBe(true);

      // Second resume event while deadline is still pending
      dispatchResume();
      // Should NOT have sent another ping
      expect(socket.sent).toHaveLength(1);

      transport.dispose();
    });
  });

  test('resume event while a reconnect timer is pending triggers immediate reconnect', async () => {
    await withDomAndTimers(async ({ dispatchResume, timers }) => {
      const sockets = [new FakeSocket(), new FakeSocket()];
      let socketIndex = 0;
      const events: string[] = [];

      const transport = new TerminalTransport({
        refreshAuth: async () => 'token-1',
        openSocket: () => {
          const s = sockets[socketIndex++];
          if (!s) throw new Error('no more sockets');
          return s;
        },
      });

      transport.subscribe('term-1', { onEvent: (e) => events.push(e.type) });
      await tick();
      sockets[0].open();
      await tick();

      // Unexpected close schedules reconnect
      sockets[0].close();
      await tick();
      expect(events).toContain('reconnecting');
      expect(timers.hasTimeout((delay) => delay === 500)).toBe(true);

      // Resume event fires while reconnect timer is pending
      dispatchResume();
      await tick();

      // Reconnect timer should have been cleared and new socket opened
      expect(timers.hasTimeout((delay) => delay === 500)).toBe(false);
      expect(socketIndex).toBe(2);

      sockets[1].open();
      await tick();
      expect(sockets[1].readyState).toBe(1);

      transport.dispose();
    });
  });

  test('visibilitychange and online events probe when open and wake when reconnecting', async () => {
    await withDomAndTimers(async ({ setVisibility, dispatchOnline, timers }) => {
      const sockets = [new FakeSocket(), new FakeSocket()];
      let socketIndex = 0;

      const transport = new TerminalTransport({
        refreshAuth: async () => 'token-1',
        openSocket: () => sockets[socketIndex++]!,
      });

      transport.subscribe('term-1', { onEvent: () => {} });
      await tick();
      sockets[0].open();
      await tick();
      sockets[0].sent = [];

      // Online event sends probe ping
      dispatchOnline();
      expect(sockets[0].sent).toEqual([{ t: 'ping', v: 3 }]);

      // Clear pong deadline by receiving pong
      sockets[0].emit({ t: 'pong', v: 3 });
      await tick();
      expect(timers.hasTimeout((delay) => delay === 10_000)).toBe(false);

      // Visibility change to visible sends probe ping
      sockets[0].sent = [];
      setVisibility('visible');
      expect(sockets[0].sent).toEqual([{ t: 'ping', v: 3 }]);

      transport.dispose();
    });
  });

  test('never probes or wakes while document is hidden or navigator is offline', async () => {
    await withDomAndTimers(async ({ fakeNavigator, setVisibility, dispatchResume, dispatchOnline, timers }) => {
      const socket = new FakeSocket();
      const transport = new TerminalTransport({
        refreshAuth: async () => 'token-1',
        openSocket: () => socket,
      });

      transport.subscribe('term-1', { onEvent: () => {} });
      await tick();
      socket.open();
      await tick();
      socket.sent = [];

      // When document is hidden
      setVisibility('hidden');
      dispatchResume();
      dispatchOnline();
      timers.fireInterval((interval) => interval === 45_000);
      expect(socket.sent).toHaveLength(0);
      expect(timers.hasTimeout((delay) => delay === 10_000)).toBe(false);

      // Make navigator offline before restoring visibility
      fakeNavigator.onLine = false;
      setVisibility('visible');
      dispatchResume();
      dispatchOnline();
      timers.fireInterval((interval) => interval === 45_000);
      expect(socket.sent).toHaveLength(0);
      expect(timers.hasTimeout((delay) => delay === 10_000)).toBe(false);

      transport.dispose();
    });
  });

  test('dispose removes persistent listeners and events after dispose do nothing', async () => {
    await withDomAndTimers(async ({ fakeWindow, fakeDocument, dispatchResume }) => {
      const socket = new FakeSocket();
      const transport = new TerminalTransport({
        refreshAuth: async () => 'token-1',
        openSocket: () => socket,
      });

      expect(fakeWindow.listenerCount('pichamber:system-resume')).toBe(1);
      expect(fakeWindow.listenerCount('online')).toBe(1);
      expect(fakeDocument.listenerCount('visibilitychange')).toBe(1);

      transport.dispose();

      expect(fakeWindow.listenerCount('pichamber:system-resume')).toBe(0);
      expect(fakeWindow.listenerCount('online')).toBe(0);
      expect(fakeDocument.listenerCount('visibilitychange')).toBe(0);

      // Dispatching after dispose must not throw or send
      dispatchResume();
      expect(fakeWindow.listenerCount('pichamber:system-resume')).toBe(0);
    });
  });
});
