import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, stat, readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createSessionDaemon } from './session-daemon/session-daemon.js';
import { getPiSessionDirectory } from './session-daemon/session-jsonl.js';
import { resolveSessionLeaseFile } from './session-daemon/session-lease.js';

/**
 * Regression coverage for the session persistence gap.
 *
 * Scenario, driven through the real daemon IPC protocol with a real
 * `SessionManager` (no injected `createRuntime`):
 *  1. `sessions.create` a fresh session.
 *  2. Reject its first prompt before any assistant message with a model
 *     failure (`sessions.prompt` with an unavailable model -> `INVALID_MODEL`).
 *  3. Lose the resident registry via daemon stop/restart (same cwd/agentDir).
 *  4. Assert the session is still listed and reopenable instead of
 *     `INVALID_SESSION`.
 *
 * Why this seam is faithful:
 * - Same entrypoint and harness shape as `session-lifecycle.integration.test.js`:
 *   real `createSessionDaemon`, temp cwd/agent dirs, local socket endpoint.
 * - One-request-per-connection, exactly like production `requestSessionDaemon`
 *   (`server/lib/pi/session-daemon/ipc-client.js`): daemon error frames carry
 *   no `requestId` and destroy the socket, so the lifecycle test's
 *   persistent-socket helper cannot observe the prompt rejection. A nugatory
 *   networked prompt was also rejected as a seam: offline it hangs instead of
 *   failing fast, so `INVALID_MODEL` is the deterministic public-protocol model
 *   failure before any assistant message. The persistence consequence is
 *   identical (Pi's `SessionManager` defers JSONL creation until the first
 *   assistant message, so nothing reaches disk either way).
 *
 * Fixed behavior: a rejected first input materializes the valid snapshot at
 * Pi's assigned path (owner-only, atomic no-clobber, path-validated) and
 * recycles the resident runtime, so the pre-restart list coverage no longer
 * comes only from the in-memory resident overlay. Untouched creates stay
 * ephemeral by design.
 */
const credential = 'persistence-gap-regression-secret';

const testDaemonEndpoint = (root) => {
  if (process.platform === 'win32') return `\\\\.\\pipe\\pichamber-persist-gap-${process.pid}-${Math.random().toString(16).slice(2)}`;
  return join(root, 'daemon.sock');
};

// Production-faithful single-request client: authenticate, send exactly one
// request, resolve the response or the error frame, then destroy the socket.
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

describe('session persistence gap regression', () => {
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

  it('a fresh session whose first prompt is rejected survives daemon restart', async () => {
    const previousOffline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = '1';
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'pichamber-persist-gap-'));
      const projectDir = join(tempRoot, 'project');
      const agentDir = join(tempRoot, 'agent');
      const endpoint = testDaemonEndpoint(tempRoot);
      await mkdir(projectDir, { recursive: true });
      await mkdir(agentDir, { recursive: true });

      const daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
      daemons.push(daemon);
      await daemon.start();

      const created = await daemonRequest(endpoint, 'sessions.create', { cwd: projectDir });
      expect(created.ok).toBe(true);
      const sessionId = created.result?.session?.id;
      expect(typeof sessionId).toBe('string');

      // First prompt fails before any assistant message: unavailable model is
      // the deterministic public-protocol model failure (no network involved).
      const rejected = await daemonRequest(endpoint, 'sessions.prompt', {
        sessionId,
        text: 'hello before restart',
        model: { providerId: '__nonexistent__', modelId: '__nonexistent__' },
      });
      expect(rejected.ok).toBe(false);
      expect(rejected.error?.code).toBe('INVALID_MODEL');

      // Before restart the session is visible via the resident registry overlay.
      const listedBefore = await daemonRequest(endpoint, 'sessions.list', { directory: projectDir });
      expect(listedBefore.ok).toBe(true);
      expect(listedBefore.result.sessions.map((entry) => entry.session.id)).toContain(sessionId);

      // Lose the resident registry exactly like a daemon restart.
      await daemon.stop();
      daemons.pop();
      const restarted = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
      daemons.push(restarted);
      await restarted.start();

      // Regression assertions: the session must survive on persisted state,
      // not just in the previous process's memory.
      const listedAfter = await daemonRequest(endpoint, 'sessions.list', { directory: projectDir });
      expect(listedAfter.ok).toBe(true);
      expect(listedAfter.result.sessions.map((entry) => entry.session.id)).toContain(sessionId);

      const openedAfter = await daemonRequest(endpoint, 'sessions.open', { sessionId, directory: projectDir });
      expect(openedAfter.ok).toBe(true);
      expect(openedAfter.result?.session?.id).toBe(sessionId);
    } finally {
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
    }
  }, 60_000);

  it('a rejected first prompt stays retryable same-daemon without clobbering the snapshot', async () => {
    const previousOffline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = '1';
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'pichamber-persist-gap-'));
      const projectDir = join(tempRoot, 'project');
      const agentDir = join(tempRoot, 'agent');
      const endpoint = testDaemonEndpoint(tempRoot);
      await mkdir(projectDir, { recursive: true });
      await mkdir(agentDir, { recursive: true });

      const daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
      daemons.push(daemon);
      await daemon.start();

      const created = await daemonRequest(endpoint, 'sessions.create', { cwd: projectDir });
      expect(created.ok).toBe(true);
      const sessionId = created.result?.session?.id;
      expect(typeof sessionId).toBe('string');

      const rejected = await daemonRequest(endpoint, 'sessions.prompt', {
        sessionId,
        text: 'hello retry',
        model: { providerId: '__nonexistent__', modelId: '__nonexistent__' },
      });
      expect(rejected.ok).toBe(false);
      expect(rejected.error?.code).toBe('INVALID_MODEL');

      // Durability materialized the snapshot: the assigned JSONL exists with
      // owner-only permissions.
      const sessionDir = getPiSessionDirectory({ cwd: projectDir, agentDir });
      const files = await readdir(sessionDir);
      const persistedName = files.find((name) => name.endsWith(`_${sessionId}.jsonl`));
      expect(persistedName).toBeDefined();
      const persistedPath = join(sessionDir, persistedName);
      const beforeStat = await stat(persistedPath);
      if (process.platform !== 'win32') {
        expect(beforeStat.mode & 0o777).toBe(0o600);
      }
      const beforeContent = await readFile(persistedPath, 'utf8');
      expect(beforeContent).toContain(sessionId);

      // Recycling released the lease: the session is persisted but not resident.
      const leaseFile = resolveSessionLeaseFile({ agentDir, cwd: projectDir, sessionId }).file;
      await expect(stat(leaseFile)).rejects.toMatchObject({ code: 'ENOENT' });

      // Same-daemon retry preserves the original error (no SESSION_IN_USE,
      // no INVALID_SESSION) and does not clobber the snapshot. Pi itself may
      // append a duplicate thinking-level entry when reopening an empty
      // session (SDK `createAgentSession` treats message-less logs as new),
      // so durability must preserve the prefix, not freeze the exact bytes.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const retried = await daemonRequest(endpoint, 'sessions.prompt', {
        sessionId,
        text: 'hello retry again',
        model: { providerId: '__nonexistent__', modelId: '__nonexistent__' },
      });
      expect(retried.ok).toBe(false);
      expect(retried.error?.code).toBe('INVALID_MODEL');

      const afterContent = await readFile(persistedPath, 'utf8');
      expect(afterContent.startsWith(beforeContent)).toBe(true);
      expect(afterContent).toContain(sessionId);

      const listed = await daemonRequest(endpoint, 'sessions.list', { directory: projectDir });
      expect(listed.ok).toBe(true);
      expect(listed.result.sessions.map((entry) => entry.session.id)).toContain(sessionId);

      const opened = await daemonRequest(endpoint, 'sessions.open', { sessionId, directory: projectDir });
      expect(opened.ok).toBe(true);
      expect(opened.result?.session?.id).toBe(sessionId);
    } finally {
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
    }
  }, 60_000);

  it('sessions created but never prompted stay ephemeral across restart', async () => {
    const previousOffline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = '1';
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'pichamber-persist-gap-'));
      const projectDir = join(tempRoot, 'project');
      const agentDir = join(tempRoot, 'agent');
      const endpoint = testDaemonEndpoint(tempRoot);
      await mkdir(projectDir, { recursive: true });
      await mkdir(agentDir, { recursive: true });

      const daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
      daemons.push(daemon);
      await daemon.start();

      const created = await daemonRequest(endpoint, 'sessions.create', { cwd: projectDir });
      expect(created.ok).toBe(true);
      const sessionId = created.result?.session?.id;
      expect(typeof sessionId).toBe('string');

      const listedBefore = await daemonRequest(endpoint, 'sessions.list', { directory: projectDir });
      expect(listedBefore.ok).toBe(true);
      expect(listedBefore.result.sessions.map((entry) => entry.session.id)).toContain(sessionId);

      await daemon.stop();
      daemons.pop();
      const restarted = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
      daemons.push(restarted);
      await restarted.start();

      const listedAfter = await daemonRequest(endpoint, 'sessions.list', { directory: projectDir });
      expect(listedAfter.ok).toBe(true);
      expect(listedAfter.result.sessions.map((entry) => entry.session.id)).not.toContain(sessionId);

      const openedAfter = await daemonRequest(endpoint, 'sessions.open', { sessionId, directory: projectDir });
      expect(openedAfter.ok).toBe(false);
      expect(openedAfter.error?.code).toBe('INVALID_SESSION');
    } finally {
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
    }
  }, 60_000);

  it('a rejected first prompt preserves the explicit title across restart', async () => {
    const previousOffline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = '1';
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'pichamber-persist-gap-'));
      const projectDir = join(tempRoot, 'project');
      const agentDir = join(tempRoot, 'agent');
      const endpoint = testDaemonEndpoint(tempRoot);
      await mkdir(projectDir, { recursive: true });
      await mkdir(agentDir, { recursive: true });

      const daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
      daemons.push(daemon);
      await daemon.start();

      const created = await daemonRequest(endpoint, 'sessions.create', { cwd: projectDir, title: 'Persisted Title' });
      expect(created.ok).toBe(true);
      const sessionId = created.result?.session?.id;
      expect(typeof sessionId).toBe('string');

      const rejected = await daemonRequest(endpoint, 'sessions.prompt', {
        sessionId,
        text: 'hello titled',
        model: { providerId: '__nonexistent__', modelId: '__nonexistent__' },
      });
      expect(rejected.ok).toBe(false);
      expect(rejected.error?.code).toBe('INVALID_MODEL');

      await daemon.stop();
      daemons.pop();
      const restarted = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
      daemons.push(restarted);
      await restarted.start();

      const listedAfter = await daemonRequest(endpoint, 'sessions.list', { directory: projectDir });
      expect(listedAfter.ok).toBe(true);
      const row = listedAfter.result.sessions.find((entry) => entry.session.id === sessionId);
      expect(row).toBeDefined();
      expect(row.session.title).toBe('Persisted Title');

      const openedAfter = await daemonRequest(endpoint, 'sessions.open', { sessionId, directory: projectDir });
      expect(openedAfter.ok).toBe(true);
      expect(openedAfter.result?.session?.id).toBe(sessionId);
    } finally {
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
    }
  }, 60_000);

  it('a create with an unavailable model fails without persisting or leaking a lease', async () => {
    const previousOffline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = '1';
    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'pichamber-persist-gap-'));
      const projectDir = join(tempRoot, 'project');
      const agentDir = join(tempRoot, 'agent');
      const endpoint = testDaemonEndpoint(tempRoot);
      await mkdir(projectDir, { recursive: true });
      await mkdir(agentDir, { recursive: true });

      const daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
      daemons.push(daemon);
      await daemon.start();

      const failed = await daemonRequest(endpoint, 'sessions.create', {
        cwd: projectDir,
        model: { providerId: '__nonexistent__', modelId: '__nonexistent__' },
      });
      expect(failed.ok).toBe(false);
      expect(failed.error?.code).toBe('INVALID_MODEL');

      const listed = await daemonRequest(endpoint, 'sessions.list', { directory: projectDir });
      expect(listed.ok).toBe(true);
      expect(listed.result.sessions).toEqual([]);

      const sessionDir = getPiSessionDirectory({ cwd: projectDir, agentDir });
      const files = await readdir(sessionDir).catch(() => []);
      expect(files.filter((name) => name.endsWith('.jsonl'))).toEqual([]);

      const locksDir = join(agentDir, '.pichamber', 'locks', 'sessions');
      const locks = await readdir(locksDir).catch(() => []);
      expect(locks.filter((name) => name.endsWith('.json'))).toEqual([]);
    } finally {
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
    }
  }, 60_000);
});
