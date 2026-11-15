import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';

import { registerPiRuntimeRoutes } from './routes.js';
import { createPiDaemonPool } from './session-daemon/daemon-pool.js';

const listen = (app) => new Promise((resolve, reject) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
  server.once('error', reject);
});

const close = (server) => new Promise((resolve) => {
  if (!server) return resolve();
  server.closeAllConnections?.();
  server.close(() => resolve());
});

// A fake daemon records every command it receives and answers from a table
// keyed by command name (a function receives the payload).
const fakeDaemon = (name, answers = {}) => {
  const calls = [];
  return {
    name,
    calls,
    commands: () => calls.map((call) => call.command),
    request: async (command, payload) => {
      calls.push({ command, payload });
      const answer = answers[command];
      if (answer instanceof Error) throw answer;
      if (typeof answer === 'function') return answer(payload);
      if (answer !== undefined) return answer;
      return {};
    },
  };
};

const daemonError = (code) => Object.assign(new Error(code), { code });

const session = (id, directory) => ({ id, directory, createdAt: 1, updatedAt: 2 });
const detail = (id, directory) => ({ session: session(id, directory), messages: [], lastSequence: 0 });
const row = (id, directory, extra = {}) => ({ session: session(id, directory), updatedAt: 2, ...extra });

describe('Pi routes over a daemon pool', () => {
  let server;
  afterEach(async () => {
    await close(server);
    server = undefined;
  });

  const start = async (pool) => {
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, {
      daemonPool: pool,
      archiveStore: { read: async () => ({}), set: async () => undefined },
    });
    server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}`;
    return (path, init) => fetch(`${base}${path}`, init?.body
      ? { ...init, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }
      : init);
  };

  it('sends session commands to the daemon that owns the project or its worktree', async () => {
    const main = fakeDaemon('main', { 'sessions.open': (p) => detail(p.sessionId, p.directory) });
    const sandbox = fakeDaemon('sandbox', { 'sessions.open': (p) => detail(p.sessionId, p.directory) });
    const pool = createPiDaemonPool({ getMainRuntime: () => main });
    pool.register('project-a', { runtime: sandbox, directories: ['/work/a', '/work/a-worktrees/feature'] });
    const call = await start(pool);

    expect((await call('/api/pi/sessions/s-1?directory=/work/a')).status).toBe(200);
    expect((await call('/api/pi/sessions/s-2?directory=/work/a/packages/ui')).status).toBe(200);
    expect((await call('/api/pi/sessions/s-3?directory=/work/a-worktrees/feature')).status).toBe(200);
    expect((await call('/api/pi/sessions/s-4?directory=/work/ab')).status).toBe(200);
    expect((await call('/api/pi/sessions/s-5?directory=/work/other')).status).toBe(200);

    expect(sandbox.calls.map((c) => c.payload.sessionId)).toEqual(['s-1', 's-2', 's-3']);
    expect(main.calls.map((c) => c.payload.sessionId)).toEqual(['s-4', 's-5']);
  });

  it('keeps directory-less commands and resource writes on the main daemon', async () => {
    const main = fakeDaemon('main', {
      'projects.list': { projects: [{ directory: '/work/a', selected: true }] },
      'projects.select': { directory: '/work/a' },
      'providers.list': { providers: [] },
      'engines.list': { engines: [] },
      'providers.refresh': { providers: [] },
      'providers.login': { loginId: 'l-1', state: 'pending' },
      'providers.logout': {},
      'settings.get': {},
      'resources.list': { resources: [] },
      'resources.prompts.create': { resources: [] },
    });
    const sandbox = fakeDaemon('sandbox');
    const pool = createPiDaemonPool({ getMainRuntime: () => main });
    pool.register('project-a', { runtime: sandbox, directories: ['/work/a'] });
    const call = await start(pool);

    await call('/api/pi/projects');
    await call('/api/pi/projects/select', { method: 'POST', body: { directory: '/work/a' } });
    await call('/api/pi/providers');
    await call('/api/pi/engines');
    await call('/api/pi/providers/refresh', { method: 'POST', body: { directory: '/work/a' } });
    await call('/api/pi/providers/openai/login', { method: 'POST', body: { type: 'oauth' } });
    await call('/api/pi/providers/openai/logout', { method: 'POST', body: {} });
    await call('/api/pi/settings');
    await call('/api/pi/resources');
    await call('/api/pi/resources/prompts', {
      method: 'POST',
      body: { name: 'review', description: 'd', content: 'c', location: 'global', directory: '/work/a' },
    });

    expect(sandbox.calls).toEqual([]);
    expect(main.commands()).toEqual([
      'projects.list', 'projects.select', 'providers.list', 'engines.list', 'providers.refresh',
      'providers.login', 'providers.logout', 'settings.get', 'resources.list', 'resources.prompts.create',
    ]);
  });

  it('routes create, list, rename, resources, extensions and receipts by directory', async () => {
    const answers = {
      'sessions.create': (p) => detail('s-new', p.cwd),
      'sessions.list': { sessions: [] },
      'sessions.rename': {},
      'resources.list': { resources: [] },
      'extensions.list': { extensions: [] },
      'extensions.respond': { resolved: true },
      'sessions.sendReceipt': { status: 'unknown' },
      'sessions.bash': {},
    };
    const main = fakeDaemon('main', answers);
    const sandbox = fakeDaemon('sandbox', answers);
    const pool = createPiDaemonPool({ getMainRuntime: () => main });
    pool.register('project-a', { runtime: sandbox, directories: ['/work/a', '/work/a-wt'] });
    const call = await start(pool);

    expect((await call('/api/pi/sessions', { method: 'POST', body: { cwd: '/work/a-wt' } })).status).toBe(201);
    expect((await call('/api/pi/sessions?directory=/work/a')).status).toBe(200);
    expect((await call('/api/pi/sessions/s-1', { method: 'PATCH', body: { title: 't', directory: '/work/a' } })).status).toBe(204);
    // Status codes past this point depend on fake payload shapes; routing is
    // what is asserted below.
    await call('/api/pi/resources?directory=/work/a');
    await call('/api/pi/extensions?directory=/work/a');
    await call('/api/pi/extensions/respond', { method: 'POST', body: { requestId: 'r-1', directory: '/work/a', cancelled: true } });
    await call('/api/pi/sessions/s-1/send-receipt?directory=/work/a', {
      method: 'POST',
      body: { kind: 'prompt', operationId: 'op-123456789abc' },
    });
    await call('/api/pi/sessions/s-1/bash', { method: 'POST', body: { command: 'ls', directory: '/work/a' } });

    expect(sandbox.commands()).toEqual([
      'sessions.create', 'sessions.list', 'sessions.rename', 'resources.list', 'extensions.list',
      'extensions.respond', 'sessions.sendReceipt', 'sessions.bash',
    ]);
    expect(main.calls).toEqual([]);
    // The payload the daemon sees is unchanged by routing.
    expect(sandbox.calls.find((c) => c.command === 'sessions.sendReceipt').payload)
      .toEqual({ kind: 'prompt', sessionId: 's-1', operationId: 'op-123456789abc' });
  });

  const pending = (sessionId, directory) => ({ sessionId, directory, pending: { count: 1, kind: 'input', since: 5 } });

  it('merges pending input from every live daemon, keeping the main stream cursor', async () => {
    const main = fakeDaemon('main', { 'sessions.pendingInput': { sessions: [pending('s-main', '/work/other')], sequence: 40, streamEpoch: 'epoch-main' } });
    const sandbox = fakeDaemon('sandbox', { 'sessions.pendingInput': { sessions: [pending('s-box', '/work/a')], sequence: 7, streamEpoch: 'epoch-box' } });
    const pool = createPiDaemonPool({ getMainRuntime: () => main });
    pool.register('project-a', { runtime: sandbox, directories: ['/work/a'] });
    const call = await start(pool);

    const response = await call('/api/pi/sessions/pending-input');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessions: [pending('s-main', '/work/other'), pending('s-box', '/work/a')],
      sequence: 40,
      streamEpoch: 'epoch-main',
    });
  });

  it('keeps the other daemons\' pending input when one daemon fails, and marks the list incomplete', async () => {
    const main = fakeDaemon('main', { 'sessions.pendingInput': { sessions: [pending('s-main', '/work/other')], sequence: 40, streamEpoch: 'epoch-main' } });
    const broken = fakeDaemon('broken', { 'sessions.pendingInput': daemonError('DAEMON_UNAVAILABLE') });
    const pool = createPiDaemonPool({ getMainRuntime: () => main });
    pool.register('project-a', { runtime: broken, directories: ['/work/a'] });
    const call = await start(pool);

    const response = await call('/api/pi/sessions/pending-input');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessions: [pending('s-main', '/work/other')],
      sequence: 40,
      streamEpoch: 'epoch-main',
      incomplete: true,
    });
  });

  it('fails pending input when every daemon fails', async () => {
    const main = fakeDaemon('main', { 'sessions.pendingInput': daemonError('DAEMON_UNAVAILABLE') });
    const broken = fakeDaemon('broken', { 'sessions.pendingInput': daemonError('DAEMON_UNAVAILABLE') });
    const pool = createPiDaemonPool({ getMainRuntime: () => main });
    pool.register('project-a', { runtime: broken, directories: ['/work/a'] });
    const call = await start(pool);

    const response = await call('/api/pi/sessions/pending-input');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'DAEMON_UNAVAILABLE' } });
  });

  it('merges live state from a draining daemon into a directory list by session id', async () => {
    const busy = { lifecycle: 'busy', sequence: 12 };
    const sandbox = fakeDaemon('sandbox', {
      'sessions.list': {
        streamEpoch: 'epoch-box',
        sessions: [row('s-1', '/work/a'), row('s-2', '/work/a', { live: { lifecycle: 'idle', sequence: 3 } })],
      },
    });
    const main = fakeDaemon('main', {
      'sessions.list': {
        streamEpoch: 'epoch-main',
        sessions: [
          row('s-1', '/work/a', { live: busy, inputState: { pending: null, sequence: 12 } }),
          row('s-2', '/work/a', { live: { lifecycle: 'busy', sequence: 9 } }),
          row('s-9', '/work/a', { live: busy }),
        ],
      },
    });
    const pool = createPiDaemonPool({ getMainRuntime: () => main });
    pool.register('project-a', { runtime: sandbox, directories: ['/work/a'] });
    pool.setDraining('/work/a', ['main']);
    const call = await start(pool);

    const response = await call('/api/pi/sessions?directory=/work/a');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      streamEpoch: 'epoch-box',
      sessions: [
        row('s-1', '/work/a', { live: busy, inputState: { pending: null, sequence: 12 } }),
        row('s-2', '/work/a', { live: { lifecycle: 'idle', sequence: 3 } }),
      ],
    });
    expect(main.calls).toEqual([{ command: 'sessions.list', payload: { directory: '/work/a' } }]);
  });

  it('serves the owner\'s list unchanged when the draining daemon fails', async () => {
    const rows = [row('s-1', '/work/a')];
    const sandbox = fakeDaemon('sandbox', { 'sessions.list': { sessions: rows } });
    const main = fakeDaemon('main', { 'sessions.list': daemonError('DAEMON_UNAVAILABLE') });
    const pool = createPiDaemonPool({ getMainRuntime: () => main });
    pool.register('project-a', { runtime: sandbox, directories: ['/work/a'] });
    pool.setDraining('/work/a', ['main']);
    const call = await start(pool);

    const response = await call('/api/pi/sessions?directory=/work/a');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessions: rows });
  });

  it('fails the list when the owning daemon fails, even if a draining daemon answers', async () => {
    const sandbox = fakeDaemon('sandbox', { 'sessions.list': daemonError('DAEMON_UNAVAILABLE') });
    const main = fakeDaemon('main', { 'sessions.list': { sessions: [row('s-1', '/work/a')] } });
    const pool = createPiDaemonPool({ getMainRuntime: () => main });
    pool.register('project-a', { runtime: sandbox, directories: ['/work/a'] });
    pool.setDraining('/work/a', ['main']);
    const call = await start(pool);

    const response = await call('/api/pi/sessions?directory=/work/a');
    expect(response.status).toBe(503);
  });
});
