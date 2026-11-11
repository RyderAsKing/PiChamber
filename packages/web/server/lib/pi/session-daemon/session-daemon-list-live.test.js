import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
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

  it("lists a removed folder's sessions from the session store, and rejects a path that is not a folder", async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-list-live-'));
    await mkdir(join(root, 'agent'), { recursive: true });
    const removed = join(root, 'removed-worktree');
    const listedDirectories = [];
    const { daemon, endpoint } = await startDaemon(root, new FakeSession('unused'), async ({ cwd }) => {
      listedDirectories.push(cwd);
      return cwd === removed ? [{ ...diskRow(removed, 'orphan'), cwd: removed }] : [];
    });
    daemons.push(daemon);
    const client = connectClient(endpoint);
    sockets.push(client);
    await client.authenticate();

    const listed = await client.request('sessions.list', { directory: removed });
    expect(listed.error).toBeUndefined();
    expect(listed.result.sessions.map((item) => item.session.id)).toEqual(['orphan']);
    expect(listedDirectories).toContain(removed);

    // A failed request closes the connection with an error frame, so each case gets its own client.
    const rejects = async (directory) => {
      const other = connectClient(endpoint);
      sockets.push(other);
      await other.authenticate();
      other.socket.write(`${JSON.stringify({ protocolVersion: 1, kind: 'request', requestId: 'bad', command: 'sessions.list', payload: { directory } })}\n`);
      return (await other.next((message) => message.kind === 'error')).error.code;
    };
    const file = join(root, 'not-a-folder.txt');
    await writeFile(file, 'x');
    expect(await rejects(file)).toBe('INVALID_ARGUMENT');
    expect(await rejects('relative/folder')).toBe('INVALID_ARGUMENT');
    // A Windows client's home is not an absolute path on a POSIX server.
    if (process.platform !== 'win32') expect(await rejects('C:/Users/Someone')).toBe('INVALID_ARGUMENT');
  });

  it("deletes a removed folder's session from a freshly started daemon", async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-list-live-'));
    await mkdir(join(root, 'agent'), { recursive: true });
    const removed = join(root, 'removed-worktree');
    // The transcript lives in the session store; its folder is gone.
    const sessionFile = join(root, 'orphan.jsonl');
    await writeFile(sessionFile, `${JSON.stringify({ type: 'session', id: 'orphan', cwd: removed })}\n`);
    // A new daemon has never seen the folder, as after a restart.
    const { daemon, endpoint } = await startDaemon(root, new FakeSession('unused'), async ({ cwd }) => (
      cwd === removed ? [{ ...diskRow(root, 'orphan'), cwd: removed }] : []
    ));
    daemons.push(daemon);
    const client = connectClient(endpoint);
    sockets.push(client);
    await client.authenticate();

    const deleted = await client.request('sessions.delete', { sessionId: 'orphan', directory: removed });
    expect(deleted.error).toBeUndefined();
    await expect(stat(sessionFile)).rejects.toMatchObject({ code: 'ENOENT' });
    // The removed folder does not become a known project.
    const projects = await client.request('projects.list', {});
    expect(JSON.stringify(projects.result)).not.toContain('removed-worktree');
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

  it("a folder's catalog read lists no session, while a created empty session is still listed", async () => {
    // Switching folders reads that folder's catalogs, which starts a runtime
    // with a fresh, empty Pi session. Nobody asked for that session, so it
    // must not appear as an "Awaiting first prompt" row.
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-list-live-'));
    await mkdir(join(root, 'agent'), { recursive: true });
    const sessions = [];
    let created = 0;
    const endpoint = testDaemonEndpoint(root);
    const daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      agentDir: join(root, 'agent'),
      createRuntime: async () => {
        const session = new FakeSession(`session-${(created += 1)}`);
        sessions.push(session);
        return { session, async dispose() {} };
      },
      listSessions: async () => [],
    });
    await daemon.start();
    daemons.push(daemon);
    const client = connectClient(endpoint);
    sockets.push(client);
    await client.authenticate();
    const ids = async () => {
      const response = await client.request('sessions.list', { directory: root });
      expect(response.error).toBeUndefined();
      return response.result.sessions.map((row) => row.session.id);
    };

    const catalog = await client.request('extensions.list', { directory: root });
    expect(catalog.error).toBeUndefined();
    expect(sessions).toHaveLength(1);
    expect(await ids()).toEqual([]);

    // An explicitly created session is listed before its first prompt.
    const createdSession = await client.request('sessions.create', { cwd: root });
    expect(createdSession.error).toBeUndefined();
    expect(await ids()).toEqual([createdSession.result.session.id]);

    // An extension's session_start message, shown or hidden, lands in every
    // such session and does not make it a conversation.
    sessions[0].messages = [
      { role: 'custom', customType: 'greeting', content: 'hi', display: true, timestamp: 1 },
      { role: 'custom', customType: 'state', content: '', display: false, timestamp: 1 },
    ];
    expect(await ids()).toEqual([createdSession.result.session.id]);

    // The catalog session is listed once it holds a conversation.
    sessions[0].messages.push({ role: 'user', content: 'hello', timestamp: 2 });
    expect(new Set(await ids())).toEqual(new Set([sessions[0].sessionId, createdSession.result.session.id]));
  });

  it('prefers the resident runtime name over the disk name, including clears', async () => {
    const { session, list } = await setup();
    let liveName = 'Not yet flushed';
    session.sessionManager.getSessionName = () => liveName;
    let { byId } = await list();
    expect(byId.get('resident').session.title).toBe('Not yet flushed');
    expect(byId.get('disk-only').session.title).toBe('disk-only');
    liveName = undefined;
    ({ byId } = await list());
    // Cleared in Pi: the stale disk name must not win; no prompt to derive from.
    expect(byId.get('resident').session.title).toBeUndefined();
  });

  it('publishes an empty title when Pi clears the session name', async () => {
    const { session, client } = await setup();
    const cleared = client.next((message) => message.kind === 'event' && message.event === 'session.updated');
    session.emit({ type: 'session_info_changed', name: undefined });
    await expect(cleared).resolves.toMatchObject({ payload: { sessionId: 'resident', title: '' } });
  });
});
