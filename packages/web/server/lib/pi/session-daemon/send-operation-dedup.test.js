import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { createSessionDaemon as createSessionDaemonImpl } from './session-daemon.js';

const credential = 'a-private-daemon-credential';

function createSessionDaemon(options) {
  return createSessionDaemonImpl({ ...options, agentDir: options.agentDir ?? options.cwd });
}

function testDaemonEndpoint(root) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\pichamber-send-dedup-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return join(root, 'daemon.sock');
}

/**
 * Minimal Pi session double: counts actual Pi invocations (`sent`) so the
 * tests prove one intent executes at most once within the bounded retention
 * window (not lifetime: tombstones are capped and restarts lose receipts).
 */
class FakeSession {
  constructor(sessionId, sessionFile) {
    this.sessionId = sessionId;
    this.sessionFile = sessionFile;
    this.isStreaming = false;
    this.listeners = new Set();
    this.names = [];
    this.entries = [];
    this.sent = [];
    this.aborted = 0;
    this.model = { provider: 'test', id: 'model' };
    this.thinkingLevel = 'low';
    this.activationGate = null;
    this.modelRuntime = {
      getModel: (providerId, modelId) => providerId === 'test' ? { provider: providerId, id: modelId } : undefined,
      getModels: () => [{ provider: 'test', id: 'model', name: 'Test model', contextWindow: 128_000, reasoning: true, thinkingLevelMap: { low: 1, high: null } }],
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
    options?.preflightResult?.(true);
    const deliverAs = options?.streamingBehavior;
    this.sent.push({ text, options: deliverAs ? { deliverAs } : undefined });
  }

  async sendUserMessage(text, options) {
    this.sent.push({ text, options });
  }

  async setModel(model) {
    this.model = { provider: model.providerId ?? model.provider, id: model.modelId ?? model.id };
  }

  setThinkingLevel(thinking) { this.thinkingLevel = thinking; }

  async abort() { this.aborted += 1; this.isStreaming = false; }

  getSteeringMessages() { return []; }

  getFollowUpMessages() { return []; }
}

class FakeRuntime {
  constructor({ cwd, session }) {
    this.cwd = cwd;
    this.session = session;
    this.disposed = false;
  }
  async dispose() { this.disposed = true; }
}

function connectClient(endpoint) {
  const socket = createConnection({ path: endpoint });
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const waiters = [];

  const publish = (message) => {
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

  const next = (predicate) => new Promise((resolve, reject) => {
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

  return {
    async authenticate() {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write(`${JSON.stringify({ kind: 'authenticate', credential })}\n`);
      await next((message) => message.kind === 'authenticated');
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

/**
 * Finding #3 only: stable operation identity, daemon dedup, exact receipt,
 * and payload mismatch. No stream-epoch guard and no per-session
 * send/config lock belong in this split.
 */
describe('send dedup (finding #3)', () => {
  const roots = [];
  const daemons = [];
  let client;
  let currentEndpoint;

  // The daemon destroys a request connection on a rejected command, so each
  // send uses its own short-lived authenticated connection.
  const send = async (command, payload) => {
    const connection = connectClient(currentEndpoint);
    await connection.authenticate();
    try {
      return await connection.request(command, payload);
    } finally {
      await connection.close().catch(() => {});
    }
  };

  afterEach(async () => {
    client = undefined;
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop().catch(() => {})));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const startDaemonWithSession = async ({ ttlMs, openSession = true } = {}) => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-send-dedup-'));
    roots.push(root);
    const endpoint = testDaemonEndpoint(root);
    const sessionFile = join(root, 'session-1.jsonl');
    await writeFile(sessionFile, `{"type":"session","id":"session-1","cwd":"${root}"}\n`);
    const session = new FakeSession('session-1', sessionFile);
    const daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      ...(ttlMs !== undefined ? { sendOperationTtlMs: ttlMs } : {}),
      createRuntime: async () => {
        if (session.activationGate) await session.activationGate.released;
        return new FakeRuntime({ cwd: root, session });
      },
      listSessions: async () => [
        { path: sessionFile, id: 'session-1', cwd: root, created: new Date(), modified: new Date(), messageCount: 0 },
      ],
    });
    daemons.push(daemon);
    await daemon.start();
    currentEndpoint = endpoint;
    client = connectClient(endpoint);
    await client.authenticate();
    if (openSession) await client.request('sessions.open', { sessionId: 'session-1' });
    return { session, endpoint, root, sessionFile };
  };

  it.each([
    ['sessions.prompt', 'prompt'],
    ['sessions.steer', 'steer'],
    ['sessions.followUp', 'followUp'],
  ])('a lost-ack retry of the same operation id executes %s once and returns the original receipt', async (command) => {
    const { session } = await startDaemonWithSession();
    const payload = { sessionId: 'session-1', text: 'one intent', operationId: 'op-lost-ack' };

    const first = await send(command, payload);
    expect(first.result).toMatchObject({ accepted: true, messageId: 'fake-entry' });
    expect(first.result.deduplicated).toBeUndefined();
    expect(session.sent).toHaveLength(1);

    const retry = await send(command, payload);
    expect(retry.result).toMatchObject({ accepted: true, messageId: 'fake-entry', deduplicated: true });
    expect(session.sent).toHaveLength(1);
  });

  it('rejects the same operation id with a different payload without invoking Pi', async () => {
    const { session } = await startDaemonWithSession();
    await expect(send('sessions.prompt', { sessionId: 'session-1', text: 'original', operationId: 'op-mismatch' }))
      .resolves.toMatchObject({ result: { accepted: true } });
    expect(session.sent).toHaveLength(1);

    await expect(send('sessions.prompt', { sessionId: 'session-1', text: 'different', operationId: 'op-mismatch' }))
      .rejects.toMatchObject({ code: 'OPERATION_PAYLOAD_MISMATCH' });
    await expect(send('sessions.prompt', {
      sessionId: 'session-1',
      text: 'original',
      operationId: 'op-mismatch',
      model: { providerId: 'test', modelId: 'other-model' },
    })).rejects.toMatchObject({ code: 'OPERATION_PAYLOAD_MISMATCH' });
    expect(session.sent).toHaveLength(1);

    await expect(send('sessions.prompt', { sessionId: 'session-1', text: 'original', operationId: 'op-other' }))
      .resolves.toMatchObject({ result: { accepted: true } });
    expect(session.sent).toHaveLength(2);
  });

  it('treats a daemon restart as the explicit crash window: a replayed id re-executes on the new daemon', async () => {
    const first = await startDaemonWithSession();
    const { sessionFile, root } = first;
    const payload = { sessionId: 'session-1', text: 'across restart', operationId: 'op-restart' };
    await expect(send('sessions.prompt', payload)).resolves.toMatchObject({ result: { accepted: true } });
    expect(first.session.sent).toHaveLength(1);
    await client.close();

    await daemons.pop().stop();
    const endpoint = testDaemonEndpoint(root);
    currentEndpoint = endpoint;
    const session = new FakeSession('session-1', sessionFile);
    const daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      createRuntime: async () => new FakeRuntime({ cwd: root, session }),
      listSessions: async () => [
        { path: sessionFile, id: 'session-1', cwd: root, created: new Date(), modified: new Date(), messageCount: 0 },
      ],
    });
    daemons.push(daemon);
    await daemon.start();
    client = connectClient(endpoint);
    await client.authenticate();

    await expect(send('sessions.prompt', payload)).resolves.toMatchObject({ result: { accepted: true } });
    expect(session.sent).toHaveLength(1);
  });

  it('sessions.sendReceipt tracks pending then accepted then expired with no false guarantee', async () => {
    const { session } = await startDaemonWithSession({ ttlMs: 30, openSession: false });
    const gate = {};
    gate.released = new Promise((resolve) => { gate.release = resolve; });
    session.activationGate = gate;
    const lookup = { kind: 'prompt', sessionId: 'session-1', operationId: 'op-receipt-lifecycle' };
    const payload = { sessionId: 'session-1', text: 'lifecycle', operationId: 'op-receipt-lifecycle' };

    const pendingSend = send('sessions.prompt', payload);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(send('sessions.sendReceipt', lookup)).resolves.toMatchObject({ result: { status: 'pending' } });
    expect(session.sent).toHaveLength(0);

    gate.release();
    await expect(pendingSend).resolves.toMatchObject({ result: { accepted: true } });
    expect(session.sent).toHaveLength(1);
    await expect(send('sessions.sendReceipt', lookup))
      .resolves.toMatchObject({ result: { status: 'accepted', receipt: { accepted: true } } });

    await new Promise((resolve) => setTimeout(resolve, 60));
    const expired = await send('sessions.sendReceipt', lookup);
    expect(expired.result.status).toBe('expired');
    expect(expired.result.receipt).toBeUndefined();

    await expect(send('sessions.prompt', payload)).rejects.toMatchObject({ code: 'OPERATION_EXPIRED' });
    expect(session.sent).toHaveLength(1);
    const retryPayload = { ...payload, operationId: 'op-receipt-lifecycle-2' };
    const retry = await send('sessions.prompt', retryPayload);
    expect(retry.result).toMatchObject({ accepted: true });
    expect(retry.result.deduplicated).toBeUndefined();
    expect(session.sent).toHaveLength(2);
    await expect(send('sessions.sendReceipt', { ...lookup, operationId: 'op-receipt-lifecycle-2' }))
      .resolves.toMatchObject({ result: { status: 'accepted' } });
  });
});
