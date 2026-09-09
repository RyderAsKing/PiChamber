import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { requestSessionDaemon } from './ipc-client.js';
import { createSessionDaemon as createSessionDaemonImpl } from './session-daemon.js';

const credential = 'a-private-daemon-credential';

function createSessionDaemon(options) {
  return createSessionDaemonImpl({ ...options, agentDir: options.agentDir ?? options.cwd });
}

function testDaemonEndpoint(root) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\pichamber-send-op-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return join(root, 'daemon.sock');
}

/**
 * FakeSession whose send can be held open with a barrier so tests can observe
 * what the daemon does while a send promise is still pending (the lost-ack
 * window), and which counts actual Pi invocations.
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
    this.modelApplications = [];
    this.aborted = 0;
    this.model = { provider: 'test', id: 'model' };
    this.thinkingLevel = 'low';
    // When set, sendUserMessage awaits `release()` before resolving.
    this.sendBarrier = null;
    // When set, createRuntime awaits `release()` before resolving.
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

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  async prompt() {}

  async sendUserMessage(text, options) {
    this.sent.push({ text, options });
    if (this.sendBarrier) await this.sendBarrier.released;
  }

  async setModel(model) {
    this.modelApplications.push(model);
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

  const next = (predicate) => {
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

describe('send operation safety (findings #3 and #4)', () => {
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
    const root = await mkdtemp(join(tmpdir(), 'pichamber-send-op-'));
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
        // Tests can gate activation to hold the config+acceptance lock open.
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

    // Transport retry / manual confirmation reuses the SAME operation id.
    const retry = await send(command, payload);
    expect(retry.result).toMatchObject({ accepted: true, messageId: 'fake-entry', deduplicated: true });
    // Exactly one Pi invocation for the one intent, and the inline config was
    // applied at most once (the duplicate never reaches config application).
    expect(session.sent).toHaveLength(1);
    expect(session.modelApplications).toHaveLength(0);
  });

  it('a concurrent duplicate shares the original acceptance receipt', async () => {
    const { session } = await startDaemonWithSession();
    const payload = { sessionId: 'session-1', text: 'shared intent', operationId: 'op-concurrent' };

    const [first, duplicate] = await Promise.all([
      send('sessions.prompt', payload),
      send('sessions.prompt', payload),
    ]);
    expect(session.sent).toHaveLength(1);
    expect(first.result).toMatchObject({ accepted: true, messageId: 'fake-entry' });
    expect(duplicate.result).toMatchObject({ accepted: true, messageId: 'fake-entry' });
    expect([first.result.deduplicated, duplicate.result.deduplicated]).toContain(true);
    expect([first.result.deduplicated, duplicate.result.deduplicated]).not.toContain(false);
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
    // Only the original intent executed.
    expect(session.sent).toHaveLength(1);

    // A distinct id is a distinct intent and executes.
    await expect(send('sessions.prompt', { sessionId: 'session-1', text: 'original', operationId: 'op-other' }))
      .resolves.toMatchObject({ result: { accepted: true } });
    expect(session.sent).toHaveLength(2);
  });

  it('scopes deduplication by delivery kind', async () => {
    const { session } = await startDaemonWithSession();
    const payload = { sessionId: 'session-1', text: 'same text', operationId: 'op-kind' };
    await expect(send('sessions.prompt', payload)).resolves.toMatchObject({ result: { accepted: true } });
    await expect(send('sessions.steer', payload)).resolves.toMatchObject({ result: { accepted: true } });
    expect(session.sent).toHaveLength(2);
  });

  it('explicitly rejects an ordinary concurrent prompt as SESSION_BUSY while a send is being accepted', async () => {
    const { session } = await startDaemonWithSession({ openSession: false });
    // Hold runtime activation open: the first prompt owns the acceptance lock
    // for that whole window.
    const gate = {};
    gate.released = new Promise((resolve) => { gate.release = resolve; });
    session.activationGate = gate;

    const first = send('sessions.prompt', { sessionId: 'session-1', text: 'first', operationId: 'op-busy-1' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(send('sessions.prompt', { sessionId: 'session-1', text: 'second', operationId: 'op-busy-2' }))
      .rejects.toMatchObject({ code: 'SESSION_BUSY' });

    gate.release();
    await expect(first).resolves.toMatchObject({ result: { accepted: true } });
    // The rejected prompt was never delivered to Pi; the session stays usable.
    await expect(send('sessions.prompt', { sessionId: 'session-1', text: 'third', operationId: 'op-busy-3' }))
      .resolves.toMatchObject({ result: { accepted: true } });
    expect(session.sent.map((entry) => entry.text).filter((text) => text !== 'first')).toEqual(['third']);
  });

  it('does not hold the lock for a whole turn: config and abort proceed while the send promise is pending', async () => {
    const { session } = await startDaemonWithSession();
    const barrier = {};
    barrier.promise = new Promise((resolve) => { barrier.release = resolve; });
    session.sendBarrier = { released: barrier.promise };

    await expect(send('sessions.prompt', { sessionId: 'session-1', text: 'long turn', operationId: 'op-turn' }))
      .resolves.toMatchObject({ result: { accepted: true } });
    expect(session.sent).toHaveLength(1);
    session.isStreaming = true;

    // The send promise is still pending here. A short config write and an
    // abort must both proceed without waiting for the turn.
    await expect(send('sessions.setModel', { sessionId: 'session-1', model: { providerId: 'test', modelId: 'model' } }))
      .resolves.toMatchObject({ result: {} });
    await expect(send('sessions.abort', { sessionId: 'session-1' })).resolves.toMatchObject({ result: {} });
    expect(session.modelApplications).toHaveLength(1);
    expect(session.aborted).toBe(1);

    barrier.release();
    session.sendBarrier = null;
  });

  it('serializes a standalone setModel behind an in-flight send acceptance instead of interleaving', async () => {
    const { session } = await startDaemonWithSession({ openSession: false });
    // Hold activation open: the prompt owns the lock while activating.
    const gate = {};
    gate.released = new Promise((resolve) => { gate.release = resolve; });
    session.activationGate = gate;

    const prompt = send('sessions.prompt', { sessionId: 'session-1', text: 'with config', operationId: 'op-order', model: { providerId: 'test', modelId: 'model' } });
    const config = send('sessions.setModel', { sessionId: 'session-1', model: { providerId: 'test', modelId: 'model' } });

    await new Promise((resolve) => setTimeout(resolve, 50));
    // While the send owns the acceptance lock, the config write did NOT
    // interleave: it is waiting behind the send instead of racing it.
    expect(session.modelApplications).toHaveLength(0);
    expect(session.sent).toHaveLength(0);

    gate.release();
    await prompt;
    await config;
    // The config write applied only after the send's acceptance section.
    expect(session.sent).toHaveLength(1);
    expect(session.modelApplications).toHaveLength(1);
  });

  it('a config failure rejects the send before any Pi invocation', async () => {
    const { session } = await startDaemonWithSession();
    await expect(send('sessions.prompt', {
      sessionId: 'session-1',
      text: 'bad config',
      operationId: 'op-bad-config',
      model: { providerId: 'missing-provider', modelId: 'missing-model' },
    })).rejects.toMatchObject({ code: 'INVALID_MODEL' });
    expect(session.sent).toHaveLength(0);

    // The failed config left nothing behind: an ordinary send still works.
    await expect(send('sessions.prompt', { sessionId: 'session-1', text: 'good config', operationId: 'op-good-config' }))
      .resolves.toMatchObject({ result: { accepted: true } });
    expect(session.sent).toHaveLength(1);

    // The rejection happened before Pi ran, so retrying the same intent id
    // with a valid payload is safe and executes.
    await expect(send('sessions.prompt', {
      sessionId: 'session-1',
      text: 'bad config',
      operationId: 'op-bad-config',
      model: { providerId: 'test', modelId: 'model' },
    })).resolves.toMatchObject({ result: { accepted: true } });
    expect(session.sent).toHaveLength(2);
  });

  it('rejects an expired operation id so the bounded retention contract is observable', async () => {
    const { session } = await startDaemonWithSession({ ttlMs: 30 });
    await expect(send('sessions.prompt', { sessionId: 'session-1', text: 'expires', operationId: 'op-expiry' }))
      .resolves.toMatchObject({ result: { accepted: true } });
    expect(session.sent).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 60));
    // After expiry the same id can never auto-replay: it is rejected as
    // expired (outcome unknown, never assume success). The caller must use
    // a new operation id afterwards.
    await expect(send('sessions.prompt', { sessionId: 'session-1', text: 'expires', operationId: 'op-expiry' }))
      .rejects.toMatchObject({ code: 'OPERATION_EXPIRED' });
    expect(session.sent).toHaveLength(1);
    await expect(send('sessions.sendReceipt', { kind: 'prompt', sessionId: 'session-1', operationId: 'op-expiry' }))
      .resolves.toMatchObject({ result: { status: 'expired' } });
    // A new id is a new intent and executes exactly once.
    await expect(send('sessions.prompt', { sessionId: 'session-1', text: 'expires', operationId: 'op-expiry-2' }))
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

    // Stop the daemon and start a fresh one (fresh in-memory registry).
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

    // Receipts do not survive a restart; the client's runtime-switch contract
    // (no uncertain replay across a verified stream-epoch change) covers this.
    await expect(send('sessions.prompt', payload)).resolves.toMatchObject({ result: { accepted: true } });
    expect(session.sent).toHaveLength(1);
  });

  it('a SESSION_BUSY rejection settles its claim so the same id retries cleanly with exact Pi counts', async () => {
    const { session } = await startDaemonWithSession({ openSession: false });
    const gate = {};
    gate.released = new Promise((resolve) => { gate.release = resolve; });
    session.activationGate = gate;

    const firstPayload = { sessionId: 'session-1', text: 'busy first', operationId: 'op-busy-retry-a' };
    const busyPayload = { sessionId: 'session-1', text: 'busy second', operationId: 'op-busy-retry-b' };
    const first = send('sessions.prompt', firstPayload);
    await new Promise((resolve) => setTimeout(resolve, 25));
    // Different id while the acceptance lock is held: rejected before Pi.
    await expect(send('sessions.prompt', busyPayload)).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    expect(session.sent).toHaveLength(0);

    gate.release();
    await expect(first).resolves.toMatchObject({ result: { accepted: true } });
    expect(session.sent).toHaveLength(1);
    expect(session.sent[0].text).toBe('busy first');

    // The busy rejection freed its id (nothing executed): retrying the same
    // busy id is a new execution, exactly one more Pi call.
    await expect(send('sessions.prompt', busyPayload)).resolves.toMatchObject({ result: { accepted: true } });
    expect(session.sent).toHaveLength(2);
    expect(session.sent[1].text).toBe('busy second');

    // The accepted first id still deduplicates with no further Pi call.
    await expect(send('sessions.prompt', firstPayload))
      .resolves.toMatchObject({ result: { accepted: true, deduplicated: true } });
    expect(session.sent).toHaveLength(2);
  });

  it('rejects a send stamped with a retired streamEpoch before any registry or Pi side effect', async () => {
    const { session } = await startDaemonWithSession();
    const health = await client.request('runtime.health');
    const epoch = health.result.streamEpoch;
    expect(typeof epoch).toBe('string');
    expect(epoch.length).toBeGreaterThan(0);
    const staleEpoch = `${epoch}-retired`;

    // Correct epoch executes exactly once.
    await expect(send('sessions.prompt', { sessionId: 'session-1', text: 'epoch ok', operationId: 'op-epoch-ok', streamEpoch: epoch }))
      .resolves.toMatchObject({ result: { accepted: true } });
    expect(session.sent).toHaveLength(1);

    // Retired epoch is outcome-unknown: rejected, never executed.
    await expect(send('sessions.prompt', { sessionId: 'session-1', text: 'epoch stale', operationId: 'op-epoch-stale', streamEpoch: staleEpoch }))
      .rejects.toMatchObject({ code: 'STALE_STREAM_EPOCH' });
    expect(session.sent).toHaveLength(1);

    // The stale attempt never claimed its id, so the same id with the
    // current epoch is a fresh execution (one more Pi call, not deduplicated).
    const retry = await send('sessions.prompt', { sessionId: 'session-1', text: 'epoch stale', operationId: 'op-epoch-stale', streamEpoch: epoch });
    expect(retry.result).toMatchObject({ accepted: true });
    expect(retry.result.deduplicated).toBeUndefined();
    expect(session.sent).toHaveLength(2);

    // Malformed epoch shapes never reach Pi either.
    await expect(send('sessions.prompt', { sessionId: 'session-1', text: 'epoch bad', operationId: 'op-epoch-bad', streamEpoch: '' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(session.sent).toHaveLength(2);
  });

  it('sessions.sendReceipt enforces exact kind/session/operation/epoch identity without invoking Pi', async () => {
    const { session } = await startDaemonWithSession();
    const health = await client.request('runtime.health');
    const epoch = health.result.streamEpoch;
    const staleEpoch = `${epoch}-retired`;
    const base = { kind: 'prompt', sessionId: 'session-1', operationId: 'op-receipt-exact' };

    await expect(send('sessions.sendReceipt', base)).resolves.toMatchObject({ result: { status: 'unknown', streamEpoch: epoch } });
    expect(session.sent).toHaveLength(0);

    await expect(send('sessions.prompt', { sessionId: 'session-1', text: 'receipt exact', operationId: 'op-receipt-exact' }))
      .resolves.toMatchObject({ result: { accepted: true } });
    expect(session.sent).toHaveLength(1);

    await expect(send('sessions.sendReceipt', base))
      .resolves.toMatchObject({ result: { status: 'accepted', streamEpoch: epoch, receipt: { accepted: true } } });
    // Exact identity: a different delivery kind is a different intent.
    await expect(send('sessions.sendReceipt', { ...base, kind: 'steer' })).resolves.toMatchObject({ result: { status: 'unknown' } });
    await expect(send('sessions.sendReceipt', { ...base, kind: 'followUp' })).resolves.toMatchObject({ result: { status: 'unknown' } });
    // Exact identity: a different session or operation is unknown.
    await expect(send('sessions.sendReceipt', { ...base, sessionId: 'session-other' })).resolves.toMatchObject({ result: { status: 'unknown' } });
    await expect(send('sessions.sendReceipt', { ...base, operationId: 'op-receipt-other' })).resolves.toMatchObject({ result: { status: 'unknown' } });
    // Retired epoch can never confirm: unknown even for a retained receipt.
    await expect(send('sessions.sendReceipt', { ...base, streamEpoch: staleEpoch })).resolves.toMatchObject({ result: { status: 'unknown' } });
    // Current epoch confirms.
    await expect(send('sessions.sendReceipt', { ...base, streamEpoch: epoch }))
      .resolves.toMatchObject({ result: { status: 'accepted' } });
    // Receipt lookups never invoke Pi.
    expect(session.sent).toHaveLength(1);

    // Invalid lookups fail without invoking Pi.
    await expect(send('sessions.sendReceipt', { ...base, kind: 'promptx' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(send('sessions.sendReceipt', { sessionId: 'session-1', operationId: 'op-receipt-exact' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
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

    // After expiry the same id is rejected (never an automatic re-execution).
    await expect(send('sessions.prompt', payload)).rejects.toMatchObject({ code: 'OPERATION_EXPIRED' });
    expect(session.sent).toHaveLength(1);
    // A new operation id is a new intent: exactly one more Pi call.
    const retryPayload = { ...payload, operationId: 'op-receipt-lifecycle-2' };
    const retry = await send('sessions.prompt', retryPayload);
    expect(retry.result).toMatchObject({ accepted: true });
    expect(retry.result.deduplicated).toBeUndefined();
    expect(session.sent).toHaveLength(2);
    await expect(send('sessions.sendReceipt', { ...lookup, operationId: 'op-receipt-lifecycle-2' }))
      .resolves.toMatchObject({ result: { status: 'accepted' } });
  });

  it('tryAcquire creator triple overlap keeps queued configs serialized and rejects a concurrent prompt (thrown config drains)', async () => {
    const { session } = await startDaemonWithSession({ openSession: false });
    const gate = {};
    gate.released = new Promise((resolve) => { gate.release = resolve; });
    session.activationGate = gate;
    // Hold the first queued config inside setModel so the race window stays
    // open deterministically: P1 holds via activation, C1 holds via model.
    const modelGate = {};
    modelGate.released = new Promise((resolve) => { modelGate.release = resolve; });
    const originalSetModel = session.setModel.bind(session);
    let setModelCalls = 0;
    session.setModel = async (model) => {
      setModelCalls += 1;
      if (setModelCalls === 1) await modelGate.released;
      return originalSetModel(model);
    };
    const validModel = { providerId: 'test', modelId: 'model' };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (predicate) => {
      const start = Date.now();
      while (!predicate()) {
        if (Date.now() - start > 2000) throw new Error('Timed out waiting for lock state');
        await sleep(5);
      }
    };

    // Triple overlap: P1 (tryAcquire holder) + C1 (valid waiter) + C2
    // (invalid waiter that throws). P1 carries no inline model so only the
    // queued configs touch setModel.
    const prompt = send('sessions.prompt', { sessionId: 'session-1', text: 'first', operationId: 'op-tri-acquire-1' });
    await sleep(25);
    const config1 = send('sessions.setModel', { sessionId: 'session-1', model: validModel });
    const config2 = send('sessions.setModel', { sessionId: 'session-1', model: { providerId: 'missing-provider', modelId: 'missing-model' } });
    await sleep(50);
    expect(session.sent).toHaveLength(0);
    expect(setModelCalls).toBe(0);

    gate.release();
    // P1 accepts, releases, then C1 starts and blocks in setModel while C2
    // stays queued behind it.
    await waitFor(() => session.sent.length === 1 && setModelCalls === 1);
    // The lock entry must survive P1's release while waiters drain: a new
    // prompt arriving now is concurrent with queued config work and must be
    // rejected, never interleaved. With the premature-delete race this
    // resolves accepted on a fresh entry concurrently with C1.
    await expect(send('sessions.prompt', { sessionId: 'session-1', text: 'probe', operationId: 'op-tri-acquire-probe' }))
      .rejects.toMatchObject({ code: 'SESSION_BUSY' });
    expect(session.sent).toHaveLength(1);

    modelGate.release();
    await expect(prompt).resolves.toMatchObject({ result: { accepted: true } });
    await expect(config1).resolves.toMatchObject({ result: {} });
    await expect(config2).rejects.toMatchObject({ code: 'INVALID_MODEL' });
    // Only the valid config reached Pi; the thrown config still released.
    expect(session.modelApplications).toHaveLength(1);
    // The last waiter drained and cleaned up: the session stays usable.
    await expect(send('sessions.prompt', { sessionId: 'session-1', text: 'after', operationId: 'op-tri-acquire-after' }))
      .resolves.toMatchObject({ result: { accepted: true } });
    expect(session.sent).toHaveLength(2);
  });

  it('withSession creator triple overlap keeps queued configs serialized and rejects a concurrent prompt (thrown config drains)', async () => {
    const { session } = await startDaemonWithSession({ openSession: false });
    const gate = {};
    gate.released = new Promise((resolve) => { gate.release = resolve; });
    session.activationGate = gate;
    // Hold the second config (first waiter) so the probe lands while a
    // waiter still owns the queue: C0 completes first, C1 blocks, C2 throws.
    const modelGate = {};
    modelGate.released = new Promise((resolve) => { modelGate.release = resolve; });
    const originalSetModel = session.setModel.bind(session);
    let setModelCalls = 0;
    session.setModel = async (model) => {
      setModelCalls += 1;
      if (setModelCalls === 2) await modelGate.released;
      return originalSetModel(model);
    };
    const validModel = { providerId: 'test', modelId: 'model' };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (predicate) => {
      const start = Date.now();
      while (!predicate()) {
        if (Date.now() - start > 2000) throw new Error('Timed out waiting for lock state');
        await sleep(5);
      }
    };

    // Triple overlap: C0 (withSession creator) + C1 (valid waiter) + C2
    // (invalid waiter that throws).
    const creator = send('sessions.setModel', { sessionId: 'session-1', model: validModel });
    await sleep(25);
    const waiter = send('sessions.setModel', { sessionId: 'session-1', model: validModel });
    const thrown = send('sessions.setModel', { sessionId: 'session-1', model: { providerId: 'missing-provider', modelId: 'missing-model' } });
    await sleep(50);
    expect(setModelCalls).toBe(0);
    expect(session.sent).toHaveLength(0);

    gate.release();
    // C0 finishes, C1 starts and blocks in setModel while C2 stays queued.
    await waitFor(() => setModelCalls === 2);
    // The creator entry must survive until the last waiter drains: a prompt
    // arriving now is concurrent with queued config work and must be
    // rejected. With the premature-delete race this resolves accepted on a
    // fresh entry concurrently with C1.
    await expect(send('sessions.prompt', { sessionId: 'session-1', text: 'probe', operationId: 'op-tri-creator-probe' }))
      .rejects.toMatchObject({ code: 'SESSION_BUSY' });
    expect(session.sent).toHaveLength(0);

    modelGate.release();
    await expect(creator).resolves.toMatchObject({ result: {} });
    await expect(waiter).resolves.toMatchObject({ result: {} });
    await expect(thrown).rejects.toMatchObject({ code: 'INVALID_MODEL' });
    // Both valid configs reached Pi exactly once; the thrown config still
    // released the queue.
    expect(session.modelApplications).toHaveLength(2);
    // The last waiter drained and cleaned up: the session stays usable.
    await expect(send('sessions.prompt', { sessionId: 'session-1', text: 'after', operationId: 'op-tri-creator-after' }))
      .resolves.toMatchObject({ result: { accepted: true } });
    expect(session.sent).toHaveLength(1);
  });

  it('an abort during acceptance cancels the send before Pi runs and leaves the session usable', async () => {
    const { session } = await startDaemonWithSession({ openSession: false });
    const gate = {};
    gate.released = new Promise((resolve) => { gate.release = resolve; });
    session.activationGate = gate;
    const payload = { sessionId: 'session-1', text: 'abort me', operationId: 'op-abort-barrier' };

    const pendingSend = send('sessions.prompt', payload);
    await new Promise((resolve) => setTimeout(resolve, 25));
    // Abort while the send holds the acceptance lock: marks ONLY this
    // acceptance. The abort request itself blocks on the same gate via the
    // shared activation inflight, so release after it is in flight.
    const pendingAbort = send('sessions.abort', { sessionId: 'session-1' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    gate.release();

    await expect(pendingSend).rejects.toMatchObject({ code: 'SESSION_ABORTED' });
    await expect(pendingAbort).resolves.toMatchObject({ result: {} });
    // Cancelled before Pi: zero invocations, id freed (nothing executed).
    expect(session.sent).toHaveLength(0);
    await expect(send('sessions.sendReceipt', { kind: 'prompt', sessionId: 'session-1', operationId: 'op-abort-barrier' }))
      .resolves.toMatchObject({ result: { status: 'unknown' } });

    // Delayed abort did not poison the session: the same id retries cleanly
    // and a new id executes; exactly two Pi calls total, no stray abort kill.
    await expect(send('sessions.prompt', payload)).resolves.toMatchObject({ result: { accepted: true } });
    expect(session.sent).toHaveLength(1);
    await expect(send('sessions.prompt', { sessionId: 'session-1', text: 'after abort', operationId: 'op-abort-after' }))
      .resolves.toMatchObject({ result: { accepted: true } });
    expect(session.sent).toHaveLength(2);
  });
});
