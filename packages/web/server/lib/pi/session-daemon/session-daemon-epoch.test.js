import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { createSessionDaemon } from './session-daemon.js';

const credential = 'a-private-daemon-credential';

class FakeSession {
  constructor(sessionId = 'pi-session-1') {
    this.sessionId = sessionId;
    this.isStreaming = false;
    this.listeners = new Set();
    this.entries = [];
    this.model = { provider: 'test', id: 'model' };
    this.thinkingLevel = 'low';
    this.sessionManager = {
      getSessionFile: () => undefined,
      getHeader: () => ({ timestamp: '2026-01-01T00:00:00.000Z' }),
      getEntries: () => this.entries,
      getEntry: (id) => this.entries.find((entry) => entry.id === id),
      getLeafId: () => 'fake-entry',
      getTree: () => [],
      appendSessionInfo: () => undefined,
      getSessionName: () => undefined,
    };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  async prompt() {}

  async sendUserMessage() {}

  async abort() {}

  async compact() {}

  getSteeringMessages() { return []; }

  getFollowUpMessages() { return []; }
}

function testDaemonEndpoint(root) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\pichamber-pi-daemon-epoch-test-${Math.random().toString(36).slice(2)}`
    : join(root, 'daemon.sock');
}

function connectClient(endpoint) {
  const socket = createConnection(endpoint);
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const messages = [];
  const waiters = [];

  socket.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      messages.push(message);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index];
        if (waiter.predicate(message)) {
          waiters.splice(index, 1);
          waiter.resolve(message);
        }
      }
    }
  });

  const next = (predicate) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index !== -1) waiters.splice(index, 1);
        reject(new Error('Timed out waiting for daemon message'));
      }, 2_000);
      waiters.push({ predicate, reject, resolve: (message) => { clearTimeout(timer); resolve(message); } });
    });
  };

  let closed = false;
  return {
    socket,
    async authenticate({ fromSequence, streamEpoch } = {}) {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write(`${JSON.stringify({
        kind: 'authenticate',
        credential,
        ...(fromSequence !== undefined ? { fromSequence } : {}),
        ...(streamEpoch ? { streamEpoch } : {}),
      })}\n`);
      await next((message) => message.kind === 'authenticated');
    },
    request(command, payload = {}) {
      const requestId = `request-${Math.random()}`;
      socket.write(`${JSON.stringify({ protocolVersion: 1, kind: 'request', requestId, command, payload })}\n`);
      return next((message) => message.kind === 'response' && message.requestId === requestId);
    },
    next,
    async close() {
      if (closed) return;
      closed = true;
      socket.end();
      await new Promise((resolve) => {
        if (socket.destroyed) { resolve(); return; }
        socket.once('close', resolve);
        setTimeout(resolve, 250);
      });
    },
  };
}

const startDaemon = async (root, session) => {
  const endpoint = testDaemonEndpoint(root);
  const daemon = createSessionDaemon({
    endpoint,
    credential,
    cwd: root,
    agentDir: join(root, 'agent'),
    createRuntime: async () => ({ session, async dispose() {} }),
  });
  await daemon.start();
  return { daemon, endpoint };
};

describe('session daemon stream epoch', () => {
  const daemons = [];
  const sockets = [];

  const track = async (root, session) => {
    const started = await startDaemon(root, session);
    daemons.push(started.daemon);
    return started;
  };

  afterEach(async () => {
    for (const socket of sockets.splice(0)) await socket.close().catch(() => {});
    for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => {});
  });

  it('stamps a stable opaque streamEpoch on health, snapshots, events, and session reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-epoch-'));
    await mkdir(join(root, 'agent'), { recursive: true });
    const session = new FakeSession();
    const { endpoint } = await track(root, session);

    const client = connectClient(endpoint);
    sockets.push(client);
    await client.authenticate();
    const snapshot = await client.next((message) => message.kind === 'event' && message.event === 'session.snapshot');
    // Register the injected runtime so live session events are published.
    await client.request('sessions.create', { cwd: root });

    expect(typeof snapshot.streamEpoch).toBe('string');
    expect(snapshot.streamEpoch.length).toBeGreaterThanOrEqual(16);
    expect(snapshot.streamEpoch).not.toMatch(/pi-session|credential|agent/);
    expect(snapshot.payload.resync).toBeUndefined();

    const health = await client.request('runtime.health');
    expect(health.result.streamEpoch).toBe(snapshot.streamEpoch);
    expect(health.result.capabilities).toContain('events.streamEpoch');

    const eventPromise = client.next((message) => message.kind === 'event' && message.event === 'session.updated');
    session.emit({ type: 'session_info_changed', name: 'renamed' });
    const event = await eventPromise;
    expect(event.streamEpoch).toBe(snapshot.streamEpoch);

    const opened = await client.request('sessions.open', { sessionId: session.sessionId, cwd: root });
    expect(opened.result.streamEpoch).toBe(snapshot.streamEpoch);
  });

  it('replays contiguously at the same epoch without a resync snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-epoch-'));
    await mkdir(join(root, 'agent'), { recursive: true });
    const session = new FakeSession();
    const { endpoint } = await track(root, session);

    const first = connectClient(endpoint);
    sockets.push(first);
    await first.authenticate();
    const snapshot = await first.next((message) => message.kind === 'event' && message.event === 'session.snapshot');
    await first.request('sessions.create', { cwd: root });
    const renamed = first.next((message) => message.kind === 'event' && message.event === 'session.updated');
    session.emit({ type: 'session_info_changed', name: 'one' });
    const renameEvent = await renamed;

    // Reconnect from the rename cursor, stamping the cursor's stream epoch:
    // the retained suffix replays without a snapshot, and the epoch is
    // unchanged.
    const second = connectClient(endpoint);
    sockets.push(second);
    await second.authenticate({ fromSequence: renameEvent.sequence, streamEpoch: snapshot.streamEpoch });
    session.emit({ type: 'session_info_changed', name: 'two' });
    const replayed = await second.next((message) => message.kind === 'event');
    expect(replayed.event).toBe('session.updated');
    expect(replayed.payload.title).toBe('two');
    expect(replayed.streamEpoch).toBe(snapshot.streamEpoch);
    expect(replayed.sequence).toBeGreaterThan(renameEvent.sequence);
  });

  it('a restart changes the epoch and a stale cursor resyncs from a lower snapshot baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-epoch-'));
    await mkdir(join(root, 'agent'), { recursive: true });
    const firstSession = new FakeSession();
    const first = await track(root, firstSession);

    const oldClient = connectClient(first.endpoint);
    sockets.push(oldClient);
    await oldClient.authenticate();
    const oldSnapshot = await oldClient.next((message) => message.kind === 'event' && message.event === 'session.snapshot');
    await oldClient.request('sessions.create', { cwd: root });
    const renameWait = oldClient.next((message) => message.kind === 'event' && message.event === 'session.updated');
    firstSession.emit({ type: 'session_info_changed', name: 'before restart' });
    const renameEvent = await renameWait;
    expect(renameEvent.sequence).toBeGreaterThan(oldSnapshot.sequence);
    const oldEpoch = renameEvent.streamEpoch;

    // Restart: a brand new daemon process owns the endpoint's role. Its
    // sequence space starts over, so the old epoch must differ and the old
    // cursor must be unreplayable.
    await oldClient.close();
    await first.daemon.stop();
    const secondSession = new FakeSession();
    const second = await startDaemon(root, secondSession);
    daemons.push(second.daemon);

    const newClient = connectClient(second.endpoint);
    sockets.push(newClient);
    // The client stamps its cursor with the retired epoch, so the daemon can
    // tell the sequence space reset even before looking at the numbers.
    await newClient.authenticate({ fromSequence: renameEvent.sequence, streamEpoch: oldEpoch });
    const resyncSnapshot = await newClient.next((message) => message.kind === 'event');
    expect(resyncSnapshot.event).toBe('session.snapshot');
    expect(resyncSnapshot.payload.resync).toBe(true);
    expect(resyncSnapshot.streamEpoch).toBeTruthy();
    expect(resyncSnapshot.streamEpoch).not.toBe(oldEpoch);
    expect(resyncSnapshot.sequence).toBeLessThan(renameEvent.sequence);
    expect(resyncSnapshot.payload.lastSequence).toBeLessThan(renameEvent.sequence);

    // Register the restarted runtime so live session events are published.
    await newClient.request('sessions.create', { cwd: root });

    // Live events after the resync share the new epoch and grow from the
    // lower baseline.
    const liveWait = newClient.next((message) => message.kind === 'event' && message.event === 'session.updated');
    secondSession.emit({ type: 'session_info_changed', name: 'after restart' });
    const live = await liveWait;
    expect(live.streamEpoch).toBe(resyncSnapshot.streamEpoch);
    expect(live.sequence).toBeGreaterThan(resyncSnapshot.sequence);
  });

  it('rejects a replay cursor without its stream epoch as a protocol mismatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-epoch-'));
    await mkdir(join(root, 'agent'), { recursive: true });
    const session = new FakeSession();
    const { endpoint } = await track(root, session);

    const first = connectClient(endpoint);
    sockets.push(first);
    await first.authenticate();
    const snapshot = await first.next((message) => message.kind === 'event' && message.event === 'session.snapshot');
    await first.request('sessions.create', { cwd: root });
    const renameWait = first.next((message) => message.kind === 'event' && message.event === 'session.updated');
    session.emit({ type: 'session_info_changed', name: 'one' });
    const renameEvent = await renameWait;

    // An old client reconnects with a replayable cursor but cannot epoch-
    // verify it (no streamEpoch marker). The daemon must reject the resume
    // rather than silently replaying or substituting a snapshot.
    const legacy = connectClient(endpoint);
    sockets.push(legacy);
    await legacy.authenticate({ fromSequence: renameEvent.sequence });
    const legacyFrame = await legacy.next((message) => message.kind === 'error');
    expect(legacyFrame.error).toEqual({ code: 'DAEMON_PROTOCOL_MISMATCH' });
    expect(snapshot.streamEpoch).toBeTruthy();
  });

  it('a new daemon whose sequence overtook the old cursor resyncs instead of replaying the wrong window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-epoch-'));
    await mkdir(join(root, 'agent'), { recursive: true });
    const firstSession = new FakeSession();
    const first = await track(root, firstSession);

    const oldClient = connectClient(first.endpoint);
    sockets.push(oldClient);
    await oldClient.authenticate();
    await oldClient.next((message) => message.kind === 'event' && message.event === 'session.snapshot');
    await oldClient.request('sessions.create', { cwd: root });
    const renameWait = oldClient.next((message) => message.kind === 'event' && message.event === 'session.updated');
    firstSession.emit({ type: 'session_info_changed', name: 'before restart' });
    const renameEvent = await renameWait;
    const oldEpoch = renameEvent.streamEpoch;
    const oldCursor = renameEvent.sequence;
    await oldClient.close();
    await first.daemon.stop();

    // The restarted daemon emits several events, so its new sequence space
    // numerically OVERTAKES the old client's cursor before it reconnects.
    const secondSession = new FakeSession();
    const second = await startDaemon(root, secondSession);
    daemons.push(second.daemon);
    const warmup = connectClient(second.endpoint);
    sockets.push(warmup);
    await warmup.authenticate();
    await warmup.request('sessions.create', { cwd: root });
    for (let index = 0; index < Math.max(4, oldCursor + 2); index += 1) {
      const wait = warmup.next((message) => message.kind === 'event' && message.event === 'session.updated');
      secondSession.emit({ type: 'session_info_changed', name: `warmup-${index}` });
      await wait;
    }
    const warmupState = await warmup.request('runtime.health');
    const newEpoch = warmupState.result.streamEpoch;
    expect(newEpoch).not.toBe(oldEpoch);

    // The old cursor is numerically replayable on the new daemon, but the
    // epoch marker proves it belongs to the retired sequence space: the
    // daemon must resync rather than replay events 1..cursor of the new
    // epoch the client never saw.
    const returning = connectClient(second.endpoint);
    sockets.push(returning);
    await returning.authenticate({ fromSequence: oldCursor, streamEpoch: oldEpoch });
    const resync = await returning.next((message) => message.kind === 'event');
    expect(resync.event).toBe('session.snapshot');
    expect(resync.payload.resync).toBe(true);
    expect(resync.streamEpoch).toBe(newEpoch);
  });
});
