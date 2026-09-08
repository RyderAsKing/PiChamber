import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import net from 'node:net';

import {
  DEFAULT_EVENT_STREAM_MAX_BUFFERED_BYTES,
  createPiEventStreamRegistry,
  openPiEventStream,
} from './event-stream.js';
import { registerPiRuntimeRoutes } from './routes.js';

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const createFakeReq = () => {
  const listeners = {};
  return {
    once: (event, handler) => {
      (listeners[event] ??= []).push(handler);
    },
    off: (event, handler) => {
      listeners[event] = (listeners[event] ?? []).filter((candidate) => candidate !== handler);
    },
    emit: (event) => {
      for (const handler of [...(listeners[event] ?? [])]) handler();
    },
  };
};

/**
 * Fake response with deterministic backpressure: every write is buffered
 * forever (the client never reads), so `writableLength` grows monotonically
 * and `write()` returns false once past `highWater`.
 */
/**
 * Fake response with deterministic backpressure: every write is buffered
 * forever (the client never reads), so `writableLength` grows monotonically.
 * With `highWaterMark`, `write()` buffers the chunk and then returns false
 * once past the mark (like a real socket), and `'drain'` only fires if a test
 * emits it — so a never-draining client is fully deterministic.
 */
const createFakeRes = ({ highWaterMark } = {}) => {
  const state = { chunks: [], destroyed: false, writableEnded: false, endCount: 0, bytes: 0, closeEmitted: false };
  const listeners = {};
  const res = {
    get destroyed() {
      return state.destroyed;
    },
    get writableEnded() {
      return state.writableEnded;
    },
    get writableLength() {
      return state.bytes;
    },
    write(chunk) {
      if (state.destroyed || state.writableEnded) return false;
      state.chunks.push(chunk);
      state.bytes += Buffer.byteLength(chunk);
      return highWaterMark === undefined || state.bytes < highWaterMark;
    },
    end() {
      state.endCount += 1;
      state.writableEnded = true;
    },
    destroy() {
      state.destroyed = true;
      if (!state.closeEmitted) {
        state.closeEmitted = true;
        res.emit('close');
      }
    },
    once(event, handler) {
      (listeners[event] ??= []).push(handler);
    },
    off(event, handler) {
      listeners[event] = (listeners[event] ?? []).filter((candidate) => candidate !== handler);
    },
    emit(event, ...args) {
      for (const handler of [...(listeners[event] ?? [])]) handler(...args);
    },
  };
  res.__state = state;
  return res;
};

const frame = (sequence, padding = '') => ({
  protocolVersion: 1,
  kind: 'event',
  event: 'session.updated',
  sequence,
  payload: { sessionId: 's', directory: '/workspace', title: `t${sequence}${padding}` },
});

const writtenData = (res) => res.__state.chunks
  .filter((chunk) => chunk.startsWith('data: '))
  .map((chunk) => JSON.parse(chunk.slice('data: '.length)).payload.title);

describe('Pi event stream lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes a late subscription exactly once when the client disconnects while subscribe is pending', async () => {
    let resolveSubscribe;
    let closeCalls = 0;
    const req = createFakeReq();
    const res = createFakeRes();
    openPiEventStream({
      req,
      res,
      projectFrame: (value) => value,
      subscribe: () => new Promise((resolve) => {
        resolveSubscribe = resolve;
      }),
    });

    // Client leaves before the subscription opens.
    req.emit('close');
    resolveSubscribe(() => {
      closeCalls += 1;
    });
    await flush();

    expect(closeCalls).toBe(1);
    expect(res.__state.chunks).toEqual([]);
    expect(res.__state.endCount).toBe(0);
    // No heartbeat is attached to the dead response.
    vi.advanceTimersByTime(60_000);
    expect(res.__state.chunks).toEqual([]);
  });

  it('closes a late subscription exactly once on shutdown while subscribe is pending', async () => {
    const registry = createPiEventStreamRegistry();
    let resolveSubscribe;
    let closeCalls = 0;
    const req = createFakeReq();
    const res = createFakeRes();
    openPiEventStream({
      req,
      res,
      registry,
      projectFrame: (value) => value,
      subscribe: () => new Promise((resolve) => {
        resolveSubscribe = resolve;
      }),
    });
    expect(registry.size).toBe(1);

    registry.closeAll();
    registry.closeAll();
    resolveSubscribe(() => {
      closeCalls += 1;
    });
    await flush();

    expect(closeCalls).toBe(1);
    expect(registry.size).toBe(0);
    expect(res.__state.chunks).toEqual([]);
  });

  it('ends an active connection once on shutdown and is idempotent across close events', async () => {
    const registry = createPiEventStreamRegistry();
    let closeCalls = 0;
    const req = createFakeReq();
    const res = createFakeRes();
    openPiEventStream({
      req,
      res,
      registry,
      heartbeatMs: 5,
      projectFrame: (value) => value,
      subscribe: async () => () => {
        closeCalls += 1;
      },
    });
    await flush();
    expect(res.__state.chunks.filter((chunk) => chunk.startsWith('event: heartbeat'))).toHaveLength(1);

    registry.closeAll();
    req.emit('close');
    await flush();

    expect(closeCalls).toBe(1);
    expect(res.__state.endCount).toBe(1);
    expect(registry.size).toBe(0);
    const after = res.__state.chunks.length;
    vi.advanceTimersByTime(60_000);
    expect(res.__state.chunks).toHaveLength(after);
  });

  it('sends named heartbeats on a healthy connection and never on a dead response', async () => {
    const req = createFakeReq();
    const res = createFakeRes();
    openPiEventStream({
      req,
      res,
      heartbeatMs: 10,
      projectFrame: (value) => value,
      subscribe: async () => () => {},
    });
    await flush();

    expect(res.__state.chunks[0]).toBe('event: heartbeat\ndata: {}\n\n');
    vi.advanceTimersByTime(30);
    const heartbeats = res.__state.chunks.filter((chunk) => chunk.startsWith('event: heartbeat'));
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);

    // Response dies: no heartbeat write, no late write, no throw.
    res.destroy();
    const before = res.__state.chunks.length;
    vi.advanceTimersByTime(100);
    expect(res.__state.chunks).toHaveLength(before);
  });

  it('skips late daemon events after cleanup without throwing', async () => {
    let push;
    const req = createFakeReq();
    const res = createFakeRes();
    openPiEventStream({
      req,
      res,
      projectFrame: (value) => value,
      subscribe: async ({ onEvent }) => {
        push = onEvent;
        return () => {};
      },
    });
    await flush();
    push(frame(1));
    expect(writtenData(res)).toEqual(['t1']);

    req.emit('close');
    push(frame(2));
    expect(writtenData(res)).toEqual(['t1']);
  });

  it('aborts the provided signal when the client disconnects', async () => {
    let captured;
    const req = createFakeReq();
    const res = createFakeRes();
    openPiEventStream({
      req,
      res,
      projectFrame: (value) => value,
      subscribe: async (handlers) => {
        captured = handlers;
        return () => {};
      },
    });
    await flush();
    expect(captured.signal.aborted).toBe(false);

    req.emit('close');
    expect(captured.signal.aborted).toBe(true);
  });

  it('ends once on daemon error and stays idempotent when close events follow', async () => {
    let fail;
    let closeCalls = 0;
    const req = createFakeReq();
    const res = createFakeRes();
    openPiEventStream({
      req,
      res,
      heartbeatMs: 5,
      projectFrame: (value) => value,
      subscribe: async ({ onError }) => {
        fail = onError;
        return () => {
          closeCalls += 1;
        };
      },
    });
    await flush();
    fail();
    req.emit('close');
    await flush();

    expect(closeCalls).toBe(1);
    expect(res.__state.endCount).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(res.__state.chunks.filter((chunk) => chunk.startsWith('event: heartbeat'))).toHaveLength(1);
  });

  it('disconnects a slow client at the byte bound without dropping any buffered event', async () => {
    let push;
    let closeCalls = 0;
    const req = createFakeReq();
    const res = createFakeRes();
    const bound = 1024;
    openPiEventStream({
      req,
      res,
      maxBufferedBytes: bound,
      projectFrame: (value) => value,
      subscribe: async ({ onEvent }) => {
        push = onEvent;
        return () => {
          closeCalls += 1;
        };
      },
    });
    await flush();

    // Replay overload: a long synchronous burst.
    for (let sequence = 1; sequence <= 500; sequence++) push(frame(sequence));
    await flush();

    expect(closeCalls).toBe(1);
    expect(res.__state.endCount).toBe(1);
    // Every event written before the bound survived, in order: the slow client
    // gets a recoverable disconnect, not a dropped event.
    const titles = writtenData(res);
    expect(titles).toEqual(titles.map((_, index) => `t${index + 1}`));
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.length).toBeLessThan(500);
    expect(res.__state.bytes).toBeLessThan(bound * 2);
    // Frames emitted after the disconnect are not written.
    push(frame(501));
    expect(writtenData(res)).toEqual(titles);
  });

  it('never writes an oversized frame that would overshoot the byte bound', async () => {
    let push;
    const req = createFakeReq();
    const res = createFakeRes();
    openPiEventStream({
      req,
      res,
      maxBufferedBytes: 100,
      projectFrame: (value) => value,
      subscribe: async ({ onEvent }) => {
        push = onEvent;
        return () => {};
      },
    });
    await flush();

    // The initial heartbeat (28 bytes) fits; this frame (~400 bytes) would
    // overshoot the 100-byte bound, so it must be dropped BEFORE the write
    // and the stream ended instead of writing one huge overshoot.
    push(frame(1, 'x'.repeat(380)));
    await flush();

    expect(writtenData(res)).toEqual([]);
    expect(res.__state.chunks).toEqual(['event: heartbeat\ndata: {}\n\n']);
    expect(res.__state.writableEnded).toBe(true);
  });

  it('destroys a stalled socket after the bounded terminate deadline so shutdown cannot hang', async () => {
    let push;
    let closeCalls = 0;
    const req = createFakeReq();
    const res = createFakeRes();
    openPiEventStream({
      req,
      res,
      maxBufferedBytes: 1024,
      terminateTimeoutMs: 100,
      projectFrame: (value) => value,
      subscribe: async ({ onEvent }) => {
        push = onEvent;
        return () => {
          closeCalls += 1;
        };
      },
    });
    await flush();

    for (let sequence = 1; sequence <= 100; sequence++) push(frame(sequence));
    await flush();

    // The bound crossed: res.end() ran, but a stalled client never reads, so
    // end() alone cannot release the socket.
    expect(closeCalls).toBe(1);
    expect(res.__state.endCount).toBe(1);
    expect(res.__state.writableEnded).toBe(true);
    expect(res.__state.destroyed).toBe(false);

    // The terminate deadline bounds the wait and destroys the socket.
    vi.advanceTimersByTime(99);
    expect(res.__state.destroyed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(res.__state.destroyed).toBe(true);
    expect(closeCalls).toBe(1);
  });

  it('ends a quiet client whose socket never drains after the bounded drain deadline', async () => {
    let push;
    let closeCalls = 0;
    const req = createFakeReq();
    const res = createFakeRes({ highWaterMark: 64 });
    openPiEventStream({
      req,
      res,
      drainTimeoutMs: 100,
      terminateTimeoutMs: 100,
      projectFrame: (value) => value,
      subscribe: async ({ onEvent }) => {
        push = onEvent;
        return () => {
          closeCalls += 1;
        };
      },
    });
    await flush();

    // One frame fills the socket buffer (write returned false) and then the
    // client goes quiet: the byte bound is never crossed, but the connection
    // must still be released by the drain deadline.
    push(frame(1));
    await flush();
    expect(res.__state.writableEnded).toBe(false);

    vi.advanceTimersByTime(99);
    expect(res.__state.writableEnded).toBe(false);
    vi.advanceTimersByTime(1);
    expect(closeCalls).toBe(1);
    expect(res.__state.endCount).toBe(1);
    // The terminate deadline then releases the stalled socket itself.
    vi.advanceTimersByTime(100);
    expect(res.__state.destroyed).toBe(true);
    // No late frame is written after teardown.
    push(frame(2));
    expect(writtenData(res)).toEqual(['t1']);
  });

  it('clears the drain deadline when the socket drains in time and keeps streaming', async () => {
    let push;
    const req = createFakeReq();
    const res = createFakeRes({ highWaterMark: 64 });
    openPiEventStream({
      req,
      res,
      drainTimeoutMs: 100,
      terminateTimeoutMs: 100,
      projectFrame: (value) => value,
      subscribe: async ({ onEvent }) => {
        push = onEvent;
        return () => {};
      },
    });
    await flush();

    push(frame(1));
    await flush();
    // The socket drains before the deadline: the connection stays open.
    res.emit('drain');
    vi.advanceTimersByTime(200);
    expect(res.__state.writableEnded).toBe(false);
    expect(res.__state.destroyed).toBe(false);

    // Streaming continues normally after the drain.
    push(frame(2));
    expect(writtenData(res)).toEqual(['t1', 't2']);
  });

  it('swallows a late response error after cleanup instead of crashing', async () => {
    let push;
    const req = createFakeReq();
    const res = createFakeRes();
    openPiEventStream({
      req,
      res,
      projectFrame: (value) => value,
      subscribe: async ({ onEvent }) => {
        push = onEvent;
        return () => {};
      },
    });
    await flush();
    push(frame(1));
    req.emit('close');

    // Teardown completed while data was still in flight: a late response
    // error must not surface as an unhandled 'error' event.
    expect(() => {
      res.emit('error', new Error('late socket error'));
      res.emit('error', new Error('second late error'));
    }).not.toThrow();
    expect(writtenData(res)).toEqual(['t1']);
  });

  it('keeps a healthy client independent of a slow one and preserves order', async () => {
    const senders = [];
    const subscribe = async ({ onEvent }) => {
      senders.push(onEvent);
      return () => {};
    };
    const slowReq = createFakeReq();
    const slowRes = createFakeRes();
    openPiEventStream({
      req: slowReq,
      res: slowRes,
      maxBufferedBytes: 512,
      projectFrame: (value) => value,
      subscribe,
    });
    const healthyReq = createFakeReq();
    const healthyRes = createFakeRes();
    openPiEventStream({
      req: healthyReq,
      res: healthyRes,
      maxBufferedBytes: DEFAULT_EVENT_STREAM_MAX_BUFFERED_BYTES,
      projectFrame: (value) => value,
      subscribe,
    });
    await flush();

    for (const send of senders) {
      for (let sequence = 1; sequence <= 50; sequence++) send(frame(sequence));
    }
    await flush();

    // The slow client was disconnected mid-burst with a preserved prefix.
    expect(slowRes.__state.writableEnded).toBe(true);
    const slowTitles = writtenData(slowRes);
    expect(slowTitles).toEqual(slowTitles.map((_, index) => `t${index + 1}`));
    expect(slowTitles.length).toBeLessThan(50);

    // The healthy client received the whole burst in order.
    expect(writtenData(healthyRes)).toEqual(Array.from({ length: 50 }, (_, index) => `t${index + 1}`));

    // Later events still reach only the healthy client.
    for (const send of senders) {
      for (let sequence = 51; sequence <= 60; sequence++) send(frame(sequence));
    }
    await flush();
    expect(writtenData(healthyRes)).toHaveLength(60);
    expect(writtenData(slowRes)).toEqual(slowTitles);
  });

  it('delivers a full replay overload in order to a healthy client with the default bound', async () => {
    let push;
    const req = createFakeReq();
    const res = createFakeRes();
    openPiEventStream({
      req,
      res,
      projectFrame: (value) => value,
      subscribe: async ({ onEvent }) => {
        push = onEvent;
        return () => {};
      },
    });
    await flush();

    for (let sequence = 1; sequence <= 2000; sequence++) push(frame(sequence, 'x'.repeat(50)));
    await flush();

    expect(res.__state.writableEnded).toBe(false);
    expect(writtenData(res)).toEqual(Array.from({ length: 2000 }, (_, index) => `t${index + 1}${'x'.repeat(50)}`));
  });
});

describe('Pi event stream route', () => {
  let server;

  const listen = (app) => new Promise((resolve, reject) => {
    const created = app.listen(0, '127.0.0.1', () => resolve(created));
    const connections = new Set();
    created.on('connection', (socket) => {
      connections.add(socket);
      socket.once('close', () => connections.delete(socket));
    });
    created.__testConnections = connections;
    created.once('error', reject);
  });

  const close = async () => {
    if (!server) return;
    // SSE deliberately keeps a response open; destroy test sockets so teardown
    // cannot hang forever.
    for (const socket of server.__testConnections ?? []) socket.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
    server = undefined;
  };

  afterEach(close);

  it('cleans up the subscription when the client disconnects before subscribe resolves', async () => {
    let resolveSubscribe;
    let closeCalls = 0;
    const runtime = {
      subscribe: () => new Promise((resolve) => {
        resolveSubscribe = () => resolve(() => {
          closeCalls += 1;
        });
      }),
    };
    const app = express();
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);

    const controller = new AbortController();
    // Abort either rejects fetch (before headers) or fails the body read
    // (after headers); normalize the outcome so nothing is left unhandled.
    const clientOutcome = fetch(`http://127.0.0.1:${server.address().port}/api/pi/events`, { signal: controller.signal })
      .then((response) => response.text())
      .catch(() => 'aborted');
    await vi.waitFor(() => expect(resolveSubscribe).toBeDefined());
    controller.abort();
    resolveSubscribe();
    await vi.waitFor(() => expect(closeCalls).toBe(1));
    // The aborted client's connection is fully gone.
    await vi.waitFor(() => expect(server.__testConnections.size).toBe(0));
    await clientOutcome;
  });

  it('enforces the byte bound before writing so no frame overshoots it', async () => {
    const runtime = {
      subscribe: async ({ onEvent }) => {
        for (let sequence = 1; sequence <= 20; sequence++) {
          onEvent({
            protocolVersion: 1,
            kind: 'event',
            event: 'session.updated',
            sequence,
            payload: { sessionId: 's', directory: '/workspace', title: `t${sequence}` },
          });
        }
        return () => {};
      },
    };
    const app = express();
    registerPiRuntimeRoutes(app, {
      getPiSessionDaemonRuntime: () => runtime,
      eventStreamMaxBufferedBytes: 1,
    });
    server = await listen(app);

    // Every frame (even the heartbeat) would overshoot the one-byte bound, so
    // the bound is enforced before any write: the response ends with zero
    // bytes written and the client reconnects for replay — no one-frame
    // overshoot, no silently dropped middle frame.
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/events`);
    const text = await response.text();
    expect(text).toBe('');
  });

  /** A raw HTTP client that sends the request and then never reads a byte. */
  const stalledClient = (port) => {
    const client = net.connect(port, '127.0.0.1');
    client.on('connect', () => {
      client.write('GET /events HTTP/1.1\r\nHost: localhost\r\n\r\n');
      client.pause();
    });
    client.on('error', () => {});
    return client;
  };

  /** Await server.close() with a bounded guard so a regression fails instead of hanging. */
  const closeWithin = (ms = 3_000) => new Promise((resolve) => {
    const guard = setTimeout(() => resolve(false), ms);
    server.close(() => {
      clearTimeout(guard);
      resolve(true);
    });
  });

  it('releases a stalled reader via the bounded terminate deadline so server shutdown completes', async () => {
    const registry = createPiEventStreamRegistry();
    let resRef;
    const app = express();
    app.get('/events', (req, res) => {
      resRef = res;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.flushHeaders?.();
      openPiEventStream({
        req,
        res,
        registry,
        heartbeatMs: 15_000,
        maxBufferedBytes: 64 * 1024,
        // The drain shortcut stays out of the way: the byte bound does the
        // ending here, and only the terminate deadline can release the
        // socket afterwards.
        drainTimeoutMs: 60_000,
        terminateTimeoutMs: 150,
        projectFrame: (value) => value,
        subscribe: async ({ onEvent }) => {
          // ~215KB against a never-reading client: crosses the 64KB bound.
          for (let i = 1; i <= 1000; i++) onEvent(frame(i, 'y'.repeat(180)));
          return () => {};
        },
      });
    });
    server = await listen(app);

    const client = stalledClient(server.address().port);
    await vi.waitFor(
      () => {
        expect(resRef).toBeDefined();
        expect(resRef.writableEnded).toBe(true);
      },
      { timeout: 5_000 },
    );

    // res.end() only queues the FIN behind the unflushable backlog: without
    // the bounded destroy, server.close() hangs forever. With it, shutdown
    // completes promptly and the socket is destroyed.
    expect(await closeWithin()).toBe(true);
    expect(resRef.destroyed).toBe(true);
    expect(registry.size).toBe(0);
    client.destroy();
  });

  it('releases a stalled reader after shutdown closeAll without crossing the byte bound', async () => {
    const registry = createPiEventStreamRegistry();
    let resRef;
    const app = express();
    app.get('/events', (req, res) => {
      resRef = res;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.flushHeaders?.();
      openPiEventStream({
        req,
        res,
        registry,
        heartbeatMs: 15_000,
        // The default-sized bound is never crossed; shutdown must release
        // the stalled reader anyway.
        maxBufferedBytes: DEFAULT_EVENT_STREAM_MAX_BUFFERED_BYTES,
        drainTimeoutMs: 60_000,
        terminateTimeoutMs: 150,
        projectFrame: (value) => value,
        subscribe: async ({ onEvent }) => {
          // Buffer some data behind the stalled socket without ending.
          for (let i = 1; i <= 500; i++) onEvent(frame(i, 'y'.repeat(180)));
          return () => {};
        },
      });
    });
    server = await listen(app);

    const client = stalledClient(server.address().port);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(resRef).toBeDefined();
    expect(resRef.writableEnded).toBe(false);

    registry.closeAll();
    expect(resRef.writableEnded).toBe(true);

    expect(await closeWithin()).toBe(true);
    expect(resRef.destroyed).toBe(true);
    client.destroy();
  });

  it('preserves the unavailable-daemon 503 mapping', async () => {
    const app = express();
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => undefined });
    server = await listen(app);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/events`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: { code: 'DAEMON_UNAVAILABLE' } });
  });
});
