import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';

import { registerPiRuntimeRoutes } from './routes.js';
import { createPiDaemonPool } from './session-daemon/daemon-pool.js';

const listen = (app) => new Promise((resolve, reject) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
  server.once('error', reject);
});

const close = (server) => new Promise((resolve) => {
  if (!server) return resolve();
  server.closeAllConnections?.();
  server.close(() => resolve());
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// A fake daemon whose event stream the test drives: every subscription is
// recorded with its options, and `emit` writes a daemon frame to every open
// subscription.
const fakeDaemon = (epoch) => {
  const subscriptions = [];
  return {
    epoch,
    subscriptions,
    get open() {
      return subscriptions.filter((s) => !s.closed);
    },
    request: async () => ({}),
    subscribe: async (options) => {
      const record = { options, closed: false };
      subscriptions.push(record);
      return () => { record.closed = true; };
    },
    emit(event, sequence, payload) {
      for (const s of this.open) {
        s.options.onEvent({ protocolVersion: 1, kind: 'event', event, sequence, streamEpoch: epoch, payload });
      }
    },
    fail() {
      for (const s of this.open) s.options.onError(new Error('socket closed'));
    },
  };
};

const title = (sessionId, directory, value) => ({ sessionId, directory, title: value });

// Reads SSE `data:` frames from a response as parsed JSON, ignoring heartbeats.
const sseReader = (response) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames = [];
  // One read stays pending across timeouts: a read abandoned after a
  // timeout would still take the next chunk and drop it.
  let pending = null;
  return {
    frames,
    async until(predicate, limit = 50) {
      for (let i = 0; i < limit && !predicate(frames); i += 1) {
        pending ??= reader.read();
        const next = await Promise.race([pending, new Promise((r) => setTimeout(() => r({ timeout: true }), 200))]);
        if (next.timeout) continue;
        pending = null;
        if (next.done) break;
        buffer += decoder.decode(next.value);
        let end = buffer.indexOf('\n\n');
        while (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block.split('\n').find((line) => line.startsWith('data: '));
          if (data && !block.startsWith('event: heartbeat')) frames.push(JSON.parse(data.slice(6)));
          end = buffer.indexOf('\n\n');
        }
      }
      return frames;
    },
    cancel: () => reader.cancel(),
  };
};

describe('merged Pi event stream over a daemon pool', () => {
  let server;
  const readers = [];
  afterEach(async () => {
    for (const reader of readers.splice(0)) await reader.cancel().catch(() => undefined);
    await close(server);
    server = undefined;
  });

  const start = async (pool) => {
    const app = express();
    registerPiRuntimeRoutes(app, { daemonPool: pool, archiveStore: { read: async () => ({}), set: async () => undefined } });
    server = await listen(app);
    return async (query = '') => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/events?capabilities=events.streamEpoch${query}`);
      if (response.status !== 200) return { status: response.status, body: await response.json() };
      const reader = sseReader(response);
      readers.push(reader);
      await reader.until(() => false, 1);
      return reader;
    };
  };

  it('keeps main-only frames and subscribe options unchanged', async () => {
    const main = fakeDaemon('epoch-main');
    const pool = createPiDaemonPool({ getMainRuntime: () => main });
    const open = await start(pool);

    const stream = await open('&sessionId=s-1&directory=/work/other&fromSequence=7&streamEpoch=epoch-main');
    main.emit('session.updated', 8, title('s-1', '/work/other', 'Main'));
    await stream.until((frames) => frames.length >= 1);

    expect(stream.frames).toEqual([{
      protocolVersion: 1, kind: 'event', name: 'session.updated', sequence: 8,
      sessionId: 's-1', directory: '/work/other', streamEpoch: 'epoch-main', payload: { title: 'Main' },
    }]);
    const { onEvent, onError, signal, ...options } = main.subscriptions[0].options;
    expect(options).toEqual({ sessionId: 's-1', directory: '/work/other', fromSequence: 7, streamEpoch: 'epoch-main' });
  });

  it('merges every daemon\'s frames, tagging project daemon frames with an opaque stream and cursor', async () => {
    const main = fakeDaemon('epoch-main');
    const sandbox = fakeDaemon('epoch-box');
    const pool = createPiDaemonPool({ getMainRuntime: () => main });
    pool.register('/work/a', { runtime: sandbox, directories: ['/work/a'] });
    const open = await start(pool);

    const stream = await open();
    main.emit('session.updated', 3, title('s-main', '/work/other', 'Main'));
    sandbox.emit('session.updated', 11, title('s-box', '/work/a', 'Box'));
    await stream.until((frames) => frames.length >= 2);

    const [fromMain, fromBox] = stream.frames;
    expect(fromMain).toEqual({
      protocolVersion: 1, kind: 'event', name: 'session.updated', sequence: 3,
      sessionId: 's-main', directory: '/work/other', streamEpoch: 'epoch-main', payload: { title: 'Main' },
    });
    expect(fromBox).toMatchObject({ name: 'session.updated', sequence: 11, sessionId: 's-box', streamEpoch: 'epoch-box', payload: { title: 'Box' } });
    expect(typeof fromBox.stream).toBe('string');
    expect(typeof fromBox.cursor).toBe('string');
    // Opaque: the pool key (a server path) never appears on the wire.
    expect(fromBox.stream).not.toContain('/work');
    expect(Buffer.from(fromBox.cursor, 'base64url').toString()).not.toContain('/work');
  });

  it('resumes every project daemon from the cursor and main from its own sequence', async () => {
    const main = fakeDaemon('epoch-main');
    const sandbox = fakeDaemon('epoch-box');
    const other = fakeDaemon('epoch-other');
    const pool = createPiDaemonPool({ getMainRuntime: () => main });
    pool.register('/work/a', { runtime: sandbox, directories: ['/work/a'] });
    pool.register('/work/b', { runtime: other, directories: ['/work/b'] });
    const open = await start(pool);

    const first = await open();
    sandbox.emit('session.updated', 11, title('s-box', '/work/a', 'Box'));
    other.emit('session.updated', 4, title('s-other', '/work/b', 'Other'));
    await first.until((frames) => frames.length >= 2);
    const cursor = first.frames[1].cursor;

    await open(`&fromSequence=30&streamEpoch=epoch-main&cursor=${encodeURIComponent(cursor)}`);
    const pick = ({ fromSequence, streamEpoch }) => ({ fromSequence, streamEpoch });
    expect(pick(main.subscriptions[1].options)).toEqual({ fromSequence: 30, streamEpoch: 'epoch-main' });
    expect(pick(sandbox.subscriptions[1].options)).toEqual({ fromSequence: 11, streamEpoch: 'epoch-box' });
    expect(pick(other.subscriptions[1].options)).toEqual({ fromSequence: 4, streamEpoch: 'epoch-other' });
  });

  it('rejects a malformed cursor and a cursor without the epoch capability', async () => {
    const main = fakeDaemon('epoch-main');
    const pool = createPiDaemonPool({ getMainRuntime: () => main });
    const open = await start(pool);

    expect(await open('&cursor=not-a-cursor')).toEqual({ status: 400, body: { error: { code: 'INVALID_ARGUMENT' } } });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/events?cursor=e30`);
    expect(response.status).toBe(400);
    expect(main.subscriptions).toEqual([]);
  });

  it('a restarted project daemon resyncs only its own sessions', async () => {
    const main = fakeDaemon('epoch-main');
    const sandbox = fakeDaemon('epoch-box');
    const pool = createPiDaemonPool({ getMainRuntime: () => main });
    pool.register('/work/a', { runtime: sandbox, directories: ['/work/a'] });
    const open = await start(pool);

    const stream = await open();
    main.emit('session.updated', 3, title('s-main', '/work/other', 'Main'));
    sandbox.emit('session.updated', 11, title('s-box', '/work/a', 'Box'));
    await stream.until((frames) => frames.length >= 2);

    const restarted = fakeDaemon('epoch-box-2');
    pool.register('/work/a', { runtime: restarted, directories: ['/work/a'] });
    await stream.until((frames) => frames.length >= 3);
    await tick();

    expect(stream.frames[2]).toEqual({
      protocolVersion: 1, kind: 'event', name: 'session.moved', sequence: 0,
      sessionId: 's-box', directory: '/work/a', payload: {},
    });
    expect(sandbox.open).toEqual([]);
    // The new process is asked to resume from the old lifetime's cursor, which
    // it answers with a resync snapshot.
    const { fromSequence, streamEpoch } = restarted.subscriptions[0].options;
    expect({ fromSequence, streamEpoch }).toEqual({ fromSequence: 11, streamEpoch: 'epoch-box' });
    // Main was never resubscribed and keeps streaming.
    expect(main.subscriptions).toHaveLength(1);
    main.emit('session.updated', 4, title('s-main', '/work/other', 'Still'));
    restarted.emit('session.updated', 1, title('s-box', '/work/a', 'Again'));
    await stream.until((frames) => frames.length >= 5);
    expect(stream.frames.slice(3).map((f) => [f.sessionId, f.streamEpoch])).toEqual([
      ['s-main', 'epoch-main'], ['s-box', 'epoch-box-2'],
    ]);
    expect(stream.frames.filter((f) => f.name === 'session.moved')).toHaveLength(1);
  });

  it('a project daemon stopping or failing does not drop the others', async () => {
    const main = fakeDaemon('epoch-main');
    const sandbox = fakeDaemon('epoch-box');
    const other = fakeDaemon('epoch-other');
    const pool = createPiDaemonPool({ getMainRuntime: () => main });
    pool.register('/work/a', { runtime: sandbox, directories: ['/work/a'] });
    pool.register('/work/b', { runtime: other, directories: ['/work/b'] });
    const open = await start(pool);

    const stream = await open();
    sandbox.emit('session.updated', 11, title('s-box', '/work/a', 'Box'));
    other.emit('session.updated', 4, title('s-other', '/work/b', 'Other'));
    await stream.until((frames) => frames.length >= 2);

    pool.unregister('/work/a');
    other.fail();
    await stream.until((frames) => frames.length >= 4);
    expect(stream.frames.slice(2).map((f) => [f.name, f.sessionId])).toEqual([
      ['session.moved', 's-box'], ['session.moved', 's-other'],
    ]);
    expect(sandbox.open).toEqual([]);

    main.emit('session.updated', 5, title('s-main', '/work/other', 'Main'));
    await stream.until((frames) => frames.length >= 5);
    expect(stream.frames[4]).toMatchObject({ sessionId: 's-main', streamEpoch: 'epoch-main' });
  });

  it('retries a failed project daemon subscription from its last position and drops a stopped daemon from the cursor', async () => {
    const main = fakeDaemon('epoch-main');
    const sandbox = fakeDaemon('epoch-box');
    const other = fakeDaemon('epoch-other');
    const pool = createPiDaemonPool({ getMainRuntime: () => main });
    pool.register('/work/a', { runtime: sandbox, directories: ['/work/a'] });
    pool.register('/work/b', { runtime: other, directories: ['/work/b'] });
    const app = express();
    registerPiRuntimeRoutes(app, { daemonPool: pool, eventStreamRetryBaseMs: 1, archiveStore: { read: async () => ({}), set: async () => undefined } });
    server = await listen(app);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/events?capabilities=events.streamEpoch`);
    const stream = sseReader(response);
    readers.push(stream);
    await stream.until(() => false, 1);

    sandbox.emit('session.updated', 11, title('s-box', '/work/a', 'Box'));
    other.emit('session.updated', 4, title('s-other', '/work/b', 'Other'));
    await stream.until((frames) => frames.length >= 2);
    sandbox.fail();
    for (let i = 0; i < 20 && sandbox.open.length === 0; i += 1) await tick();
    const { fromSequence, streamEpoch } = sandbox.subscriptions.at(-1).options;
    expect({ fromSequence, streamEpoch }).toEqual({ fromSequence: 11, streamEpoch: 'epoch-box' });

    pool.unregister('/work/a');
    other.emit('session.updated', 5, title('s-other', '/work/b', 'Again'));
    await stream.until((frames) => frames.some((f) => f.payload?.title === 'Again'));
    const last = stream.frames.at(-1);
    const decoded = JSON.parse(Buffer.from(last.cursor, 'base64url').toString());
    expect(Object.values(decoded.d)).toEqual([['epoch-other', 5]]);
  });

  it('subscribes to a daemon that appears mid-stream without a cursor', async () => {
    const main = fakeDaemon('epoch-main');
    const pool = createPiDaemonPool({ getMainRuntime: () => main });
    const open = await start(pool);
    const stream = await open('&fromSequence=2&streamEpoch=epoch-main');

    const sandbox = fakeDaemon('epoch-box');
    pool.register('/work/a', { runtime: sandbox, directories: ['/work/a'] });
    await tick();
    expect(sandbox.subscriptions).toHaveLength(1);
    expect(sandbox.subscriptions[0].options.fromSequence).toBeUndefined();
    expect(sandbox.subscriptions[0].options.streamEpoch).toBeUndefined();
    sandbox.emit('session.snapshot', 1, { sessionId: 's-box', directory: '/work/a', lifecycle: 'idle', queue: {} });
    await stream.until((frames) => frames.length >= 1);
    expect(stream.frames[0]).toMatchObject({ name: 'session.snapshot', sessionId: 's-box', streamEpoch: 'epoch-box' });
  });

  it('announces a session whose frames move to another daemon', async () => {
    const main = fakeDaemon('epoch-main');
    const sandbox = fakeDaemon('epoch-box');
    const pool = createPiDaemonPool({ getMainRuntime: () => main });
    pool.register('/work/a', { runtime: sandbox, directories: ['/work/a'] });
    const open = await start(pool);
    const stream = await open();

    main.emit('session.updated', 3, title('s-1', '/work/a', 'Before'));
    sandbox.emit('session.updated', 1, title('s-1', '/work/a', 'After'));
    await stream.until((frames) => frames.length >= 3);
    expect(stream.frames.map((f) => [f.name, f.streamEpoch])).toEqual([
      ['session.updated', 'epoch-main'], ['session.moved', undefined], ['session.updated', 'epoch-box'],
    ]);

    pool.announceMove('s-2', '/work/a');
    await stream.until((frames) => frames.length >= 4);
    expect(stream.frames[3]).toMatchObject({ name: 'session.moved', sessionId: 's-2', directory: '/work/a' });
  });

  it('still ends the connection when the main daemon subscription fails', async () => {
    const main = fakeDaemon('epoch-main');
    const sandbox = fakeDaemon('epoch-box');
    const pool = createPiDaemonPool({ getMainRuntime: () => main });
    pool.register('/work/a', { runtime: sandbox, directories: ['/work/a'] });
    const open = await start(pool);
    await open();

    main.fail();
    await tick();
    expect(main.open).toEqual([]);
    expect(sandbox.open).toEqual([]);
  });
});
