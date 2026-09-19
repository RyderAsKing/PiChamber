import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createSessionDaemon } from './session-daemon.js';
import { getPiSessionDirectory } from './session-jsonl.js';
import { resolveSessionLeaseFile } from './session-lease.js';

/**
 * Focused regression coverage for failed-create model/thinking cleanup:
 *
 * - `sessions.create` with an invalid model/thinking after lease acquisition
 *   disposes first and releases only after success.
 * - When that first disposal rejects, the create returns the original
 *   model/thinking error (not the disposal error), retains the lease, keeps
 *   `{ runtime, cwd, sessionId }` pending without registering the runtime or
 *   installing dormant state, and leaves the session unexposed.
 * - `sessions.delete` (per-session) and daemon stop (all sessions) retry the
 *   pending cleanup dispose-first; a failed retry stays pending without
 *   releasing ownership, a successful retry disposes exactly once and
 *   releases the lease.
 *
 * Seam notes (existing injection only, no new DI):
 * - `createRuntime` fakes Pi's session surface so an unknown model
 *   (`modelRuntime.getModel` returns undefined) triggers INVALID_MODEL after
 *   the lease, and a throwing `setThinkingLevel` triggers a thinking setup
 *   error after the lease.
 * - One-request-per-connection IPC (like production `requestSessionDaemon`)
 *   so create/delete rejections resolve as error frames with preserved codes.
 */

const credential = 'failed-create-cleanup-regression-secret';

const testDaemonEndpoint = (root, name = 'daemon.sock') => {
  if (process.platform === 'win32') return `\\\\.\\pipe\\pichamber-failed-create-${process.pid}-${Math.random().toString(16).slice(2)}`;
  return join(root, name);
};

const daemonRequest = (endpoint, command, payload, timeoutMs = 20_000) => new Promise((resolve, reject) => {
  const requestId = `req-${Math.random().toString(16).slice(2)}`;
  const socket = createConnection({ path: endpoint });
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let authenticated = false;
  let settled = false;
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      socket.destroy();
      reject(new Error(`Timed out waiting for daemon ${command}`));
    }
  }, timeoutMs);
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    callback(value);
  };
  socket.once('error', (error) => finish(reject, error));
  socket.on('connect', () => {
    socket.write(`${JSON.stringify({ kind: 'authenticate', credential })}\n`);
  });
  socket.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      if (!authenticated) {
        if (frame.kind !== 'authenticated') {
          finish(reject, new Error(`Daemon authentication failed for ${command}`));
          return;
        }
        authenticated = true;
        socket.write(`${JSON.stringify({
          protocolVersion: 1, kind: 'request', requestId, command, payload,
        })}\n`);
        continue;
      }
      if (frame.kind === 'response' && frame.requestId === requestId) {
        finish(resolve, { ok: true, result: frame.result });
        return;
      }
      if (frame.kind === 'error') {
        finish(resolve, { ok: false, error: frame.error });
        return;
      }
    }
  });
  socket.on('close', () => {
    if (!settled && authenticated) finish(reject, new Error(`Daemon connection closed waiting for ${command}`));
  });
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 5_000, intervalMs = 10, message = 'Timed out' } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      if (await predicate()) return true;
    } catch {
      // Retry until the timeout expires.
    }
    if (Date.now() - start > timeoutMs) throw new Error(message);
    await sleep(intervalMs);
  }
}

class FakeSession {
  constructor(sessionId, { modelNotFound = false, thinkingShouldThrow = false } = {}) {
    this.sessionId = sessionId;
    this.isStreaming = false;
    this.isCompacting = false;
    this.listeners = new Set();
    this.names = [];
    this.entries = [];
    this.model = { provider: 'test', id: 'model' };
    this.thinkingLevel = 'low';
    this.modelNotFound = modelNotFound;
    this.thinkingShouldThrow = thinkingShouldThrow;
    this.modelRuntime = {
      getModel: (providerId, modelId) => {
        if (this.modelNotFound) return undefined;
        return { provider: providerId, id: modelId };
      },
      getModels: () => [{ provider: 'test', id: 'model', name: 'Test model', contextWindow: 128_000, reasoning: true }],
      getProvider: (providerId) => (providerId === 'test' ? ({ name: 'Test provider' }) : undefined),
      getProviderAuthStatus: () => ({ configured: true }),
    };
    this.sessionManager = {
      getSessionFile: () => undefined,
      getHeader: () => ({ type: 'session', id: sessionId, cwd: '/tmp', timestamp: '2026-01-01T00:00:00.000Z' }),
      getEntries: () => this.entries,
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

  async setModel(model) {
    this.model = model;
  }

  setThinkingLevel(thinking) {
    if (this.thinkingShouldThrow) {
      throw Object.assign(new Error('thinking setup rejected'), { code: 'THINKING_SETUP_FAILED' });
    }
    this.thinkingLevel = thinking;
  }

  async abort() {
    this.isStreaming = false;
  }

  getSteeringMessages() { return []; }
  getFollowUpMessages() { return []; }
}

class FakeRuntime {
  constructor({ cwd, session, onDispose }) {
    this.cwd = cwd;
    this.session = session;
    this.disposed = false;
    this.onDispose = onDispose;
  }

  async dispose() {
    if (typeof this.onDispose === 'function') await this.onDispose(this);
    this.disposed = true;
  }
}

describe('failed-create model/thinking cleanup', () => {
  let tempRoot;
  const daemons = [];

  afterEach(async () => {
    while (daemons.length > 0) {
      const daemon = daemons.pop();
      await daemon.stop().catch(() => {});
    }
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
      tempRoot = null;
    }
  });

  it('invalid model keeps the lease on dispose failure and delete retries exactly once', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'pichamber-failed-create-model-'));
    const projectDir = join(tempRoot, 'project');
    const agentDir = join(tempRoot, 'agent');
    const endpoint = testDaemonEndpoint(tempRoot);
    await mkdir(projectDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });

    const sessionId = 'failed-create-model-session';
    const leaseFile = resolveSessionLeaseFile({ agentDir, cwd: projectDir, sessionId }).file;
    const sessionDir = getPiSessionDirectory({ cwd: projectDir, agentDir });
    const assignedPath = join(sessionDir, `20260101T000000Z_${sessionId}.jsonl`);

    const session = new FakeSession(sessionId, { modelNotFound: true });
    let disposeAttempts = 0;
    let disposeShouldFail = true;
    const runtime = new FakeRuntime({
      cwd: projectDir,
      session,
      onDispose: async () => {
        disposeAttempts += 1;
        if (disposeShouldFail) {
          throw Object.assign(new Error('first dispose rejected'), { code: 'DISPOSE_REJECTED' });
        }
      },
    });

    // Persisted file appears only to let delete exercise its normal unlink
    // after the pending drain; it is created after the failed create so the
    // create itself stays ephemeral.
    let persistedAvailable = false;
    const daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: projectDir,
      agentDir,
      idleTimeoutMs: 60_000,
      profileKey: 'test-failed-create-model',
      daemonId: 'test-daemon-model',
      serverInstanceId: 'test-server-model',
      serverPid: process.pid,
      createRuntime: async () => runtime,
      listSessions: async () => (persistedAvailable
        ? [{ path: assignedPath, id: sessionId, cwd: projectDir, created: new Date(), modified: new Date(), messageCount: 0 }]
        : []),
    });
    daemons.push(daemon);
    await daemon.start();

    const created = await daemonRequest(endpoint, 'sessions.create', {
      cwd: projectDir,
      model: { providerId: 'test', modelId: 'missing-model' },
    });
    // Original model error wins over the disposal rejection.
    expect(created.ok).toBe(false);
    expect(created.error?.code).toBe('INVALID_MODEL');
    expect(disposeAttempts).toBe(1);

    // Dispose-first failure retains ownership: runtime not marked disposed,
    // lease still held, failed runtime never exposed through open.
    expect(runtime.disposed).toBe(false);
    await expect(stat(leaseFile)).resolves.toBeDefined();
    const openedBeforeDelete = await daemonRequest(endpoint, 'sessions.open', { sessionId, directory: projectDir });
    expect(openedBeforeDelete.ok).toBe(false);

    // Failed delete retry stays pending without releasing ownership.
    await mkdir(sessionDir, { recursive: true });
    await writeFile(assignedPath, `${JSON.stringify({ type: 'session', id: sessionId, version: 3, timestamp: '2026-01-01T00:00:00.000Z', cwd: projectDir })}\n`);
    persistedAvailable = true;
    const deleteWhileDisposeFails = await daemonRequest(endpoint, 'sessions.delete', { sessionId, directory: projectDir });
    expect(deleteWhileDisposeFails.ok).toBe(false);
    expect(deleteWhileDisposeFails.error?.code).toBe('RUNTIME_DISPOSAL_FAILED');
    expect(disposeAttempts).toBe(2);
    expect(runtime.disposed).toBe(false);
    await expect(stat(leaseFile)).resolves.toBeDefined();
    // Persisted file is untouched while the pending dispose keeps failing.
    await expect(stat(assignedPath)).resolves.toBeDefined();

    // Successful delete retry disposes exactly once more and releases.
    disposeShouldFail = false;
    const deleted = await daemonRequest(endpoint, 'sessions.delete', { sessionId, directory: projectDir });
    expect(deleted.ok).toBe(true);
    expect(disposeAttempts).toBe(3);
    expect(runtime.disposed).toBe(true);
    await waitFor(async () => (await stat(leaseFile).then(() => false).catch((error) => error?.code === 'ENOENT')) === true, {
      message: 'failed-create lease was not released by successful delete retry',
    });
    await expect(stat(assignedPath)).rejects.toMatchObject({ code: 'ENOENT' });

    // No double-dispose/release: stopping after a drained delete is a no-op.
    await daemon.stop();
    expect(disposeAttempts).toBe(3);
    await expect(stat(leaseFile)).rejects.toMatchObject({ code: 'ENOENT' });
    daemons.pop();
  }, 60_000);

  it('invalid thinking keeps the lease on dispose failure and stop retries exactly once', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'pichamber-failed-create-thinking-'));
    const projectDir = join(tempRoot, 'project');
    const agentDir = join(tempRoot, 'agent');
    const endpoint = testDaemonEndpoint(tempRoot);
    await mkdir(projectDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });

    const sessionId = 'failed-create-thinking-session';
    const leaseFile = resolveSessionLeaseFile({ agentDir, cwd: projectDir, sessionId }).file;

    const session = new FakeSession(sessionId, { thinkingShouldThrow: true });
    let disposeAttempts = 0;
    let disposeShouldFail = true;
    const runtime = new FakeRuntime({
      cwd: projectDir,
      session,
      onDispose: async () => {
        disposeAttempts += 1;
        if (disposeShouldFail) {
          throw Object.assign(new Error('first dispose rejected'), { code: 'DISPOSE_REJECTED' });
        }
      },
    });

    const daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: projectDir,
      agentDir,
      idleTimeoutMs: 60_000,
      profileKey: 'test-failed-create-thinking',
      daemonId: 'test-daemon-thinking',
      serverInstanceId: 'test-server-thinking',
      serverPid: process.pid,
      createRuntime: async () => runtime,
    });
    daemons.push(daemon);
    await daemon.start();

    const created = await daemonRequest(endpoint, 'sessions.create', { cwd: projectDir, thinking: 'high' });
    // Original thinking error wins over the disposal rejection.
    expect(created.ok).toBe(false);
    expect(created.error?.code).toBe('THINKING_SETUP_FAILED');
    expect(disposeAttempts).toBe(1);

    // Lease remains held and the failed runtime stays unexposed.
    expect(runtime.disposed).toBe(false);
    await expect(stat(leaseFile)).resolves.toBeDefined();
    const opened = await daemonRequest(endpoint, 'sessions.open', { sessionId, directory: projectDir });
    expect(opened.ok).toBe(false);

    // Stop retries the pending cleanup dispose-first. A failing retry stays
    // pending without releasing ownership.
    await daemon.stop();
    expect(disposeAttempts).toBe(2);
    expect(runtime.disposed).toBe(false);
    await expect(stat(leaseFile)).resolves.toBeDefined();

    // Successful stop retry releases the lease with exactly one more dispose.
    // The pending record survives stop/start because it is daemon-owned.
    disposeShouldFail = false;
    await daemon.start();
    await daemon.stop();
    expect(disposeAttempts).toBe(3);
    expect(runtime.disposed).toBe(true);
    await waitFor(async () => (await stat(leaseFile).then(() => false).catch((error) => error?.code === 'ENOENT')) === true, {
      message: 'failed-create lease was not released by successful stop retry',
    });
    await expect(stat(leaseFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(disposeAttempts).toBe(3);
    daemons.pop();
  }, 60_000);
});
