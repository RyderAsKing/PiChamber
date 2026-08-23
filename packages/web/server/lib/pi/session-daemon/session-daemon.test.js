import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { createMessageEntryAliases } from './message-entry-aliases.js';
import { createSessionDaemon, isLocalSessionDaemonEndpoint } from './session-daemon.js';

const credential = 'a-private-daemon-credential';

class FakeSession {
  constructor(sessionId = 'pi-session-1', sessionFile) {
    this.sessionId = sessionId;
    this.isStreaming = false;
    this.listeners = new Set();
    this.names = [];
    this.entries = [];
    this.sent = [];
    this.aborted = 0;
    this.compacted = 0;
    this.model = { provider: 'test', id: 'model' };
    this.thinkingLevel = 'low';
    this.providerAuthenticated = true;
    this.modelRuntime = {
      getModel: (providerId, modelId) => ({ provider: providerId, id: modelId }),
      getModels: () => [{ provider: 'test', id: 'model', name: 'Test model', contextWindow: 128_000, reasoning: true, thinkingLevelMap: { low: 1, high: null } }],
      getProvider: (providerId) => providerId === 'test' ? ({ name: 'Test provider' }) : undefined,
      getProviderAuthStatus: () => ({ configured: this.providerAuthenticated }),
      login: async (_providerId, type, interaction) => {
        if (type === 'api_key') this.lastApiKey = await interaction.prompt({ type: 'secret', message: 'Key' });
        else {
          interaction.notify({ type: 'device_code', userCode: 'CODE', verificationUri: 'https://example.test/device' });
          this.lastOAuthCode = await interaction.prompt({ type: 'manual_code', message: 'Paste code' });
        }
        this.providerAuthenticated = true;
      },
      logout: async () => { this.providerAuthenticated = false; },
    };
    this.sessionManager = {
      getSessionFile: () => sessionFile,
      getHeader: () => ({ timestamp: '2026-01-01T00:00:00.000Z' }),
      getEntries: () => this.entries,
      getEntry: (id) => this.entries.find((entry) => entry.id === id),
      getLeafId: () => 'fake-entry',
      getTree: () => [{ entry: { id: 'fake-entry', parentId: undefined, timestamp: '2026-01-01T00:00:00.000Z' }, children: [] }],
      appendSessionInfo: (name) => this.names.push(name),
      getSessionName: () => this.names[this.names.length - 1],
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

  async sendUserMessage(text, options) { this.sent.push({ text, options }); }

  async setModel(model) { this.model = model; }

  setThinkingLevel(thinking) { this.thinkingLevel = thinking; }

  async abort() { this.aborted += 1; this.isStreaming = false; }

  async compact() { this.compacted += 1; }

  async navigateTree(messageId) { this.navigatedTo = messageId; return { cancelled: false }; }

  getSteeringMessages() { return []; }

  getFollowUpMessages() { return []; }
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

  async newSession({ setup } = {}) {
    const session = new FakeSession('pi-session-new');
    await setup?.(session.sessionManager);
    this.session = session;
    await this.rebindSession?.(session);
    return { cancelled: false };
  }

  async switchSession() {
    const session = new FakeSession('pi-session-persisted');
    this.session = session;
    await this.rebindSession?.(session);
    return { cancelled: false };
  }

  async fork() {
    const session = new FakeSession('pi-session-forked');
    this.session = session;
    await this.rebindSession?.(session);
    return { cancelled: false };
  }

  async dispose() {
    this.disposed = true;
  }
}

function testDaemonEndpoint(root) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\pichamber-test-${createHash('sha1').update(root).digest('hex').slice(0, 16)}`;
  }
  return join(root, 'daemon.sock');
}

function connectClient(endpoint) {
  const socket = createConnection({ path: endpoint });
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
    async authenticate(value = credential, { sessionId, fromSequence } = {}) {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write(`${JSON.stringify({ kind: 'authenticate', credential: value, ...(sessionId ? { sessionId } : {}), ...(fromSequence !== undefined ? { fromSequence } : {}) })}\n`);
      await next((message) => message.kind === 'authenticated');
      if (fromSequence !== undefined) return undefined;
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
    const endpoint = testDaemonEndpoint(root);
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const session = new FakeSession();
    const runtimeCalls = [];

    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: projectDir,
      agentDir,
      createRuntime: async (options) => {
        runtimeCalls.push(options);
        return {
          session,
          async dispose() {},
        };
      },
    });
    await daemon.start();

    expect(runtimeCalls).toEqual([]);
    if (process.platform !== 'win32') {
      expect((await stat(endpoint)).mode & 0o777).toBe(0o600);
    }

    const firstClient = connectClient(endpoint);
    const firstSnapshot = await firstClient.authenticate();
    expect(firstSnapshot.payload.directory).toBe(projectDir);
    await firstClient.request('sessions.create', { cwd: projectDir });
    const health = await firstClient.request('runtime.health');
    expect(health.result).toMatchObject({ state: 'ready', sessionId: 'pi-session-1' });
    await firstClient.close();

    const reconnectingClient = connectClient(endpoint);
    const reconnectSnapshot = await reconnectingClient.authenticate();
    const userStartPromise = reconnectingClient.next((message) => message.event === 'assistant.message.start' && message.payload?.role === 'user');
    session.emit({ type: 'message_start', message: { role: 'user', timestamp: 0, content: 'hello' } });
    const userStart = await userStartPromise;
    const messageStart = reconnectingClient.next((message) => message.event === 'assistant.message.start' && message.payload?.role === 'assistant');
    const delta = reconnectingClient.next((message) => message.event === 'assistant.message.delta');
    const messageEnd = reconnectingClient.next((message) => message.event === 'assistant.message.end');
    const toolStart = reconnectingClient.next((message) => message.event === 'session.tool.start');
    session.emit({ type: 'message_start', message: { role: 'assistant', timestamp: 1, provider: 'test', model: 'model' } });
    session.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'still running' },
    });
    session.emit({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'file.txt' } });
    const toolEnd = reconnectingClient.next((message) => message.event === 'session.tool.end');
    session.emit({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'read', result: { content: [{ type: 'text', text: 'file contents' }] }, isError: false });
    session.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'still running' }] } });

    await expect(delta).resolves.toMatchObject({
      payload: { sessionId: 'pi-session-1', contentIndex: 0, delta: 'still running' },
    });
    await expect(messageStart).resolves.toMatchObject({
      payload: {
        sessionId: 'pi-session-1', directory: projectDir, role: 'assistant', parentId: userStart.payload.messageId,
        model: { providerId: 'test', modelId: 'model' },
      },
    });
    await expect(toolStart).resolves.toMatchObject({
      payload: { sessionId: 'pi-session-1', toolCallId: 'tool-1', toolName: 'read', input: { path: 'file.txt' }, startedAt: expect.any(Number) },
    });
    await expect(toolEnd).resolves.toMatchObject({
      payload: { sessionId: 'pi-session-1', toolCallId: 'tool-1', state: 'completed', output: 'file contents', endedAt: expect.any(Number) },
    });
    await expect(messageEnd).resolves.toMatchObject({ payload: { sessionId: 'pi-session-1', text: 'still running' } });
    expect((await delta).sequence).toBeGreaterThan(reconnectSnapshot.sequence);
    await reconnectingClient.close();
  });

  it('replays a contiguous reconnect gap and sends a snapshot when the cursor predates retained events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-'));
    const endpoint = testDaemonEndpoint(root);
    const session = new FakeSession();
    daemon = createSessionDaemon({ endpoint, credential, cwd: root, createRuntime: async () => ({ session, async dispose() {} }) });
    await daemon.start();

    const first = connectClient(endpoint);
    const snapshot = await first.authenticate();
    await first.request('sessions.create', { cwd: root });
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'replay' } });
    const delta = await first.next((frame) => frame.event === 'assistant.message.delta');
    await first.close();

    const replay = connectClient(endpoint);
    await replay.authenticate(credential, { sessionId: 'pi-session-1', fromSequence: snapshot.sequence });
    await expect(replay.next((frame) => frame.event === 'assistant.message.delta')).resolves.toMatchObject({ sequence: delta.sequence, payload: { delta: 'replay' } });
    await replay.close();

    const stale = connectClient(endpoint);
    await stale.authenticate(credential, { sessionId: 'pi-session-1', fromSequence: 0 });
    await expect(stale.next((frame) => frame.event === 'session.snapshot')).resolves.toMatchObject({ payload: { lastSequence: expect.any(Number) } });
    await stale.close();
  });

  it('keeps existing and late-joining device streams independent during one turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-multi-client-'));
    const endpoint = testDaemonEndpoint(root);
    const session = new FakeSession();
    session.isStreaming = true;
    session.messages = [{
      role: 'assistant',
      content: [{ type: 'text', text: 'half' }],
      provider: 'test',
      model: 'model',
      timestamp: 1_000,
    }];
    daemon = createSessionDaemon({ endpoint, credential, cwd: root, createRuntime: async () => ({ session, async dispose() {} }) });
    await daemon.start();

    const first = connectClient(endpoint);
    await first.authenticate();
    await first.request('sessions.create', { cwd: root });
    const detail = await first.request('sessions.open', { sessionId: 'pi-session-1', cwd: root });
    expect(detail.result).toMatchObject({
      isStreaming: true,
      lifecycle: 'busy',
      lastSequence: expect.any(Number),
      messages: [expect.objectContaining({ parts: [expect.objectContaining({ text: 'half' })] })],
    });

    const late = connectClient(endpoint);
    await late.authenticate(credential, {
      sessionId: 'pi-session-1',
      fromSequence: detail.result.lastSequence,
    });
    const firstDelta = first.next((frame) => frame.event === 'assistant.message.delta');
    const lateDelta = late.next((frame) => frame.event === 'assistant.message.delta');
    session.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' plus the rest' },
    });
    const [firstDeltaFrame, lateDeltaFrame] = await Promise.all([firstDelta, lateDelta]);
    expect(firstDeltaFrame.sequence).toBe(lateDeltaFrame.sequence);
    expect(lateDeltaFrame.payload.delta).toBe(' plus the rest');

    const firstIdle = first.next((frame) => frame.event === 'session.lifecycle' && frame.payload?.state === 'idle');
    const lateIdle = late.next((frame) => frame.event === 'session.lifecycle' && frame.payload?.state === 'idle');
    session.isStreaming = false;
    session.emit({ type: 'agent_settled' });
    const [firstIdleFrame, lateIdleFrame] = await Promise.all([firstIdle, lateIdle]);
    expect(firstIdleFrame.sequence).toBe(lateIdleFrame.sequence);
    expect(firstIdleFrame.sequence).toBeGreaterThan(firstDeltaFrame.sequence);

    await late.close();
    await first.close();
  });

  it('lists only validated cwd-scoped sessions without exposing Pi JSONL paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-'));
    const endpoint = testDaemonEndpoint(root);
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
        }, {
          path: join(root, 'unnamed-session.jsonl'),
          id: 'pi-session-unnamed',
          cwd: root,
          created: new Date('2026-01-03T00:00:00.000Z'),
          modified: new Date('2026-01-04T00:00:00.000Z'),
          messageCount: 1,
          firstMessage: 'Inspect this report\n\n[Attachment report.pdf is available at /tmp/pi-clipboard-7f7ec702-256a-4783-855c-df34e3ecedab.pdf]',
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
        }, {
          session: {
            id: 'pi-session-unnamed',
            directory: root,
            title: 'Inspect this report',
            messageCount: 1,
          },
          preview: 'Inspect this report\n\n[attachment]',
          updatedAt: Date.parse('2026-01-04T00:00:00.000Z'),
        }],
      },
    });
    await expect(client.request('sessions.list', { directory: root })).resolves.toMatchObject({
      result: {
        sessions: [
          { session: { id: 'pi-session-1', title: 'Pi session' } },
          { session: { id: 'pi-session-unnamed', title: 'Inspect this report' }, preview: 'Inspect this report\n\n[attachment]' },
        ],
      },
    });
    expect(listed).toEqual([
      { cwd: root, agentDir: expect.any(String) },
      { cwd: root, agentDir: expect.any(String) },
    ]);
    expect(JSON.stringify((await client.request('sessions.list')).result)).not.toContain('pi-clipboard-');
    expect(JSON.stringify((await client.request('sessions.list')).result)).not.toContain('session.jsonl');
    await client.close();
  });

  it('shares an in-flight sessions.list for the same directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-share-'));
    const endpoint = testDaemonEndpoint(root);
    const agentDir = join(root, 'agent');
    await mkdir(agentDir, { recursive: true });
    let calls = 0;
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      agentDir,
      createRuntime: async () => ({ session: new FakeSession(), async dispose() {} }),
      listSessions: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 80));
        return [{
          path: join(root, 'session.jsonl'),
          id: 'pi-session-1',
          cwd: root,
          created: new Date('2026-01-01T00:00:00.000Z'),
          modified: new Date('2026-01-02T00:00:00.000Z'),
        }];
      },
    });
    await daemon.start();

    const first = connectClient(endpoint);
    await first.authenticate();
    const second = connectClient(endpoint);
    await second.authenticate();
    const [left, right] = await Promise.all([
      first.request('sessions.list', { directory: root }),
      second.request('sessions.list', { directory: root }),
    ]);
    expect(calls).toBe(1);
    expect(left.result.sessions[0].session.id).toBe('pi-session-1');
    expect(right.result.sessions[0].session.id).toBe('pi-session-1');
    await first.close();
    await second.close();
  });

  it('shares an in-flight sessions.open for the same session id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-open-share-'));
    const endpoint = testDaemonEndpoint(root);
    const agentDir = join(root, 'agent');
    await mkdir(agentDir, { recursive: true });
    const sessionFile = join(root, 'session.jsonl');
    await writeFile(sessionFile, `{"type":"session","id":"pi-session-1","cwd":${JSON.stringify(root)}}\n`);
    let calls = 0;
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      agentDir,
      listSessions: async () => [{
        path: sessionFile,
        id: 'pi-session-1',
        cwd: root,
        created: new Date('2026-01-01T00:00:00.000Z'),
        modified: new Date('2026-01-02T00:00:00.000Z'),
      }],
      createRuntime: async (options) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 80));
        return new FakeRuntime({
          cwd: options.cwd,
          session: new FakeSession('pi-session-1', options.sessionFile),
        });
      },
    });
    await daemon.start();

    const first = connectClient(endpoint);
    await first.authenticate();
    const second = connectClient(endpoint);
    await second.authenticate();
    const [left, right] = await Promise.all([
      first.request('sessions.open', { sessionId: 'pi-session-1', directory: root }),
      second.request('sessions.open', { sessionId: 'pi-session-1', directory: root }),
    ]);
    expect(calls).toBe(1);
    expect(left.result.session.id).toBe('pi-session-1');
    expect(right.result.session.id).toBe('pi-session-1');
    await first.close();
    await second.close();
  });

  it('does not include in-memory sessions from another directory when listing a newly selected project directory', async () => {
    const rootA = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-a-'));
    const rootB = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-b-'));
    const endpoint = testDaemonEndpoint(rootA);
    const activeSessionA = new FakeSession('pi-session-a');
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: rootA,
      createRuntime: async ({ cwd }) => ({ cwd, session: cwd === rootA ? activeSessionA : new FakeSession('pi-session-b'), async dispose() {} }),
      listSessions: async ({ cwd }) => {
        if (cwd === rootA) {
          return [{
            path: join(rootA, 'session-a.jsonl'),
            id: 'pi-session-a',
            cwd: rootA,
            name: 'Session A',
            created: new Date('2026-01-01T00:00:00.000Z'),
            modified: new Date('2026-01-02T00:00:00.000Z'),
            messageCount: 1,
            firstMessage: 'Session in project A',
          }];
        }
        return [];
      },
    });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();

    await client.request('projects.select', { directory: rootA });
    const listA = await client.request('sessions.list', { directory: rootA });
    expect(listA.result.sessions).toHaveLength(1);
    expect(listA.result.sessions[0].session.directory).toBe(rootA);

    await client.request('projects.select', { directory: rootB });
    const listB = await client.request('sessions.list', { directory: rootB });
    expect(listB.result.sessions).toHaveLength(0);
    await client.close();
  });

  it('renames active and persisted sessions without exposing their JSONL paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-'));
    const endpoint = testDaemonEndpoint(root);
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
    await client.request('sessions.create', { cwd: root });
    await expect(client.request('sessions.rename', { sessionId: 'pi-session-new', title: '  Active title  ' })).resolves.toMatchObject({ result: {} });
    await expect(client.request('sessions.rename', { sessionId: 'pi-session-persisted', title: 'Persisted title' })).resolves.toMatchObject({ result: {} });
    expect(renamed).toEqual([{ sessionFile: persistedSessionFile, title: 'Persisted title' }]);
    await client.close();
  });

  it('publishes session.updated when a session is first prompted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-'));
    const endpoint = testDaemonEndpoint(root);
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      createRuntime: async () => new FakeRuntime({ cwd: root, session: new FakeSession('pi-session-old') }),
    });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();
    await client.request('sessions.create', { cwd: root });
    const promptedUpdated = client.next((frame) => frame.event === 'session.updated' && frame.payload?.title === 'Inspect this report');
    await client.request('sessions.prompt', { sessionId: 'pi-session-new', text: 'Inspect this report\n\nDetails' });
    await expect(promptedUpdated).resolves.toMatchObject({
      event: 'session.updated',
      payload: { sessionId: 'pi-session-new', title: 'Inspect this report' },
    });
    await client.close();
  });

  it('creates and selects a persisted Pi session with supported creation metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-'));
    const endpoint = testDaemonEndpoint(root);
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
    await client.close();
  });

  it('resolves live message ids to Pi entry ids for navigation and forking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-message-alias-'));
    const endpoint = testDaemonEndpoint(root);
    const sessionFile = join(root, 'fixture.jsonl');
    await writeFile(sessionFile, `${JSON.stringify({ type: 'session', id: 'fixture-session', cwd: root, timestamp: '2026-01-01T00:00:00.000Z' })}\n`);
    const session = new FakeSession('fixture-session', sessionFile);
    const hydratedMessage = { role: 'user', timestamp: 1, content: 'm3' };
    session.entries.push({ type: 'message', id: 'm3-entry', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: hydratedMessage });
    const navigated = [];
    session.navigateTree = async (entryId) => {
      if (!session.sessionManager.getEntry(entryId)) throw new Error(`Entry ${entryId} not found`);
      navigated.push(entryId);
      return { cancelled: false };
    };
    const forked = [];
    const runtime = new FakeRuntime({ cwd: root, session });
    runtime.fork = async (entryId) => {
      if (!session.sessionManager.getEntry(entryId)) throw new Error('Invalid entry ID for forking');
      forked.push(entryId);
      return { cancelled: false };
    };
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      createRuntime: async () => runtime,
      listSessions: async () => [{ path: sessionFile, id: 'fixture-session', cwd: root }],
    });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();
    await client.request('sessions.open', { sessionId: 'fixture-session', directory: root });

    await expect(client.request('sessions.navigate', { sessionId: 'fixture-session', directory: root, messageId: 'm3-entry' })).resolves.toMatchObject({
      result: { navigation: { targetEntryId: 'm3-entry' } },
    });

    const replacementUser = { role: 'user', timestamp: 2, content: 'm4 replacement' };
    const userStartPromise = client.next((frame) => frame.event === 'assistant.message.start' && frame.payload?.role === 'user' && frame.payload?.text === 'm4 replacement');
    session.emit({ type: 'message_start', message: replacementUser });
    session.emit({ type: 'message_end', message: replacementUser });
    session.entries.push({ type: 'message', id: 'm4-rev-entry', parentId: 'm3-entry', timestamp: '2026-01-01T00:00:02.000Z', message: replacementUser });
    const publishedUserId = (await userStartPromise).payload.messageId;
    await Promise.resolve();

    await expect(client.request('sessions.navigate', { sessionId: 'fixture-session', directory: root, messageId: publishedUserId })).resolves.toMatchObject({
      result: { navigation: { targetEntryId: 'm4-rev-entry' } },
    });
    await expect(client.request('sessions.fork', { sessionId: 'fixture-session', directory: root, messageId: publishedUserId })).resolves.toMatchObject({ result: expect.any(Object) });

    // Pi agent-core shallow-copies the streaming start; message_end carries
    // the distinct finalized object that SessionManager persists.
    const assistantStartMessage = { role: 'assistant', timestamp: 3, provider: 'test', model: 'model', content: [] };
    const replacementAssistant = { role: 'assistant', timestamp: 3, provider: 'test', model: 'model', content: [{ type: 'text', text: 'replacement answer' }] };
    const assistantStartPromise = client.next((frame) => frame.event === 'assistant.message.start' && frame.payload?.role === 'assistant');
    session.emit({ type: 'message_start', message: assistantStartMessage });
    session.emit({ type: 'message_end', message: replacementAssistant });
    session.entries.push({ type: 'message', id: 'm4-assistant-entry', parentId: 'm4-rev-entry', timestamp: '2026-01-01T00:00:03.000Z', message: replacementAssistant });
    const publishedAssistantId = (await assistantStartPromise).payload.messageId;
    await Promise.resolve();

    await expect(client.request('sessions.navigate', {
      sessionId: 'fixture-session',
      directory: root,
      messageId: `${publishedAssistantId}:text:0`,
    })).resolves.toMatchObject({ result: { navigation: { targetEntryId: 'm4-assistant-entry' } } });
    await expect(client.request('sessions.fork', {
      sessionId: 'fixture-session',
      directory: root,
      messageId: `${publishedAssistantId}:text:0`,
    })).resolves.toMatchObject({ result: expect.any(Object) });

    expect(navigated).toEqual(['m3-entry', 'm4-rev-entry', 'm4-assistant-entry']);
    expect(forked).toEqual(['m4-rev-entry', 'm4-assistant-entry']);
    await expect(client.request('sessions.fork', {
      sessionId: 'fixture-session',
      directory: root,
      messageId: 'user-fixture-session-unknown',
    })).rejects.toThrow('Daemon connection closed');

    const navigationClient = connectClient(endpoint);
    await navigationClient.authenticate();
    await expect(navigationClient.request('sessions.navigate', {
      sessionId: 'fixture-session',
      directory: root,
      messageId: 'user-fixture-session-unknown',
    })).rejects.toThrow('Daemon connection closed');
  });

  it('keeps live message aliases across idle disposal and runtime reopening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-message-alias-idle-'));
    const endpoint = testDaemonEndpoint(root);
    const sessionFile = join(root, 'fixture.jsonl');
    await writeFile(sessionFile, `${JSON.stringify({ type: 'session', id: 'fixture-session', cwd: root, timestamp: '2026-01-01T00:00:00.000Z' })}\n`);
    const liveMessage = { role: 'user', timestamp: 1, content: 'persist me' };
    const persistedEntry = { type: 'message', id: 'persisted-entry', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: liveMessage };
    const firstSession = new FakeSession('fixture-session', sessionFile);
    const firstRuntime = new FakeRuntime({ cwd: root, session: firstSession });
    const reopenedSession = new FakeSession('fixture-session', sessionFile);
    reopenedSession.entries.push({ ...persistedEntry, message: { ...liveMessage } });
    reopenedSession.navigateTree = async (entryId) => {
      if (!reopenedSession.sessionManager.getEntry(entryId)) throw new Error(`Entry ${entryId} not found`);
      reopenedSession.navigatedTo = entryId;
      return { cancelled: false };
    };
    const reopenedRuntime = new FakeRuntime({ cwd: root, session: reopenedSession });
    let runtimeCount = 0;
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      idleTimeoutMs: 10,
      listSessions: async () => [{ path: sessionFile, id: 'fixture-session', cwd: root }],
      createRuntime: async () => (++runtimeCount === 1 ? firstRuntime : reopenedRuntime),
    });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();
    await client.request('sessions.open', { sessionId: 'fixture-session', directory: root });
    const userStartPromise = client.next((frame) => frame.event === 'assistant.message.start' && frame.payload?.role === 'user');
    firstSession.emit({ type: 'message_start', message: liveMessage });
    firstSession.emit({ type: 'message_end', message: liveMessage });
    firstSession.entries.push(persistedEntry);
    const publishedId = (await userStartPromise).payload.messageId;
    await Promise.resolve();
    firstSession.emit({ type: 'agent_settled' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(firstRuntime.disposed).toBe(true);

    await expect(client.request('sessions.navigate', {
      sessionId: 'fixture-session',
      directory: root,
      messageId: publishedId,
    })).resolves.toMatchObject({ result: { navigation: { targetEntryId: 'persisted-entry' } } });
    expect(reopenedSession.navigatedTo).toBe('persisted-entry');
    await client.close();
  });

  it('scopes live message aliases by directory and session id', () => {
    const aliases = createMessageEntryAliases({ scheduleMicrotask: (callback) => callback() });
    const messageA = { role: 'user', content: 'same' };
    const messageB = { role: 'user', content: 'same' };
    const managerA = {
      getEntry: () => undefined,
      getEntries: () => [{ type: 'message', id: 'entry-a', message: messageA }],
    };
    const managerB = {
      getEntry: () => undefined,
      getEntries: () => [{ type: 'message', id: 'entry-b', message: messageB }],
    };
    aliases.retain({ cwd: '/project-a', sessionId: 'same-session', syntheticMessageId: 'user-same-session-1', message: messageA });
    aliases.retain({ cwd: '/project-b', sessionId: 'same-session', syntheticMessageId: 'user-same-session-1', message: messageB });
    aliases.observeMessageEnd({ cwd: '/project-a', sessionId: 'same-session', syntheticMessageId: 'user-same-session-1', message: messageA, sessionManager: managerA });
    aliases.observeMessageEnd({ cwd: '/project-b', sessionId: 'same-session', syntheticMessageId: 'user-same-session-1', message: messageB, sessionManager: managerB });

    expect(aliases.resolve({ cwd: '/project-a', sessionId: 'same-session', requestedId: 'user-same-session-1', sessionManager: managerA })).toBe('entry-a');
    expect(aliases.resolve({ cwd: '/project-b', sessionId: 'same-session', requestedId: 'user-same-session-1:text:0', sessionManager: managerB })).toBe('entry-b');
    expect(aliases.resolve({ cwd: '/project-a', sessionId: 'same-session', requestedId: 'user-same-session-unknown', sessionManager: managerA })).toBe('user-same-session-unknown');

    aliases.clearSession({ cwd: '/project-a', sessionId: 'same-session' });
    expect(aliases.resolve({ cwd: '/project-a', sessionId: 'same-session', requestedId: 'user-same-session-1', sessionManager: managerA })).toBe('user-same-session-1');
    expect(aliases.resolve({ cwd: '/project-b', sessionId: 'same-session', requestedId: 'user-same-session-1', sessionManager: managerB })).toBe('entry-b');
    aliases.clear();
    expect(aliases.resolve({ cwd: '/project-b', sessionId: 'same-session', requestedId: 'user-same-session-1:text:0', sessionManager: managerB })).toBe('user-same-session-1');
  });

  it('disposes an idle runtime without deleting its Pi JSONL and restores it on demand', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-'));
    const endpoint = testDaemonEndpoint(root);
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
      listSessions: async () => [{ path: sessionFile, id: 'pi-session-1', cwd: root }],
      createRuntime: async (options) => {
        runtimeCalls.push(options);
        return runtimeCalls.length === 1 ? firstRuntime : restoredRuntime;
      },
    });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();
    await client.request('sessions.open', { sessionId: 'pi-session-1' });
    firstRuntime.session.emit({ type: 'agent_settled' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(firstRuntime.disposed).toBe(true);
    await expect(stat(sessionFile)).resolves.toMatchObject({ isFile: expect.any(Function) });

    await client.request('sessions.prompt', { sessionId: 'pi-session-1', text: 'resume after idle' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtimeCalls).toEqual([
      { cwd: root, agentDir: expect.any(String), sessionFile },
      { cwd: root, agentDir: expect.any(String), sessionFile },
    ]);
    await client.close();
  });

  it('rebinds daemon events to the replacement Pi session identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-'));
    const endpoint = testDaemonEndpoint(root);
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
    await client.request('sessions.create', { cwd: root });
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

  it('handles every session command with path-selected identities and preserves busy-session configuration on rejection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-'));
    const endpoint = testDaemonEndpoint(root);
    const persistedSessionFile = join(root, 'persisted.jsonl');
    await writeFile(persistedSessionFile, `{"type":"session","id":"pi-session-persisted","cwd":"${root}"}\n`);
    const runtime = new FakeRuntime({ cwd: root, session: new FakeSession('pi-session-1') });
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      createRuntime: async () => runtime,
      listSessions: async () => [{
        path: persistedSessionFile,
        id: 'pi-session-persisted',
        cwd: root,
        created: new Date('2026-01-01T00:00:00.000Z'),
        modified: new Date('2026-01-01T00:00:01.000Z'),
        messageCount: 0,
      }],
    });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();

    await expect(client.request('projects.list')).resolves.toMatchObject({ result: { projects: [{ directory: root, selected: true }] } });
    await expect(client.request('providers.list')).resolves.toMatchObject({ result: { providers: [{ id: 'test', authenticated: true, models: [{ id: 'model', supportsThinking: true, thinkingLevels: ['off', 'minimal', 'low', 'medium'] }] }] } });
    await expect(client.request('projects.select', { directory: root })).resolves.toMatchObject({ result: { directory: root } });
    await expect(client.request('sessions.create', { cwd: root, title: 'Created' })).resolves.toMatchObject({ result: { session: { id: 'pi-session-new' } } });
    await expect(client.request('sessions.open', { sessionId: 'pi-session-persisted' })).resolves.toMatchObject({ result: { session: { id: 'pi-session-persisted' } } });
    runtime.session.entries = [{
      type: 'message',
      id: 'assistant-with-attachment-path',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'assistant',
        provider: 'test',
        model: 'model',
        content: [
          { type: 'text', text: 'Opened /tmp/pi-clipboard-7f7ec702-256a-4783-855c-df34e3ecedab.pdf' },
          { type: 'toolCall', id: 'tool-with-path', name: 'read', arguments: { path: '/tmp/pi-clipboard-7f7ec702-256a-4783-855c-df34e3ecedab.pdf' } },
        ],
      },
    }, {
      type: 'message',
      id: 'tool-result-entry',
      timestamp: '2026-01-01T00:00:03.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'tool-with-path',
        toolName: 'read',
        content: [{ type: 'text', text: 'file content for /tmp/pi-clipboard-7f7ec702-256a-4783-855c-df34e3ecedab.pdf' }],
        details: { truncation: { truncated: false } },
        isError: false,
        timestamp: 2_000,
      },
    }];
    const redactedDetail = await client.request('sessions.open', { sessionId: 'pi-session-persisted' });
    expect(JSON.stringify(redactedDetail.result)).not.toContain('pi-clipboard-');
    expect(redactedDetail.result).toMatchObject({
      messages: [{
        message: { text: 'Opened [attachment]' },
        parts: [
          { type: 'text', text: 'Opened [attachment]' },
          {
            type: 'tool',
            input: { path: '[attachment]' },
            output: 'file content for [attachment]',
            state: 'completed',
            metadata: { truncation: { truncated: false } },
            endedAt: expect.any(Number),
          },
        ],
      }],
    });
    await expect(client.request('sessions.tree', { sessionId: 'pi-session-persisted' })).resolves.toMatchObject({ result: { rootId: 'pi-session-persisted' } });
    await expect(client.request('sessions.navigate', { sessionId: 'pi-session-persisted', messageId: 'fake-entry' })).resolves.toMatchObject({ result: { session: { id: 'pi-session-persisted' } } });
    await expect(client.request('sessions.fork', { sessionId: 'pi-session-persisted', messageId: 'fake-entry' })).resolves.toMatchObject({ result: { session: { id: 'pi-session-forked' } } });
    await expect(client.request('sessions.clone', { sessionId: 'pi-session-forked' })).resolves.toMatchObject({ result: { session: { id: 'pi-session-forked' } } });
    const modelEvent = client.next((frame) => frame.event === 'session.model');
    await expect(client.request('sessions.setModel', { sessionId: 'pi-session-forked', model: { providerId: 'other', modelId: 'model' } })).resolves.toMatchObject({ result: {} });
    await expect(modelEvent).resolves.toMatchObject({ payload: { model: { providerId: 'other', modelId: 'model' } } });
    const thinkingEvent = client.next((frame) => frame.event === 'session.thinking');
    await expect(client.request('sessions.setThinking', { sessionId: 'pi-session-forked', thinking: 'minimal' })).resolves.toMatchObject({ result: {} });
    await expect(thinkingEvent).resolves.toMatchObject({ payload: { thinking: 'minimal' } });
    await expect(client.request('sessions.compact', { sessionId: 'pi-session-forked', thinking: 'medium' })).resolves.toMatchObject({ result: { accepted: true } });
    expect(runtime.session.compacted).toBe(1);
    await expect(client.request('sessions.prompt', { sessionId: 'pi-session-forked', text: 'prompt' })).resolves.toMatchObject({ result: { accepted: true, messageId: 'fake-entry' } });
    expect(runtime.session.sent).toEqual([{ text: 'prompt', options: undefined }]);
    runtime.session.isStreaming = true;
    await expect(client.request('sessions.setModel', { sessionId: 'pi-session-forked', model: { providerId: 'test', modelId: 'model' } })).resolves.toMatchObject({ result: {} });
    await expect(client.request('sessions.steer', { sessionId: 'pi-session-forked', text: 'steer text' })).resolves.toMatchObject({ result: { accepted: true, messageId: 'fake-entry' } });
    await expect(client.request('sessions.followUp', { sessionId: 'pi-session-forked', text: 'follow-up text' })).resolves.toMatchObject({ result: { accepted: true, messageId: 'fake-entry' } });
    expect(runtime.session.sent).toEqual([
      { text: 'prompt', options: undefined },
      { text: 'steer text', options: { deliverAs: 'steer' } },
      { text: 'follow-up text', options: { deliverAs: 'followUp' } },
    ]);
    await expect(client.request('sessions.abort', { sessionId: 'pi-session-forked' })).resolves.toMatchObject({ result: {} });
    expect(runtime.session.aborted).toBe(1);
    runtime.session.isStreaming = false;
    await expect(client.request('sessions.delete', { sessionId: 'pi-session-forked' })).resolves.toMatchObject({ result: {} });
    await client.close();
  });

  it('projects large tool payloads without blocking attachment redaction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-large-payload-'));
    const endpoint = testDaemonEndpoint(root);
    const persistedSessionFile = join(root, 'persisted.jsonl');
    await writeFile(persistedSessionFile, `{"type":"session","id":"pi-session-large","cwd":"${root}"}\n`);
    const session = new FakeSession('pi-session-large', persistedSessionFile);
    const largeEncodedValue = 'A'.repeat(80_000);
    session.entries = [{
      type: 'message',
      id: 'assistant-large-tool',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'assistant',
        provider: 'test',
        model: 'model',
        content: [{ type: 'toolCall', id: 'large-tool', name: 'read', arguments: { encoded: largeEncodedValue } }],
      },
    }, {
      type: 'message',
      id: 'large-tool-result',
      timestamp: '2026-01-01T00:00:03.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'large-tool',
        toolName: 'read',
        content: [{ type: 'text', text: largeEncodedValue }],
        details: {
          encoded: largeEncodedValue,
          windowsPath: 'C:\\Temp\\pi-clipboard-7f7ec702-256a-4783-855c-df34e3ecedab.png',
          bracketed: '[Attachment report.png is available at /tmp/pi-clipboard-7f7ec702-256a-4783-855c-df34e3ecedab.png]',
          punctuated: 'before,/tmp/pi-clipboard-7f7ec702-256a-4783-855c-df34e3ecedab.png;after',
          unicodePrefix: 'İ /tmp/pi-clipboard-7f7ec702-256a-4783-855c-df34e3ecedab.png',
        },
        isError: false,
      },
    }];
    const runtime = new FakeRuntime({ cwd: root, session });
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      createRuntime: async () => runtime,
      listSessions: async () => [{
        path: persistedSessionFile,
        id: 'pi-session-large',
        cwd: root,
        created: new Date('2026-01-01T00:00:00.000Z'),
        modified: new Date('2026-01-01T00:00:01.000Z'),
        messageCount: 2,
      }],
    });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();

    const startedAt = performance.now();
    const opened = await client.request('sessions.open', { sessionId: 'pi-session-large', directory: root });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(900);
    expect(opened.result.messages[0].parts[0]).toMatchObject({
      input: { encoded: largeEncodedValue },
      output: largeEncodedValue,
      metadata: {
        encoded: largeEncodedValue,
        windowsPath: '[attachment]',
        bracketed: '[attachment]',
        punctuated: 'before,[attachment];after',
        unicodePrefix: 'İ [attachment]',
      },
    });
    expect(JSON.stringify(opened.result)).not.toContain('pi-clipboard-');
    await client.close();
  }, 2_000);

  it('keeps Pi global/project defaults and trust decisions authoritative', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-settings-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const endpoint = testDaemonEndpoint(root);
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    daemon = createSessionDaemon({
      endpoint, credential, cwd, agentDir,
      createRuntime: async () => ({ session: new FakeSession(), async dispose() {} }),
    });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();

    await expect(client.request('settings.get')).resolves.toMatchObject({ result: { global: {}, project: { trusted: false } } });
    await expect(client.request('settings.set', { scope: 'global', defaultModel: { providerId: 'test', modelId: 'model' }, defaultThinking: 'medium' })).resolves.toMatchObject({
      result: { global: { defaultProvider: 'test', defaultModel: 'model', defaultThinking: 'medium' } },
    });
    await expect(client.request('settings.set', { scope: 'project', trust: true })).resolves.toMatchObject({ result: { project: { trusted: true } } });
    await expect(client.request('settings.set', { scope: 'project', defaultModel: { providerId: 'project-provider', modelId: 'project-model' }, defaultThinking: 'high' })).resolves.toMatchObject({
      result: { project: { trusted: true, defaultProvider: 'project-provider', defaultModel: 'project-model', defaultThinking: 'high' } },
    });
    await client.close();
  });

  it('lists and edits only opaque Pi resource identifiers without disclosing server paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-resources-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const endpoint = testDaemonEndpoint(root);
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    const loader = {
      getSkills: () => ({ skills: [{ name: 'review', description: 'Review changes', filePath: join(agentDir, 'skills', 'review', 'SKILL.md'), sourceInfo: { scope: 'user', origin: 'top-level' } }] }),
      getPrompts: () => ({ prompts: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
    };
    daemon = createSessionDaemon({
      endpoint, credential, cwd, agentDir,
      createRuntime: async () => ({ session: new FakeSession(), services: { resourceLoader: loader }, async dispose() {} }),
    });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();
    const listed = await client.request('resources.list');
    expect(listed.result.skills).toEqual([expect.objectContaining({ name: 'review', location: 'global' })]);
    const globalAgents = listed.result.agents.find((resource) => resource.location === 'global');
    expect(globalAgents).toMatchObject({ kind: 'agents', name: 'AGENTS.md', editable: true });
    expect(JSON.stringify(listed.result)).not.toContain(agentDir);
    await expect(client.request('resources.update', { resourceId: globalAgents.id, content: '# Global instructions\n' })).resolves.toMatchObject({ result: { agents: expect.any(Array) } });
    await expect(readFile(join(agentDir, 'AGENTS.md'), 'utf8')).resolves.toBe('# Global instructions\n');
    await client.close();
  });

  it('updates Pi models.json through an idle daemon and projects only credential-blind configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-'));
    const endpoint = testDaemonEndpoint(root);
    const updates = [];
    const modelConfigStore = {
      get: async (providerId) => providerId === 'custom' ? null : null,
      update: async (input) => {
        updates.push(input);
        return { providerId: input.providerId, label: input.label, baseUrl: input.baseUrl, api: input.api ?? 'openai-completions', models: input.models };
      },
    };
    daemon = createSessionDaemon({
      endpoint, credential, cwd: root, modelConfigStore,
      createRuntime: async () => ({ session: new FakeSession(), async dispose() {} }),
    });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();
    await expect(client.request('providers.config.get', { providerId: 'custom' })).resolves.toEqual(expect.objectContaining({ result: { config: null } }));
    const result = await client.request('providers.models.set', {
      providerId: 'custom', label: 'Custom', baseUrl: 'https://api.example.test/v1',
      models: [{ id: 'model', providerId: 'custom', label: 'Model' }], apiKeyReference: '{env:CUSTOM_KEY}',
    });
    expect(result.result).toEqual({ config: { providerId: 'custom', label: 'Custom', baseUrl: 'https://api.example.test/v1', api: 'openai-completions', models: [{ id: 'model', providerId: 'custom', label: 'Model' }] } });
    expect(updates).toEqual([{
      providerId: 'custom', label: 'Custom', baseUrl: 'https://api.example.test/v1',
      models: [{ id: 'model', providerId: 'custom', label: 'Model' }], apiKeyReference: '{env:CUSTOM_KEY}',
    }]);
    expect(JSON.stringify(result.result)).not.toContain('CUSTOM_KEY');
    await client.close();
  });

  it('runs persisted API-key and interactive OAuth logins without exposing credential values in daemon responses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-'));
    const endpoint = testDaemonEndpoint(root);
    const session = new FakeSession();
    daemon = createSessionDaemon({ endpoint, credential, cwd: root, createRuntime: async () => ({ session, async dispose() {} }) });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();

    const apiLogin = await client.request('providers.login', { providerId: 'test', type: 'api_key', apiKey: 'private-key' });
    expect(apiLogin.result.login).toMatchObject({ providerId: 'test', state: 'pending' });
    expect(JSON.stringify(apiLogin)).not.toContain('private-key');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.lastApiKey).toBe('private-key');

    const oauthLogin = await client.request('providers.login', { providerId: 'test', type: 'oauth' });
    const loginId = oauthLogin.result.login.id;
    expect(oauthLogin.result.login).toMatchObject({ deviceCode: { userCode: 'CODE', verificationUri: 'https://example.test/device' } });
    await expect(client.request('providers.login.respond', { providerId: 'test', loginId, value: 'manual-code' })).resolves.toMatchObject({ result: { login: { id: loginId, state: 'pending' } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.lastOAuthCode).toBe('manual-code');
    await expect(client.request('providers.logout', { providerId: 'test' })).resolves.toMatchObject({ result: { authenticated: false } });
    await client.close();
  });

  it('acknowledges manual compaction before summarization completes and publishes its outcome', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-compact-'));
    const endpoint = testDaemonEndpoint(root);
    const session = new FakeSession('pi-session-compact');
    let finishCompaction;
    session.compact = async (customInstructions) => {
      session.compacted += 1;
      session.compactionInstructions = customInstructions;
      session.emit({ type: 'compaction_start', reason: 'manual' });
      await new Promise((resolve) => { finishCompaction = resolve; });
      session.emit({
        type: 'compaction_end',
        reason: 'manual',
        result: { tokensBefore: 120_000, estimatedTokensAfter: 24_000 },
        aborted: false,
        willRetry: false,
      });
    };
    daemon = createSessionDaemon({ endpoint, credential, cwd: root, createRuntime: async () => ({ session, async dispose() {} }) });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();
    await client.request('sessions.create', { cwd: root });

    const started = client.next((frame) => frame.event === 'session.compaction' && frame.payload.phase === 'running');
    const completed = client.next((frame) => frame.event === 'session.compaction' && frame.payload.phase === 'completed');
    await expect(client.request('sessions.compact', {
      sessionId: 'pi-session-compact',
      customInstructions: 'Keep the unresolved test failures',
    })).resolves.toMatchObject({ result: { accepted: true } });
    expect(session.compacted).toBe(1);
    expect(session.compactionInstructions).toBe('Keep the unresolved test failures');
    await expect(started).resolves.toMatchObject({ payload: { phase: 'running', reason: 'manual' } });

    const observer = connectClient(endpoint);
    const snapshot = await observer.authenticate();
    expect(snapshot.payload.compaction).toMatchObject({ phase: 'running', reason: 'manual' });
    await observer.close();

    const retrying = client.next((frame) => frame.event === 'session.compaction' && frame.payload.phase === 'retrying');
    session.emit({ type: 'summarization_retry_scheduled', attempt: 1, maxAttempts: 3, delayMs: 2_000, errorMessage: 'temporary provider failure' });
    await expect(retrying).resolves.toMatchObject({
      payload: { phase: 'retrying', attempt: 1, maxAttempts: 3, message: 'temporary provider failure' },
    });

    finishCompaction();
    await expect(completed).resolves.toMatchObject({
      payload: {
        phase: 'completed',
        reason: 'manual',
        tokensBefore: 120_000,
        estimatedTokensAfter: 24_000,
      },
    });
    await client.close();
  });

  it('publishes a terminal compaction failure when the SDK rejects without an end event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-compact-failure-'));
    const endpoint = testDaemonEndpoint(root);
    const session = new FakeSession('pi-session-compact-failure');
    session.compact = async () => { throw new Error('summary provider unavailable'); };
    daemon = createSessionDaemon({ endpoint, credential, cwd: root, createRuntime: async () => ({ session, async dispose() {} }) });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();
    await client.request('sessions.create', { cwd: root });

    const failed = client.next((frame) => frame.event === 'session.compaction' && frame.payload.phase === 'failed');
    await expect(client.request('sessions.compact', { sessionId: session.sessionId })).resolves.toMatchObject({ result: { accepted: true } });
    await expect(failed).resolves.toMatchObject({
      payload: { phase: 'failed', reason: 'manual', message: 'summary provider unavailable', willRetry: false },
    });
    await client.close();
  });

  it('maps all core session event families to sequenced public-safe daemon frames', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-'));
    const endpoint = testDaemonEndpoint(root);
    const session = new FakeSession('pi-session-1');
    daemon = createSessionDaemon({ endpoint, credential, cwd: root, createRuntime: async () => ({ session, async dispose() {} }) });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();
    await client.request('sessions.create', { cwd: root });

    const events = [
      'session.lifecycle', 'assistant.message.start', 'assistant.message.delta', 'assistant.thinking.delta', 'assistant.message.end',
      'session.tool.start', 'session.tool.update', 'session.tool.end', 'session.queue', 'session.thinking', 'session.compaction',
      'session.error', 'session.interrupted',
    ].map((event) => client.next((frame) => frame.event === event));
    session.emit({ type: 'agent_start' });
    session.emit({ type: 'message_start', message: { role: 'assistant', timestamp: 1, provider: 'test', model: 'model' } });
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '/tmp/pi-clip' } });
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'board-7f7ec702-256a-4783-855c-df34e3ecedab.pdf followed by safe text' } });
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: 'a sufficiently long thought delta' } });
    session.emit({ type: 'tool_execution_start', toolCallId: 'tool', toolName: 'read', args: { path: '/tmp/pi-clipboard-7f7ec702-256a-4783-855c-df34e3ecedab.pdf' } });
    session.emit({
      type: 'tool_execution_update',
      toolCallId: 'tool',
      toolName: 'read',
      args: { path: '/tmp/pi-clipboard-7f7ec702-256a-4783-855c-df34e3ecedab.pdf' },
      partialResult: { content: [{ type: 'text', text: 'partial /tmp/pi-clipboard-7f7ec702-256a-4783-855c-df34e3ecedab.pdf output' }] },
    });
    session.emit({
      type: 'tool_execution_end',
      toolCallId: 'tool',
      toolName: 'read',
      result: {
        content: [{ type: 'text', text: 'final /tmp/pi-clipboard-7f7ec702-256a-4783-855c-df34e3ecedab.pdf output' }],
        details: { truncation: { truncated: true }, fullOutputPath: '/tmp/pi-bash-123' },
      },
      isError: false,
    });
    session.emit({ type: 'queue_update', steering: ['one'], followUp: ['two'] });
    session.emit({ type: 'thinking_level_changed', level: 'high' });
    session.emit({ type: 'compaction_start' });
    session.emit({ type: 'compaction_end' });
    session.emit({ type: 'agent_end', messages: [{ role: 'assistant', errorMessage: 'failed' }] });
    session.emit({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'aborted' }] });
    session.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'text' }] } });
    session.emit({ type: 'agent_settled' });

    const frames = await Promise.all(events);
    expect(new Set(frames.map((frame) => frame.sequence)).size).toBe(frames.length);
    expect(frames.every((frame) => Number.isSafeInteger(frame.sequence) && frame.sequence > 1
      && frame.payload.sessionId === 'pi-session-1' && frame.payload.directory === root)).toBe(true);
    const textDelta = frames.find((frame) => frame.event === 'assistant.message.delta');
    expect(textDelta.payload.delta).toContain('[attachment]');
    expect(textDelta.payload.delta).not.toContain('pi-clipboard-');
    const toolStart = frames.find((frame) => frame.event === 'session.tool.start');
    expect(JSON.stringify(toolStart.payload)).not.toContain('pi-clipboard-');
    expect(toolStart.payload.input).toEqual({ path: '[attachment]' });
    const toolUpdate = frames.find((frame) => frame.event === 'session.tool.update');
    expect(toolUpdate.payload.output).toContain('[attachment]');
    expect(toolUpdate.payload.output).not.toContain('pi-clipboard-');
    const toolEnd = frames.find((frame) => frame.event === 'session.tool.end');
    expect(toolEnd.payload.output).toContain('[attachment]');
    expect(toolEnd.payload.output).not.toContain('pi-clipboard-');
    expect(toolEnd.payload.metadata).toEqual({ truncation: { truncated: true } });
    expect(toolEnd.payload.endedAt).toBeTypeOf('number');
    await client.close();
  });

  it('keeps retry attempts attached to the original user turn until Pi settles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-retry-'));
    const endpoint = testDaemonEndpoint(root);
    const session = new FakeSession('pi-session-retry');
    daemon = createSessionDaemon({ endpoint, credential, cwd: root, createRuntime: async () => ({ session, async dispose() {} }) });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();
    await client.request('sessions.create', { cwd: root });

    const userStartPromise = client.next((frame) => frame.event === 'assistant.message.start' && frame.payload?.role === 'user');
    session.emit({ type: 'message_start', message: { role: 'user', content: 'recover this turn', timestamp: 1_000 } });
    const userStart = await userStartPromise;

    const failedStartPromise = client.next((frame) => frame.event === 'assistant.message.start' && frame.payload?.role === 'assistant');
    session.emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1_100 } });
    const failedStart = await failedStartPromise;
    session.emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Rate limit exceeded' } });

    const retryLifecycle = client.next((frame) => frame.event === 'session.lifecycle' && frame.payload.state === 'retry');
    const prematureError = client.next((frame) => frame.event === 'session.error');
    session.emit({ type: 'agent_end', willRetry: true, messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'Rate limit exceeded' }] });
    session.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2_000, errorMessage: 'Rate limit exceeded' });

    await expect(retryLifecycle).resolves.toMatchObject({
      payload: { state: 'retry', attempt: 1, message: 'Rate limit exceeded' },
    });

    const retryObserver = connectClient(endpoint);
    const retrySnapshot = await retryObserver.authenticate();
    expect(retrySnapshot.payload).toMatchObject({
      lifecycle: 'retry',
      retry: { attempt: 1, message: 'Rate limit exceeded' },
    });

    session.emit({ type: 'agent_start' });
    const recoveredStartPromise = client.next((frame) => frame.event === 'assistant.message.start'
      && frame.payload?.role === 'assistant'
      && frame.payload.messageId !== failedStart.payload.messageId);
    session.emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1_200 } });
    const recoveredStart = await recoveredStartPromise;
    const recoveredDeltaPromise = client.next((frame) => frame.event === 'assistant.message.delta'
      && frame.payload?.messageId === recoveredStart.payload.messageId);
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Recovered' } });

    await expect(recoveredDeltaPromise).resolves.toMatchObject({ payload: { delta: 'Recovered' } });
    expect(failedStart.payload.parentId).toBe(userStart.payload.messageId);
    expect(recoveredStart.payload.parentId).toBe(userStart.payload.messageId);
    await expect(prematureError).rejects.toThrow(/Timed out/);

    session.emit({ type: 'agent_settled' });
    await retryObserver.close();
    await client.close();
  });

  it('keeps ordinary tool errors live and resumes the next assistant in the same user turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-'));
    const endpoint = testDaemonEndpoint(root);
    const session = new FakeSession('pi-session-tool-seq');
    daemon = createSessionDaemon({ endpoint, credential, cwd: root, createRuntime: async () => ({ session, async dispose() {} }) });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();
    await client.request('sessions.create', { cwd: root });

    const userStartPromise = client.next((frame) => frame.event === 'assistant.message.start' && frame.payload?.role === 'user');
    const messageStartPromise = client.next((frame) => frame.event === 'assistant.message.start' && frame.payload?.role === 'assistant');
    const messageEndPromise = client.next((frame) => frame.event === 'assistant.message.end');
    const toolStartPromise = client.next((frame) => frame.event === 'session.tool.start');
    const toolEndPromise = client.next((frame) => frame.event === 'session.tool.end');

    session.emit({ type: 'message_start', message: { role: 'user', content: 'run the command', timestamp: 0 } });
    session.emit({ type: 'message_start', message: { role: 'assistant', timestamp: 1 } });
    session.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Calling tool' },
          { type: 'toolCall', id: 'tool-call-1', name: 'bash', arguments: { command: 'echo hi' } },
        ],
      },
    });
    session.emit({ type: 'tool_execution_start', toolCallId: 'tool-call-1', toolName: 'bash', args: { command: 'echo hi' } });
    session.emit({ type: 'tool_execution_end', toolCallId: 'tool-call-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'command failed' }] }, isError: true });

    const userStart = await userStartPromise;
    const messageStart = await messageStartPromise;
    const messageEnd = await messageEndPromise;
    const toolStart = await toolStartPromise;
    const toolEnd = await toolEndPromise;

    expect(messageStart.payload.messageId).toMatch(/^assistant-pi-session-tool-seq-\d+$/);
    expect(messageEnd.payload.messageId).toBe(messageStart.payload.messageId);
    expect(messageEnd.payload.continuing).toBe(true);
    expect(toolStart.payload.messageId).toBe(messageStart.payload.messageId);
    expect(toolStart.payload.partId).toBe(`${messageStart.payload.messageId}:tool:tool-call-1`);
    expect(toolEnd.payload.messageId).toBe(messageStart.payload.messageId);
    expect(toolEnd.payload.partId).toBe(`${messageStart.payload.messageId}:tool:tool-call-1`);
    expect(toolEnd.payload).toMatchObject({ state: 'error', isError: true, error: 'command failed' });

    const recoveredStartPromise = client.next((frame) => frame.event === 'assistant.message.start'
      && frame.payload?.role === 'assistant'
      && frame.payload.messageId !== messageStart.payload.messageId);
    session.emit({ type: 'message_start', message: { role: 'assistant', timestamp: 2 } });
    const recoveredStart = await recoveredStartPromise;
    const recoveredDeltaPromise = client.next((frame) => frame.event === 'assistant.message.delta'
      && frame.payload?.messageId === recoveredStart.payload.messageId);
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Recovered from tool failure' } });

    await expect(recoveredDeltaPromise).resolves.toMatchObject({ payload: { delta: 'Recovered from tool failure' } });
    expect(messageStart.payload.parentId).toBe(userStart.payload.messageId);
    expect(recoveredStart.payload.parentId).toBe(userStart.payload.messageId);
    session.emit({ type: 'agent_settled' });
    await client.close();
  });

  it('rejects non-local endpoints and unauthenticated clients before a request can reach the runtime', async () => {
    expect(() => createSessionDaemon({
      endpoint: 'http://127.0.0.1:3000',
      credential,
      cwd: '/workspace',
    })).toThrow('endpoint must be local');

    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-'));
    const endpoint = testDaemonEndpoint(root);
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

  it('accepts Windows named pipes and rejects TCP or filesystem paths on win32', () => {
    expect(isLocalSessionDaemonEndpoint('\\\\.\\pipe\\pichamber-pi-session-daemon-0123456789abcdef', 'win32')).toBe(true);
    expect(isLocalSessionDaemonEndpoint('\\\\.\\pipe\\pichamber-pi-session-daemon-0123456789abcdef\\extra', 'win32')).toBe(false);
    expect(isLocalSessionDaemonEndpoint('http://127.0.0.1:3000', 'win32')).toBe(false);
    expect(isLocalSessionDaemonEndpoint('/tmp/pi-session-daemon.sock', 'win32')).toBe(false);
    expect(isLocalSessionDaemonEndpoint('\\\\.\\pipe\\pichamber-pi-session-daemon-0123456789abcdef', 'linux')).toBe(false);
  });

  it('does not unlink an existing endpoint when startup fails', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-'));
    const endpoint = testDaemonEndpoint(root);
    await writeFile(endpoint, 'not a daemon socket');
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      createRuntime: async () => ({
        session: new FakeSession(),
        async dispose() {},
      }),
    });

    await expect(daemon.start()).rejects.toThrow('endpoint already exists');
    expect(daemon.isStarted).toBe(false);
  });

  it('creates a Pi SDK session with a disposable normal agent directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-sdk-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const endpoint = testDaemonEndpoint(root);
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

  it('supports multiple sessions running concurrently without stopping earlier sessions on switch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-multi-'));
    const endpoint = testDaemonEndpoint(root);
    const file1 = join(root, 'session-1.jsonl');
    const file2 = join(root, 'session-2.jsonl');
    await writeFile(file1, `{"type":"session","id":"session-1","cwd":"${root}"}\n`);
    await writeFile(file2, `{"type":"session","id":"session-2","cwd":"${root}"}\n`);

    const sessions = new Map();
    sessions.set('session-1', new FakeSession('session-1', file1));
    sessions.set('session-2', new FakeSession('session-2', file2));

    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      createRuntime: async ({ sessionFile }) => {
        const id = sessionFile?.includes('session-2') ? 'session-2' : 'session-1';
        return new FakeRuntime({ cwd: root, session: sessions.get(id) });
      },
      listSessions: async () => [
        { path: file1, id: 'session-1', cwd: root, created: new Date(), modified: new Date(), messageCount: 0 },
        { path: file2, id: 'session-2', cwd: root, created: new Date(), modified: new Date(), messageCount: 0 },
      ],
    });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();

    // 1. Open session 1 and prompt it
    await client.request('sessions.open', { sessionId: 'session-1' });
    const s1 = sessions.get('session-1');
    await client.request('sessions.prompt', { sessionId: 'session-1', text: 'Prompt in session 1' });
    s1.isStreaming = true;

    expect(s1.sent).toHaveLength(1);
    expect(s1.sent[0].text).toBe('Prompt in session 1');

    // 2. Switch to session 2 while session 1 is still streaming
    const open2 = await client.request('sessions.open', { sessionId: 'session-2' });
    expect(open2.result).toMatchObject({
      session: { id: 'session-2' },
    });

    // Session 1 is still streaming and not aborted
    expect(s1.isStreaming).toBe(true);
    expect(s1.aborted).toBe(0);

    // 3. Prompt session 2 concurrently
    const s2 = sessions.get('session-2');
    await client.request('sessions.prompt', { sessionId: 'session-2', text: 'Prompt in session 2' });

    expect(s2.sent).toHaveLength(1);
    expect(s2.sent[0].text).toBe('Prompt in session 2');

    // Both sessions processed their prompts independently
    expect(s1.sent).toHaveLength(1);
    expect(s2.sent).toHaveLength(1);

    await client.close();
  });

  it('acknowledges a prompt without waiting for the agent turn to finish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-prompt-ack-'));
    const endpoint = testDaemonEndpoint(root);
    const sessionFile = join(root, 'session-1.jsonl');
    await writeFile(sessionFile, `{"type":"session","id":"session-1","cwd":"${root}"}\n`);
    const session = new FakeSession('session-1', sessionFile);
    let finishTurn;
    session.sendUserMessage = (text, options) => {
      session.sent.push({ text, options });
      return new Promise((resolve) => {
        finishTurn = resolve;
      });
    };
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      createRuntime: async () => new FakeRuntime({ cwd: root, session }),
      listSessions: async () => [
        { path: sessionFile, id: 'session-1', cwd: root, created: new Date(), modified: new Date(), messageCount: 0 },
      ],
    });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();

    const response = await client.request('sessions.prompt', {
      sessionId: 'session-1',
      text: 'keep working',
      messageId: 'client-message-1',
    });

    expect(response.result).toEqual({ accepted: true, messageId: 'client-message-1' });
    expect(session.sent).toHaveLength(1);
    finishTurn();
    await client.close();
  });

  it('starts a new turn when follow-up arrives after the stream has already ended', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-followup-idle-'));
    const endpoint = testDaemonEndpoint(root);
    const sessionFile = join(root, 'session-1.jsonl');
    await writeFile(sessionFile, `{"type":"session","id":"session-1","cwd":"${root}"}\n`);
    const session = new FakeSession('session-1', sessionFile);
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      createRuntime: async () => new FakeRuntime({ cwd: root, session }),
      listSessions: async () => [
        { path: sessionFile, id: 'session-1', cwd: root, created: new Date(), modified: new Date(), messageCount: 0 },
      ],
    });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();

    const response = await client.request('sessions.followUp', {
      sessionId: 'session-1',
      text: 'continue after the stream died',
    });

    expect(response.result.accepted).toBe(true);
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0].options).toBeUndefined();
    await client.close();
  });

  it('ignores a stale send rejection after a newer prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-stale-send-'));
    const endpoint = testDaemonEndpoint(root);
    const sessionFile = join(root, 'session-1.jsonl');
    await writeFile(sessionFile, `{"type":"session","id":"session-1","cwd":"${root}"}\n`);
    const session = new FakeSession('session-1', sessionFile);
    let rejectFirst;
    let finishSecond;
    let sendCount = 0;
    session.sendUserMessage = (text, options) => {
      session.sent.push({ text, options });
      sendCount += 1;
      if (sendCount === 1) return new Promise((_, reject) => { rejectFirst = reject; });
      return new Promise((resolve) => { finishSecond = resolve; });
    };
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      createRuntime: async () => new FakeRuntime({ cwd: root, session }),
      listSessions: async () => [
        { path: sessionFile, id: 'session-1', cwd: root, created: new Date(), modified: new Date(), messageCount: 0 },
      ],
    });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();
    await client.request('sessions.prompt', { sessionId: 'session-1', text: 'first' });
    await client.request('sessions.prompt', { sessionId: 'session-1', text: 'second' });
    const staleError = client.next((message) => message.kind === 'event' && message.event === 'session.error');
    rejectFirst(new Error('Stream ended without finish_reason'));
    await expect(staleError).rejects.toThrow(/Timed out/);
    finishSecond();
    await client.close();
  });

  it('aborts a stuck stream after the owned send promise rejects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-abort-stuck-'));
    const endpoint = testDaemonEndpoint(root);
    const sessionFile = join(root, 'session-1.jsonl');
    await writeFile(sessionFile, `{"type":"session","id":"session-1","cwd":"${root}"}\n`);
    const session = new FakeSession('session-1', sessionFile);
    session.sendUserMessage = (text, options) => {
      session.sent.push({ text, options });
      session.isStreaming = true;
      return Promise.reject(new Error('Stream ended without finish_reason'));
    };
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      createRuntime: async () => new FakeRuntime({ cwd: root, session }),
      listSessions: async () => [
        { path: sessionFile, id: 'session-1', cwd: root, created: new Date(), modified: new Date(), messageCount: 0 },
      ],
    });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();
    const error = client.next((message) => message.kind === 'event' && message.event === 'session.error');
    await client.request('sessions.prompt', { sessionId: 'session-1', text: 'go' });
    await error;
    expect(session.aborted).toBe(1);
    expect(session.isStreaming).toBe(false);
    await client.close();
  });

  it('projects unmatched tools as running only while the session is authoritative-busy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-live-hydrate-'));
    const endpoint = testDaemonEndpoint(root);
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const session = new FakeSession('pi-session-live');
    session.isStreaming = true;
    session.entries = [
      {
        type: 'message',
        id: 'user-1',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: 'run it', timestamp: 1_000 },
      },
      {
        type: 'message',
        id: 'assistant-1',
        timestamp: '2026-01-01T00:00:01.100Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling bash' },
            { type: 'toolCall', id: 'tool-live', name: 'bash', arguments: { command: 'ls' } },
          ],
          provider: 'test',
          model: 'model',
          timestamp: 1_100,
        },
      },
    ];
    session.messages = [
      { role: 'user', content: 'run it', timestamp: 1_000 },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling bash' },
          { type: 'toolCall', id: 'tool-live', name: 'bash', arguments: { command: 'ls' } },
        ],
        provider: 'test',
        model: 'model',
        timestamp: 1_100,
      },
    ];

    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: projectDir,
      agentDir,
      createRuntime: async () => ({ session, async dispose() {} }),
      listSessions: async () => [],
    });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();
    const detail = await client.request('sessions.create', { cwd: projectDir });
    expect(detail.result.isStreaming).toBe(true);
    expect(detail.result.lifecycle).toBe('busy');
    expect(detail.result.messages).toHaveLength(2);
    expect(detail.result.messages[1].parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'calling bash' }),
      expect.objectContaining({ type: 'tool', name: 'bash', state: 'running', toolCallId: 'tool-live' }),
    ]));

    session.isStreaming = false;
    const settled = await client.request('sessions.open', { sessionId: session.sessionId, cwd: projectDir });
    expect(settled.result.lifecycle).toBe('idle');
    expect(settled.result.messages[1].parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool',
        name: 'bash',
        state: 'error',
        toolCallId: 'tool-live',
        isError: true,
        error: 'Tool was interrupted before completion.',
        endedAt: expect.any(Number),
      }),
    ]));
    await client.close();
  });

  it('overlays an unpersisted live user prompt onto getSession while streaming', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-live-user-'));
    const endpoint = testDaemonEndpoint(root);
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const session = new FakeSession('pi-session-live-user');
    session.isStreaming = true;
    session.entries = [];
    session.messages = [
      { role: 'user', content: 'just sent', timestamp: 2_000 },
    ];

    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: projectDir,
      agentDir,
      createRuntime: async () => ({ session, async dispose() {} }),
      listSessions: async () => [],
    });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();
    const detail = await client.request('sessions.create', { cwd: projectDir });
    expect(detail.result.isStreaming).toBe(true);
    expect(detail.result.lifecycle).toBe('busy');
    expect(detail.result.messages).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ role: 'user', text: 'just sent' }),
      }),
    ]);
    await client.close();
  });

  it('projects Pi usage in getSession messages and message_end events, omitting malformed payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-usage-'));
    const endpoint = testDaemonEndpoint(root);
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const session = new FakeSession('pi-session-usage');
    session.entries = [
      {
        type: 'message',
        id: 'assistant-usage-good',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          provider: 'test',
          model: 'model',
          usage: {
            input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 165,
            cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
          },
        },
      },
      {
        type: 'message',
        id: 'assistant-usage-malformed',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'partial' }],
          provider: 'test',
          model: 'model',
          usage: { input: 'oops', output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
        },
      },
    ];

    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: projectDir,
      agentDir,
      createRuntime: async () => ({ session, async dispose() {} }),
      listSessions: async () => [],
    });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();
    const detail = await client.request('sessions.create', { cwd: projectDir });
    const messages = detail.result.messages;
    const good = messages.find((entry) => entry.message.id === 'assistant-usage-good');
    const bad = messages.find((entry) => entry.message.id === 'assistant-usage-malformed');
    expect(good.message.usage).toEqual({
      input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 165,
      cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
    });
    expect(bad.message.usage).toBeUndefined();

    const [goodEnd, badEnd] = [
      client.next((frame) => frame.event === 'assistant.message.end' && frame.payload?.usage?.totalTokens === 19),
      client.next((frame) => frame.event === 'assistant.message.end' && frame.payload?.usage === undefined),
    ];
    session.emit({ type: 'message_end', message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'live' }],
      usage: {
        input: 7, output: 9, cacheRead: 1, cacheWrite: 2, totalTokens: 19,
        cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
      },
    } });
    session.emit({ type: 'message_end', message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'interrupted' }],
      usage: { input: NaN, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
    } });
    const [goodFrame, badFrame] = await Promise.all([goodEnd, badEnd]);
    expect(goodFrame.payload.usage).toEqual({
      input: 7, output: 9, cacheRead: 1, cacheWrite: 2, totalTokens: 19,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
    });
    expect(badFrame.payload.usage).toBeUndefined();
    await client.close();
  });

  it('projects the last assistant model and thinking onto an opened session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-last-model-'));
    const endpoint = testDaemonEndpoint(root);
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const session = new FakeSession('pi-session-last-model');
    session.model = { provider: 'openai', id: 'gpt-5' };
    session.thinkingLevel = 'low';
    session.entries = [
      {
        type: 'message',
        id: 'assistant-last',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          provider: 'anthropic',
          model: 'sonnet',
          thinkingLevel: 'high',
        },
      },
    ];

    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: projectDir,
      agentDir,
      createRuntime: async () => ({ session, async dispose() {} }),
      listSessions: async () => [],
    });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();
    const detail = await client.request('sessions.create', { cwd: projectDir });
    expect(detail.result.session.model).toEqual({ providerId: 'anthropic', modelId: 'sonnet' });
    expect(detail.result.session.thinking).toBe('high');
    expect(detail.result.messages[0].message.thinkingLevel).toBe('high');
    await client.close();
  });
});
