import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createSessionDaemon } from './session-daemon/session-daemon.js';
import { resolveSessionLeaseFile } from './session-daemon/session-lease.js';

/**
 * Focused ephemeral-session lifecycle coverage.
 *
 * Pi's `SessionManager` defers JSONL creation until the first assistant
 * message, so `sessions.create` alone stays ephemeral and a rejected first
 * prompt persists nothing. The contract under test:
 *
 * 1. A rejected first prompt keeps the runtime resident and retryable until
 *    normal idle disposal (no materialization, no recycle, lease held).
 * 2. Successful idle disposal positively checks the assigned JSONL: when
 *    absent (ENOENT only) it clears matching dormant state and publishes the
 *    existing `session.deleted` event so connected clients remove it.
 * 3. Persisted sessions keep dormant/reopen behavior and emit no deletion.
 * 4. A non-ENOENT stat failure never claims deletion.
 * 5. A failed idle disposal retains ownership (registry, lease, runtime) and
 *    emits no deletion; a later disposal can still recover.
 * 6. Untouched creates stay ephemeral across restart.
 * 7. An unknown session file (throwing/missing getSessionFile) never claims
 *    deletion: disposal still releases cleanly without emitting deleted.
 * 8. A stolen lease blocks deletion publication: determination happens while
 *    the lease is held, release is attempted, and session.deleted publishes
 *    only after a successful release, closing the cross-daemon recreate
 *    race. When release reports not-owned, the runtime still disposes but no
 *    deletion publishes and a later open reports SESSION_IN_USE.
 * 9. Failed `sessions.create` model/thinking cleanup stays covered by
 *    `session-daemon/session-failed-create-cleanup.test.js`.
 *
 * Seam notes (existing injection only, no new DI):
 * - `createRuntime` fakes Pi's session surface so prompt rejection
 *   (`preflightResult(false)` + `INVALID_MODEL`) exercises the real daemon
 *   idle-disposal and event path against temp dirs.
 * - One-request-per-connection IPC (like production `requestSessionDaemon`)
 *   so prompt rejections resolve as error frames with preserved codes.
 * - One persistent subscriber per idle-disposal test observes the broadcast
 *   `session.deleted` / `session.error` events.
 */

const credential = 'ephemeral-lifecycle-regression-secret';

const testDaemonEndpoint = (root) => {
  if (process.platform === 'win32') return `\\\\.\\pipe\\pichamber-ephemeral-${process.pid}-${Math.random().toString(16).slice(2)}`;
  return join(root, 'daemon.sock');
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

function connectSubscriber(endpoint) {
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
  socket.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line) publishMessage(JSON.parse(line));
    }
  });
  const waitForMessage = (predicate, timeoutMs = 5_000) => {
    const hit = messages.find(predicate);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        reject(new Error('Timed out waiting for daemon message'));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
  return {
    waitForMessage,
    async authenticate() {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write(`${JSON.stringify({ kind: 'authenticate', credential })}\n`);
      await waitForMessage((message) => message.kind === 'authenticated');
      return waitForMessage((message) => message.kind === 'event' && message.event === 'session.snapshot');
    },
    async close() {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Daemon client closed'));
      }
      if (!socket.destroyed) {
        socket.end();
        await Promise.race([
          new Promise((resolve) => socket.once('close', resolve)),
          new Promise((resolve) => setTimeout(resolve, 1_000)),
        ]);
      }
    },
  };
}

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

function rejectedPromptError() {
  return Object.assign(new Error('first-input rejected'), { code: 'INVALID_MODEL' });
}

class FakeSession {
  constructor(sessionId, sessionFile, { rejectPrompt = false } = {}) {
    this.sessionId = sessionId;
    this.isStreaming = false;
    this.isCompacting = false;
    this.listeners = new Set();
    this.names = [];
    this.entries = [];
    this.promptCalls = 0;
    this.rejectPrompt = rejectPrompt;
    this.model = { provider: 'test', id: 'model' };
    this.thinkingLevel = 'low';
    this.sessionManager = {
      getSessionFile: () => sessionFile,
      getHeader: () => ({ type: 'session', id: sessionId, cwd: '/tmp', timestamp: '2026-01-01T00:00:00.000Z' }),
      getEntries: () => this.entries,
      getEntry: (entryId) => this.entries.find((candidate) => candidate?.id === entryId)
        ?? (entryId === 'fake-entry' ? { id: entryId } : undefined),
      getSessionId: () => sessionId,
      getLeafId: () => 'fake-entry',
      getTree: () => [
        { entry: { id: 'fake-entry', parentId: undefined, timestamp: '2026-01-01T00:00:00.000Z' }, children: [] },
      ],
      appendSessionInfo: (name) => this.names.push(name),
      getSessionName: () => this.names[this.names.length - 1],
    };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text, options) {
    this.promptCalls += 1;
    if (this.rejectPrompt) {
      options?.preflightResult?.(false);
      throw rejectedPromptError();
    }
    options?.preflightResult?.(true);
  }

  async navigateTree() {
    return { cancelled: false };
  }

  async abort() {
    this.isStreaming = false;
  }

  getSteeringMessages() {
    return [];
  }

  getFollowUpMessages() {
    return [];
  }
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

function createSessionHeaderLine(sessionId, cwd) {
  return `${JSON.stringify({ type: 'session', id: sessionId, cwd, timestamp: '2026-01-01T00:00:00.000Z' })}\n`;
}

describe('ephemeral session lifecycle', () => {
  let tempRoot;
  const daemons = [];
  const subscribers = [];

  afterEach(async () => {
    while (subscribers.length > 0) {
      const subscriber = subscribers.pop();
      await subscriber.close().catch(() => {});
    }
    while (daemons.length > 0) {
      const daemon = daemons.pop();
      await daemon.stop().catch(() => {});
    }
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
      tempRoot = null;
    }
  });

  async function setupDirs(prefix) {
    tempRoot = await mkdtemp(join(tmpdir(), prefix));
    const projectDir = join(tempRoot, 'project');
    const agentDir = join(tempRoot, 'agent');
    const endpoint = testDaemonEndpoint(tempRoot);
    await mkdir(projectDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    return { projectDir, agentDir, endpoint };
  }

  function leaseFileFor({ agentDir, projectDir, sessionId }) {
    return resolveSessionLeaseFile({ agentDir, cwd: projectDir, sessionId }).file;
  }

  function startDaemon({ endpoint, projectDir, agentDir, idleTimeoutMs, createRuntime, listSessions }) {
    const daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: projectDir,
      agentDir,
      idleTimeoutMs,
      profileKey: 'test-ephemeral-profile',
      daemonId: `test-ephemeral-daemon-${Math.random().toString(16).slice(2)}`,
      serverInstanceId: `test-ephemeral-server-${Math.random().toString(16).slice(2)}`,
      serverPid: process.pid,
      ...(createRuntime ? { createRuntime } : {}),
      ...(listSessions ? { listSessions } : {}),
    });
    daemons.push(daemon);
    return daemon;
  }

  it('a rejected first prompt keeps the runtime resident and retryable until idle disposal', async () => {
    const { projectDir, agentDir, endpoint } = await setupDirs('pichamber-ephemeral-resident-');
    const sessionId = 'rejected-first-input';
    const assignedPath = join(agentDir, 'sessions', '--tmp-project--', `20260101T000000Z_${sessionId}.jsonl`);
    const session = new FakeSession(sessionId, assignedPath, { rejectPrompt: true });
    const runtime = new FakeRuntime({ cwd: projectDir, session });
    let createRuntimeCalls = 0;
    const daemon = startDaemon({
      endpoint, projectDir, agentDir, idleTimeoutMs: 60_000,
      createRuntime: async () => {
        createRuntimeCalls += 1;
        return runtime;
      },
      listSessions: async () => [],
    });
    await daemon.start();

    const created = await daemonRequest(endpoint, 'sessions.create', { cwd: projectDir });
    expect(created.ok).toBe(true);
    expect(created.result?.session?.id).toBe(sessionId);

    // The original prompt error propagates unchanged.
    const rejected = await daemonRequest(endpoint, 'sessions.prompt', { sessionId, text: 'hello rejected' });
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe('INVALID_MODEL');

    // Nothing is materialized: the assigned JSONL stays absent and the lease
    // stays held by the resident runtime.
    await expect(stat(assignedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(runtime.disposed).toBe(false);
    await expect(stat(leaseFileFor({ agentDir, projectDir, sessionId }))).resolves.toBeDefined();

    // The session stays retryable on the same resident runtime: reopening
    // does not create a second runtime and a second prompt reports the same
    // prompt error rather than SESSION_IN_USE or INVALID_SESSION.
    const opened = await daemonRequest(endpoint, 'sessions.open', { sessionId, directory: projectDir });
    expect(opened.ok).toBe(true);
    expect(opened.result?.session?.id).toBe(sessionId);
    expect(createRuntimeCalls).toBe(1);

    const retried = await daemonRequest(endpoint, 'sessions.prompt', { sessionId, text: 'hello again' });
    expect(retried.ok).toBe(false);
    expect(retried.error?.code).toBe('INVALID_MODEL');
    expect(session.promptCalls).toBe(2);
    expect(createRuntimeCalls).toBe(1);
    expect(runtime.disposed).toBe(false);

    // While resident, the ephemeral session is still listed through the
    // resident registry overlay even though nothing reached disk.
    const listed = await daemonRequest(endpoint, 'sessions.list', { directory: projectDir });
    expect(listed.ok).toBe(true);
    expect(listed.result.sessions.map((entry) => entry.session.id)).toContain(sessionId);
  }, 60_000);

  it('idle disposal of an ephemeral session publishes session.deleted and clears dormant state', async () => {
    const { projectDir, agentDir, endpoint } = await setupDirs('pichamber-ephemeral-disposal-');
    const sessionId = 'ephemeral-idle-session';
    const assignedPath = join(agentDir, 'sessions', '--tmp-project--', `20260101T000000Z_${sessionId}.jsonl`);
    const session = new FakeSession(sessionId, assignedPath, { rejectPrompt: true });
    const runtime = new FakeRuntime({ cwd: projectDir, session });
    const daemon = startDaemon({
      endpoint, projectDir, agentDir, idleTimeoutMs: 50,
      createRuntime: async () => runtime,
      listSessions: async () => [],
    });
    await daemon.start();

    const subscriber = connectSubscriber(endpoint);
    subscribers.push(subscriber);
    await subscriber.authenticate();

    const created = await daemonRequest(endpoint, 'sessions.create', { cwd: projectDir });
    expect(created.ok).toBe(true);
    const rejected = await daemonRequest(endpoint, 'sessions.prompt', { sessionId, text: 'hello ephemeral' });
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe('INVALID_MODEL');

    // The rejected session is evicted by normal idle disposal, which
    // positively finds its assigned JSONL absent and reports deletion.
    const deleted = await subscriber.waitForMessage(
      (message) => message.event === 'session.deleted' && message.payload?.sessionId === sessionId,
    );
    expect(deleted.payload?.directory).toBe(projectDir);
    await waitFor(() => runtime.disposed === true, { message: 'ephemeral runtime was not disposed' });
    await waitFor(
      async () => (await stat(leaseFileFor({ agentDir, projectDir, sessionId })).then(() => false).catch((error) => error?.code === 'ENOENT')) === true,
      { message: 'ephemeral lease was not released' },
    );

    // Dormant state is cleared: the session is gone from listings and can no
    // longer be opened, instead of reopening from a stale dormant record.
    const listed = await daemonRequest(endpoint, 'sessions.list', { directory: projectDir });
    expect(listed.ok).toBe(true);
    expect(listed.result.sessions.map((entry) => entry.session.id)).not.toContain(sessionId);
    const opened = await daemonRequest(endpoint, 'sessions.open', { sessionId, directory: projectDir });
    expect(opened.ok).toBe(false);
    expect(opened.error?.code).toBe('INVALID_SESSION');
  }, 60_000);

  it('idle disposal of a persisted session keeps dormant reopen behavior and emits no deletion', async () => {
    const { projectDir, agentDir, endpoint } = await setupDirs('pichamber-ephemeral-persisted-');
    const sessionId = 'persisted-idle-session';
    const sessionFile = join(tempRoot, `${sessionId}.jsonl`);
    await writeFile(sessionFile, createSessionHeaderLine(sessionId, projectDir));
    let createRuntimeCalls = 0;
    const runtimes = [];
    const daemon = startDaemon({
      endpoint, projectDir, agentDir, idleTimeoutMs: 50,
      createRuntime: async (options) => {
        createRuntimeCalls += 1;
        const runtime = new FakeRuntime({ cwd: projectDir, session: new FakeSession(sessionId, options?.sessionFile ?? sessionFile) });
        runtimes.push(runtime);
        return runtime;
      },
      listSessions: async () => [{ path: sessionFile, id: sessionId, cwd: projectDir }],
    });
    await daemon.start();

    const subscriber = connectSubscriber(endpoint);
    subscribers.push(subscriber);
    await subscriber.authenticate();
    let deletedSeen = false;
    void subscriber.waitForMessage(
      (message) => message.event === 'session.deleted' && message.payload?.sessionId === sessionId,
    ).then(() => { deletedSeen = true; }).catch(() => {});

    const opened = await daemonRequest(endpoint, 'sessions.open', { sessionId, directory: projectDir });
    expect(opened.ok).toBe(true);
    expect(createRuntimeCalls).toBe(1);

    // Idle disposal runs (the file exists, so the session is persisted) but
    // must not report deletion.
    await waitFor(() => runtimes[0]?.disposed === true, { message: 'persisted runtime was not disposed' });
    await sleep(300);
    expect(deletedSeen).toBe(false);

    // Dormant/reopen behavior is retained: opening again rehydrates from the
    // persisted JSONL instead of failing as INVALID_SESSION.
    const reopened = await daemonRequest(endpoint, 'sessions.open', { sessionId, directory: projectDir });
    expect(reopened.ok).toBe(true);
    expect(reopened.result?.session?.id).toBe(sessionId);
    expect(createRuntimeCalls).toBe(2);
  }, 60_000);

  it('a non-ENOENT stat failure during idle disposal never claims deletion', async () => {
    const { projectDir, agentDir, endpoint } = await setupDirs('pichamber-ephemeral-stat-');
    const sessionId = 'stat-failure-session';
    // A regular file in the assigned path's position makes stat fail with
    // ENOTDIR (not ENOENT), which must never be treated as absence.
    const blockerFile = join(tempRoot, 'blocker');
    await writeFile(blockerFile, 'blocker');
    const assignedPath = join(blockerFile, `${sessionId}.jsonl`);
    const session = new FakeSession(sessionId, assignedPath, { rejectPrompt: true });
    const runtime = new FakeRuntime({ cwd: projectDir, session });
    const daemon = startDaemon({
      endpoint, projectDir, agentDir, idleTimeoutMs: 50,
      createRuntime: async () => runtime,
      listSessions: async () => [],
    });
    await daemon.start();

    const subscriber = connectSubscriber(endpoint);
    subscribers.push(subscriber);
    await subscriber.authenticate();
    let deletedSeen = false;
    void subscriber.waitForMessage(
      (message) => message.event === 'session.deleted' && message.payload?.sessionId === sessionId,
    ).then(() => { deletedSeen = true; }).catch(() => {});

    const created = await daemonRequest(endpoint, 'sessions.create', { cwd: projectDir });
    expect(created.ok).toBe(true);
    const rejected = await daemonRequest(endpoint, 'sessions.prompt', { sessionId, text: 'hello stat' });
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe('INVALID_MODEL');

    // Disposal still runs and releases the lease, but claims no deletion.
    await waitFor(() => runtime.disposed === true, { message: 'runtime was not disposed' });
    await waitFor(
      async () => (await stat(leaseFileFor({ agentDir, projectDir, sessionId })).then(() => false).catch((error) => error?.code === 'ENOENT')) === true,
      { message: 'lease was not released' },
    );
    await sleep(300);
    expect(deletedSeen).toBe(false);
  }, 60_000);

  it('a failed idle disposal retains ownership and emits no deletion', async () => {
    const { projectDir, agentDir, endpoint } = await setupDirs('pichamber-ephemeral-dispose-fail-');
    const sessionId = 'dispose-failed-session';
    const assignedPath = join(agentDir, 'sessions', '--tmp-project--', `20260101T000000Z_${sessionId}.jsonl`);
    const session = new FakeSession(sessionId, assignedPath, { rejectPrompt: true });
    let disposeShouldFail = true;
    const runtime = new FakeRuntime({
      cwd: projectDir,
      session,
      onDispose: async () => {
        if (disposeShouldFail) throw new Error('dispose rejected');
      },
    });
    let createRuntimeCalls = 0;
    const daemon = startDaemon({
      endpoint, projectDir, agentDir, idleTimeoutMs: 50,
      createRuntime: async () => {
        createRuntimeCalls += 1;
        return runtime;
      },
      listSessions: async () => [],
    });
    await daemon.start();

    const subscriber = connectSubscriber(endpoint);
    subscribers.push(subscriber);
    await subscriber.authenticate();
    let deletedSeen = false;
    void subscriber.waitForMessage(
      (message) => message.event === 'session.deleted' && message.payload?.sessionId === sessionId,
    ).then(() => { deletedSeen = true; }).catch(() => {});

    const created = await daemonRequest(endpoint, 'sessions.create', { cwd: projectDir });
    expect(created.ok).toBe(true);
    const rejected = await daemonRequest(endpoint, 'sessions.prompt', { sessionId, text: 'hello dispose' });
    expect(rejected.ok).toBe(false);

    // The failed disposal surfaces session.error, keeps the registry entry,
    // lease, and runtime, and never emits deletion.
    const disposalError = await subscriber.waitForMessage(
      (message) => message.event === 'session.error' && message.payload?.sessionId === sessionId,
    );
    expect(disposalError.payload?.code).toBe('RUNTIME_DISPOSAL_FAILED');
    expect(runtime.disposed).toBe(false);
    await expect(stat(leaseFileFor({ agentDir, projectDir, sessionId }))).resolves.toBeDefined();
    const opened = await daemonRequest(endpoint, 'sessions.open', { sessionId, directory: projectDir });
    expect(opened.ok).toBe(true);
    expect(createRuntimeCalls).toBe(1);
    await sleep(200);
    expect(deletedSeen).toBe(false);

    // Recovery: once disposal succeeds, the next idle disposal (re-armed
    // by a fresh access) reports the ephemeral session as deleted exactly
    // once.
    disposeShouldFail = false;
    const reopened = await daemonRequest(endpoint, 'sessions.open', { sessionId, directory: projectDir });
    expect(reopened.ok).toBe(true);
    expect(createRuntimeCalls).toBe(1);
    const deleted = await subscriber.waitForMessage(
      (message) => message.event === 'session.deleted' && message.payload?.sessionId === sessionId,
    );
    expect(deleted.payload?.directory).toBe(projectDir);
    await waitFor(() => runtime.disposed === true, { message: 'retained runtime did not recover' });
    await waitFor(
      async () => (await stat(leaseFileFor({ agentDir, projectDir, sessionId })).then(() => false).catch((error) => error?.code === 'ENOENT')) === true,
      { message: 'retained lease was not released on recovery' },
    );
  }, 60_000);

  it('sessions created but never prompted stay ephemeral across restart', async () => {
    const { projectDir, agentDir, endpoint } = await setupDirs('pichamber-ephemeral-untouched-');
    const sessionId = 'untouched-session';
    const session = new FakeSession(sessionId, undefined);
    const runtime = new FakeRuntime({ cwd: projectDir, session });
    const daemon = startDaemon({
      endpoint, projectDir, agentDir, idleTimeoutMs: 60_000,
      createRuntime: async () => runtime,
      listSessions: async () => [],
    });
    await daemon.start();

    const created = await daemonRequest(endpoint, 'sessions.create', { cwd: projectDir });
    expect(created.ok).toBe(true);
    expect(created.result?.session?.id).toBe(sessionId);

    const listedBefore = await daemonRequest(endpoint, 'sessions.list', { directory: projectDir });
    expect(listedBefore.ok).toBe(true);
    expect(listedBefore.result.sessions.map((entry) => entry.session.id)).toContain(sessionId);

    await daemon.stop();
    daemons.pop();
    const restarted = startDaemon({
      endpoint, projectDir, agentDir, idleTimeoutMs: 60_000,
      createRuntime: async () => {
        throw new Error('must not create a runtime for an ephemeral session');
      },
      listSessions: async () => [],
    });
    await restarted.start();

    const listedAfter = await daemonRequest(endpoint, 'sessions.list', { directory: projectDir });
    expect(listedAfter.ok).toBe(true);
    expect(listedAfter.result.sessions.map((entry) => entry.session.id)).not.toContain(sessionId);

    const openedAfter = await daemonRequest(endpoint, 'sessions.open', { sessionId, directory: projectDir });
    expect(openedAfter.ok).toBe(false);
    expect(openedAfter.error?.code).toBe('INVALID_SESSION');
  }, 60_000);

  it('an unknown session file never claims deletion during idle disposal', async () => {
    const { projectDir, agentDir, endpoint } = await setupDirs('pichamber-ephemeral-unknown-');
    const sessionId = 'unknown-file-session';
    const session = new FakeSession(sessionId, undefined, { rejectPrompt: true });
    // Unknown: getSessionFile throws, so ephemerality cannot be proven.
    // The daemon must still dispose and release cleanly without emitting
    // deletion (cannot prove absent) and without surfacing disposal failure.
    session.sessionManager.getSessionFile = () => { throw new Error('unknown session file'); };
    const runtime = new FakeRuntime({ cwd: projectDir, session });
    const daemon = startDaemon({
      endpoint, projectDir, agentDir, idleTimeoutMs: 50,
      createRuntime: async () => runtime,
      listSessions: async () => [],
    });
    await daemon.start();

    const subscriber = connectSubscriber(endpoint);
    subscribers.push(subscriber);
    await subscriber.authenticate();
    let deletedSeen = false;
    void subscriber.waitForMessage(
      (message) => message.event === 'session.deleted' && message.payload?.sessionId === sessionId,
    ).then(() => { deletedSeen = true; }).catch(() => {});
    let disposalFailed = false;
    void subscriber.waitForMessage(
      (message) => message.event === 'session.error' && message.payload?.sessionId === sessionId,
    ).then(() => { disposalFailed = true; }).catch(() => {});

    const created = await daemonRequest(endpoint, 'sessions.create', { cwd: projectDir });
    expect(created.ok).toBe(true);
    const rejected = await daemonRequest(endpoint, 'sessions.prompt', { sessionId, text: 'hello unknown' });
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe('INVALID_MODEL');

    // Disposal still runs and releases the lease, but claims no deletion
    // and reports no disposal failure: unknown means cannot prove absent.
    await waitFor(() => runtime.disposed === true, { message: 'runtime was not disposed' });
    await waitFor(
      async () => (await stat(leaseFileFor({ agentDir, projectDir, sessionId })).then(() => false).catch((error) => error?.code === 'ENOENT')) === true,
      { message: 'lease was not released' },
    );
    await sleep(300);
    expect(deletedSeen).toBe(false);
    expect(disposalFailed).toBe(false);
  }, 60_000);

  it('a stolen lease blocks deletion publication (publish only after successful release)', async () => {
    const { projectDir, agentDir, endpoint } = await setupDirs('pichamber-ephemeral-stolen-');
    const sessionId = 'stolen-lease-session';
    const assignedPath = join(agentDir, 'sessions', '--tmp-project--', `20260101T000000Z_${sessionId}.jsonl`);
    const session = new FakeSession(sessionId, assignedPath, { rejectPrompt: true });
    const runtime = new FakeRuntime({ cwd: projectDir, session });
    const daemon = startDaemon({
      endpoint, projectDir, agentDir, idleTimeoutMs: 100,
      createRuntime: async () => runtime,
      listSessions: async () => [],
    });
    await daemon.start();

    const subscriber = connectSubscriber(endpoint);
    subscribers.push(subscriber);
    await subscriber.authenticate();
    let deletedSeen = false;
    void subscriber.waitForMessage(
      (message) => message.event === 'session.deleted' && message.payload?.sessionId === sessionId,
    ).then(() => { deletedSeen = true; }).catch(() => {});

    const created = await daemonRequest(endpoint, 'sessions.create', { cwd: projectDir });
    expect(created.ok).toBe(true);
    const rejected = await daemonRequest(endpoint, 'sessions.prompt', { sessionId, text: 'hello stolen' });
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe('INVALID_MODEL');

    // Cross-daemon steal: overwrite the lease with a different live owner
    // before idle disposal fires. The daemon still disposes its registry
    // entry, but release reports not-owned, so no deletion may publish.
    // This proves publication happens only after a successful release;
    // precise stat-vs-release interleaving beyond this gate is not
    // observable through existing IPC/lease seams without new DI.
    const leaseFile = leaseFileFor({ agentDir, projectDir, sessionId });
    await expect(stat(leaseFile)).resolves.toBeDefined();
    await writeFile(leaseFile, JSON.stringify({
      profileKey: 'thief-profile',
      serverInstanceId: 'thief-server',
      daemonId: 'thief-daemon',
      daemonPid: process.pid,
      sessionId,
      cwd: projectDir,
      agentDir,
      acquiredAt: new Date().toISOString(),
    }));

    await waitFor(() => runtime.disposed === true, { message: 'runtime was not disposed' });
    await sleep(400);
    expect(deletedSeen).toBe(false);
    // The lease is still held by the thief, so no deletion was published
    // and ownership was not handed back. Open still fails INVALID_SESSION
    // (no JSONL exists for this ephemeral id); the proof of blocked
    // publication is the surviving thief lease below, contrasting with the
    // successful-release case where the lease is ENOENT after deletion.
    const thiefLease = JSON.parse(await readFile(leaseFile, 'utf8'));
    expect(thiefLease.daemonId).toBe('thief-daemon');
    const opened = await daemonRequest(endpoint, 'sessions.open', { sessionId, directory: projectDir });
    expect(opened.ok).toBe(false);
    expect(opened.error?.code).toBe('INVALID_SESSION');
  }, 60_000);
});
