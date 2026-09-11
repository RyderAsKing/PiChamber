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

class FakeSocket implements RelayTunnelWebSocket {
  readyState = 0;
  binaryType: 'blob' | 'arraybuffer' = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: RelayTunnelWebSocket['onmessage'] = null;
  onerror: (() => void) | null = null;
  onclose: RelayTunnelWebSocket['onclose'] = null;
  sent: Record<string, unknown>[] = [];
  open(): void { this.readyState = 1; this.onopen?.(); }
  emit(message: Record<string, unknown>): void {
    const bytes = frame(message);
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
  }
  send(data: string | ArrayBuffer | ArrayBufferView): void {
    const bytes = typeof data === 'string'
      ? encoder.encode(data)
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const parsed = JSON.parse(decoder.decode(bytes.subarray(1))) as Record<string, unknown>;
    this.sent.push(parsed);
  }
  close(): void { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('terminal transport switch (same-runtime reattach)', () => {
  test('generation bumps once per reset and listeners clean up on unmount', async () => {
    const api = await import('./terminalApi');
    const before = api.getTerminalTransportGeneration();
    let calls = 0;
    const unsubscribe = api.subscribeTerminalTransportGeneration(() => { calls += 1; });
    api.resetTerminalTransport();
    expect(api.getTerminalTransportGeneration()).toBe(before + 1);
    expect(calls).toBe(1);
    unsubscribe();
    api.resetTerminalTransport();
    expect(calls).toBe(1);
  });

  test('mounted multiple tabs reattach exactly once; old late open/connect rejected', async () => {
    const oldSocket = new FakeSocket();
    const oldTransport = new TerminalTransport({ refreshAuth: async () => 'old-token', openSocket: () => oldSocket });
    const oldEvents: string[] = [];
    const unsubs = [
      oldTransport.subscribe('pty-a', { onEvent: (e) => oldEvents.push(`a:${e.type}`) }),
      oldTransport.subscribe('pty-b', { onEvent: (e) => oldEvents.push(`b:${e.type}`) }),
    ];
    await tick();
    oldSocket.open();
    await tick();
    expect(oldSocket.sent.filter((m) => m.t === 'attach')).toHaveLength(2);

    oldTransport.dispose();
    oldSocket.emit({ t: 'output', v: 3, s: 'pty-a', q: 99, d: 'stale' });
    await tick();
    expect(oldEvents).toEqual([]);
    for (const unsub of unsubs) {
      try { unsub(); } catch { /* disposed */ }
    }

    const newSockets: FakeSocket[] = [];
    const newTransport = new TerminalTransport({
      refreshAuth: async () => 'fresh-token',
      openSocket: () => { const s = new FakeSocket(); newSockets.push(s); return s; },
    });
    newTransport.subscribe('pty-a', { onEvent: () => {} });
    newTransport.subscribe('pty-b', { onEvent: () => {} });
    await tick();
    expect(newSockets).toHaveLength(1);
    newSockets[0]!.open();
    await tick();
    const attaches = newSockets[0]!.sent.filter((m) => m.t === 'attach');
    expect(attaches).toHaveLength(2);
    expect(new Set(attaches.map((m) => m.s))).toEqual(new Set(['pty-a', 'pty-b']));
    newTransport.dispose();
  });

  test('old late data after replacement is dropped; scrollback never duplicates', async () => {
    const socket = new FakeSocket();
    const transport = new TerminalTransport({ refreshAuth: async () => '', openSocket: () => socket });
    const events: Array<{ type: string; sequence?: number }> = [];
    transport.subscribe('pty-1', { onEvent: (e) => events.push({ type: e.type, sequence: e.sequence }) });
    await tick();
    socket.open();
    await tick();
    socket.emit({ t: 'snapshot', v: 3, s: 'pty-1', q: 5, history: 'prompt$ ', status: 'running' });
    await tick();
    socket.emit({ t: 'output', v: 3, s: 'pty-1', q: 6, d: 'ls', r: 'ls' });
    await tick();
    expect(events.map((e) => `${e.type}:${e.sequence}`)).toEqual(['snapshot:5', 'data:6']);

    transport.dispose();
    const replacement = new FakeSocket();
    const next = new TerminalTransport({ refreshAuth: async () => '', openSocket: () => replacement });
    const nextEvents: string[] = [];
    next.subscribe('pty-1', { onEvent: (e) => nextEvents.push(`${e.type}:${e.sequence ?? ''}`) });
    expect(nextEvents).toEqual([]);
    await tick();
    replacement.open();
    await tick();
    socket.emit({ t: 'output', v: 3, s: 'pty-1', q: 7, d: 'stale' });
    await tick();
    expect(events).toHaveLength(2);
    replacement.emit({ t: 'snapshot', v: 3, s: 'pty-1', q: 6, history: 'prompt$ ls', status: 'running' });
    await tick();
    replacement.emit({ t: 'output', v: 3, s: 'pty-1', q: 6, d: 'duplicate' });
    await tick();
    expect(nextEvents).toEqual(['snapshot:6']);
    next.dispose();
  });

  test('backoff restarts fresh after a switch instead of inheriting the cap', async () => {
    if (typeof document !== 'undefined') Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    if (typeof navigator !== 'undefined') Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    const firstAttempts: number[] = [];
    const failing = new TerminalTransport({
      refreshAuth: async () => '',
      openSocket: () => { throw new Error('offline'); },
    });
    failing.subscribe('pty-1', {
      onEvent: (e) => { if (e.type === 'reconnecting' && typeof e.attempt === 'number') firstAttempts.push(e.attempt); },
    });
    await tick();
    await tick();
    expect(firstAttempts).toEqual([1]);
    failing.dispose();

    const secondAttempts: number[] = [];
    const replacement = new TerminalTransport({
      refreshAuth: async () => '',
      openSocket: () => { throw new Error('offline'); },
    });
    replacement.subscribe('pty-1', {
      onEvent: (e) => { if (e.type === 'reconnecting' && typeof e.attempt === 'number') secondAttempts.push(e.attempt); },
    });
    await tick();
    await tick();
    expect(secondAttempts).toEqual([1]);
    replacement.dispose();
  });

  test('unmount clears reconnect timers; no dial after detach+dispose', async () => {
    let openCalls = 0;
    const transport = new TerminalTransport({
      refreshAuth: async () => '',
      openSocket: () => { openCalls += 1; throw new Error('offline'); },
    });
    const unsubscribe = transport.subscribe('pty-1', { onEvent: () => {} });
    await tick();
    await tick();
    expect(openCalls).toBe(1);
    unsubscribe();
    transport.dispose();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(openCalls).toBe(1);
  });

  test('ambiguous input is dropped, never sent', async () => {
    const socket = new FakeSocket();
    let authCalls = 0;
    const transport = new TerminalTransport({
      refreshAuth: async () => { authCalls += 1; return ''; },
      openSocket: () => socket,
    });
    transport.subscribe('pty-1', { onEvent: () => {} });
    await tick();
    socket.open();
    await tick();
    const sentBefore = socket.sent.length;
    await transport.write('pty-1', '');
    expect(socket.sent.length).toBe(sentBefore);
    expect(authCalls).toBe(1);
    transport.dispose();
  });

  test('pending write straddling a replacement is dropped, not replayed', async () => {
    let releaseAuth!: (token: string) => void;
    const authGate = new Promise<string>((resolve) => { releaseAuth = resolve; });
    const socket = new FakeSocket();
    const transport = new TerminalTransport({
      refreshAuth: () => authGate,
      openSocket: () => socket,
    });
    transport.subscribe('pty-1', { onEvent: () => {} });
    const pending = transport.write('pty-1', 'typed-during-gap');
    transport.dispose();
    releaseAuth('late-token');
    await expect(pending).rejects.toThrow('Terminal runtime changed');
    expect(socket.sent.filter((m) => m.t === 'write')).toEqual([]);
  });

  test('old late open/connect after dispose is rejected (no attach, no projection)', async () => {
    let releaseAuth!: (token: string) => void;
    const authGate = new Promise<string>((resolve) => { releaseAuth = resolve; });
    const staleSocket = new FakeSocket();
    let openedSockets = 0;
    const staleTransport = new TerminalTransport({
      refreshAuth: () => authGate,
      openSocket: () => { openedSockets += 1; return staleSocket; },
    });
    const staleEvents: string[] = [];
    staleTransport.subscribe('pty-stale', { onEvent: (e) => staleEvents.push(e.type) });
    await tick();
    // Replacement intervenes while the old dial is still waiting on auth.
    staleTransport.dispose();
    releaseAuth('late-token');
    await tick();
    await tick();
    // Old open must not attach, must not deliver, must not schedule backoff.
    expect(openedSockets).toBe(0);
    expect(staleSocket.sent.filter((m) => m.t === 'attach')).toHaveLength(0);
    expect(staleEvents).toEqual([]);
    // Fresh transport still dials exactly once and attaches.
    const freshSocket = new FakeSocket();
    const fresh = new TerminalTransport({ refreshAuth: async () => 'fresh', openSocket: () => freshSocket });
    fresh.subscribe('pty-stale', { onEvent: () => {} });
    await tick();
    freshSocket.open();
    await tick();
    expect(freshSocket.sent.filter((m) => m.t === 'attach')).toHaveLength(1);
    fresh.dispose();
  });

  test('auth is minted fresh on reattach via centralized refresh (direct/relay fixture)', async () => {
    const seenTokens: string[] = [];
    const directSockets: FakeSocket[] = [];
    const direct = new TerminalTransport({
      refreshAuth: async () => { seenTokens.push('direct-token'); return 'direct-token'; },
      openSocket: (token) => {
        expect(token).toBe('direct-token');
        const s = new FakeSocket();
        directSockets.push(s);
        queueMicrotask(() => s.open());
        return s;
      },
    });
    direct.subscribe('pty-1', { onEvent: () => {} });
    await tick();
    await tick();
    expect(directSockets).toHaveLength(1);
    direct.dispose();

    const relaySockets: FakeSocket[] = [];
    const relay = new TerminalTransport({
      refreshAuth: async () => { seenTokens.push('relay-token'); return 'relay-token'; },
      openSocket: (token) => {
        expect(token).toBe('relay-token');
        const s = new FakeSocket();
        relaySockets.push(s);
        queueMicrotask(() => s.open());
        return s;
      },
    });
    relay.subscribe('pty-1', { onEvent: () => {} });
    await tick();
    await tick();
    expect(relaySockets).toHaveLength(1);
    expect(seenTokens).toEqual(['direct-token', 'relay-token']);
    relay.dispose();
  });

  test('disposable PTY forget clears replay so close never resurrects output', async () => {
    const socket = new FakeSocket();
    const transport = new TerminalTransport({ refreshAuth: async () => '', openSocket: () => socket });
    transport.subscribe('pty-disposable', { onEvent: () => {} });
    await tick();
    socket.open();
    await tick();
    socket.emit({ t: 'snapshot', v: 3, s: 'pty-disposable', q: 3, history: 'ephemeral', status: 'running' });
    await tick();
    transport.forget('pty-disposable');
    const events: string[] = [];
    transport.subscribe('pty-disposable', { onEvent: (e) => events.push(e.type) });
    expect(events).toEqual([]);
    transport.dispose();
  });
});
