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

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

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
    this.sent.push(JSON.parse(decoder.decode(bytes.subarray(1))) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '' });
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const attachMessages = (socket: FakeSocket) => socket.sent.filter((message) => message.t === 'attach');

describe('terminal transport switch', () => {
  test('reset bumps the generation once and supports listener cleanup', async () => {
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

  test('replacement attaches each PTY once, rejects stale data, and deduplicates sequence replay', async () => {
    const tokens: string[] = [];
    const oldSocket = new FakeSocket();
    const oldTransport = new TerminalTransport({
      refreshAuth: async () => { tokens.push('old'); return 'old'; },
      openSocket: () => oldSocket,
    });
    const oldEvents: string[] = [];
    oldTransport.subscribe('pty-a', { onEvent: (event) => oldEvents.push(`a:${event.type}`) });
    oldTransport.subscribe('pty-b', { onEvent: (event) => oldEvents.push(`b:${event.type}`) });
    await tick();
    oldSocket.open();
    await tick();
    expect(attachMessages(oldSocket)).toHaveLength(2);

    oldSocket.emit({ t: 'snapshot', v: 3, s: 'pty-a', q: 5, history: 'prompt$ ', status: 'running' });
    await tick();
    expect(oldEvents).toEqual(['a:snapshot']);
    oldTransport.dispose();
    oldSocket.emit({ t: 'output', v: 3, s: 'pty-a', q: 99, d: 'stale' });
    await tick();
    expect(oldEvents).toEqual(['a:snapshot']);

    const newSocket = new FakeSocket();
    const replacement = new TerminalTransport({
      refreshAuth: async () => { tokens.push('new'); return 'new'; },
      openSocket: () => newSocket,
    });
    const newEvents: string[] = [];
    replacement.subscribe('pty-a', { onEvent: (event) => newEvents.push(`${event.type}:${event.sequence ?? ''}`) });
    replacement.subscribe('pty-b', { onEvent: () => {} });
    await tick();
    newSocket.open();
    await tick();

    const attaches = attachMessages(newSocket);
    expect(attaches).toHaveLength(2);
    expect(new Set(attaches.map((message) => message.s))).toEqual(new Set(['pty-a', 'pty-b']));
    expect(tokens).toEqual(['old', 'new']);

    newSocket.emit({ t: 'snapshot', v: 3, s: 'pty-a', q: 6, history: 'prompt$ ls', status: 'running' });
    newSocket.emit({ t: 'output', v: 3, s: 'pty-a', q: 6, d: 'duplicate' });
    await tick();
    expect(newEvents).toEqual(['snapshot:6']);
    replacement.dispose();
  });

  test('a pending write interrupted by replacement is dropped instead of replayed', async () => {
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
    expect(socket.sent.filter((message) => message.t === 'write')).toEqual([]);
  });
});
