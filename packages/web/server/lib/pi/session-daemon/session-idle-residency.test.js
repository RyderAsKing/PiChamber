import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { createSessionDaemon as createSessionDaemonImpl } from './session-daemon.js';

const credential = 'a-private-daemon-credential';

function createSessionDaemon(options) {
  return createSessionDaemonImpl({ ...options, agentDir: options.agentDir ?? options.cwd });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 5_000, intervalMs = 10, message = 'Timed out' } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      if (await predicate()) {
        return true;
      }
    } catch {
      // Retry until the timeout expires.
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(message);
    }
    await sleep(intervalMs);
  }
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

class FakeSession {
  constructor(sessionId = 'pi-session-1', sessionFile, entries = []) {
    this.sessionId = sessionId;
    this.isStreaming = false;
    this.isCompacting = false;
    this.listeners = new Set();
    this.names = [];
    this.entries = entries;
    this.sent = [];
    this.aborted = 0;
    this.compacted = 0;
    this.pendingSend = undefined;
    this.model = { provider: 'test', id: 'model' };
    this.thinkingLevel = 'low';
    this.sessionManager = {
      getSessionFile: () => sessionFile,
      getHeader: () => ({ timestamp: '2026-01-01T00:00:00.000Z' }),
      getEntries: () => this.entries,
      getEntry: (entryId) => this.entries.find((candidate) => candidate.id === entryId),
      getLeafId: () => 'fake-entry',
      getTree: () => [
        {
          entry: { id: 'fake-entry', parentId: undefined, timestamp: '2026-01-01T00:00:00.000Z' },
          children: [],
        },
      ],
      appendSessionInfo: (name) => this.names.push(name),
      getSessionName: () => this.names[this.names.length - 1],
    };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async prompt(text, options) {
    options?.preflightResult?.(true);
    const deliverAs = options?.streamingBehavior;
    this.sent.push({ text, options: deliverAs ? { deliverAs } : undefined });
    if (this.pendingSend) {
      await this.pendingSend;
    }
  }

  async sendUserMessage(text, options) {
    this.sent.push({ text, options });
    if (this.pendingSend) {
      await this.pendingSend;
    }
  }

  async setModel(model) {
    this.model = model;
  }

  setThinkingLevel(thinkingLevel) {
    this.thinkingLevel = thinkingLevel;
  }

  async abort() {
    this.aborted += 1;
    this.isStreaming = false;
  }

  async compact() {
    this.compacted += 1;
  }

  async navigateTree(messageId) {
    this.navigatedTo = messageId;
    return { cancelled: false };
  }

  getSteeringMessages() {
    return [];
  }

  getFollowUpMessages() {
    return [];
  }
}

class FakeRuntime {
  constructor({ cwd, session }) {
    this.cwd = cwd;
    this.session = session;
    this.disposed = false;
  }

  async dispose() {
    this.disposed = true;
  }
}

function createUserMessageEntry(entryId, text) {
  return {
    type: 'message',
    id: entryId,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'user',
      content: text,
      timestamp: Date.parse('2026-01-01T00:00:00.000Z'),
    },
  };
}

function createSessionHeaderLine(sessionId, cwd) {
  const header = {
    type: 'session',
    id: sessionId,
    cwd,
    timestamp: '2026-01-01T00:00:00.000Z',
  };
  return `${JSON.stringify(header)}\n`;
}

function testDaemonEndpoint(root) {
  if (process.platform === 'win32') {
    const pipeHash = createHash('sha1').update(root).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\pichamber-test-${pipeHash}`;
  }
  return join(root, 'daemon.sock');
}

function connectDaemonClient(endpoint) {
  const socket = createConnection({ path: endpoint });
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const messages = [];
  const waiters = [];

  const publishMessage = (message) => {
    messages.push(message);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter.predicate(message)) {
        waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  };

  const failPendingWaiters = (error) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };

  socket.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        publishMessage(JSON.parse(line));
      }
    }
  });
  socket.on('close', () => {
    failPendingWaiters(new Error('Daemon connection closed'));
  });

  const waitForMessage = (predicate) => {
    const hit = messages.find(predicate);
    if (hit) {
      return Promise.resolve(hit);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (message) => {
          clearTimeout(waiter.timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(waiter.timer);
          reject(error);
        },
      };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) {
          waiters.splice(index, 1);
        }
        reject(new Error('Timed out waiting for daemon message'));
      }, 5_000);
      waiters.push(waiter);
    });
  };

  return {
    socket,
    waitForMessage,
    async authenticate(credentialOverride = credential) {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write(`${JSON.stringify({ kind: 'authenticate', credential: credentialOverride })}\n`);
      await waitForMessage((message) => message.kind === 'authenticated');
      return waitForMessage((message) => message.kind === 'event' && message.event === 'session.snapshot');
    },
    request(command, payload = {}) {
      const requestId = `request-${Math.random()}`;
      const frame = {
        protocolVersion: 1,
        kind: 'request',
        requestId,
        command,
        payload,
      };
      socket.write(`${JSON.stringify(frame)}\n`);
      return waitForMessage((message) => message.kind === 'response' && message.requestId === requestId);
    },
    async close() {
      failPendingWaiters(new Error('Daemon client closed'));
      if (socket.destroyed) {
        return;
      }
      socket.end();
      await Promise.race([
        new Promise((resolve) => socket.once('close', resolve)),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    },
  };
}

describe('Pi session daemon idle residency', () => {
  let daemon;
  const temporaryRoots = new Set();
  const connectedClients = new Set();

  const createTemporaryRoot = async (prefix) => {
    const root = await mkdtemp(join(tmpdir(), prefix));
    temporaryRoots.add(root);
    return root;
  };

  const connectAuthenticatedClient = async (endpoint) => {
    const client = connectDaemonClient(endpoint);
    connectedClients.add(client);
    await client.authenticate();
    return client;
  };

  const createPendingClient = (endpoint) => {
    const client = connectDaemonClient(endpoint);
    connectedClients.add(client);
    return client;
  };

  const openSession = (client, sessionId, directory) => {
    if (directory) {
      return client.request('sessions.open', { sessionId, directory });
    }
    return client.request('sessions.open', { sessionId });
  };

  const isExpectedSocketClosure = (error) => /Daemon (connection closed|client closed)/.test(error?.message ?? '');

  async function expectRequestFailure(requestPromise) {
    try {
      await expect(requestPromise).rejects.toThrow();
    } catch (error) {
      if (!isExpectedSocketClosure(error)) {
        throw error;
      }
    }
  }

  async function startSingleSessionDaemon(prefix, sessionId, idleTimeoutMs, createRuntimeOverride) {
    const root = await createTemporaryRoot(prefix);
    const endpoint = testDaemonEndpoint(root);
    const sessionFile = join(root, 'session.jsonl');
    await writeFile(sessionFile, createSessionHeaderLine(sessionId, root));

    const runtimes = [];
    const defaultCreateRuntime = async (daemonOptions) => {
      const runtimeCwd = typeof daemonOptions?.cwd === 'string' && daemonOptions.cwd.length > 0
        ? daemonOptions.cwd
        : root;
      const runtime = new FakeRuntime({
        cwd: runtimeCwd,
        session: new FakeSession(sessionId, sessionFile),
      });
      runtimes.push(runtime);
      return runtime;
    };
    const createRuntimeFactory = createRuntimeOverride ?? defaultCreateRuntime;
    const trackedCreateRuntime = async (...args) => {
      const runtime = await createRuntimeFactory(...args);
      if (!runtimes.includes(runtime)) {
        runtimes.push(runtime);
      }
      return runtime;
    };

    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      idleTimeoutMs,
      listSessions: async () => [{ path: sessionFile, id: sessionId, cwd: root }],
      createRuntime: trackedCreateRuntime,
    });
    await daemon.start();
    return { root, endpoint, sessionFile, runtimes };
  }

  afterEach(async () => {
    for (const client of [...connectedClients]) {
      connectedClients.delete(client);
      await client.close().catch(() => {});
    }
    await daemon?.stop().catch(() => {});
    daemon = undefined;
    for (const root of [...temporaryRoots]) {
      temporaryRoots.delete(root);
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('disposes browse-only sessions after the idle timeout and reopens them from JSONL', async () => {
    const sessionCount = 20;
    const root = await createTemporaryRoot('pichamber-pi-daemon-idle-residency-');
    const endpoint = testDaemonEndpoint(root);
    const sessionFiles = [];
    for (let index = 0; index < sessionCount; index += 1) {
      const sessionId = `idle-session-${index}`;
      const sessionPath = join(root, `idle-${index}.jsonl`);
      await writeFile(sessionPath, createSessionHeaderLine(sessionId, root));
      sessionFiles.push({ path: sessionPath, id: sessionId, cwd: root });
    }

    const runtimes = [];
    const createdRuntimes = [];
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      idleTimeoutMs: 600,
      listSessions: async () => sessionFiles,
      createRuntime: async (daemonOptions) => {
        createdRuntimes.push(daemonOptions);
        const matchedFile = sessionFiles.find((candidate) => candidate.path === daemonOptions.sessionFile);
        const runtimeCwd = typeof daemonOptions?.cwd === 'string' && daemonOptions.cwd.length > 0
          ? daemonOptions.cwd
          : root;
        const runtime = new FakeRuntime({
          cwd: runtimeCwd,
          session: new FakeSession(
            matchedFile.id,
            matchedFile.path,
            [createUserMessageEntry(`entry-${matchedFile.id}`, `hello ${matchedFile.id}`)],
          ),
        });
        runtimes.push(runtime);
        return runtime;
      },
    });
    await daemon.start();

    const client = await connectAuthenticatedClient(endpoint);
    for (const sessionFile of sessionFiles) {
      const opened = await openSession(client, sessionFile.id, root);
      expect(opened.result.session.id).toBe(sessionFile.id);
    }
    expect(runtimes.filter((runtime) => !runtime.disposed)).toHaveLength(sessionCount);
    expect(createdRuntimes).toHaveLength(sessionCount);

    await waitFor(() => runtimes.every((runtime) => runtime.disposed), {
      timeoutMs: 8_000,
      message: 'browse-only sessions were not disposed',
    });
    for (const sessionFile of sessionFiles) {
      await expect(stat(sessionFile.path)).resolves.toMatchObject({ isFile: expect.any(Function) });
    }

    const reopened = await openSession(client, sessionFiles[0].id, root);
    expect(reopened.result.session.id).toBe(sessionFiles[0].id);
    expect(reopened.result.messages).toHaveLength(1);
    expect(reopened.result.messages[0].message.text).toBe(`hello ${sessionFiles[0].id}`);
    expect(createdRuntimes).toHaveLength(sessionCount + 1);
  });

  it('rearms the idle timer on repeated view-only opens', async () => {
    const { root, endpoint, runtimes } = await startSingleSessionDaemon(
      'pichamber-pi-daemon-idle-touch-',
      'touch-session',
      300,
    );
    const client = await connectAuthenticatedClient(endpoint);
    await openSession(client, 'touch-session', root);
    await sleep(100);
    await openSession(client, 'touch-session', root);
    await sleep(100);
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0].disposed).toBe(false);
    await waitFor(() => runtimes[0].disposed === true, {
      message: 're-armed idle timer never disposed',
    });
  });

  it('protects an active prompt and its retry window from idle disposal', async () => {
    const root = await createTemporaryRoot('pichamber-pi-daemon-idle-active-');
    const endpoint = testDaemonEndpoint(root);
    const sessionFile = join(root, 'session.jsonl');
    await writeFile(sessionFile, createSessionHeaderLine('active-session', root));

    const session = new FakeSession('active-session', sessionFile);
    const sendGate = createDeferred();
    session.pendingSend = sendGate.promise;
    const runtime = new FakeRuntime({ cwd: root, session });
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      idleTimeoutMs: 200,
      listSessions: async () => [{ path: sessionFile, id: 'active-session', cwd: root }],
      createRuntime: async () => runtime,
    });
    await daemon.start();

    const client = await connectAuthenticatedClient(endpoint);
    await openSession(client, 'active-session', root);
    await expect(
      client.request('sessions.prompt', { sessionId: 'active-session', text: 'do work' }),
    ).resolves.toMatchObject({ result: { accepted: true } });

    session.isStreaming = true;
    session.emit({ type: 'agent_start' });
    await sleep(350);
    expect(runtime.disposed).toBe(false);

    session.emit({
      type: 'auto_retry_start',
      attempt: 1,
      delayMs: 1_000,
      errorMessage: 'transient failure',
    });
    await sleep(350);
    expect(runtime.disposed).toBe(false);

    sendGate.resolve();
    session.isStreaming = false;
    session.emit({ type: 'agent_settled' });
    await waitFor(() => runtime.disposed === true, {
      message: 'settled session was not disposed',
    });
  });

  it('rejects an unknown session without arming disposal for it', async () => {
    const root = await createTemporaryRoot('pichamber-pi-daemon-idle-failed-');
    const endpoint = testDaemonEndpoint(root);
    let creations = 0;
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      idleTimeoutMs: 200,
      listSessions: async () => [],
      createRuntime: async () => {
        creations += 1;
        return new FakeRuntime({ cwd: root, session: new FakeSession('missing', undefined) });
      },
    });
    await daemon.start();

    const client = await connectAuthenticatedClient(endpoint);
    await expect(openSession(client, 'missing')).rejects.toThrow();
    expect(creations).toBe(0);
  });

  it('shares one runtime for concurrent opens and disposes it on shutdown', async () => {
    const createDelayedRuntime = async (daemonOptions) => {
      await sleep(20);
      const runtimeCwd = typeof daemonOptions?.cwd === 'string' && daemonOptions.cwd.length > 0
        ? daemonOptions.cwd
        : undefined;
      const sessionFile = typeof daemonOptions?.sessionFile === 'string'
        ? daemonOptions.sessionFile
        : join(runtimeCwd ?? '', 'session.jsonl');
      return new FakeRuntime({
        cwd: runtimeCwd,
        session: new FakeSession('shared-session', sessionFile),
      });
    };
    const { endpoint, root, runtimes } = await startSingleSessionDaemon(
      'pichamber-pi-daemon-idle-shutdown-',
      'shared-session',
      10_000,
      createDelayedRuntime,
    );

    const firstClient = createPendingClient(endpoint);
    await firstClient.authenticate();
    const secondClient = createPendingClient(endpoint);
    await secondClient.authenticate();
    const [firstOpened, secondOpened] = await Promise.all([
      openSession(firstClient, 'shared-session', root),
      openSession(secondClient, 'shared-session', root),
    ]);
    expect(firstOpened.result.session.id).toBe('shared-session');
    expect(secondOpened.result.session.id).toBe('shared-session');
    expect(runtimes).toHaveLength(1);

    for (const client of [firstClient, secondClient]) {
      connectedClients.delete(client);
      await client.close().catch(() => {});
    }
    await daemon.stop();
    daemon = undefined;
    expect(runtimes[0].disposed).toBe(true);
  });

  it('does not cancel an unrelated idle timer on a malformed open', async () => {
    const { root, endpoint, runtimes } = await startSingleSessionDaemon(
      'pichamber-pi-daemon-idle-malformed-',
      'resident-a',
      250,
    );
    const client = await connectAuthenticatedClient(endpoint);
    const opened = await openSession(client, 'resident-a', root);
    expect(opened.result.session.id).toBe('resident-a');
    await expectRequestFailure(client.request('sessions.open', {}));
    await waitFor(() => runtimes[0]?.disposed === true, {
      message: 'malformed open cancelled the unrelated idle timer',
    });
  });

  it.each([
    [
      'read',
      (sessionId, directory) => [
        'sessions.messages',
        { sessionId, directory, before: 'stale-cursor' },
      ],
    ],
    [
      'model change',
      (sessionId, directory) => [
        'sessions.setModel',
        { sessionId, directory, model: { providerId: 'missing', modelId: 'missing' } },
      ],
    ],
  ])('still disposes after a failed existing-session %s', async (_label, buildRequest) => {
    const { root, endpoint, runtimes } = await startSingleSessionDaemon(
      'pichamber-pi-daemon-idle-failed-op-',
      'fail-session',
      250,
    );
    const client = await connectAuthenticatedClient(endpoint);
    await openSession(client, 'fail-session', root);
    const [command, payload] = buildRequest('fail-session', root);
    await expectRequestFailure(client.request(command, payload));
    await waitFor(() => runtimes[0]?.disposed === true, {
      message: 'failed operation leaked its idle runtime',
    });
  });

  it('holds disposal while a slow operation and a fast read overlap', async () => {
    const root = await createTemporaryRoot('pichamber-pi-daemon-idle-overlap-');
    const endpoint = testDaemonEndpoint(root);
    const sessionFile = join(root, 'session.jsonl');
    await writeFile(sessionFile, createSessionHeaderLine('overlap-session', root));

    const session = new FakeSession('overlap-session', sessionFile);
    const runtime = new FakeRuntime({ cwd: root, session });
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      idleTimeoutMs: 200,
      listSessions: async () => [{ path: sessionFile, id: 'overlap-session', cwd: root }],
      createRuntime: async () => runtime,
    });
    await daemon.start();

    const slowClient = createPendingClient(endpoint);
    await slowClient.authenticate();
    const fastClient = createPendingClient(endpoint);
    await fastClient.authenticate();

    const releaseSlowOperation = createDeferred();
    const slowOperationEntered = createDeferred();
    const originalNavigateTree = session.navigateTree.bind(session);
    let navigateCalls = 0;
    session.navigateTree = async (messageId) => {
      navigateCalls += 1;
      slowOperationEntered.resolve();
      await releaseSlowOperation.promise;
      return originalNavigateTree(messageId);
    };

    try {
      await openSession(slowClient, 'overlap-session', root);
      const slowOperation = slowClient.request('sessions.navigate', {
        sessionId: 'overlap-session',
        directory: root,
        messageId: 'fake-entry',
      });
      await slowOperationEntered.promise;
      const fastOpened = await openSession(fastClient, 'overlap-session', root);
      expect(fastOpened.result.session.id).toBe('overlap-session');
      await sleep(350);
      expect(navigateCalls).toBe(1);
      expect(runtime.disposed).toBe(false);
      releaseSlowOperation.resolve();
      await slowOperation;
      await waitFor(() => runtime.disposed === true, {
        message: 'overlapped session was not disposed',
      });
    } finally {
      releaseSlowOperation.resolve();
    }
  });

  it('waits for a slow disposal before reopening from JSONL', async () => {
    const { root, endpoint, runtimes } = await startSingleSessionDaemon(
      'pichamber-pi-daemon-idle-racing-',
      'racing-session',
      150,
    );
    const client = await connectAuthenticatedClient(endpoint);
    const racingClient = createPendingClient(endpoint);
    await racingClient.authenticate();

    await openSession(client, 'racing-session', root);
    expect(runtimes).toHaveLength(1);

    const firstRuntime = runtimes[0];
    let disposeCalls = 0;
    const originalDispose = firstRuntime.dispose.bind(firstRuntime);
    const releaseDisposal = createDeferred();
    const disposalStarted = createDeferred();
    firstRuntime.dispose = async () => {
      disposeCalls += 1;
      disposalStarted.resolve();
      await releaseDisposal.promise;
      await originalDispose();
    };

    await disposalStarted.promise;
    const reopening = racingClient.request('sessions.open', {
      sessionId: 'racing-session',
      directory: root,
    });
    await sleep(50);
    expect(disposeCalls).toBe(1);
    releaseDisposal.resolve();

    const reopened = await reopening;
    expect(reopened.result.session.id).toBe('racing-session');
    expect(firstRuntime.disposed).toBe(true);
    expect(runtimes.length).toBeGreaterThanOrEqual(2);
    expect(runtimes[runtimes.length - 1].disposed).toBe(false);
  });

  it('stops without double-disposing a racing idle disposal', async () => {
    const { root, endpoint, runtimes } = await startSingleSessionDaemon(
      'pichamber-pi-daemon-idle-stop-race-',
      'stop-race-session',
      150,
    );
    const client = await connectAuthenticatedClient(endpoint);
    await openSession(client, 'stop-race-session', root);
    expect(runtimes).toHaveLength(1);

    const targetRuntime = runtimes[0];
    let disposeCalls = 0;
    const originalDispose = targetRuntime.dispose.bind(targetRuntime);
    const releaseDisposal = createDeferred();
    const disposalStarted = createDeferred();
    targetRuntime.dispose = async () => {
      disposeCalls += 1;
      disposalStarted.resolve();
      await releaseDisposal.promise;
      await originalDispose();
    };

    await disposalStarted.promise;
    const stopping = daemon.stop();
    await sleep(50);
    releaseDisposal.resolve();
    await stopping;
    daemon = undefined;
    expect(disposeCalls).toBe(1);
    expect(targetRuntime.disposed).toBe(true);
  });
});
