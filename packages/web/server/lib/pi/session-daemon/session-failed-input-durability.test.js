import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createSessionDaemon } from './session-daemon.js';
import { getPiSessionDirectory } from './session-jsonl.js';
import { resolveSessionLeaseFile } from './session-lease.js';

/**
 * Focused regression coverage for failed-first-input durability findings:
 *
 * 1. Overlapping rejected first inputs must persist exactly once. The former
 *    `activeSessionRequests > 1` point-in-time early return let every
 *    concurrent failure skip; the final release holder now performs exactly
 *    one deferred attempt once safe.
 * 2. A `runtimeRegistry.dispose` rejection during durability recycling must
 *    retain the resident lease/runtime (no lease release, no runtime clear,
 *    no dormant install), mirroring the idle-disposal failure invariant,
 *    while still preserving the original prompt error. Later disposal can
 *    still recover.
 * 3. A detached durability attempt must not overlap `sessions.delete` or
 *    daemon stop: delete seals and awaits its session, stop bumps the epoch
 *    and awaits all, with a generation fence checked before publication and
 *    before the recycle. After delete completes no snapshot can appear;
 *    after stop completes no durability work remains or touches disposed
 *    state. Idle re-arm failures never mask the prompt error and never
 *    surface as unhandled rejections.
 *
 * Seam notes (existing injection only, no new DI):
 * - `createRuntime` fakes Pi's SessionManager surface (assigned path, valid
 *   header/entries) so durability exercises its real filesystem path
 *   validation, atomic no-clobber link, and recycle against temp dirs.
 * - One-request-per-connection IPC (like production `requestSessionDaemon`)
 *   so prompt rejections resolve as error frames with preserved codes, and
 *   separate connections overlap to hold concurrent session refcounts.
 */

const credential = 'failed-input-durability-regression-secret';

const testDaemonEndpoint = (root) => {
  if (process.platform === 'win32') return `\\\\.\\pipe\\pichamber-failed-durability-${process.pid}-${Math.random().toString(16).slice(2)}`;
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

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

const sessionTimestamp = '2026-01-01T00:00:00.000Z';

class FakeSession {
  constructor(sessionId, sessionFile, projectDir, hooks = {}) {
    this.sessionId = sessionId;
    this.isStreaming = false;
    this.isCompacting = false;
    this.listeners = new Set();
    this.names = [];
    this.entries = [];
    this.hooks = hooks;
    this.promptCalls = 0;
    this.sessionManager = {
      getSessionFile: () => sessionFile,
      getHeader: () => ({ type: 'session', id: sessionId, cwd: projectDir, timestamp: sessionTimestamp }),
      getEntries: () => this.entries,
      getEntry: (entryId) => this.entries.find((candidate) => candidate?.id === entryId)
        ?? (entryId === 'fake-entry' ? { id: entryId } : undefined),
      getSessionId: () => sessionId,
      getLeafId: () => 'fake-entry',
      getTree: () => {
        if (typeof this.hooks.getTree === 'function') return this.hooks.getTree();
        return [
          { entry: { id: 'fake-entry', parentId: undefined, timestamp: sessionTimestamp }, children: [] },
        ];
      },
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
    if (typeof this.hooks.prompt === 'function') return this.hooks.prompt(text, options, this);
    options?.preflightResult?.(false);
    const error = new Error('first-input rejected');
    error.code = 'INVALID_MODEL';
    throw error;
  }

  async navigateTree(messageId) {
    if (typeof this.hooks.navigateTree === 'function') return this.hooks.navigateTree(messageId);
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

describe('failed first-input durability concurrency and disposal safety', () => {
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

  it('overlapping rejected first inputs persist exactly once via the final holder', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'pichamber-failed-durability-'));
    const projectDir = join(tempRoot, 'project');
    const agentDir = join(tempRoot, 'agent');
    const endpoint = testDaemonEndpoint(tempRoot);
    await mkdir(projectDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });

    const sessionId = 'concurrent-first-input';
    const sessionDir = getPiSessionDirectory({ cwd: projectDir, agentDir });
    const assignedPath = join(sessionDir, `20260101T000000Z_${sessionId}.jsonl`);

    const runtimes = [];
    let disposeCalls = 0;
    const navigateEntered = createDeferred();
    const releaseNavigate = createDeferred();
    let promptEntered = 0;
    let releasePrompts;
    const promptsBarrier = new Promise((resolve) => { releasePrompts = resolve; });

    const hooks = {
      navigateTree: async () => {
        navigateEntered.resolve();
        await releaseNavigate.promise;
        return { cancelled: false };
      },
      prompt: async (text, options) => {
        promptEntered += 1;
        if (promptEntered === 2) releasePrompts();
        else {
          await Promise.race([
            promptsBarrier,
            sleep(5_000).then(() => {
              throw new Error('Timed out waiting for the second overlapping prompt');
            }),
          ]);
        }
        // Both prompts overlap inside Pi activation while the slow navigate
        // holds a third refcount, so every inline durability check observes
        // concurrency and defers. Previously both skipped forever.
        options?.preflightResult?.(false);
        const error = new Error('first-input rejected');
        error.code = 'INVALID_MODEL';
        throw error;
      },
    };
    const session = new FakeSession(sessionId, assignedPath, projectDir, hooks);
    const runtime = new FakeRuntime({
      cwd: projectDir,
      session,
      onDispose: async () => { disposeCalls += 1; },
    });
    runtimes.push(runtime);

    const daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: projectDir,
      agentDir,
      idleTimeoutMs: 60_000,
      createRuntime: async () => runtime,
    });
    daemons.push(daemon);
    await daemon.start();

    const created = await daemonRequest(endpoint, 'sessions.create', { cwd: projectDir });
    expect(created.ok).toBe(true);
    expect(created.result?.session?.id).toBe(sessionId);

    // Slow navigate holds the session refcount across both failures.
    const navigateRequest = daemonRequest(endpoint, 'sessions.navigate', { sessionId, directory: projectDir, messageId: 'fake-entry' });
    await navigateEntered.promise;

    const first = daemonRequest(endpoint, 'sessions.prompt', { sessionId, text: 'first overlapping hello' });
    const second = daemonRequest(endpoint, 'sessions.prompt', { sessionId, text: 'second overlapping hello' });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    // Original prompt errors are preserved for both concurrent failures.
    expect(firstResult.ok).toBe(false);
    expect(firstResult.error?.code).toBe('INVALID_MODEL');
    expect(secondResult.ok).toBe(false);
    expect(secondResult.error?.code).toBe('INVALID_MODEL');

    // Release the slow holder last so the deferred attempt runs once safe.
    releaseNavigate.resolve();
    const navigateResult = await navigateRequest;
    expect(navigateResult.ok).toBe(true);

    await waitFor(async () => (await stat(assignedPath).then(() => true).catch(() => false)) === true, {
      message: 'overlapping failures did not persist the session snapshot',
    });
    await waitFor(() => disposeCalls === 1, {
      message: 'overlapping failures did not recycle exactly once',
    });

    const content = await readFile(assignedPath, 'utf8');
    expect(content).toContain(sessionId);

    // Recycled session stays retryable: reopening from the persisted snapshot
    // succeeds instead of SESSION_IN_USE or INVALID_SESSION.
    const opened = await daemonRequest(endpoint, 'sessions.open', { sessionId, directory: projectDir });
    expect(opened.ok).toBe(true);
    expect(opened.result?.session?.id).toBe(sessionId);
  }, 60_000);

  it('a dispose rejection retains runtime and lease with later recovery', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'pichamber-failed-dispose-'));
    const projectDir = join(tempRoot, 'project');
    const agentDir = join(tempRoot, 'agent');
    const endpoint = testDaemonEndpoint(tempRoot);
    await mkdir(projectDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });

    const sessionId = 'dispose-rejected-session';
    const sessionDir = getPiSessionDirectory({ cwd: projectDir, agentDir });
    const assignedPath = join(sessionDir, `20260101T000000Z_${sessionId}.jsonl`);

    const session = new FakeSession(sessionId, assignedPath, projectDir);
    let disposeAttempts = 0;
    let disposeShouldFail = true;
    const runtime = new FakeRuntime({
      cwd: projectDir,
      session,
      onDispose: async () => {
        disposeAttempts += 1;
        if (disposeShouldFail) throw new Error('dispose rejected');
      },
    });
    let createRuntimeCalls = 0;

    const daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: projectDir,
      agentDir,
      idleTimeoutMs: 150,
      profileKey: 'test-profile',
      daemonId: 'test-daemon',
      serverInstanceId: 'test-server',
      serverPid: process.pid,
      createRuntime: async () => {
        createRuntimeCalls += 1;
        return runtime;
      },
    });
    daemons.push(daemon);
    await daemon.start();

    const created = await daemonRequest(endpoint, 'sessions.create', { cwd: projectDir });
    expect(created.ok).toBe(true);
    expect(created.result?.session?.id).toBe(sessionId);
    expect(createRuntimeCalls).toBe(1);

    const leaseFile = resolveSessionLeaseFile({ agentDir, cwd: projectDir, sessionId }).file;
    await expect(stat(leaseFile)).resolves.toBeDefined();

    const rejected = await daemonRequest(endpoint, 'sessions.prompt', { sessionId, text: 'hello dispose' });
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe('INVALID_MODEL');

    // Durability persisted the snapshot before attempting recycle.
    await waitFor(async () => (await stat(assignedPath).then(() => true).catch(() => false)) === true, {
      message: 'failed input did not persist before dispose',
    });
    expect(disposeAttempts).toBe(1);

    // Dispose failure retains ownership: runtime still resident, lease held,
    // no dormant install that would force a reopen from disk.
    expect(runtime.disposed).toBe(false);
    await expect(stat(leaseFile)).resolves.toBeDefined();
    await waitFor(async () => {
      const opened = await daemonRequest(endpoint, 'sessions.open', { sessionId, directory: projectDir });
      return opened.ok === true;
    }, { message: 'retained runtime was not reopenable' });
    expect(createRuntimeCalls).toBe(1);

    // Later recovery: once disposal succeeds, idle expiry recycles and
    // releases the lease instead of leaking the retained runtime.
    disposeShouldFail = false;
    await waitFor(() => runtime.disposed === true, {
      message: 'retained runtime did not recover via later disposal',
    });
    await waitFor(async () => (await stat(leaseFile).then(() => false).catch((error) => error?.code === 'ENOENT')) === true, {
      message: 'retained lease was not released on recovery',
    });
  }, 60_000);

  it('open during durability recycle waits for disposal and reopens from JSONL', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'pichamber-failed-durability-recycle-race-'));
    const projectDir = join(tempRoot, 'project');
    const agentDir = join(tempRoot, 'agent');
    const endpoint = testDaemonEndpoint(tempRoot);
    await mkdir(projectDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });

    const sessionId = 'durability-recycle-race-session';
    const sessionDir = getPiSessionDirectory({ cwd: projectDir, agentDir });
    const assignedPath = join(sessionDir, `20260101T000000Z_${sessionId}.jsonl`);

    const disposeEntered = createDeferred();
    const releaseDispose = createDeferred();
    let disposeCalls = 0;
    let createRuntimeCalls = 0;
    const firstSession = new FakeSession(sessionId, assignedPath, projectDir);
    const firstRuntime = new FakeRuntime({
      cwd: projectDir,
      session: firstSession,
      onDispose: async () => {
        disposeCalls += 1;
        disposeEntered.resolve();
        await releaseDispose.promise;
      },
    });

    const daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: projectDir,
      agentDir,
      idleTimeoutMs: 60_000,
      createRuntime: async (options) => {
        createRuntimeCalls += 1;
        if (createRuntimeCalls === 1) return firstRuntime;
        expect(options?.sessionFile).toBe(assignedPath);
        return new FakeRuntime({
          cwd: projectDir,
          session: new FakeSession(sessionId, options?.sessionFile, projectDir),
        });
      },
    });
    daemons.push(daemon);
    await daemon.start();

    const created = await daemonRequest(endpoint, 'sessions.create', { cwd: projectDir });
    expect(created.ok).toBe(true);
    expect(created.result?.session?.id).toBe(sessionId);

    // The failing prompt persists the snapshot then hangs in the recycle
    // dispose, so an open arriving now must wait instead of adopting the
    // dying runtime.
    const promptRequest = daemonRequest(endpoint, 'sessions.prompt', { sessionId, text: 'hello recycle race' });
    await disposeEntered.promise;
    await waitFor(async () => (await stat(assignedPath).then(() => true).catch(() => false)) === true, {
      message: 'durability did not write the snapshot before recycle dispose',
    });

    const openRequest = daemonRequest(endpoint, 'sessions.open', { sessionId, directory: projectDir });
    let promptSettled = false;
    let openSettled = false;
    void promptRequest.then(() => { promptSettled = true; }, () => { promptSettled = true; });
    void openRequest.then(() => { openSettled = true; }, () => { openSettled = true; });
    await sleep(50);
    expect(promptSettled).toBe(false);
    expect(openSettled).toBe(false);
    expect(disposeCalls).toBe(1);

    releaseDispose.resolve();
    const [promptResult, openResult] = await Promise.all([promptRequest, openRequest]);
    expect(promptResult.ok).toBe(false);
    expect(promptResult.error?.code).toBe('INVALID_MODEL');
    expect(openResult.ok).toBe(true);
    expect(openResult.result?.session?.id).toBe(sessionId);
    expect(disposeCalls).toBe(1);
    expect(createRuntimeCalls).toBe(2);
  }, 60_000);

  it('delete during in-flight durability does not resurrect or double-dispose', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'pichamber-failed-durability-delete-'));
    const projectDir = join(tempRoot, 'project');
    const agentDir = join(tempRoot, 'agent');
    const endpoint = testDaemonEndpoint(tempRoot);
    await mkdir(projectDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });

    const sessionId = 'delete-race-session';
    const sessionDir = getPiSessionDirectory({ cwd: projectDir, agentDir });
    const assignedPath = join(sessionDir, `20260101T000000Z_${sessionId}.jsonl`);
    const leaseFile = resolveSessionLeaseFile({ agentDir, cwd: projectDir, sessionId }).file;

    const session = new FakeSession(sessionId, assignedPath, projectDir);
    const disposeEntered = createDeferred();
    const releaseDispose = createDeferred();
    let disposeCalls = 0;
    const runtime = new FakeRuntime({
      cwd: projectDir,
      session,
      onDispose: async () => {
        disposeCalls += 1;
        disposeEntered.resolve();
        await releaseDispose.promise;
      },
    });

    const daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: projectDir,
      agentDir,
      idleTimeoutMs: 60_000,
      profileKey: 'test-profile-delete',
      daemonId: 'test-daemon-delete',
      serverInstanceId: 'test-server-delete',
      serverPid: process.pid,
      createRuntime: async () => runtime,
    });
    daemons.push(daemon);
    await daemon.start();

    const created = await daemonRequest(endpoint, 'sessions.create', { cwd: projectDir });
    expect(created.ok).toBe(true);
    expect(created.result?.session?.id).toBe(sessionId);

    // The failing prompt enters durability, writes the snapshot, then hangs
    // in the recycle dispose so the durability task is deterministically
    // in-flight while delete runs.
    await expect(stat(leaseFile)).resolves.toBeDefined();
    const promptRequest = daemonRequest(endpoint, 'sessions.prompt', { sessionId, text: 'hello delete race' });
    await disposeEntered.promise;
    await waitFor(async () => (await stat(assignedPath).then(() => true).catch(() => false)) === true, {
      message: 'durability did not write the snapshot before delete',
    });

    const deleteRequest = daemonRequest(endpoint, 'sessions.delete', { sessionId, directory: projectDir });
    let promptSettled = false;
    let deleteSettled = false;
    void promptRequest.then(() => { promptSettled = true; }, () => { promptSettled = true; });
    void deleteRequest.then(() => { deleteSettled = true; }, () => { deleteSettled = true; });
    await sleep(50);
    // Delete awaits the bounded in-flight durability instead of overlapping
    // its dispose and unlink; the prompt still awaits the same task.
    expect(promptSettled).toBe(false);
    expect(deleteSettled).toBe(false);
    expect(disposeCalls).toBe(1);

    releaseDispose.resolve();
    const [promptResult, deleteResult] = await Promise.all([promptRequest, deleteRequest]);
    expect(promptResult.ok).toBe(false);
    expect(promptResult.error?.code).toBe('INVALID_MODEL');
    expect(deleteResult.ok).toBe(true);

    // Authoritative result: after delete completes no snapshot can appear.
    // Durability wrote before delete, delete unlinked, and the fenced
    // recycle skipped the lease/dormant install that would resurrect it.
    // The cancelled-after-dispose handoff is drained here: lease ownership
    // is released, disposal stays exactly once, and no dormant state can
    // resurrect the deleted snapshot.
    await waitFor(async () => (await stat(assignedPath).then(() => false).catch((error) => error?.code === 'ENOENT')) === true, {
      message: 'deleted session snapshot was resurrected by durability',
    });
    expect(disposeCalls).toBe(1);
    await waitFor(async () => (await stat(leaseFile).then(() => false).catch((error) => error?.code === 'ENOENT')) === true, {
      message: 'cancelled durability lease was not drained by delete',
    });
    await sleep(200);
    await expect(stat(assignedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(leaseFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(disposeCalls).toBe(1);

    const opened = await daemonRequest(endpoint, 'sessions.open', { sessionId, directory: projectDir });
    expect(opened.ok).toBe(false);

    // Stale-global proof: teardown must not dispose the already-disposed
    // runtime a second time. Without clearing the module-global reference
    // before the cancellation fence, stop would dispose it again.
    await daemon.stop();
    expect(disposeCalls).toBe(1);
    await expect(stat(leaseFile)).rejects.toMatchObject({ code: 'ENOENT' });
    daemons.pop();
  }, 60_000);

  it('stop during pending durability leaves no post-stop snapshot or double-dispose', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'pichamber-failed-durability-stop-'));
    const projectDir = join(tempRoot, 'project');
    const agentDir = join(tempRoot, 'agent');
    const endpoint = testDaemonEndpoint(tempRoot);
    await mkdir(projectDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });

    const sessionId = 'stop-pending-session';
    const sessionDir = getPiSessionDirectory({ cwd: projectDir, agentDir });
    const assignedPath = join(sessionDir, `20260101T000000Z_${sessionId}.jsonl`);

    const navigateEntered = createDeferred();
    const releaseNavigate = createDeferred();
    const hooks = {
      navigateTree: async () => {
        navigateEntered.resolve();
        await releaseNavigate.promise;
        return { cancelled: false };
      },
    };
    const session = new FakeSession(sessionId, assignedPath, projectDir, hooks);
    let disposeCalls = 0;
    const runtime = new FakeRuntime({
      cwd: projectDir,
      session,
      onDispose: async () => { disposeCalls += 1; },
    });

    const daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: projectDir,
      agentDir,
      idleTimeoutMs: 60_000,
      createRuntime: async () => runtime,
    });
    daemons.push(daemon);
    await daemon.start();

    const created = await daemonRequest(endpoint, 'sessions.create', { cwd: projectDir });
    expect(created.ok).toBe(true);

    // Slow holder forces the failing prompt to defer: durability is pending
    // (no snapshot yet) and deterministically in-flight as intent while
    // stop runs.
    const navigateRequest = daemonRequest(endpoint, 'sessions.navigate', { sessionId, directory: projectDir, messageId: 'fake-entry' });
    await navigateEntered.promise;
    const promptResult = await daemonRequest(endpoint, 'sessions.prompt', { sessionId, text: 'hello stop race' });
    expect(promptResult.ok).toBe(false);
    expect(promptResult.error?.code).toBe('INVALID_MODEL');
    await expect(stat(assignedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const navigateSettled = navigateRequest.then(() => 'settled', () => 'settled');
    void navigateSettled.catch(() => {});

    await daemon.stop();
    expect(daemon.isStarted).toBe(false);
    releaseNavigate.resolve();
    await navigateSettled.catch(() => {});

    // Authoritative result: after stop completes no durability work remains.
    // The pending intent was dropped, the epoch fence blocks publication,
    // and teardown disposed exactly once without a second durability dispose.
    await sleep(200);
    await expect(stat(assignedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(disposeCalls).toBe(1);
    daemons.pop();
  }, 60_000);

  it('stop during durability dispose drains the held lease exactly once', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'pichamber-failed-durability-stop-recycle-'));
    const projectDir = join(tempRoot, 'project');
    const agentDir = join(tempRoot, 'agent');
    const endpoint = testDaemonEndpoint(tempRoot);
    await mkdir(projectDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });

    const sessionId = 'stop-recycle-session';
    const sessionDir = getPiSessionDirectory({ cwd: projectDir, agentDir });
    const assignedPath = join(sessionDir, `20260101T000000Z_${sessionId}.jsonl`);
    const leaseFile = resolveSessionLeaseFile({ agentDir, cwd: projectDir, sessionId }).file;

    const session = new FakeSession(sessionId, assignedPath, projectDir);
    const disposeEntered = createDeferred();
    const releaseDispose = createDeferred();
    let disposeCalls = 0;
    const runtime = new FakeRuntime({
      cwd: projectDir,
      session,
      onDispose: async () => {
        disposeCalls += 1;
        disposeEntered.resolve();
        await releaseDispose.promise;
      },
    });

    const daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: projectDir,
      agentDir,
      idleTimeoutMs: 60_000,
      profileKey: 'test-profile-stop-recycle',
      daemonId: 'test-daemon-stop-recycle',
      serverInstanceId: 'test-server-stop-recycle',
      serverPid: process.pid,
      createRuntime: async () => runtime,
    });
    daemons.push(daemon);
    await daemon.start();

    const created = await daemonRequest(endpoint, 'sessions.create', { cwd: projectDir });
    expect(created.ok).toBe(true);
    expect(created.result?.session?.id).toBe(sessionId);
    await expect(stat(leaseFile)).resolves.toBeDefined();

    // The failing prompt writes the snapshot then hangs in the recycle
    // dispose, so stop deterministically cancels a successful dispose.
    const promptRequest = daemonRequest(endpoint, 'sessions.prompt', { sessionId, text: 'hello stop recycle' });
    // The prompt socket may be torn down by stop; settlement alone matters
    // here, not the preserved prompt error code covered by the delete path.
    void promptRequest.catch(() => {});
    await disposeEntered.promise;
    await waitFor(async () => (await stat(assignedPath).then(() => true).catch(() => false)) === true, {
      message: 'durability did not write the snapshot before stop',
    });

    const stopPromise = daemon.stop();
    void stopPromise.catch(() => {});
    await sleep(50);
    // Stop awaits the bounded in-flight durability instead of overlapping
    // its teardown dispose; the recycle dispose is still the only disposal.
    expect(disposeCalls).toBe(1);

    releaseDispose.resolve();
    await stopPromise;
    expect(daemon.isStarted).toBe(false);
    await promptRequest.catch(() => ({}));

    // Authoritative result: the cancelled-after-dispose handoff is drained
    // by stop. The stale global is already cleared so teardown cannot reuse
    // or re-dispose it, the held lease is released, disposal stays exactly
    // once, and no dormant state can mutate the persisted snapshot.
    expect(disposeCalls).toBe(1);
    await waitFor(async () => (await stat(leaseFile).then(() => false).catch((error) => error?.code === 'ENOENT')) === true, {
      message: 'cancelled durability lease was not drained by stop',
    });
    await expect(stat(assignedPath)).resolves.toBeDefined();
    await sleep(200);
    expect(disposeCalls).toBe(1);
    await expect(stat(leaseFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(assignedPath)).resolves.toBeDefined();
    daemons.pop();

    // Lease release proof through observable behavior: a fresh daemon with
    // the same directories can acquire and open the persisted snapshot.
    // A different daemon identity proves the first daemon released: a held
    // lease would surface as SESSION_IN_USE instead of a successful open.
    const reopenEndpoint = testDaemonEndpoint(tempRoot);
    const reopenDaemon = createSessionDaemon({
      endpoint: reopenEndpoint,
      credential,
      cwd: projectDir,
      agentDir,
      idleTimeoutMs: 60_000,
      profileKey: 'test-profile-stop-recycle',
      daemonId: 'test-daemon-stop-recycle-reopen',
      serverInstanceId: 'test-server-stop-recycle-reopen',
      serverPid: process.pid,
      createRuntime: async (options) => new FakeRuntime({
        cwd: projectDir,
        session: new FakeSession(sessionId, options?.sessionFile ?? assignedPath, projectDir),
      }),
    });
    daemons.push(reopenDaemon);
    await reopenDaemon.start();
    const reopened = await daemonRequest(reopenEndpoint, 'sessions.open', { sessionId, directory: projectDir });
    expect(reopened.ok).toBe(true);
    expect(reopened.result?.session?.id).toBe(sessionId);
    await reopenDaemon.stop();
    daemons.pop();
  }, 60_000);
});
