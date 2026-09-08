import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';

import { createSessionReplayLog, MAX_REPLAY_BYTES, MAX_REPLAY_EVENTS } from './session-replay.js';
import { createSessionDaemon as createSessionDaemonImpl } from './session-daemon.js';

const credential = 'replay-test-credential';

function createSessionDaemon(options) {
  return createSessionDaemonImpl({ ...options, agentDir: options.agentDir ?? options.cwd });
}

class FakeSession {
  constructor(sessionId = 'pi-session-1', sessionFile) {
    this.sessionId = sessionId;
    this.isStreaming = true;
    this.listeners = new Set();
    this.entries = [];
    this.model = { provider: 'test', id: 'model' };
    this.thinkingLevel = 'low';
    this.sessionManager = {
      getSessionFile: () => sessionFile,
      getHeader: () => ({ timestamp: '2026-01-01T00:00:00.000Z' }),
      getEntries: () => this.entries,
      getEntry: (entryId) => this.entries.find((candidate) => candidate.id === entryId),
      getLeafId: () => 'entry',
      getTree: () => [],
      appendSessionInfo: () => {},
      getSessionName: () => undefined,
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

  async prompt() {}

  async sendUserMessage() {}

  async setModel(model) {
    this.model = model;
  }

  setThinkingLevel(thinkingLevel) {
    this.thinkingLevel = thinkingLevel;
  }

  async abort() {}

  async compact() {}

  async navigateTree() {
    return { cancelled: false };
  }

  getSteeringMessages() {
    return [];
  }

  getFollowUpMessages() {
    return [];
  }
}

function testDaemonEndpoint(root) {
  if (process.platform === 'win32') {
    const pipeHash = createHash('sha1').update(root).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\pichamber-replay-${pipeHash}`;
  }
  return join(root, 'daemon.sock');
}

function connectDaemonClient(endpoint) {
  const socket = createConnection({ path: endpoint });
  socket.on('error', () => {});
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
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Daemon connection closed'));
    }
  });

  const waitForMessage = (predicate, timeoutMs = 10_000) => {
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
      }, timeoutMs);
      waiters.push(waiter);
    });
  };

  return {
    socket,
    messages,
    waitForMessage,
    async authenticate(credentialOverride = credential, { sessionId, fromSequence } = {}) {
      await new Promise((resolve, reject) => {
        if (socket.connecting === false && socket.pending === false) {
          return resolve();
        }
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      const frame = {
        kind: 'authenticate',
        credential: credentialOverride,
        ...(sessionId ? { sessionId } : {}),
        ...(fromSequence !== undefined ? { fromSequence } : {}),
      };
      socket.write(`${JSON.stringify(frame)}\n`);
      await waitForMessage((message) => message.kind === 'authenticated');
      if (fromSequence !== undefined) {
        return undefined;
      }
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
      try {
        socket.end();
      } catch {}
      if (socket.destroyed) {
        return;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            socket.destroy();
          } catch {}
          resolve();
        }, 2_000);
        socket.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

function formatReplayLine(sequence, extraFields) {
  return `${JSON.stringify({ sequence, ...extraFields })}\n`;
}

function createTestReplayLog(maxEvents, maxBytes) {
  return createSessionReplayLog({ maxEvents, maxBytes });
}

describe('session replay log bounds', () => {
  it('keeps the configured count and encoded-byte budgets', () => {
    expect(MAX_REPLAY_EVENTS).toBe(1024);
    expect(MAX_REPLAY_BYTES).toBe(8 * 1024 * 1024);
  });

  it('evicts whole oldest events once the count bound is exceeded', () => {
    const replayLog = createTestReplayLog(3, 1024 * 1024);
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      replayLog.append(sequence, 's1', formatReplayLine(sequence));
    }
    expect(replayLog.size).toBe(3);
    expect(replayLog.oldestSequence).toBe(3);
    expect(replayLog.newestSequence).toBe(5);
    expect(replayLog.canReplay(2, 5)).toBe(true);
    expect(replayLog.canReplay(1, 5)).toBe(false);
    const retainedSequences = [...replayLog.linesAfter(2, undefined)].map(
      (line) => JSON.parse(line).sequence,
    );
    expect(retainedSequences).toEqual([3, 4, 5]);
  });

  it('evicts whole oldest events once the byte bound is exceeded without truncating content', () => {
    const replayLog = createTestReplayLog(1024, 500);
    replayLog.append(1, 's1', formatReplayLine(1, { text: 'a'.repeat(200) }));
    replayLog.append(2, 's1', formatReplayLine(2, { text: 'b'.repeat(200) }));
    replayLog.append(3, 's1', formatReplayLine(3, { text: 'c'.repeat(200) }));
    expect(replayLog.retainedBytes).toBeLessThanOrEqual(500);
    expect(replayLog.oldestSequence).toBe(2);
    const retainedLines = [...replayLog.linesAfter(1, undefined)];
    expect(retainedLines).toHaveLength(2);
    expect(retainedLines[0]).toContain('b'.repeat(200));
    expect(retainedLines[1]).toContain('c'.repeat(200));
    expect(replayLog.canReplay(1, 3)).toBe(true);
    expect(replayLog.canReplay(0, 3)).toBe(false);
  });

  it('counts encoded UTF-8 bytes and never splits multi-byte characters', () => {
    // 'é' is 2 UTF-8 bytes but 1 char; eviction drops whole events.
    const replayLog = createTestReplayLog(1024, 200);
    const firstLine = formatReplayLine(1, { text: 'é'.repeat(50) });
    expect(Buffer.byteLength(firstLine)).toBeGreaterThan(firstLine.length);
    replayLog.append(1, 's1', firstLine);
    replayLog.append(2, 's1', formatReplayLine(2, { text: 'é'.repeat(50) }));
    expect(replayLog.retainedBytes).toBeLessThanOrEqual(200);
    expect(replayLog.oldestSequence).toBe(2);
    const retainedLines = [...replayLog.linesAfter(1, undefined)];
    expect(retainedLines).toHaveLength(1);
    expect(retainedLines[0]).toContain('é'.repeat(50));
    expect(() => JSON.parse(retainedLines[0])).not.toThrow();
  });

  it('treats snapshot sequence gaps as intentional, not as replay holes', () => {
    const replayLog = createTestReplayLog(10, 1024 * 1024);
    replayLog.append(1, 's1', formatReplayLine(1));
    replayLog.append(2, 's1', formatReplayLine(2));
    // Sequences 3-4 are private snapshots that never enter the replay suffix.
    replayLog.append(5, 's1', formatReplayLine(5));
    expect(replayLog.canReplay(2, 5)).toBe(true);
    expect(replayLog.canReplay(4, 5)).toBe(true);
    const afterTwo = [...replayLog.linesAfter(2, undefined)].map((line) => JSON.parse(line).sequence);
    expect(afterTwo).toEqual([5]);
    const afterFour = [...replayLog.linesAfter(4, undefined)].map((line) => JSON.parse(line).sequence);
    expect(afterFour).toEqual([5]);
  });

  it('drops an oversized single event and forces a snapshot for cursors that missed it', () => {
    const replayLog = createTestReplayLog(1024, 256);
    replayLog.append(1, 's1', formatReplayLine(1, { text: 'ok' }));
    replayLog.append(2, 's1', formatReplayLine(2, { text: 'ok' }));
    expect(
      replayLog.append(3, 's1', formatReplayLine(3, { text: 'z'.repeat(1024) })),
    ).toMatchObject({ retained: false, oversized: true });
    expect(replayLog.size).toBe(0);
    expect(replayLog.canReplay(2, 3)).toBe(false);
    replayLog.append(4, 's1', formatReplayLine(4, { text: 'ok' }));
    expect(replayLog.oldestSequence).toBe(4);
    expect(replayLog.canReplay(2, 4)).toBe(false);
    expect(replayLog.canReplay(3, 4)).toBe(true);
    expect([...replayLog.linesAfter(3, undefined)]).toHaveLength(1);
  });

  it('treats an empty ring and a future cursor as snapshot cases', () => {
    expect(createTestReplayLog(4, 1024).canReplay(0, 0)).toBe(false);
    const replayLog = createTestReplayLog(4, 1024);
    replayLog.append(1, 's1', formatReplayLine(1));
    replayLog.append(2, 's1', formatReplayLine(2));
    expect(replayLog.canReplay(99, 2)).toBe(false);
    expect(replayLog.canReplay(2, 2)).toBe(true);
    expect([...replayLog.linesAfter(2, undefined)]).toHaveLength(0);
  });

  it('keeps the global contiguity gate while filtering delivery by session', () => {
    const replayLog = createTestReplayLog(2, 1024 * 1024);
    replayLog.append(1, 'session-a', formatReplayLine(1));
    replayLog.append(2, 'session-b', formatReplayLine(2));
    replayLog.append(3, 'session-a', formatReplayLine(3));
    expect(replayLog.oldestSequence).toBe(2);
    expect(replayLog.canReplay(0, 3)).toBe(false);
    expect(replayLog.canReplay(1, 3)).toBe(true);
    const filteredLines = [...replayLog.linesAfter(1, 'session-a')];
    expect(filteredLines).toHaveLength(1);
    expect(filteredLines[0]).toContain('"sequence":3');
  });
});

describe('daemon byte-bounded reconnect', () => {
  let daemon;
  const temporaryRoots = [];
  const connectedClients = new Set();

  const connectLiveClient = async (endpoint) => {
    const client = connectDaemonClient(endpoint);
    connectedClients.add(client);
    await client.authenticate();
    return client;
  };

  const connectResumingClient = async (endpoint, fromSequence) => {
    const client = connectDaemonClient(endpoint);
    connectedClients.add(client);
    await client.authenticate(credential, { sessionId: 'pi-session-1', fromSequence });
    return client;
  };

  const startReplayDaemon = async (prefix, session = new FakeSession()) => {
    const root = await mkdtemp(join(tmpdir(), prefix));
    temporaryRoots.push(root);
    const endpoint = testDaemonEndpoint(root);
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: root,
      createRuntime: async (daemonOptions) => {
        const runtimeCwd = typeof daemonOptions?.cwd === 'string' && daemonOptions.cwd.length > 0
          ? daemonOptions.cwd
          : root;
        return {
          cwd: runtimeCwd,
          session,
          async dispose() {},
        };
      },
    });
    await daemon.start();
    return { root, endpoint, session };
  };

  const readLastSequence = (client) => {
    return client.request('runtime.health').then((response) => response.result.lastSequence);
  };

  const emitLargeToolUpdates = (session, eventCount = 200, fillCharacter = 'y') => {
    const largePayload = fillCharacter.repeat(64 * 1024);
    for (let index = 0; index < eventCount; index += 1) {
      session.emit({
        type: 'tool_execution_update',
        toolCallId: `flood-${index}`,
        toolName: 'read',
        args: { path: 'f.txt' },
        partialResult: { content: [{ type: 'text', text: `${largePayload}${index}` }] },
      });
    }
  };

  const waitForSnapshot = (client) => {
    return client.waitForMessage((message) => message.event === 'session.snapshot');
  };

  const collectReplayedMessages = (client, cursor) => {
    return client.messages.filter(
      (message) => message.sequence > cursor && message.event !== 'session.snapshot',
    );
  };

  afterEach(async () => {
    for (const client of [...connectedClients]) {
      connectedClients.delete(client);
      try {
        await client.close();
      } catch {}
    }
    try {
      await daemon?.stop();
    } catch {}
    daemon = undefined;
    while (temporaryRoots.length > 0) {
      const root = temporaryRoots.pop();
      try {
        await rm(root, { recursive: true, force: true });
      } catch {}
    }
  });

  it('serializes each live event once for multiple clients', async () => {
    const { root, endpoint, session } = await startReplayDaemon('pichamber-replay-serialize-');
    const firstClient = await connectLiveClient(endpoint);
    await firstClient.request('sessions.create', { cwd: root });
    const secondClient = await connectResumingClient(endpoint, await readLastSequence(firstClient));
    const firstDelivery = firstClient.waitForMessage(
      (message) => message.event === 'assistant.message.delta' && message.payload?.delta === 'once-marker',
    );
    const secondDelivery = secondClient.waitForMessage(
      (message) => message.event === 'assistant.message.delta' && message.payload?.delta === 'once-marker',
    );

    const originalStringify = JSON.stringify;
    let serializeCalls = 0;
    JSON.stringify = function stringifyWithCounter(value, replacer, space) {
      if (value?.event === 'assistant.message.delta' && value?.payload?.delta === 'once-marker') {
        serializeCalls += 1;
      }
      return originalStringify.call(this, value, replacer, space);
    };
    try {
      session.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'once-marker' },
      });
    } finally {
      JSON.stringify = originalStringify;
    }

    const [firstEvent, secondEvent] = await Promise.all([firstDelivery, secondDelivery]);
    expect(serializeCalls).toBe(1);
    expect(secondEvent.sequence).toBe(firstEvent.sequence);
  });

  it('bounds retained replay bytes with a >8MiB fixture while preserving tiny tail deltas', async () => {
    // 200 x 64 KiB (~13 MiB encoded): stale cursor snapshots, cursor-100 replays, tail stays intact.
    const { root, endpoint, session } = await startReplayDaemon('pichamber-replay-byte-');
    const liveClient = await connectLiveClient(endpoint);
    const staleCursor = (await liveClient.waitForMessage((message) => message.event === 'session.snapshot')).sequence;
    await liveClient.request('sessions.create', { cwd: root });
    emitLargeToolUpdates(session, 200, 'y');
    for (const delta of ['tail-0', 'tail-1', 'tail-2']) {
      session.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta },
      });
    }

    const lastSequence = await readLastSequence(liveClient);
    expect(lastSequence - staleCursor).toBeGreaterThan(200);

    const staleClient = await connectResumingClient(endpoint, staleCursor);
    const staleSnapshot = await waitForSnapshot(staleClient);
    expect(staleSnapshot.sequence).toBeGreaterThan(staleCursor);
    expect(staleSnapshot.payload.lastSequence).toBe(staleSnapshot.sequence);
    expect(collectReplayedMessages(staleClient, staleCursor)).toHaveLength(0);

    const withinBudgetClient = await connectResumingClient(endpoint, lastSequence - 100);
    const replayedTail = await withinBudgetClient.waitForMessage(
      (message) => message.sequence === lastSequence,
    );
    expect(replayedTail.event).not.toBe('session.snapshot');
    expect(withinBudgetClient.messages.filter((message) => message.event === 'session.snapshot')).toHaveLength(0);

    const recentClient = await connectResumingClient(endpoint, lastSequence - 3);
    const lastEvent = await recentClient.waitForMessage((message) => message.sequence === lastSequence);
    expect(lastEvent.event).not.toBe('session.snapshot');
    expect(lastEvent.payload?.delta).toBe('tail-2');
    expect(recentClient.messages.filter((message) => message.event === 'session.snapshot')).toHaveLength(0);
    const tailDeltas = recentClient.messages
      .filter((message) => message.event === 'assistant.message.delta' && message.sequence > lastSequence - 3)
      .map((message) => message.payload?.delta);
    expect(tailDeltas).toEqual(['tail-0', 'tail-1', 'tail-2']);
  });

  it('recovers a missed tool final via snapshot plus sessions.open hydrate', async () => {
    // Replay alone cannot carry an evicted tool final; snapshot is metadata and hydrate rebuilds it.
    const { root, endpoint, session } = await startReplayDaemon('pichamber-replay-hydrate-');
    session.isStreaming = false;
    const primaryClient = await connectLiveClient(endpoint);
    await primaryClient.request('sessions.create', { cwd: root });
    const cursor = await readLastSequence(primaryClient);
    session.isStreaming = true;

    const toolEnd = primaryClient.waitForMessage(
      (message) => message.event === 'session.tool.end' && message.payload?.toolCallId === 'recover-tool',
    );
    session.emit({
      type: 'tool_execution_start',
      toolCallId: 'recover-tool',
      toolName: 'read',
      args: { path: 'f.txt' },
    });
    session.emit({
      type: 'tool_execution_end',
      toolCallId: 'recover-tool',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'final file contents' }] },
      isError: false,
    });
    const toolEndEvent = await toolEnd;
    expect(toolEndEvent.payload.output).toBe('final file contents');

    session.isStreaming = false;
    session.entries = [
      {
        type: 'message',
        id: 'user-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'read f.txt' },
      },
      {
        type: 'message',
        id: 'assistant-1',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          provider: 'test',
          model: 'model',
          content: [{ type: 'toolCall', id: 'recover-tool', name: 'read', arguments: { path: 'f.txt' } }],
        },
      },
      {
        type: 'message',
        id: 'tool-result-1',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'recover-tool',
          isError: false,
          content: [{ type: 'text', text: 'final file contents' }],
        },
      },
    ];
    emitLargeToolUpdates(session, 200, 'z');
    await readLastSequence(primaryClient);

    const staleClient = await connectResumingClient(endpoint, cursor);
    const staleSnapshot = await waitForSnapshot(staleClient);
    expect(staleSnapshot.sequence).toBeGreaterThan(cursor);
    expect(staleSnapshot.payload.lastSequence).toBe(staleSnapshot.sequence);
    expect(staleSnapshot.payload.lifecycle).toBe('idle');
    expect(collectReplayedMessages(staleClient, cursor)).toHaveLength(0);
    expect(JSON.stringify(staleSnapshot)).not.toContain('final file contents');

    const opened = await staleClient.request('sessions.open', {
      sessionId: 'pi-session-1',
      directory: root,
    });
    expect(opened.result.lifecycle).toBe('idle');
    expect(opened.result.isStreaming).toBe(false);
    const assistantEntry = opened.result.messages.find((candidate) => candidate?.message?.role === 'assistant');
    expect(assistantEntry.parts.find((part) => part?.toolCallId === 'recover-tool')).toMatchObject({
      state: 'completed',
      output: 'final file contents',
    });
  });

  it('delivers an oversized event live but replays it as a snapshot gap', async () => {
    // Oversized is >8 MiB (over replay budget) but <16 MiB IPC ceiling, so live stays full-fidelity.
    const { root, endpoint, session } = await startReplayDaemon('pichamber-replay-oversized-');
    const liveClient = await connectLiveClient(endpoint);
    const initialSnapshot = await liveClient.waitForMessage((message) => message.event === 'session.snapshot');
    await liveClient.request('sessions.create', { cwd: root });
    const cursorBeforeHugeEvent = await readLastSequence(liveClient);

    const hugeText = 'h'.repeat(9 * 1024 * 1024);
    const toolEnd = liveClient.waitForMessage(
      (message) => message.event === 'session.tool.end' && message.payload?.toolCallId === 'huge-tool',
    );
    session.emit({
      type: 'tool_execution_end',
      toolCallId: 'huge-tool',
      toolName: 'read',
      result: { content: [{ type: 'text', text: hugeText }] },
      isError: false,
    });
    const toolEndEvent = await toolEnd;
    expect(toolEndEvent.payload.output).toHaveLength(hugeText.length);
    expect(await readLastSequence(liveClient)).toBeGreaterThan(cursorBeforeHugeEvent);
    expect(initialSnapshot.sequence).toBeLessThanOrEqual(cursorBeforeHugeEvent);

    const staleClient = await connectResumingClient(endpoint, cursorBeforeHugeEvent);
    await expect(waitForSnapshot(staleClient)).resolves.toMatchObject({
      payload: { lastSequence: expect.any(Number) },
    });
    expect(collectReplayedMessages(staleClient, cursorBeforeHugeEvent)).toHaveLength(0);
  });

  it('snapshots a future cursor and preserves session-filtered sequence order', async () => {
    const { root, endpoint, session } = await startReplayDaemon('pichamber-replay-cursor-');
    const liveClient = await connectLiveClient(endpoint);
    await liveClient.request('sessions.create', { cwd: root });
    session.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'ordered' },
    });
    const deltaEvent = await liveClient.waitForMessage((message) => message.event === 'assistant.message.delta');
    const lastSequence = await readLastSequence(liveClient);

    const futureClient = await connectResumingClient(endpoint, lastSequence + 100);
    await expect(waitForSnapshot(futureClient)).resolves.toMatchObject({
      payload: { lastSequence: expect.any(Number) },
    });

    const filteredClient = await connectResumingClient(endpoint, deltaEvent.sequence - 1);
    const replayedDelta = await filteredClient.waitForMessage(
      (message) => message.event === 'assistant.message.delta',
    );
    expect(replayedDelta.sequence).toBe(deltaEvent.sequence);
    expect(replayedDelta.payload.sessionId).toBe('pi-session-1');
  });
});
