import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { createSessionDaemon } from './session-daemon.js';

const credential = 'a-private-daemon-credential';

class FakeSession {
  constructor(sessionId = 'pi-session-1', sessionFile) {
    this.sessionId = sessionId;
    this.isStreaming = false;
    this.listeners = new Set();
    this.names = [];
    this.sessionManager = {
      getSessionFile: () => sessionFile,
      getHeader: () => ({ timestamp: '2026-01-01T00:00:00.000Z' }),
      getEntries: () => [],
      getLeafId: () => 'fake-entry',
      appendSessionInfo: (name) => this.names.push(name),
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
}

class FakeRuntime {
  constructor({ cwd, session }) {
    this.cwd = cwd;
    this.session = session;
    this.rebindSession = undefined;
    this.disposed = false;
  }

  setRebindSession(rebindSession) {
    this.rebindSession = rebindSession;
  }

  async replaceSession(session) {
    this.session = session;
    await this.rebindSession?.(session);
  }

  async newSession() {
    const session = new FakeSession('pi-session-new');
    this.session = session;
    await this.rebindSession?.(session);
    return { cancelled: false };
  }

  async dispose() {
    this.disposed = true;
  }
}

function connectClient(endpoint) {
  const socket = createConnection(endpoint);
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const messages = [];
  const waiters = [];

  const publish = (message) => {
    messages.push(message);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter.predicate(message)) {
        waiters.splice(index, 1);
        waiter.resolve(message);
      }
    }
  };

  socket.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line) publish(JSON.parse(line));
    }
  });
  socket.on('close', () => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error('Daemon connection closed'));
  });

  const next = (predicate) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index !== -1) waiters.splice(index, 1);
        reject(new Error('Timed out waiting for daemon message'));
      }, 1_000);
      waiters.push({
        predicate,
        reject,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  };

  return {
    socket,
    async authenticate(value = credential) {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write(`${JSON.stringify({ kind: 'authenticate', credential: value })}\n`);
      await next((message) => message.kind === 'authenticated');
      return next((message) => message.kind === 'event' && message.event === 'session.snapshot');
    },
    request(command, payload = {}) {
      const requestId = `request-${Math.random()}`;
      socket.write(`${JSON.stringify({ protocolVersion: 1, kind: 'request', requestId, command, payload })}\n`);
      return next((message) => message.kind === 'response' && message.requestId === requestId);
    },
    next,
    async close() {
      socket.end();
      await new Promise((resolve) => socket.once('close', resolve));
    },
  };
}

describe('Pi session daemon spike', () => {
  let daemon;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
  });

  it('uses the selected cwd and agent directory, restricts its Unix socket, and retains event sequencing across a client reconnect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-'));
    const endpoint = join(root, 'daemon.sock');
    const session = new FakeSession();
    const runtimeCalls = [];

    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: join(root, 'project'),
      agentDir: join(root, 'agent'),
      createRuntime: async (options) => {
        runtimeCalls.push(options);
        return {
          session,
          async dispose() {},
        };
      },
    });
    await daemon.start();

    expect(runtimeCalls).toEqual([{ cwd: join(root, 'project'), agentDir: join(root, 'agent') }]);
    expect((await stat(endpoint)).mode & 0o777).toBe(0o600);

    const firstClient = connectClient(endpoint);
    const firstSnapshot = await firstClient.authenticate();
    expect(firstSnapshot.payload.sessionId).toBe('pi-session-1');
    const health = await firstClient.request('runtime.health');
    expect(health.result).toMatchObject({ state: 'ready', sessionId: 'pi-session-1' });
    await firstClient.close();

    const reconnectingClient = connectClient(endpoint);
    const reconnectSnapshot = await reconnectingClient.authenticate();
    const messageStart = reconnectingClient.next((message) => message.event === 'assistant.message.start');
    const delta = reconnectingClient.next((message) => message.event === 'assistant.message.delta');
    const messageEnd = reconnectingClient.next((message) => message.event === 'assistant.message.end');
    const toolStart = reconnectingClient.next((message) => message.event === 'session.tool.start');
    session.emit({ type: 'message_start', message: { role: 'assistant', timestamp: 1, provider: 'test', model: 'model' } });
    session.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'still running' },
    });
    session.emit({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read' });
    session.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'still running' }] } });

    await expect(delta).resolves.toMatchObject({
      payload: { sessionId: 'pi-session-1', contentIndex: 0, delta: 'still running' },
    });
    await expect(messageStart).resolves.toMatchObject({
      payload: { sessionId: 'pi-session-1', directory: join(root, 'project'), role: 'assistant', model: { providerId: 'test', modelId: 'model' } },
    });
    await expect(toolStart).resolves.toMatchObject({
      payload: { sessionId: 'pi-session-1', toolCallId: 'tool-1', toolName: 'read' },
    });
    await expect(messageEnd).resolves.toMatchObject({ payload: { sessionId: 'pi-session-1', text: 'still running' } });
    expect((await delta).sequence).toBeGreaterThan(reconnectSnapshot.sequence);
    await reconnectingClient.close();
  });

  it('lists only validated cwd-scoped sessions without exposing Pi JSONL paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-'));
    const endpoint = join(root, 'daemon.sock');
    const listed = [];
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      createRuntime: async () => ({ session: new FakeSession(), async dispose() {} }),
      listSessions: async (options) => {
        listed.push(options);
        return [{
          path: join(root, 'session.jsonl'),
          id: 'pi-session-1',
          cwd: root,
          name: 'Pi session',
          created: new Date('2026-01-01T00:00:00.000Z'),
          modified: new Date('2026-01-02T00:00:00.000Z'),
          messageCount: 3,
          firstMessage: 'Keep this preview',
        }];
      },
    });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();
    await expect(client.request('sessions.list', { directory: root })).resolves.toMatchObject({
      result: {
        sessions: [{
          session: {
            id: 'pi-session-1',
            directory: root,
            title: 'Pi session',
            messageCount: 3,
          },
          preview: 'Keep this preview',
          updatedAt: Date.parse('2026-01-02T00:00:00.000Z'),
        }],
      },
    });
    expect(listed).toEqual([{ cwd: root, agentDir: expect.any(String) }]);
    expect(JSON.stringify((await client.request('sessions.list')).result)).not.toContain('session.jsonl');
    await client.close();
  });

  it('renames active and persisted sessions without exposing their JSONL paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-'));
    const endpoint = join(root, 'daemon.sock');
    const persistedSessionFile = join(root, 'persisted.jsonl');
    await writeFile(persistedSessionFile, `{"type":"session","id":"pi-session-persisted","cwd":"${root}"}\n`);
    const activeSession = new FakeSession('pi-session-active');
    const renamed = [];
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      createRuntime: async () => new FakeRuntime({ cwd: root, session: activeSession }),
      listSessions: async () => [{
        path: persistedSessionFile,
        id: 'pi-session-persisted',
        cwd: root,
        created: new Date('2026-01-01T00:00:00.000Z'),
        modified: new Date('2026-01-01T00:00:01.000Z'),
        messageCount: 1,
        firstMessage: 'stored',
      }],
      renamePersistedSession: ({ sessionFile, title }) => renamed.push({ sessionFile, title }),
    });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();
    await expect(client.request('sessions.rename', { sessionId: 'pi-session-active', title: '  Active title  ' })).resolves.toMatchObject({ result: {} });
    await expect(client.request('sessions.rename', { sessionId: 'pi-session-persisted', title: 'Persisted title' })).resolves.toMatchObject({ result: {} });
    expect(activeSession.names).toEqual(['Active title']);
    expect(renamed).toEqual([{ sessionFile: persistedSessionFile, title: 'Persisted title' }]);
    await client.close();
  });

  it('creates and selects a persisted Pi session with supported creation metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-'));
    const endpoint = join(root, 'daemon.sock');
    const runtime = new FakeRuntime({ cwd: root, session: new FakeSession('pi-session-old') });
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      createRuntime: async () => runtime,
      listSessions: async () => [{
        path: join(root, 'new-session.jsonl'),
        id: runtime.session.sessionId,
        cwd: root,
        created: new Date('2026-01-01T00:00:00.000Z'),
        modified: new Date('2026-01-01T00:00:01.000Z'),
        messageCount: 0,
        firstMessage: '',
      }],
    });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();
    await expect(client.request('sessions.create', { cwd: root })).resolves.toMatchObject({
      result: {
        session: { id: 'pi-session-new', directory: root, messageCount: 0 },
        messages: [],
      },
    });
    await expect(client.request('sessions.create', { cwd: root, title: 'Named session' })).resolves.toMatchObject({
      result: { session: { id: 'pi-session-new', directory: root } },
    });
    client.socket.destroy();
  });

  it('disposes an idle runtime without deleting its Pi JSONL and restores it on demand', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-'));
    const endpoint = join(root, 'daemon.sock');
    const sessionFile = join(root, 'session.jsonl');
    await writeFile(sessionFile, `{"type":"session","id":"pi-session-1","cwd":"${root}"}\n`);
    const firstRuntime = new FakeRuntime({
      cwd: root,
      session: new FakeSession('pi-session-1', sessionFile),
    });
    const restoredRuntime = new FakeRuntime({
      cwd: root,
      session: new FakeSession('pi-session-1', sessionFile),
    });
    const runtimeCalls = [];
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      idleTimeoutMs: 10,
      createRuntime: async (options) => {
        runtimeCalls.push(options);
        return runtimeCalls.length === 1 ? firstRuntime : restoredRuntime;
      },
    });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();
    firstRuntime.session.emit({ type: 'agent_settled' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(firstRuntime.disposed).toBe(true);
    await expect(stat(sessionFile)).resolves.toMatchObject({ isFile: expect.any(Function) });

    await client.request('sessions.prompt', { text: 'resume after idle' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtimeCalls).toEqual([
      { cwd: root, agentDir: expect.any(String) },
      { cwd: root, agentDir: expect.any(String), sessionFile },
    ]);
    await client.close();
  });

  it('rebinds daemon events to the replacement Pi session identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-'));
    const endpoint = join(root, 'daemon.sock');
    const firstSession = new FakeSession('pi-session-1');
    const runtime = new FakeRuntime({ cwd: root, session: firstSession });
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      createRuntime: async () => runtime,
    });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();
    const replacementSession = new FakeSession('pi-session-2');
    await runtime.replaceSession(replacementSession);
    firstSession.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'stale' },
    });
    const delta = client.next((message) => message.event === 'assistant.message.delta');
    replacementSession.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'current' },
    });

    await expect(delta).resolves.toMatchObject({
      payload: { sessionId: 'pi-session-2', contentIndex: 0, delta: 'current' },
    });
    await client.close();
  });

  it('rejects non-local endpoints and unauthenticated clients before a request can reach the runtime', async () => {
    expect(() => createSessionDaemon({
      endpoint: 'http://127.0.0.1:3000',
      credential,
      cwd: '/workspace',
    })).toThrow('endpoint must be local');

    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-'));
    const endpoint = join(root, 'daemon.sock');
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      createRuntime: async () => ({
        session: new FakeSession(),
        async dispose() {},
      }),
    });
    await daemon.start();

    const client = connectClient(endpoint);
    await expect(client.authenticate('incorrect-credential')).rejects.toThrow('Daemon connection closed');
  });

  it('does not unlink an existing endpoint and disposes the runtime when startup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-'));
    const endpoint = join(root, 'daemon.sock');
    await writeFile(endpoint, 'not a daemon socket');
    let disposed = false;
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      createRuntime: async () => ({
        session: new FakeSession(),
        async dispose() { disposed = true; },
      }),
    });

    await expect(daemon.start()).rejects.toThrow('endpoint already exists');
    expect(disposed).toBe(true);
  });

  it('creates a Pi SDK session with a disposable normal agent directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-sdk-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const endpoint = join(root, 'daemon.sock');
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const previousOffline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = '1';
    try {
      daemon = createSessionDaemon({ endpoint, credential, cwd, agentDir });
      await daemon.start();
      const client = connectClient(endpoint);
      await client.authenticate();
      const health = await client.request('runtime.health');
      expect(health.result).toMatchObject({
        state: 'ready',
        capabilities: expect.arrayContaining(['projects.list', 'projects.select', 'sessions.list', 'sessions.create', 'sessions.open', 'sessions.rename', 'sessions.delete', 'sessions.tree', 'sessions.navigate', 'sessions.fork', 'sessions.clone', 'sessions.prompt', 'sessions.steer', 'sessions.followUp', 'sessions.abort', 'sessions.setModel', 'sessions.setThinking', 'sessions.compact']),
      });
      expect(health.result.sessionId).toEqual(expect.any(String));
      const created = await client.request('sessions.create', { cwd });
      expect(created.result).toMatchObject({
        session: { id: expect.any(String), directory: cwd, messageCount: 0 },
        messages: [],
      });
      await client.close();
    } finally {
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
    }
  });
});
