import { afterEach, describe, expect, it } from 'bun:test';
import { createConnection } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionDaemon } from './session-daemon/session-daemon.js';

const credential = 'integration-secret';

const connectClient = (endpoint) => {
  const socket = createConnection({ path: endpoint });
  let buffer = '';
  const waiters = [];

  const publish = (frame) => {
    for (let index = 0; index < waiters.length; index += 1) {
      if (waiters[index].predicate(frame)) {
        const [match] = waiters.splice(index, 1);
        match.resolve(frame);
        return;
      }
    }
  };

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) publish(JSON.parse(line));
    }
  });

  socket.on('close', () => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error('Daemon connection closed'));
  });

  const next = (predicate, timeoutMs = 2_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
      if (index !== -1) waiters.splice(index, 1);
      reject(new Error('Timed out waiting for daemon frame'));
    }, timeoutMs);
    waiters.push({
      predicate,
      resolve: (frame) => {
        clearTimeout(timer);
        resolve(frame);
      },
      reject,
    });
  });

  return {
    socket,
    next,
    async authenticate(value = credential, { sessionId, fromSequence } = {}) {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      const authPromise = next((frame) => frame.event === 'session.snapshot' || frame.kind === 'error');
      socket.write(`${JSON.stringify({
        protocolVersion: 1,
        kind: 'authenticate',
        credential: value,
        ...(sessionId ? { sessionId } : {}),
        ...(fromSequence !== undefined ? { fromSequence } : {}),
      })}\n`);
      return authPromise;
    },
    async request(command, payload) {
      const requestId = `req-${Math.random()}`;
      const responsePromise = next((frame) => frame.requestId === requestId);
      socket.write(`${JSON.stringify({
        protocolVersion: 1,
        kind: 'request',
        requestId,
        command,
        ...(payload !== undefined ? { payload } : {}),
      })}\n`);
      return responsePromise;
    },
    close: () => new Promise((resolve) => {
      socket.once('close', () => resolve());
      socket.destroy();
    }),
  };
};

describe('Pi session lifecycle multi-directory integration test', () => {
  let tempRoot;
  let daemon;

  afterEach(async () => {
    if (daemon) {
      await daemon.stop().catch(() => {});
      daemon = null;
    }
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
      tempRoot = null;
    }
  });

  it('handles multi-directory isolation, deterministic first-send titling, and clean deletion without unsolicited sessions', async () => {
    const previousOffline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = '1';

    try {
      tempRoot = await mkdtemp(join(tmpdir(), 'pichamber-integration-'));
      const dirA = join(tempRoot, 'project-a');
      const dirB = join(tempRoot, 'project-b');
      const agentDir = join(tempRoot, 'agent');
      const endpoint = process.platform === 'win32'
        ? `\\\\.\\pipe\\pichamber-integration-${process.pid}`
        : join(tempRoot, 'daemon.sock');

      await Promise.all([
        mkdir(dirA, { recursive: true }),
        mkdir(dirB, { recursive: true }),
        mkdir(agentDir, { recursive: true }),
      ]);

      daemon = createSessionDaemon({
        endpoint,
        credential,
        cwd: dirA,
        agentDir,
      });
      await daemon.start();

      const client = connectClient(endpoint);
      const snapshot = await client.authenticate();
      expect(snapshot.payload.directory).toBe(dirA);

      // 1. Projects list should show known directory
      const projects = await client.request('projects.list');
      expect(projects.result.projects).toEqual(expect.arrayContaining([
        expect.objectContaining({ directory: dirA }),
      ]));

      // 2. Initial sessions list in dirA should be empty (no unsolicited session generated on startup)
      const initialListA = await client.request('sessions.list', { directory: dirA });
      expect(initialListA.result.sessions).toEqual([]);

      // 3. Create a session in dirA without title
      const createdA = await client.request('sessions.create', { cwd: dirA });
      const sessionAId = createdA.result.session.id;
      expect(typeof sessionAId).toBe('string');
      expect(createdA.result.session.directory).toBe(dirA);

      // 4. Create a session in dirB with explicit title
      const createdB = await client.request('sessions.create', { cwd: dirB, title: 'Project B Workflow' });
      const sessionBId = createdB.result.session.id;
      expect(typeof sessionBId).toBe('string');
      expect(createdB.result.session.directory).toBe(dirB);
      expect(createdB.result.session.title).toBe('Project B Workflow');

      // 5. Multi-directory isolation: dirA lists only session A; dirB lists only session B
      const listA = await client.request('sessions.list', { directory: dirA });
      expect(listA.result.sessions.map((s) => s.session.id)).toEqual([sessionAId]);

      const listB = await client.request('sessions.list', { directory: dirB });
      expect(listB.result.sessions.map((s) => s.session.id)).toEqual([sessionBId]);
      expect(listB.result.sessions[0].session.title).toBe('Project B Workflow');

      // 6. Rename session in dirA
      await client.request('sessions.rename', {
        directory: dirA,
        sessionId: sessionAId,
        title: 'Renamed Project A Session',
      });
      const updatedListA = await client.request('sessions.list', { directory: dirA });
      expect(updatedListA.result.sessions[0].session.title).toBe('Renamed Project A Session');

      // 7. Delete session in dirA and verify it leaves dirA empty without generating a replacement
      await client.request('sessions.delete', {
        directory: dirA,
        sessionId: sessionAId,
      });
      const afterDeleteListA = await client.request('sessions.list', { directory: dirA });
      expect(afterDeleteListA.result.sessions).toEqual([]);

      // 8. Session B in dirB remains unaffected
      const intactListB = await client.request('sessions.list', { directory: dirB });
      expect(intactListB.result.sessions.map((s) => s.session.id)).toEqual([sessionBId]);

      await client.close();
    } finally {
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
    }
  });
});
