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
    ? `\\\\.\\pipe\\pichamber-pi-daemon-list-live-test-${Math.random().toString(36).slice(2)}`
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

const startDaemon = async (root, session, listSessions) => {
  const endpoint = testDaemonEndpoint(root);
  const daemon = createSessionDaemon({
    endpoint,
    credential,
    cwd: root,
    agentDir: join(root, 'agent'),
    createRuntime: async () => ({ session, async dispose() {} }),
    listSessions,
  });
  await daemon.start();
  return { daemon, endpoint };
};

const diskRow = (root, id) => ({
  path: join(root, `${id}.jsonl`),
  id,
  cwd: root,
  name: id,
  created: new Date('2026-01-01T00:00:00.000Z'),
  modified: new Date('2026-01-02T00:00:00.000Z'),
  messageCount: 1,
});

// `sessions.list` joins each row to the connected daemon's resident runtime
// and reports its lifecycle as `live`, stamped with the event sequence it
// was sampled at. Disk-only rows carry no `live`: unknown, not idle.
describe('session daemon list live status', () => {
  const daemons = [];
  const sockets = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) await socket.close().catch(() => {});
    for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => {});
  });

  const setup = async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-list-live-'));
    await mkdir(join(root, 'agent'), { recursive: true });
    const session = new FakeSession('resident');
    const { daemon, endpoint } = await startDaemon(root, session, async () => [
      diskRow(root, 'disk-only'),
      diskRow(root, 'resident'),
    ]);
    daemons.push(daemon);
    const client = connectClient(endpoint);
    sockets.push(client);
    await client.authenticate();
    await client.request('sessions.create', { cwd: root });
    const list = async () => {
      const response = await client.request('sessions.list', { directory: root });
      const byId = new Map(response.result.sessions.map((row) => [row.session.id, row]));
      return { response, byId };
    };
    return { root, session, client, list };
  };

  it('reports idle for a resident runtime and nothing for a disk-only row', async () => {
    const { list } = await setup();
    const { response, byId } = await list();
    expect(byId.get('disk-only').live).toBeUndefined();
    expect(byId.get('resident').live).toEqual({
      lifecycle: 'idle',
      sequence: expect.any(Number),
      serverNow: expect.any(Number),
    });
    expect(typeof response.result.streamEpoch).toBe('string');
  });

  it('reports busy with the server run start, sampled after the lifecycle event', async () => {
    const { session, client, list } = await setup();
    const busy = client.next((message) => message.kind === 'event' && message.event === 'session.lifecycle');
    session.isStreaming = true;
    session.emit({ type: 'agent_start' });
    const event = await busy;
    const { byId } = await list();
    const live = byId.get('resident').live;
    expect(live.lifecycle).toBe('busy');
    expect(live.runStartedAt).toBe(event.payload.runStartedAt);
    expect(live.sequence).toBeGreaterThanOrEqual(event.sequence);
    expect(byId.get('disk-only').live).toBeUndefined();
  });

  it('reports retry with bounded retry info and no raw error fields', async () => {
    const { session, client, list } = await setup();
    const retry = client.next((message) => message.kind === 'event' && message.event === 'session.lifecycle' && message.payload.state === 'retry');
    session.isStreaming = true;
    session.emit({ type: 'auto_retry_start', attempt: 2, delayMs: 1000, errorMessage: 'rate limited' });
    await retry;
    const live = (await list()).byId.get('resident').live;
    expect(live.lifecycle).toBe('retry');
    expect(live.retry).toEqual({ attempt: 2, next: expect.any(Number), message: 'rate limited' });
    expect(Object.keys(live).sort()).toEqual(['lifecycle', 'retry', 'runStartedAt', 'sequence', 'serverNow']);
  });

  it('an unpersisted resident session is listed with its live status too', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-list-live-'));
    await mkdir(join(root, 'agent'), { recursive: true });
    const session = new FakeSession('fresh');
    const { daemon, endpoint } = await startDaemon(root, session, async () => []);
    daemons.push(daemon);
    const client = connectClient(endpoint);
    sockets.push(client);
    await client.authenticate();
    await client.request('sessions.create', { cwd: root });
    const response = await client.request('sessions.list', { directory: root });
    expect(response.result.sessions).toHaveLength(1);
    expect(response.result.sessions[0].live).toMatchObject({ lifecycle: 'idle' });
  });
});
