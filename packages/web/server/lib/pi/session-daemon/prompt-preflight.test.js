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
  if (process.platform === 'win32') return `\\\\.\\pipe\\pichamber-preflight-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return join(root, 'daemon.sock');
}

class FakeSession {
  constructor(sessionId, sessionFile) {
    this.sessionId = sessionId;
    this.sessionFile = sessionFile;
    this.isStreaming = false;
    this.listeners = new Set();
    this.names = [];
    this.entries = [];
    this.promptCalls = [];
    this.sent = [];
    this.aborted = 0;
    this.model = { provider: 'test', id: 'model' };
    this.thinkingLevel = 'low';
    this.promptImpl = null;
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

  async prompt(text, options) {
    this.promptCalls.push({ text, options });
    if (this.promptImpl) return this.promptImpl(text, options);
    options?.preflightResult?.(true);
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
            reject(Object.assign(new Error(code), { code, detail: message.error }));
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

describe('prompt preflight acceptance', () => {
  const roots = [];
  const daemons = [];
  let client;
  let currentEndpoint;

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

  const startDaemonWithSession = async ({ openSession = true } = {}) => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-preflight-'));
    roots.push(root);
    const endpoint = testDaemonEndpoint(root);
    const sessionFile = join(root, 'session-1.jsonl');
    await writeFile(sessionFile, `{"type":"session","id":"session-1","cwd":"${root}"}\n`);
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
    currentEndpoint = endpoint;
    client = connectClient(endpoint);
    await client.authenticate();
    if (openSession) await client.request('sessions.open', { sessionId: 'session-1' });
    return { session, endpoint, root, sessionFile };
  };

  it('preflight rejection is propagated, not cached as accepted, and id is reusable', async () => {
    const { session } = await startDaemonWithSession();
    let calls = 0;
    session.promptImpl = async (text, options) => {
      calls += 1;
      if (calls === 1) {
        options?.preflightResult?.(false);
        throw new Error('Cannot submit a prompt while compaction is in progress.');
      }
      options?.preflightResult?.(true);
    };

    const payload = { sessionId: 'session-1', text: 'hello preflight', operationId: 'op-preflight-reuse' };
    // Generic SDK preflight errors surface as INVALID_REQUEST over IPC today;
    // the contract is rejection (not accepted) with a reusable id.
    await expect(send('sessions.prompt', payload)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(session.promptCalls).toHaveLength(1);

    const retry = await send('sessions.prompt', payload);
    expect(retry.result).toMatchObject({ accepted: true });
    expect(retry.result.deduplicated).toBeUndefined();
    expect(session.promptCalls).toHaveLength(2);
  });

  it('concurrent duplicates share one pending preflight outcome without double execution', async () => {
    const { session } = await startDaemonWithSession();
    let releasePreflight;
    const preflightGate = new Promise((resolve) => { releasePreflight = resolve; });
    let releaseTurn;
    const turnGate = new Promise((resolve) => { releaseTurn = resolve; });
    session.promptImpl = async (text, options) => {
      await preflightGate;
      options?.preflightResult?.(true);
      await turnGate;
    };

    const payload = { sessionId: 'session-1', text: 'shared preflight', operationId: 'op-preflight-shared' };
    const first = send('sessions.prompt', payload);
    // Let the first claim reach the daemon before the duplicate arrives.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const duplicate = send('sessions.prompt', payload);
    // Still waiting on preflight: Pi must have been invoked once, and neither
    // caller has an acceptance yet.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.promptCalls).toHaveLength(1);
    let settled = 0;
    first.then(() => { settled += 1; }, () => { settled += 1; });
    duplicate.then(() => { settled += 1; }, () => { settled += 1; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(0);

    releasePreflight();
    // Preflight acceptance resolves both callers before the long turn finishes.
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    expect(firstResult.result).toMatchObject({ accepted: true, messageId: 'fake-entry' });
    expect(duplicateResult.result).toMatchObject({ accepted: true, messageId: 'fake-entry' });
    expect([firstResult.result.deduplicated, duplicateResult.result.deduplicated]).toContain(true);
    expect(session.promptCalls).toHaveLength(1);
    releaseTurn();
  });

  it('acceptance returns after preflight but before the long turn finishes, with plain/rpc prompt shapes', async () => {
    const { session } = await startDaemonWithSession();
    let finishPlain;
    const plainGate = new Promise((resolve) => { finishPlain = resolve; });
    session.promptImpl = async (text, options) => {
      options?.preflightResult?.(true);
      await plainGate;
    };

    const plainResponse = await client.request('sessions.prompt', {
      sessionId: 'session-1',
      text: 'plain hello',
      messageId: 'msg-plain',
    });
    expect(plainResponse.result).toEqual({ accepted: true, messageId: 'msg-plain' });
    expect(session.promptCalls).toHaveLength(1);
    expect(session.promptCalls[0].text).toBe('plain hello');
    expect(session.promptCalls[0].options).toMatchObject({
      expandPromptTemplates: false,
      source: 'extension',
    });
    expect(session.promptCalls[0].options.preflightResult).toEqual(expect.any(Function));
    finishPlain();

    let finishSlash;
    const slashGate = new Promise((resolve) => { finishSlash = resolve; });
    session.promptImpl = async (text, options) => {
      options?.preflightResult?.(true);
      await slashGate;
    };
    // A second prompt needs a fresh generation; the first turn already settled
    // via the gate above, so the daemon accepts the slash command as a new turn.
    // Note: the fake never sets isStreaming, so no deliverAs is required.
    const slashResponse = await client.request('sessions.prompt', {
      sessionId: 'session-1',
      text: '/help arg',
      messageId: 'msg-slash',
    });
    expect(slashResponse.result).toEqual({ accepted: true, messageId: 'msg-slash' });
    const slashCall = session.promptCalls[session.promptCalls.length - 1];
    expect(slashCall.text).toBe('/help arg');
    expect(slashCall.options).toMatchObject({ source: 'rpc' });
    expect(slashCall.options.expandPromptTemplates).not.toBe(false);
    expect(slashCall.options.preflightResult).toEqual(expect.any(Function));
    finishSlash();
  });

  it('queued attachment metadata survives prompt resolution until the actual user start', async () => {
    const { session, root } = await startDaemonWithSession();
    const imageFile = join(root, 'queued.png');
    await writeFile(imageFile, Buffer.from('queued-png-data'));
    session.isStreaming = true;
    session.promptImpl = async (text, options) => {
      // SDK queued sends resolve immediately after preflight acceptance,
      // long before the queued user message starts.
      options?.preflightResult?.(true);
    };

    const response = await client.request('sessions.followUp', {
      sessionId: 'session-1',
      text: 'queued with image',
      attachments: [{ name: 'queued.png', mime: 'image/png', path: imageFile, size: 15 }],
      messageId: 'msg-queued',
    });
    expect(response.result).toEqual({ accepted: true, messageId: 'msg-queued' });
    expect(session.promptCalls).toHaveLength(1);
    expect(session.promptCalls[0].text).toBe('queued with image');
    expect(session.promptCalls[0].options).toMatchObject({
      expandPromptTemplates: false,
      source: 'extension',
      streamingBehavior: 'followUp',
    });
    expect(session.promptCalls[0].options.images).toEqual([
      { type: 'image', mimeType: 'image/png', data: Buffer.from('queued-png-data').toString('base64') },
    ]);

    // The queued prompt promise already resolved, but the file metadata must
    // still attach to the later user start (per-delivery preserved).
    const userStart = client.next((frame) => frame.event === 'assistant.message.start'
      && frame.payload?.role === 'user'
      && frame.payload?.text === 'queued with image');
    session.emit({ type: 'message_start', message: { role: 'user', content: 'queued with image', timestamp: 2_000 } });
    await expect(userStart).resolves.toMatchObject({
      payload: {
        role: 'user',
        text: 'queued with image',
        files: [{ type: 'file', mime: 'image/png', filename: 'queued.png' }],
      },
    });
  });

  it('rejects invalid send operation ttl with INVALID_SEND_OPERATION_TTL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-preflight-'));
    roots.push(root);
    const endpoint = testDaemonEndpoint(root);
    expect(() => createSessionDaemon({ endpoint, credential, cwd: root, sendOperationTtlMs: 0 }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_SEND_OPERATION_TTL' }));
    expect(() => createSessionDaemon({ endpoint, credential, cwd: root, sendOperationTtlMs: -5 }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_SEND_OPERATION_TTL' }));
  });

  it('idle followUp that turns busy during prepare still carries streamingBehavior', async () => {
    const { session } = await startDaemonWithSession();
    session.modelRuntime = {
      getModel: (providerId, modelId) => ({ provider: providerId, id: modelId }),
      getModels: () => [{ provider: 'test', id: 'model' }],
    };
    let releaseModel;
    const modelGate = new Promise((resolve) => { releaseModel = resolve; });
    let enteredModel = false;
    const originalSetModel = session.setModel.bind(session);
    session.setModel = async (model) => {
      enteredModel = true;
      await modelGate;
      return originalSetModel(model);
    };
    session.promptImpl = async (text, options) => {
      // Faithful SDK edge: streaming without an explicit behavior rejects.
      if (session.isStreaming && !options?.streamingBehavior) {
        options?.preflightResult?.(false);
        throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
      }
      options?.preflightResult?.(true);
    };
    // Arrives idle, so the early guard does not reject; it then blocks in
    // setModel while another sender starts the turn.
    const pending = send('sessions.followUp', {
      sessionId: 'session-1',
      text: 'racing followUp',
      model: { providerId: 'test', modelId: 'model' },
      messageId: 'msg-race-follow',
    });
    while (!enteredModel) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(session.isStreaming).toBe(false);
    session.isStreaming = true;
    releaseModel();
    const response = await pending;
    expect(response.result).toEqual({ accepted: true, messageId: 'msg-race-follow' });
    expect(session.promptCalls).toHaveLength(1);
    expect(session.promptCalls[0].options.streamingBehavior).toBe('followUp');
  });

  it('idle steer that turns busy during prepare still carries streamingBehavior', async () => {
    const { session } = await startDaemonWithSession();
    session.modelRuntime = {
      getModel: (providerId, modelId) => ({ provider: providerId, id: modelId }),
      getModels: () => [{ provider: 'test', id: 'model' }],
    };
    let releaseModel;
    const modelGate = new Promise((resolve) => { releaseModel = resolve; });
    let enteredModel = false;
    const originalSetModel = session.setModel.bind(session);
    session.setModel = async (model) => {
      enteredModel = true;
      await modelGate;
      return originalSetModel(model);
    };
    session.promptImpl = async (text, options) => {
      if (session.isStreaming && !options?.streamingBehavior) {
        options?.preflightResult?.(false);
        throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
      }
      options?.preflightResult?.(true);
    };
    const pending = send('sessions.steer', {
      sessionId: 'session-1',
      text: 'racing steer',
      model: { providerId: 'test', modelId: 'model' },
      messageId: 'msg-race-steer',
    });
    while (!enteredModel) await new Promise((resolve) => setTimeout(resolve, 5));
    session.isStreaming = true;
    releaseModel();
    const response = await pending;
    expect(response.result).toEqual({ accepted: true, messageId: 'msg-race-steer' });
    expect(session.promptCalls).toHaveLength(1);
    expect(session.promptCalls[0].options.streamingBehavior).toBe('steer');
  });

  it('followUp then steer overtake keeps attachment footers per delivery queue', async () => {
    const { session, root } = await startDaemonWithSession();
    const followFile = join(root, 'follow.png');
    const steerFile = join(root, 'steer.png');
    await writeFile(followFile, Buffer.from('follow-png-data'));
    await writeFile(steerFile, Buffer.from('steer-png-data'));
    session.isStreaming = true;
    session.promptImpl = async (text, options) => {
      options?.preflightResult?.(true);
    };
    const followResponse = await client.request('sessions.followUp', {
      sessionId: 'session-1',
      text: 'follow text',
      attachments: [{ name: 'follow.png', mime: 'image/png', path: followFile, size: 14 }],
      messageId: 'msg-follow',
    });
    expect(followResponse.result).toEqual({ accepted: true, messageId: 'msg-follow' });
    const steerResponse = await client.request('sessions.steer', {
      sessionId: 'session-1',
      text: 'steer text',
      attachments: [{ name: 'steer.png', mime: 'image/png', path: steerFile, size: 13 }],
      messageId: 'msg-steer',
    });
    expect(steerResponse.result).toEqual({ accepted: true, messageId: 'msg-steer' });
    expect(session.promptCalls).toHaveLength(2);
    expect(session.promptCalls[0].options.streamingBehavior).toBe('followUp');
    expect(session.promptCalls[1].options.streamingBehavior).toBe('steer');
    // SDK enqueue order then steering-first drain order. The daemon learns
    // ownership only from authoritative `queue_update` shrinks, never text.
    session.emit({ type: 'queue_update', steering: [], followUp: ['follow text'] });
    session.emit({ type: 'queue_update', steering: ['steer text'], followUp: ['follow text'] });
    // Steering overtakes: it starts first even though it was sent second.
    session.emit({ type: 'queue_update', steering: [], followUp: ['follow text'] });
    const steerStart = client.next((frame) => frame.event === 'assistant.message.start'
      && frame.payload?.role === 'user' && frame.payload?.text === 'steer text');
    session.emit({ type: 'message_start', message: { role: 'user', content: 'steer text', timestamp: 3_000 } });
    await expect(steerStart).resolves.toMatchObject({
      payload: {
        role: 'user',
        text: 'steer text',
        files: [{ type: 'file', mime: 'image/png', filename: 'steer.png' }],
      },
    });
    session.emit({ type: 'queue_update', steering: [], followUp: [] });
    const followStart = client.next((frame) => frame.event === 'assistant.message.start'
      && frame.payload?.role === 'user' && frame.payload?.text === 'follow text');
    session.emit({ type: 'message_start', message: { role: 'user', content: 'follow text', timestamp: 3_001 } });
    await expect(followStart).resolves.toMatchObject({
      payload: {
        role: 'user',
        text: 'follow text',
        files: [{ type: 'file', mime: 'image/png', filename: 'follow.png' }],
      },
    });
  });

  it('idle handled extension followUp does not leave stale metadata for the next prompt', async () => {
    const { session, root } = await startDaemonWithSession();
    const extFile = join(root, 'ext.png');
    const nextFile = join(root, 'next.png');
    await writeFile(extFile, Buffer.from('ext-png-data'));
    await writeFile(nextFile, Buffer.from('next-png-data'));
    session.extensionRunner = { getRegisteredCommands: () => [{ invocationName: 'mycmd' }] };
    let finishNext;
    const nextGate = new Promise((resolve) => { finishNext = resolve; });
    session.promptImpl = async (text, options) => {
      options?.preflightResult?.(true);
      // Handled extension commands resolve without a user start; ordinary
      // new-turn prompts stay pending until their start arrives.
      if (typeof text === 'string' && text.startsWith('/mycmd')) return;
      await nextGate;
    };
    const extResponse = await client.request('sessions.followUp', {
      sessionId: 'session-1',
      text: '/mycmd arg',
      attachments: [{ name: 'ext.png', mime: 'image/png', path: extFile, size: 12 }],
      messageId: 'msg-ext',
    });
    expect(extResponse.result).toEqual({ accepted: true, messageId: 'msg-ext' });
    // Let the handled resolution clean its still-pending entry before the
    // next send enqueues.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pendingNext = client.request('sessions.prompt', {
      sessionId: 'session-1',
      text: 'next hello',
      attachments: [{ name: 'next.png', mime: 'image/png', path: nextFile, size: 13 }],
      messageId: 'msg-next',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const nextStart = client.next((frame) => frame.event === 'assistant.message.start'
      && frame.payload?.role === 'user' && frame.payload?.text === 'next hello');
    session.emit({ type: 'message_start', message: { role: 'user', content: 'next hello', timestamp: 4_000 } });
    await expect(nextStart).resolves.toMatchObject({
      payload: {
        role: 'user',
        text: 'next hello',
        files: [{ type: 'file', mime: 'image/png', filename: 'next.png' }],
      },
    });
    finishNext();
    await expect(pendingNext).resolves.toMatchObject({ result: { accepted: true, messageId: 'msg-next' } });
  });
});
