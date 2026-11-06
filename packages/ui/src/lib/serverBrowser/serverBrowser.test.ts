import { describe, expect, test } from 'bun:test';

import type { RelayTunnelSocketCloseEvent, RelayTunnelSocketMessageEvent, RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';

import { ServerBrowserConnection, type ServerBrowserConnectionPhase } from './connection';
import {
  decodeFrame,
  serverBrowserTabKey,
  toPagePoint,
} from './protocol';

const encodeFrame = (header: Record<string, unknown>, jpeg: number[]): ArrayBuffer => {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const buffer = new ArrayBuffer(4 + headerBytes.length + jpeg.length);
  new DataView(buffer).setUint32(0, headerBytes.length);
  new Uint8Array(buffer, 4).set(headerBytes);
  new Uint8Array(buffer, 4 + headerBytes.length).set(jpeg);
  return buffer;
};

describe('server browser protocol', () => {
  test('decodes the frame header and JPEG bytes', () => {
    const frame = decodeFrame(encodeFrame({ seq: 1, width: 800, height: 600, offsetTop: 0, pageScaleFactor: 1 }, [0xff, 0xd8, 7]));
    expect(frame?.header).toMatchObject({ seq: 1, width: 800, height: 600 });
    expect([...frame!.jpeg]).toEqual([0xff, 0xd8, 7]);
    expect(decodeFrame(new ArrayBuffer(2))).toBeNull();
    expect(decodeFrame(encodeFrame({ seq: 1 }, [1]))).toBeNull();
  });

  test('maps a point on the displayed frame to page pixels', () => {
    const rect = { left: 100, top: 50, width: 400, height: 300 };
    expect(toPagePoint(300, 200, rect, { width: 800, height: 600 })).toEqual({ x: 400, y: 300 });
    // Pointer outside the frame clamps to its edge.
    expect(toPagePoint(0, 0, rect, { width: 800, height: 600 })).toEqual({ x: 0, y: 0 });
    expect(toPagePoint(1, 1, { left: 0, top: 0, width: 0, height: 0 }, { width: 800, height: 600 })).toBeNull();
  });

  test('keys tabs by directory and tab id', () => {
    const a = serverBrowserTabKey('/repo/a', 'browser');
    expect(/^[A-Za-z0-9_.:-]{1,160}$/.test(a)).toBe(true);
    expect(serverBrowserTabKey('/repo/a', 'browser')).toBe(a);
    expect(serverBrowserTabKey('/repo/b', 'browser')).not.toBe(a);
  });
});

class FakeSocket implements RelayTunnelWebSocket {
  readyState = 0;
  binaryType?: 'blob' | 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((event: RelayTunnelSocketMessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: RelayTunnelSocketCloseEvent) => void) | null = null;
  sent: string[] = [];
  closedWith: number | null = null;
  send(data: string | ArrayBuffer | ArrayBufferView) { this.sent.push(String(data)); }
  close(code?: number) { this.closedWith = code ?? 1000; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  serverClose(code: number) { this.readyState = 3; this.onclose?.({ code, reason: '' }); }
}

const setup = (popup: string | null = null) => {
  const sockets: FakeSocket[] = [];
  const opened: Array<{ tab: string; url: string; popup?: string }> = [];
  const forgotten: string[] = [];
  const timers: Array<() => void> = [];
  const phases: ServerBrowserConnectionPhase[] = [];
  const messages: unknown[] = [];
  let opens = 0;
  const connection = new ServerBrowserConnection('tab-1', () => ({ url: 'http://localhost:3000/', popup }), {
    onPhase: (phase) => phases.push(phase),
    onOpen: () => { opens += 1; },
    onMessage: (message) => messages.push(message),
    onFrame: () => {},
  }, {
    open: async (tab, url, claim) => {
      opened.push(claim ? { tab, url, popup: claim } : { tab, url });
      const socket = new FakeSocket();
      sockets.push(socket);
      return { socket, urlAuthToken: `token-${sockets.length}` };
    },
    forgetToken: (token) => forgotten.push(token),
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
    clearTimeout: () => {},
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { connection, sockets, opened, forgotten, timers, phases, messages, opens: () => opens, flush };
};

describe('ServerBrowserConnection', () => {
  test('opens the tab, forwards messages, and reconnects after Chrome exits', async () => {
    const t = setup();
    t.connection.setActive(true);
    await t.flush();
    expect(t.opened).toEqual([{ tab: 'tab-1', url: 'http://localhost:3000/' }]);
    t.sockets[0].open();
    expect(t.opens()).toBe(1);
    t.sockets[0].onmessage?.({ data: JSON.stringify({ type: 'state', url: 'x' }) });
    expect(t.messages).toEqual([{ type: 'state', url: 'x' }]);
    expect(t.connection.send({ type: 'reload' })).toBe(true);

    t.sockets[0].serverClose(4001);
    expect(t.phases.at(-1)).toBe('reconnecting');
    expect(t.timers).toHaveLength(1);
    t.timers[0]();
    await t.flush();
    expect(t.sockets).toHaveLength(2);
    t.sockets[1].open();
    expect(t.phases.at(-1)).toBe('open');
    expect(t.forgotten).toEqual([]);
  });

  test('stops when the browser is unavailable', async () => {
    const t = setup();
    t.connection.setActive(true);
    await t.flush();
    t.sockets[0].open();
    t.sockets[0].serverClose(4003);
    expect(t.phases.at(-1)).toBe('unavailable');
    expect(t.timers).toHaveLength(0);
    t.connection.retry();
    await t.flush();
    expect(t.sockets).toHaveLength(2);
  });

  test('claims a popup until a socket opens, then reconnects by tab alone', async () => {
    const t = setup('popup-1');
    t.connection.setActive(true);
    await t.flush();
    // A rejected upgrade claimed nothing.
    t.sockets[0].serverClose(1006);
    t.timers[0]();
    await t.flush();
    t.sockets[1].open();
    t.sockets[1].serverClose(4001);
    t.timers[1]();
    await t.flush();
    expect(t.opened.map((entry) => entry.popup ?? null)).toEqual(['popup-1', 'popup-1', null]);
  });

  test('stops when the page closed itself', async () => {
    const t = setup();
    t.connection.setActive(true);
    await t.flush();
    t.sockets[0].open();
    t.sockets[0].serverClose(4005);
    expect(t.phases.at(-1)).toBe('closed');
    expect(t.timers).toHaveLength(0);
  });

  test('drops a URL token whose upgrade was rejected', async () => {
    const t = setup();
    t.connection.setActive(true);
    await t.flush();
    t.sockets[0].serverClose(1006);
    expect(t.forgotten).toEqual(['token-1']);
    expect(t.phases.at(-1)).toBe('reconnecting');
  });

  test('disconnects while hidden and does not reconnect', async () => {
    const t = setup();
    t.connection.setActive(true);
    await t.flush();
    t.sockets[0].open();
    t.connection.setActive(false);
    expect(t.sockets[0].closedWith).toBe(1000);
    expect(t.phases.at(-1)).toBe('idle');
    expect(t.timers).toHaveLength(0);
    expect(t.connection.send({ type: 'reload' })).toBe(false);
  });
});
