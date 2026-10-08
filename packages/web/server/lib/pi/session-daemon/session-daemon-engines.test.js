import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { ENGINE_UNSUPPORTED_OPERATION } from './session-engines.js';
import { createSessionDaemon as createSessionDaemonImpl } from './session-daemon.js';

const credential = 'a-private-daemon-credential';

function createSessionDaemon(options) {
  return createSessionDaemonImpl({ ...options, agentDir: options.agentDir ?? options.cwd });
}

function testDaemonEndpoint(root, tag) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\pichamber-engines-${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return join(root, `${tag}.sock`);
}

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
    this.modelRuntime = {
      getModel: (providerId, modelId) => ({ provider: providerId, id: modelId }),
      getModels: () => [{ provider: 'test', id: 'model', name: 'Test model', contextWindow: 128_000, reasoning: true, thinkingLevelMap: { low: 1, high: null } }],
      getProvider: (providerId) => providerId === 'test' ? ({ name: 'Test provider' }) : undefined,
      getProviderAuthStatus: () => ({ configured: true }),
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

  async prompt(text, options) {
    options?.preflightResult?.('started');
    this.sent.push({ text, options });
  }

  async setModel(model) { this.model = model; }

  setThinkingLevel(thinking) { this.thinkingLevel = thinking; }

  async abort() { this.aborted += 1; this.isStreaming = false; }

  async compact() { this.compacted += 1; }

  async navigateTree(messageId) { return { cancelled: false, messageId }; }

  getSteeringMessages() { return []; }

  getFollowUpMessages() { return []; }
}

class FakeRuntime {
  constructor({ cwd, session }) {
    this.cwd = cwd;
    this.session = session;
    this.disposed = false;
  }

  setRebindSession() {}

  async dispose() { this.disposed = true; }
}

/**
 * Minimal in-memory engine double. Owns sessions in a Map, answers sync
 * ownership checks from that index, and records every handle call so tests
 * prove prompt dedup executes the engine at most once.
 */
class FakeEngine {
  constructor(id = 'fake') {
    this.id = id;
    this.sessions = new Map();
    this.handleCalls = [];
    this.counter = 0;
    this.disposed = false;
    this.host = undefined;
    this.failList = false;
    this.handlers = {
      'sessions.create': async (payload) => this.record('sessions.create', payload, () => {
        this.counter += 1;
        const newId = `engine-session-${this.counter}`;
        const now = Date.now();
        const session = {
          id: newId,
          directory: payload.cwd,
          title: 'engine session',
          createdAt: now,
          updatedAt: now,
        };
        this.sessions.set(newId, session);
        return {
          session: { ...session },
          messages: [],
          lastSequence: 0,
          isStreaming: false,
          lifecycle: 'idle',
        };
      }),
      'sessions.prompt': async (payload) => this.record('sessions.prompt', payload, () => ({ messageId: `engine-msg-${this.handleCalls.length}` })),
      'sessions.steer': async (payload) => this.record('sessions.steer', payload, () => ({ messageId: `engine-msg-${this.handleCalls.length}` })),
      'sessions.followUp': async (payload) => this.record('sessions.followUp', payload, () => ({ messageId: `engine-msg-${this.handleCalls.length}` })),
      'sessions.open': async (payload) => this.record('sessions.open', payload, () => {
        const session = this.sessions.get(payload.sessionId);
        if (!session) {
          throw Object.assign(new Error('missing'), { code: 'INVALID_SESSION' });
        }
        return {
          session: { ...session },
          messages: [],
          lastSequence: 0,
          isStreaming: false,
          lifecycle: 'idle',
        };
      }),
      'sessions.messages': async (payload) => this.record('sessions.messages', payload, () => {
        const session = this.sessions.get(payload.sessionId);
        if (!session) {
          throw Object.assign(new Error('missing'), { code: 'INVALID_SESSION' });
        }
        return {
          session: { ...session },
          messages: [],
          lastSequence: 0,
          isStreaming: false,
          lifecycle: 'idle',
        };
      }),
    };
  }

  record(command, payload, run) {
    this.handleCalls.push({ command, payload });
    return run();
  }

  ownsSession(sessionId) { return this.sessions.has(sessionId); }

  ownsProvider(providerId) { return providerId === 'fake-provider'; }

  async listSessions() {
    if (this.failList) throw Object.assign(new Error('engine list exploded'), { code: 'ENGINE_LIST_BROKEN' });
    return [...this.sessions.values()].map((session) => ({
      session: { ...session },
      updatedAt: session.updatedAt,
    }));
  }

  async listProviders() {
    return {
      providers: [{
        id: 'fake-provider',
        label: 'Fake provider',
        authenticated: true,
        models: [{ id: 'fake-model', providerId: 'fake-provider' }],
      }],
    };
  }

  snapshot(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return { directory: session.directory, engineNote: 'from-snapshot' };
  }

  async dispose() { this.disposed = true; }
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
    }, 2_000);
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
    async authenticate({ sessionId, fromSequence, streamEpoch } = {}) {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write(`${JSON.stringify({
        kind: 'authenticate',
        credential,
        ...(sessionId ? { sessionId } : {}),
        ...(fromSequence !== undefined ? { fromSequence } : {}),
        ...(streamEpoch ? { streamEpoch } : {}),
      })}\n`);
      await next((message) => message.kind === 'authenticated');
      if (fromSequence !== undefined) return undefined;
      return next((message) => message.kind === 'event' && message.event === 'session.snapshot');
    },
    request(command, payload = {}) {
      const requestId = `request-${Math.random()}`;
      socket.write(`${JSON.stringify({ protocolVersion: 1, kind: 'request', requestId, command, payload })}\n`);
      return new Promise((resolve, reject) => {
        next((message) => {
          if (message.kind === 'error') {
            const code = message.error?.code ?? 'DAEMON_REQUEST_FAILED';
            reject(Object.assign(new Error(code), { code }));
            return true;
          }
          return message.kind === 'response' && message.requestId === requestId;
        }).then(resolve, reject);
      });
    },
    next,
    async close() {
      if (!socket.destroyed) socket.destroy();
      if (socket.destroyed) return;
      await new Promise((resolve) => socket.once('close', resolve));
    },
  };
}

describe('session daemon engines', () => {
  const roots = [];
  const daemons = [];
  let currentEndpoint;
  let currentStreamEpoch;

  afterEach(async () => {
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop().catch(() => {})));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const startDaemon = async ({ engines = [], openPiSession = false } = {}) => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-daemon-engines-'));
    roots.push(root);
    const endpoint = testDaemonEndpoint(root, `daemon-${roots.length}`);
    const sessionFile = join(root, 'session-1.jsonl');
    await writeFile(sessionFile, `{"type":"session","id":"session-1","cwd":"${root}"}\n`);
    const session = new FakeSession('pi-session-1', sessionFile);
    const daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      engines,
      createRuntime: async () => new FakeRuntime({ cwd: root, session }),
      listSessions: async () => [
        { path: sessionFile, id: 'pi-session-1', cwd: root, created: new Date('2026-01-01T00:00:00.000Z'), modified: new Date('2026-01-02T00:00:00.000Z'), messageCount: 0 },
      ],
    });
    daemons.push(daemon);
    await daemon.start();
    currentEndpoint = endpoint;
    const health = await send('runtime.health');
    currentStreamEpoch = health.result.streamEpoch;
    if (openPiSession) await send('sessions.open', { sessionId: 'pi-session-1' });
    return { daemon, session, root, sessionFile };
  };

  // The daemon destroys a request connection on a rejected command, so each
  // send uses its own short-lived authenticated connection.
  const send = async (command, payload) => {
    const connection = connectClient(currentEndpoint);
    await connection.authenticate();
    try {
      const epochBound = ['sessions.prompt', 'sessions.steer', 'sessions.followUp', 'sessions.sendReceipt'].includes(command)
        ? { ...payload, streamEpoch: payload.streamEpoch ?? currentStreamEpoch }
        : payload;
      return await connection.request(command, epochBound);
    } finally {
      await connection.close().catch(() => {});
    }
  };

  it('rejects an invalid engine list synchronously', () => {
    expect(() => createSessionDaemon({ endpoint: '/tmp/x.sock', credential, cwd: '/tmp', engines: 'nope' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_ENGINES' }));
    expect(() => createSessionDaemon({ endpoint: '/tmp/x.sock', credential, cwd: '/tmp', engines: [() => ({})] }))
      .not.toThrow();
  });

  it('routes sessions.create by engine id, owned provider, pi, and rejects unknown engines', async () => {
    const engine = new FakeEngine('fake');
    await startDaemon({ engines: [(host) => { engine.host = host; return engine; }] });

    const byEngine = await send('sessions.create', { engine: 'fake' });
    expect(byEngine.result.session.engine).toBe('fake');
    expect(byEngine.result.session.id).toBe('engine-session-1');

    const byProvider = await send('sessions.create', { model: { providerId: 'fake-provider', modelId: 'fake-model' } });
    expect(byProvider.result.session.engine).toBe('fake');
    expect(engine.handleCalls.filter((call) => call.command === 'sessions.create')).toHaveLength(2);

    const piCreated = await send('sessions.create', { engine: 'pi' });
    expect(piCreated.result.session.engine).toBeUndefined();
    expect(piCreated.result.session.id).toBe('pi-session-1');

    await expect(send('sessions.create', { engine: 'nope' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(send('sessions.create', { engine: 42 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('merges engine rows after Pi rows and reports a failed engine without losing rows', async () => {
    const healthy = new FakeEngine('fake');
    const failing = new FakeEngine('failing');
    failing.failList = true;
    const { root } = await startDaemon({ engines: [() => healthy, () => failing] });

    await send('sessions.create', { engine: 'fake' });
    const listed = await send('sessions.list', { directory: root });
    const ids = listed.result.sessions.map((item) => item.session.id);
    expect(ids).toContain('pi-session-1');
    expect(ids).toContain('engine-session-1');
    expect(ids.indexOf('pi-session-1')).toBeLessThan(ids.indexOf('engine-session-1'));
    const engineRow = listed.result.sessions.find((item) => item.session.id === 'engine-session-1');
    expect(engineRow.session.engine).toBe('fake');
    expect(engineRow.session.directory).toBe(root);
    const piRow = listed.result.sessions.find((item) => item.session.id === 'pi-session-1');
    expect(piRow.session.engine).toBeUndefined();
    expect(listed.result.incompleteEngines).toEqual(['failing']);
  });

  it('keeps the zero-engine list result to exactly sessions and streamEpoch', async () => {
    const { root } = await startDaemon({});
    const listed = await send('sessions.list', { directory: root });
    expect(Object.keys(listed.result).sort()).toEqual(['sessions', 'streamEpoch']);
    expect(listed.result.sessions.map((item) => item.session.id)).toEqual(['pi-session-1']);
  });

  it('shares global sequence and replay between engine events and daemon events', async () => {
    const engine = new FakeEngine('fake');
    const { root } = await startDaemon({ engines: [(host) => { engine.host = host; return engine; }] });
    await send('sessions.create', { engine: 'fake' });

    const subscriber = connectClient(currentEndpoint);
    const snapshot = await subscriber.authenticate();
    const baseSequence = snapshot.sequence;

    // A Pi-owned event followed by an engine event: sequences interleave on
    // the same global counter under the current stream epoch. (Each `send`
    // authenticates and consumes snapshot sequences, so assert adjacency
    // rather than absolute positions.)
    await send('sessions.create', { title: 'pi title' });
    engine.host.publish('session.updated', { title: 'engine title' }, 'engine-session-1', root);
    const piEvent = await subscriber.next((message) => message.kind === 'event'
      && message.event === 'session.updated' && message.payload?.sessionId === 'pi-session-1');
    const engineEvent = await subscriber.next((message) => message.kind === 'event'
      && message.event === 'session.updated' && message.payload?.sessionId === 'engine-session-1');
    expect(engineEvent.sequence).toBe(piEvent.sequence + 1);
    expect(piEvent.sequence).toBeGreaterThan(baseSequence);
    expect(piEvent.streamEpoch).toBe(currentStreamEpoch);
    expect(engineEvent.streamEpoch).toBe(currentStreamEpoch);
    expect(engineEvent.event).toBe('session.updated');
    expect(engineEvent.payload).toMatchObject({ sessionId: 'engine-session-1', directory: root, title: 'engine title' });

    // A reconnect with the snapshot cursor replays the engine event.
    const replay = connectClient(currentEndpoint);
    await replay.authenticate();
    engine.host.publish('session.updated', { title: 'again' }, 'engine-session-1', root);
    const replayed = connectClient(currentEndpoint);
    await replayed.authenticate({ fromSequence: engineEvent.sequence, streamEpoch: currentStreamEpoch });
    const replayedEvent = await replayed.next((message) => message.kind === 'event' && message.event === 'session.updated');
    expect(replayedEvent.payload).toMatchObject({ title: 'again', sessionId: 'engine-session-1' });
    await subscriber.close().catch(() => {});
    await replay.close().catch(() => {});
    await replayed.close().catch(() => {});
  });

  it('strips spoofed sessionId and directory keys from engine payloads', async () => {
    const engine = new FakeEngine('fake');
    const { root } = await startDaemon({ engines: [(host) => { engine.host = host; return engine; }] });
    await send('sessions.create', { engine: 'fake' });

    const subscriber = connectClient(currentEndpoint);
    await subscriber.authenticate();
    engine.host.publish('session.updated', { sessionId: 'spoofed', directory: '/spoofed', title: 't' }, 'engine-session-1', root);
    const event = await subscriber.next((message) => message.kind === 'event' && message.event === 'session.updated');
    expect(event.payload.sessionId).toBe('engine-session-1');
    expect(event.payload.directory).toBe(root);
    await subscriber.close().catch(() => {});

    expect(() => engine.host.publish('session.snapshot', {}, 'engine-session-1', root)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => engine.host.publish('session.updated', {}, '', root)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => engine.host.publish('', {}, 'engine-session-1', root)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });

  it('normalizes engine notifications, keeps them for snapshots/details, and forgets them on delete', async () => {
    const engine = new FakeEngine('fake');
    const { root } = await startDaemon({ engines: [(host) => { engine.host = host; return engine; }] });
    await send('sessions.create', { engine: 'fake' });

    const subscriber = connectClient(currentEndpoint);
    await subscriber.authenticate();
    engine.host.publish('extension.notify', { message: 'engine did a thing', level: 'weird' }, 'engine-session-1', root);
    const event = await subscriber.next((message) => message.kind === 'event' && message.event === 'extension.notify');
    expect(event.payload).toMatchObject({ sessionId: 'engine-session-1', message: 'engine did a thing', level: 'info' });
    expect(typeof event.payload.id).toBe('string');
    expect(event.payload.id.length).toBeGreaterThan(0);
    expect(Number.isFinite(event.payload.createdAt)).toBe(true);
    expect(() => engine.host.publish('extension.notify', { message: '' }, 'engine-session-1', root)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );

    // A late subscriber sees the normalized notice in its snapshot.
    const late = connectClient(currentEndpoint);
    const snapshot = await late.authenticate({ sessionId: 'engine-session-1' });
    expect(snapshot.payload.extensionNotices).toHaveLength(1);
    expect(snapshot.payload.extensionNotices[0]).toMatchObject({
      message: 'engine did a thing', level: 'info',
    });
    expect(snapshot.payload.extensionNotices[0].id).toBe(event.payload.id);
    await late.close().catch(() => {});

    const opened = await send('sessions.open', { sessionId: 'engine-session-1' });
    expect(opened.result.extensionNotices).toHaveLength(1);
    expect(opened.result.extensionNotices[0].id).toBe(event.payload.id);

    // The engine deletion forgets that session's notices.
    engine.host.publish('session.deleted', {}, 'engine-session-1', root);
    await subscriber.next((message) => message.kind === 'event' && message.event === 'session.deleted'
      && message.payload?.sessionId === 'engine-session-1');
    const reopened = await send('sessions.open', { sessionId: 'engine-session-1' });
    expect(reopened.result.extensionNotices).toEqual([]);
    await subscriber.close().catch(() => {});
  });

  it('dedups engine prompts, rejects mismatches, serves receipts, and guards stale epochs', async () => {
    const engine = new FakeEngine('fake');
    await startDaemon({ engines: [() => engine] });
    await send('sessions.create', { engine: 'fake' });

    const payload = { sessionId: 'engine-session-1', text: 'hello engine', operationId: 'op-engine-1' };
    const first = await send('sessions.prompt', payload);
    expect(first.result).toMatchObject({ accepted: true });
    expect(typeof first.result.messageId).toBe('string');
    expect(first.result.deduplicated).toBeUndefined();

    const retry = await send('sessions.prompt', payload);
    expect(retry.result).toMatchObject({ accepted: true, messageId: first.result.messageId, deduplicated: true });
    expect(engine.handleCalls.filter((call) => call.command === 'sessions.prompt')).toHaveLength(1);

    await expect(send('sessions.prompt', { ...payload, text: 'different' }))
      .rejects.toMatchObject({ code: 'OPERATION_PAYLOAD_MISMATCH' });
    expect(engine.handleCalls.filter((call) => call.command === 'sessions.prompt')).toHaveLength(1);

    const receipt = await send('sessions.sendReceipt', {
      kind: 'prompt',
      sessionId: 'engine-session-1',
      operationId: 'op-engine-1',
    });
    expect(receipt.result).toMatchObject({ status: 'accepted', receipt: { accepted: true } });

    const beforeStale = engine.handleCalls.length;
    await expect(send('sessions.prompt', { ...payload, operationId: 'op-stale', streamEpoch: 'retired-epoch' }))
      .rejects.toMatchObject({ code: 'STALE_STREAM_EPOCH' });
    expect(engine.handleCalls).toHaveLength(beforeStale);
  });

  it('returns ENGINE_UNSUPPORTED_OPERATION for unsupported and draft commands on engine sessions', async () => {
    const engine = new FakeEngine('fake');
    await startDaemon({ engines: [() => engine] });
    await send('sessions.create', { engine: 'fake' });

    await expect(send('sessions.tree', { sessionId: 'engine-session-1' }))
      .rejects.toMatchObject({ code: ENGINE_UNSUPPORTED_OPERATION });
    await expect(send('extensions.draft', { sessionId: 'engine-session-1', text: 'hi', revision: 1 }))
      .rejects.toMatchObject({ code: ENGINE_UNSUPPORTED_OPERATION });
  });

  it('builds engine snapshots with daemon-owned sequence fields', async () => {
    const engine = new FakeEngine('fake');
    await startDaemon({ engines: [() => engine] });
    await send('sessions.create', { engine: 'fake' });

    const subscriber = connectClient(currentEndpoint);
    const snapshot = await subscriber.authenticate({ sessionId: 'engine-session-1' });
    expect(snapshot.event).toBe('session.snapshot');
    expect(snapshot.streamEpoch).toBe(currentStreamEpoch);
    expect(snapshot.payload.sessionId).toBe('engine-session-1');
    expect(snapshot.payload.lastSequence).toBe(snapshot.sequence);
    expect(snapshot.payload.engineNote).toBe('from-snapshot');
    await subscriber.close().catch(() => {});
  });

  it('normalizes engine session.input and republishes it canonically', async () => {
    const engine = new FakeEngine('fake');
    const { root } = await startDaemon({ engines: [(host) => { engine.host = host; return engine; }] });
    await send('sessions.create', { engine: 'fake' });

    const subscriber = connectClient(currentEndpoint);
    await subscriber.authenticate();
    engine.host.publish('session.input', { pending: { count: 2, kind: 'exotic', since: 123, extra: true } }, 'engine-session-1', root);
    const event = await subscriber.next((message) => message.kind === 'event' && message.event === 'session.input');
    expect(event.payload).toMatchObject({
      sessionId: 'engine-session-1',
      directory: root,
      pending: { count: 2, kind: 'input', since: 123 },
    });
    await subscriber.close().catch(() => {});

    expect(() => engine.host.publish('session.input', { pending: { count: 'many' } }, 'engine-session-1', root)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => engine.host.publish('session.input', {}, 'engine-session-1', root)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });

  it('carries engine inputState on rows, snapshots, and details with index fallback', async () => {
    const engine = new FakeEngine('fake');
    const { root } = await startDaemon({ engines: [(host) => { engine.host = host; return engine; }] });
    await send('sessions.create', { engine: 'fake' });
    await send('sessions.create', { engine: 'fake' });
    // engine-session-2 reports its own value; engine-session-1 carries none
    // and falls back to the index summary from its session.input event.
    engine.listSessions = async () => [
      { session: { ...engine.sessions.get('engine-session-1') }, updatedAt: Date.now() },
      {
        session: { ...engine.sessions.get('engine-session-2') },
        updatedAt: Date.now(),
        inputState: { pending: { count: 2, kind: 'approval', since: 40 } },
      },
    ];
    engine.host.publish('session.input', { pending: { count: 1, kind: 'input', since: 50 } }, 'engine-session-1', root);

    const listed = await send('sessions.list', { directory: root });
    const first = listed.result.sessions.find((item) => item.session.id === 'engine-session-1');
    expect(first.inputState.pending).toEqual({ count: 1, kind: 'input', since: 50 });
    expect(Number.isSafeInteger(first.inputState.sequence)).toBe(true);
    const second = listed.result.sessions.find((item) => item.session.id === 'engine-session-2');
    expect(second.inputState).toEqual({
      pending: { count: 2, kind: 'approval', since: 40 },
      sequence: first.inputState.sequence,
    });

    const snapshotClient = connectClient(currentEndpoint);
    const snapshot = await snapshotClient.authenticate({ sessionId: 'engine-session-1' });
    expect(snapshot.payload.inputState).toEqual({ pending: { count: 1, kind: 'input', since: 50 } });
    await snapshotClient.close().catch(() => {});

    const opened = await send('sessions.open', { sessionId: 'engine-session-1' });
    expect(opened.result.inputState).toEqual({ pending: { count: 1, kind: 'input', since: 50 } });

    const pending = await send('sessions.pendingInput', {});
    expect(pending.result.sessions).toEqual([
      { sessionId: 'engine-session-1', directory: root, pending: { count: 1, kind: 'input', since: 50 } },
    ]);
    expect(Number.isSafeInteger(pending.result.sequence)).toBe(true);
    expect(pending.result.streamEpoch).toBe(currentStreamEpoch);

    // Engine deletion forgets pending-input state without a session.input.
    const subscriber = connectClient(currentEndpoint);
    await subscriber.authenticate();
    const seen = subscriber.next((message) => message.kind === 'event' && message.event === 'session.input'
      && message.payload?.sessionId === 'engine-session-1');
    engine.host.publish('session.deleted', {}, 'engine-session-1', root);
    await subscriber.next((message) => message.kind === 'event' && message.event === 'session.deleted'
      && message.payload?.sessionId === 'engine-session-1');
    const afterDelete = await send('sessions.pendingInput', {});
    expect(afterDelete.result.sessions).toEqual([]);
    await Promise.race([
      seen.then(() => 'published'),
      new Promise((resolve) => setTimeout(() => resolve('silent'), 100)),
    ]).then((outcome) => expect(outcome).toBe('silent'));
    await subscriber.close().catch(() => {});
  });

  it('advertises sessions.pendingInput in runtime.health', async () => {
    await startDaemon({});
    const health = await send('runtime.health');
    expect(health.result.capabilities).toContain('sessions.pendingInput');
  });

  it('redacts attachment paths on every engine output', async () => {
    const leakedPath = '/tmp/pi-clipboard-7f7ec702-256a-4783-855c-df34e3ecedab.pdf';
    const engine = new FakeEngine('fake');
    engine.handlers['sessions.open'] = async (payload) => {
      engine.handleCalls.push({ command: 'sessions.open', payload });
      const session = engine.sessions.get(payload.sessionId);
      return {
        session: { ...session, title: `Opened ${leakedPath}` },
        messages: [],
        lastSequence: 0,
        isStreaming: false,
        lifecycle: 'idle',
      };
    };
    const { root } = await startDaemon({ engines: [(host) => { engine.host = host; return engine; }] });
    await send('sessions.create', { engine: 'fake' });
    engine.sessions.get('engine-session-1').title = `Report ${leakedPath}`;

    const listed = await send('sessions.list', { directory: root });
    const engineRow = listed.result.sessions.find((item) => item.session.id === 'engine-session-1');
    expect(JSON.stringify(engineRow)).not.toContain('pi-clipboard-');
    expect(engineRow.session.title).toContain('[attachment]');

    const opened = await send('sessions.open', { sessionId: 'engine-session-1' });
    expect(JSON.stringify(opened.result)).not.toContain('pi-clipboard-');
    expect(opened.result.session.title).toContain('[attachment]');

    const subscriber = connectClient(currentEndpoint);
    await subscriber.authenticate();
    engine.host.publish('session.updated', { title: `echo ${leakedPath}` }, 'engine-session-1', root);
    const event = await subscriber.next((message) => message.kind === 'event' && message.event === 'session.updated'
      && message.payload?.sessionId === 'engine-session-1');
    expect(JSON.stringify(event.payload)).not.toContain('pi-clipboard-');
    await subscriber.close().catch(() => {});

    const snapshotClient = connectClient(currentEndpoint);
    engine.snapshot = () => ({ directory: root, engineNote: `note ${leakedPath}` });
    const snapshot = await snapshotClient.authenticate({ sessionId: 'engine-session-1' });
    expect(JSON.stringify(snapshot.payload)).not.toContain('pi-clipboard-');
    await snapshotClient.close().catch(() => {});
  });

  it('lists engines with labels and sorted commands and advertises the capability', async () => {
    const engine = new FakeEngine('fake');
    engine.label = 'Fake Label';
    await startDaemon({ engines: [() => engine] });
    const listed = await send('engines.list');
    expect(listed.result).toEqual({
      engines: [{
        id: 'fake',
        label: 'Fake Label',
        commands: ['sessions.create', 'sessions.followUp', 'sessions.messages', 'sessions.open', 'sessions.prompt', 'sessions.steer'],
      }],
    });
    const health = await send('runtime.health');
    expect(health.result.capabilities).toContain('engines.list');
  });

  it('returns an empty engine list with zero engines', async () => {
    await startDaemon({});
    const listed = await send('engines.list');
    expect(listed.result).toEqual({ engines: [] });
  });

  it('rejects explicit creation for engines without a create handler and falls back for providers', async () => {
    const engine = new FakeEngine('no-create');
    delete engine.handlers['sessions.create'];
    engine.ownsProvider = (providerId) => providerId === 'owned-provider';
    await startDaemon({ engines: [() => engine] });
    await expect(send('sessions.create', { engine: 'no-create' }))
      .rejects.toMatchObject({ code: ENGINE_UNSUPPORTED_OPERATION });
    const fallback = await send('sessions.create', { model: { providerId: 'owned-provider', modelId: 'm' } });
    expect(fallback.result.session.engine).toBeUndefined();
    expect(fallback.result.session.id).toBe('pi-session-1');
  });

  it('exposes Pi attachment preparation to engine prompt handlers', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
    const textBytes = 'engine notes body';
    const dir = await mkdtemp(join(tmpdir(), 'pichamber-engine-attachments-'));
    roots.push(dir);
    const pngPath = join(dir, 'photo.png');
    const txtPath = join(dir, 'notes.txt');
    await writeFile(pngPath, pngBytes);
    await writeFile(txtPath, textBytes);
    let host;
    const engine = new FakeEngine('fake');
    await startDaemon({ engines: [(candidate) => { host = candidate; engine.host = candidate; return engine; }] });
    await send('sessions.create', { engine: 'fake' });
    engine.handlers['sessions.prompt'] = async (payload) => {
      engine.prepared = await host.prepareAttachments(payload.attachments);
      return { messageId: 'engine-msg-attach' };
    };
    const response = await send('sessions.prompt', {
      sessionId: 'engine-session-1',
      text: 'with files',
      attachments: [
        { id: 'a1', path: pngPath, name: 'photo.png', mime: 'image/png', size: pngBytes.length },
        { id: 'a2', path: txtPath, name: 'notes.txt', mime: 'text/plain', size: Buffer.byteLength(textBytes) },
      ],
    });
    expect(response.result).toMatchObject({ accepted: true, messageId: 'engine-msg-attach' });
    expect(engine.prepared.images).toHaveLength(1);
    expect(engine.prepared.images[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(Buffer.from(engine.prepared.images[0].data, 'base64').equals(pngBytes)).toBe(true);
    expect(engine.prepared.text).toContain(`[Attachment notes.txt is available at ${txtPath}]`);
    expect(engine.prepared.files).toEqual([
      { mime: 'image/png', filename: 'photo.png' },
      { mime: 'text/plain', filename: 'notes.txt' },
    ]);
  });

  it('keeps an attachment-rejected operation id reusable for the engine retry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pichamber-engine-attachment-retry-'));
    roots.push(dir);
    const latePath = join(dir, 'late.txt');
    let host;
    const engine = new FakeEngine('fake');
    await startDaemon({ engines: [(candidate) => { host = candidate; engine.host = candidate; return engine; }] });
    await send('sessions.create', { engine: 'fake' });
    engine.handlers['sessions.prompt'] = async (payload) => {
      engine.promptExecutions = (engine.promptExecutions ?? 0) + 1;
      engine.prepared = await host.prepareAttachments(payload.attachments);
      return { messageId: 'engine-msg-retry' };
    };
    const operationId = 'op-attach-retry';
    const attachment = { id: 'a1', path: latePath, name: 'late.txt', mime: 'text/plain', size: 5 };
    await expect(send('sessions.prompt', {
      sessionId: 'engine-session-1',
      text: 'needs file',
      operationId,
      attachments: [attachment],
    })).rejects.toMatchObject({ code: 'ATTACHMENT_MISSING' });
    const receipt = await send('sessions.sendReceipt', {
      kind: 'prompt',
      sessionId: 'engine-session-1',
      operationId,
    });
    expect(receipt.result).toMatchObject({ status: 'unknown' });
    await writeFile(latePath, 'hello');
    const retry = await send('sessions.prompt', {
      sessionId: 'engine-session-1',
      text: 'needs file',
      operationId,
      attachments: [attachment],
    });
    expect(retry.result).toMatchObject({ accepted: true, messageId: 'engine-msg-retry' });
    expect(retry.result.deduplicated).toBeUndefined();
    expect(engine.promptExecutions).toBe(2);
  });

  it('requires an absolute directory for engine events and snapshots', async () => {
    const engine = new FakeEngine('fake');
    const { root } = await startDaemon({ engines: [(host) => { engine.host = host; return engine; }] });
    await send('sessions.create', { engine: 'fake' });

    const subscriber = connectClient(currentEndpoint);
    const snapshot = await subscriber.authenticate();
    const baseSequence = snapshot.sequence;
    expect(() => engine.host.publish('session.updated', { title: 'no dir' }, 'engine-session-1'))
      .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => engine.host.publish('session.updated', { title: 'empty dir' }, 'engine-session-1', ''))
      .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => engine.host.publish('session.updated', { title: 'relative dir' }, 'engine-session-1', 'relative/path'))
      .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    engine.host.publish('session.updated', { title: 'engine title' }, 'engine-session-1', root);
    const event = await subscriber.next((message) => message.kind === 'event'
      && message.event === 'session.updated' && message.payload?.sessionId === 'engine-session-1');
    expect(event.sequence).toBe(baseSequence + 1);
    expect(event.payload).toMatchObject({ sessionId: 'engine-session-1', directory: root, title: 'engine title' });
    await subscriber.close().catch(() => {});

    engine.snapshot = () => ({ engineNote: 'no directory' });
    const probe = connectClient(currentEndpoint);
    await new Promise((resolve, reject) => {
      probe.socket.once('connect', resolve);
      probe.socket.once('error', reject);
    });
    probe.socket.write(`${JSON.stringify({ kind: 'authenticate', credential, sessionId: 'engine-session-1' })}\n`);
    await probe.next((message) => message.kind === 'authenticated');
    const raced = await Promise.race([
      probe.next((message) => message.kind === 'event' && message.event === 'session.snapshot'
        && message.payload?.sessionId === 'engine-session-1').then((message) => message),
      new Promise((resolve) => setTimeout(() => resolve('no-snapshot'), 300)),
    ]);
    expect(raced).toBe('no-snapshot');
    await probe.close().catch(() => {});
  });

  it('disposes every engine on stop even when one dispose throws', async () => {
    const first = new FakeEngine('first');
    const failing = new FakeEngine('failing');
    failing.dispose = async () => {
      failing.disposed = true;
      throw Object.assign(new Error('cannot stop'), { code: 'DISPOSE_BROKEN' });
    };
    const { daemon } = await startDaemon({ engines: [() => first, () => failing] });
    await daemon.stop();
    expect(first.disposed).toBe(true);
    expect(failing.disposed).toBe(true);
    daemons.splice(daemons.indexOf(daemon), 1);
  });
});
