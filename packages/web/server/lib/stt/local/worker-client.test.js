import { afterEach, describe, expect, test } from 'bun:test';

import { SttWorkerClient } from './worker-client.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 2_000, intervalMs = 5, message = 'Timed out waiting for condition' } = {}) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error(message);
    await sleep(intervalMs);
  }
}

class FakeWorker {
  constructor() {
    this.connected = true;
    this.killed = false;
    this.sent = [];
    this.disconnectCalls = 0;
    this.killCalls = 0;
    this.messageHandlers = [];
    this.closeHandlers = [];
    this.stderrHandlers = [];
    this.sendImpl = null;
    this.stderr = {
      on: (event, handler) => {
        if (event === 'data') this.stderrHandlers.push(handler);
        return this.stderr;
      },
    };
  }

  on(event, handler) {
    if (event === 'message') this.messageHandlers.push(handler);
    if (event === 'close') this.closeHandlers.push(handler);
    return this;
  }

  send(payload, callback) {
    this.sent.push(payload);
    if (this.sendImpl) return this.sendImpl(payload, callback);
    queueMicrotask(() => callback?.(null));
    return true;
  }

  disconnect() {
    this.disconnectCalls += 1;
    this.connected = false;
  }

  kill() {
    this.killCalls += 1;
    this.killed = true;
    return true;
  }

  respond(requestId, result = { text: 'hello' }) {
    for (const handler of [...this.messageHandlers]) handler({ type: 'response', requestId, ok: true, result });
  }

  respondError(requestId, error = 'boom') {
    for (const handler of [...this.messageHandlers]) handler({ type: 'response', requestId, ok: false, error });
  }

  emitStderr(chunk) {
    for (const handler of [...this.stderrHandlers]) handler(Buffer.from(chunk));
  }

  emitClose(code = 1, signal = null) {
    this.connected = false;
    for (const handler of [...this.closeHandlers]) handler(code, signal);
  }
}

const clients = [];
afterEach(() => {
  while (clients.length) {
    try { clients.pop()?.shutdown(); } catch {}
  }
});

function createHarness({ idleShutdownMs = 25, requestTimeoutMs = 200, forceKillMs = 15 } = {}) {
  const workers = [];
  const client = new SttWorkerClient({
    idleShutdownMs,
    requestTimeoutMs,
    forceKillMs,
    forkWorker: (...args) => {
      const worker = new FakeWorker();
      worker.forkArgs = args;
      workers.push(worker);
      return worker;
    },
  });
  clients.push(client);
  return { client, workers };
}

async function requestAndRespond(client, workers, result = { text: 'hello' }) {
  const before = workers[0]?.sent.length ?? 0;
  const pending = client.request({ type: 'transcribe' });
  await waitFor(() => workers.length === 1 && workers[0].sent.length === before + 1);
  workers[0].respond(workers[0].sent.at(-1).requestId, result);
  return pending;
}

describe('SttWorkerClient lifecycle', () => {
  test('preserves the five-minute idle, request, and force-kill defaults', () => {
    const client = new SttWorkerClient();
    clients.push(client);
    expect(client.idleShutdownMs).toBe(5 * 60 * 1000);
    expect(client.requestTimeoutMs).toBe(5 * 60 * 1000);
    expect(client.forceKillMs).toBe(1000);
  });

  test('reuses a live worker for sequential requests', async () => {
    const { client, workers } = createHarness();
    await requestAndRespond(client, workers, { text: 'one' });
    await requestAndRespond(client, workers, { text: 'two' });
    expect(workers).toHaveLength(1);
    expect(workers[0].sent).toHaveLength(2);
    expect(workers[0].disconnectCalls).toBe(0);
  });

  test('shuts the worker down after the idle timeout', async () => {
    const { client, workers } = createHarness({ idleShutdownMs: 20 });
    await expect(requestAndRespond(client, workers)).resolves.toMatchObject({ text: 'hello' });
    expect(client.worker).not.toBe(null);
    await waitFor(() => client.worker === null, { message: 'idle worker was not shut down' });
    expect(workers[0].disconnectCalls).toBe(1);
    await waitFor(() => workers[0].killCalls === 1, { message: 'force-kill fallback did not run' });
  });

  test('holds idle shutdown while a request is pending', async () => {
    const { client, workers } = createHarness({ idleShutdownMs: 20, requestTimeoutMs: 500 });
    const pending = client.request({ type: 'transcribe' });
    await waitFor(() => workers[0]?.sent.length === 1);
    const requestId = workers[0].sent[0].requestId;
    await sleep(60);
    expect(client.worker).not.toBe(null);
    expect(workers[0].disconnectCalls).toBe(0);
    workers[0].respond(requestId, { text: 'late' });
    await expect(pending).resolves.toMatchObject({ text: 'late' });
    await waitFor(() => client.worker === null, { message: 'idle shutdown did not reschedule after pending completed' });
  });

  test('serializes transcribe calls one at a time', async () => {
    const { client, workers } = createHarness({ requestTimeoutMs: 500 });
    const first = client.transcribe({ pcm16: Buffer.alloc(2) });
    const second = client.transcribe({ pcm16: Buffer.alloc(2) });
    await waitFor(() => workers.length === 1 && workers[0].sent.length === 1);
    expect(workers[0].sent).toHaveLength(1);
    workers[0].respond(workers[0].sent[0].requestId, { text: 'first' });
    await expect(first).resolves.toMatchObject({ text: 'first' });
    await waitFor(() => workers[0].sent.length === 2);
    workers[0].respond(workers[0].sent[1].requestId, { text: 'second' });
    await expect(second).resolves.toMatchObject({ text: 'second' });
  });

  test('restarts after an unexpected exit and reports stderr detail', async () => {
    const { client, workers } = createHarness({ requestTimeoutMs: 500 });
    const pending = client.request({ type: 'transcribe' });
    await waitFor(() => workers[0]?.sent.length === 1);
    pending.catch(() => {});
    workers[0].emitStderr('native addon failed');
    workers[0].emitClose(1, null);
    await expect(pending).rejects.toThrow(/STT worker exited \(code 1.*native addon failed/);
    expect(client.worker).toBe(null);
    const next = client.request({ type: 'transcribe' });
    await waitFor(() => workers.length === 2 && workers[1].sent.length === 1);
    workers[1].respond(workers[1].sent[0].requestId, { text: 'restarted' });
    await expect(next).resolves.toMatchObject({ text: 'restarted' });
  });

  test('ignores stale closes and intentional shutdown closes', async () => {
    const { client, workers } = createHarness({ requestTimeoutMs: 500 });
    await requestAndRespond(client, workers);
    const live = workers[0];
    client.handleExit({ connected: false }, 9, null);
    expect(client.worker).toBe(live);
    client.shutdownWorker();
    expect(client.worker).toBe(null);
    expect(live.disconnectCalls).toBe(1);
    expect(() => live.emitClose(0, null)).not.toThrow();
    expect(client.worker).toBe(null);
    expect(client.pending.size).toBe(0);
  });

  test('rejects on worker error responses and send failures', async () => {
    const { client, workers } = createHarness({ requestTimeoutMs: 500 });
    const failing = client.request({ type: 'transcribe' });
    await waitFor(() => workers[0]?.sent.length === 1);
    workers[0].respondError(workers[0].sent[0].requestId, 'bad audio');
    await expect(failing).rejects.toThrow('bad audio');

    workers[0].sendImpl = (payload, callback) => queueMicrotask(() => callback(new Error('ipc failed')));
    await expect(client.request({ type: 'transcribe' })).rejects.toThrow('ipc failed');
  });

  test('times out a hung request and allows the next request', async () => {
    const { client, workers } = createHarness({ idleShutdownMs: 20, requestTimeoutMs: 25, forceKillMs: 10 });
    workers.length = 0;
    const hung = client.request({ type: 'transcribe' });
    await waitFor(() => workers[0]?.sent.length === 1);
    await expect(hung).rejects.toThrow('STT worker timed out');
    const next = client.request({ type: 'transcribe' });
    await waitFor(() => workers[0].sent.length === 2);
    workers[0].respond(workers[0].sent[1].requestId, { text: 'recovered' });
    await expect(next).resolves.toMatchObject({ text: 'recovered' });
  });

  test('force-kills when disconnect does not exit, even if disconnect throws', async () => {
    const { client, workers } = createHarness({ forceKillMs: 15 });
    await requestAndRespond(client, workers);
    workers[0].disconnect = () => { workers[0].disconnectCalls += 1; throw new Error('already gone'); };
    client.shutdownWorker();
    expect(workers[0].disconnectCalls).toBe(1);
    await waitFor(() => workers[0].killCalls === 1, { message: 'worker was not force-killed after disconnect threw' });
    expect(client.worker).toBe(null);
  });

  test('terminal shutdown rejects queued transcriptions without forking or sending again', async () => {
    const { client, workers } = createHarness({ requestTimeoutMs: 500 });
    const first = client.transcribe({ pcm16: Buffer.alloc(2) });
    const second = client.transcribe({ pcm16: Buffer.alloc(2) });
    first.catch(() => {});
    second.catch(() => {});
    await waitFor(() => workers.length === 1 && workers[0].sent.length === 1);
    const forksBefore = workers.length;
    const sentBefore = workers[0].sent.length;
    client.shutdown();
    await expect(first).rejects.toThrow('STT worker shut down');
    await expect(second).rejects.toThrow('STT worker shut down');
    await sleep(20);
    expect(workers).toHaveLength(forksBefore);
    expect(workers[0].sent).toHaveLength(sentBefore);
    await expect(client.transcribe({ pcm16: Buffer.alloc(2) })).rejects.toThrow('STT worker shut down');
    await expect(client.request({ type: 'transcribe' })).rejects.toThrow('STT worker shut down');
    expect(workers).toHaveLength(forksBefore);
    expect(workers[0].sent).toHaveLength(sentBefore);
  });

  test('idle shutdownWorker still allows the next request to restart the worker', async () => {
    const { client, workers } = createHarness({ requestTimeoutMs: 500 });
    await requestAndRespond(client, workers, { text: 'before idle' });
    client.shutdownWorker();
    expect(client.worker).toBe(null);
    const next = client.request({ type: 'transcribe' });
    await waitFor(() => workers.length === 2 && workers[1].sent.length === 1);
    workers[1].respond(workers[1].sent[0].requestId, { text: 'after idle' });
    await expect(next).resolves.toMatchObject({ text: 'after idle' });
  });
});
