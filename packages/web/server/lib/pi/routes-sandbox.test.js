import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerPiRuntimeRoutes } from './routes.js';
import { createPiDaemonPool } from './session-daemon/daemon-pool.js';
import { createPiUiSettingsStore } from './ui-settings-store.js';
import { createProjectSandboxManager } from './sandbox/project-sandbox-manager.js';
import { getPiSessionDirectory } from './session-daemon/session-jsonl.js';

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
const row = (id, directory) => ({ session: session(id, directory), updatedAt: 2 });

const daemonAnswers = (extra = {}) => ({
  'sessions.open': (p) => detail(p.sessionId, p.directory),
  'sessions.create': (p) => detail('s-new', p.cwd),
  'sessions.list': (p) => ({ sessions: [row('s-1', p.directory)] }),
  'sessions.prompt': {},
  'providers.hosts': { hosts: ['api.anthropic.com'] },
  'runtime.health': { state: 'ready', residentSessions: 1 },
  ...extra,
});

// The launcher seam: a probe result and a record of what was launched.
const fakeLauncher = (probe = { available: true, version: '0.82.0', capabilities: ['landlock-abi-6'] }) => {
  const launcher = {
    id: 'nono',
    probes: 0,
    probeResult: probe,
    probe: async () => {
      launcher.probes += 1;
      return launcher.probeResult;
    },
  };
  return launcher;
};

const PI_RUNNING = [
  ['GET', '/api/pi/sessions/s-1?directory=DIR'],
  ['GET', '/api/pi/sessions/s-1/messages?directory=DIR'],
  ['POST', '/api/pi/sessions', { cwd: 'DIR' }],
  ['POST', '/api/pi/sessions/s-1/prompt', { directory: 'DIR', text: 'hi', streamEpoch: 'epoch-1' }],
  ['POST', '/api/pi/sessions/s-1/steer', { directory: 'DIR', text: 'hi', streamEpoch: 'epoch-1' }],
  ['POST', '/api/pi/sessions/s-1/follow-up', { directory: 'DIR', text: 'hi', streamEpoch: 'epoch-1' }],
  ['POST', '/api/pi/sessions/s-1/bash', { directory: 'DIR', command: 'ls' }],
  ['POST', '/api/pi/sessions/s-1/navigate', { directory: 'DIR', messageId: 'm-1' }],
  ['POST', '/api/pi/sessions/s-1/fork', { directory: 'DIR', messageId: 'm-1' }],
  ['POST', '/api/pi/sessions/s-1/compact', { directory: 'DIR' }],
  ['POST', '/api/pi/sessions/s-1/model', { directory: 'DIR', providerId: 'p', modelId: 'm' }],
  ['POST', '/api/pi/sessions/s-1/thinking', { directory: 'DIR', level: 'low' }],
  ['POST', '/api/pi/extensions/respond', { requestId: 'r-1', directory: 'DIR', cancelled: true }],
  ['GET', '/api/pi/resources?directory=DIR'],
];

describe('Pi routes for sandboxed projects', () => {
  let server;
  let manager;
  afterEach(async () => {
    await manager?.stop();
    manager = undefined;
    await close(server);
    server = undefined;
  });

  const setup = async ({ probe, mainAnswers = {}, sandboxAnswers = {}, startError, idleStopMs = 60_000 } = {}) => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-routes-sandbox-'));
    const dataDir = join(root, 'data');
    const agentDir = join(root, 'agent');
    const projectA = join(root, 'code', 'a');
    const projectB = join(root, 'code', 'b');
    const gitId = 'f'.repeat(40);
    const worktree = join(dataDir, 'worktree', gitId, 'feature');
    await Promise.all([
      mkdir(join(projectA, '.git'), { recursive: true }),
      mkdir(projectB, { recursive: true }),
      mkdir(worktree, { recursive: true }),
      mkdir(agentDir, { recursive: true }),
    ]);
    await writeFile(join(projectA, '.git', 'pichamber'), gitId);
    const uiSettingsStore = createPiUiSettingsStore({ file: join(dataDir, 'settings.json') });
    await uiSettingsStore.write({ projects: [{ id: 'proj-a', path: projectA }, { id: 'proj-b', path: projectB }] });

    const main = fakeDaemon('main', daemonAnswers(mainAnswers));
    const pool = createPiDaemonPool({ getMainRuntime: () => main });
    const launcher = fakeLauncher(probe);
    const launched = [];
    const intakes = [];
    let clock = 0;
    const timers = [];
    manager = createProjectSandboxManager({
      daemonPool: pool,
      uiSettingsStore,
      launcher,
      dataDir,
      agentDir,
      getServerPort: () => 3000,
      readRoots: ['/opt/node'],
      now: () => clock,
      setInterval: (fn) => { timers.push(fn); return timers.length; },
      clearInterval: () => {},
      idleStopMs,
      createIntake: ({ socketPath, publish }) => {
        const intake = { socketPath, publish, started: false, stopped: false };
        intakes.push(intake);
        return {
          start: async () => { intake.started = true; return true; },
          stop: async () => { intake.stopped = true; },
        };
      },
      createSupervisor: async ({ sandbox, launcher: used }) => {
        const probed = await used.probe();
        if (!probed.available) throw Object.assign(daemonError('SANDBOX_UNAVAILABLE'), { reason: probed.code });
        const daemon = fakeDaemon(`sandbox-${launched.length}`, daemonAnswers(sandboxAnswers));
        daemon.sandbox = sandbox;
        daemon.stopped = false;
        daemon.paths = { openUrlSocket: join(root, 'run', `${launched.length}`, 'open-url.sock') };
        daemon.start = async () => { if (startError) throw daemonError(startError); };
        daemon.stop = async () => { daemon.stopped = true; };
        launched.push(daemon);
        return daemon;
      },
    });
    await manager.reconcile();

    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, {
      daemonPool: pool,
      sandboxManager: manager,
      uiSettingsStore,
      archiveStore: { read: async () => ({}), set: async () => undefined },
    });
    server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (path, init) => fetch(`${base}${path}`, init?.body
      ? { ...init, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }
      : init);
    const sandboxOn = (projectId = 'proj-a', setting = {}) => call(`/api/pi/sandbox/projects/${projectId}`, {
      method: 'PUT',
      body: { mode: 'nono', allowHosts: [], allowLocalPorts: [], extraFolders: [], ...setting },
    });
    const tick = async (ms) => {
      clock += ms;
      for (const timer of timers) await timer();
    };
    return { root, dataDir, agentDir, projectA, projectB, worktree, gitId, main, pool, launcher, launched, intakes, call, sandboxOn, tick, uiSettingsStore };
  };

  it('changes nothing while no project is sandboxed', async () => {
    const ctx = await setup();
    const response = await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    expect((await response.json()).session).toEqual(session('s-1', ctx.projectA));
    expect(ctx.main.commands()).toEqual(['sessions.open']);
    expect(ctx.launched).toEqual([]);
    expect(ctx.launcher.probes).toBe(0);
  });

  it('starts a sandboxed project\'s own daemon on first use and routes the project and its worktrees there', async () => {
    const ctx = await setup();
    const saved = await ctx.sandboxOn('proj-a', {
      allowHosts: ['registry.npmjs.org'],
      allowLocalPorts: [8080],
      extraFolders: [{ path: join(ctx.root, 'docs'), access: 'read' }],
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      project: {
        projectId: 'proj-a',
        mode: 'nono',
        launcher: 'nono',
        availability: { state: 'available' },
        allowHosts: ['registry.npmjs.org'],
        allowLocalPorts: [8080],
        extraFolders: [{ path: join(ctx.root, 'docs'), access: 'read' }],
      },
    });
    // Saving starts nothing; the first Pi command does.
    expect(ctx.launched).toEqual([]);

    const opened = await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    expect((await opened.json()).session).toEqual({ ...session('s-1', ctx.projectA), sandboxed: true });
    await ctx.call(`/api/pi/sessions/s-2?directory=${ctx.worktree}`);
    await ctx.call(`/api/pi/sessions/s-3?directory=${ctx.projectB}`);

    expect(ctx.launched).toHaveLength(1);
    const [daemon] = ctx.launched;
    expect(daemon.calls.map((c) => c.payload?.sessionId)).toEqual(['s-1', 's-2']);
    expect(ctx.main.calls.filter((c) => c.command === 'sessions.open').map((c) => c.payload.sessionId)).toEqual(['s-3']);

    // Grants come from the project, its existing worktrees and its extras;
    // the network allows the signed-in providers' hosts plus the project's.
    const { grants, network, leaseAgentDir } = daemon.sandbox;
    expect(grants).toEqual(expect.arrayContaining([
      { kind: 'readWrite', path: ctx.projectA },
      { kind: 'readWrite', path: join(ctx.dataDir, 'worktree', ctx.gitId) },
      { kind: 'readWrite', path: getPiSessionDirectory({ cwd: ctx.worktree, agentDir: ctx.agentDir }) },
      { kind: 'read', path: join(ctx.root, 'docs') },
    ]));
    expect(network).toEqual({ mode: 'proxy', allowHosts: ['api.anthropic.com', 'registry.npmjs.org'], allowLocalPorts: [8080] });
    expect(leaseAgentDir).toBe(ctx.agentDir);

    // Its own Open request intake, publishing through that daemon.
    expect(ctx.intakes).toHaveLength(1);
    expect(ctx.intakes[0]).toMatchObject({ socketPath: daemon.paths.openUrlSocket, started: true });
    await ctx.intakes[0].publish({ url: 'https://example.test' });
    expect(daemon.calls.at(-1)).toEqual({ command: 'openUrl.publish', payload: { url: 'https://example.test' } });
  });

  it('marks sandboxed sessions in lists, details and creation, and leaves other projects\' rows unchanged', async () => {
    const ctx = await setup();
    await ctx.sandboxOn();
    const listA = await (await ctx.call(`/api/pi/sessions?directory=${ctx.projectA}`)).json();
    const listB = await (await ctx.call(`/api/pi/sessions?directory=${ctx.projectB}`)).json();
    const created = await (await ctx.call('/api/pi/sessions', { method: 'POST', body: { cwd: ctx.projectA } })).json();
    expect(listA.sessions[0].session.sandboxed).toBe(true);
    expect(listB.sessions[0].session).toEqual(session('s-1', ctx.projectB));
    expect(created.session.sandboxed).toBe(true);
  });

  it('fails closed: an unavailable launcher answers SANDBOX_UNAVAILABLE for every Pi-running command and never uses the main daemon', async () => {
    const ctx = await setup({ probe: { available: false, code: 'NO_LANDLOCK' } });
    const saved = await ctx.sandboxOn();
    expect(await saved.json()).toMatchObject({ project: { mode: 'nono', availability: { state: 'unavailable', reason: 'NO_LANDLOCK' } } });

    for (const [method, path, body] of PI_RUNNING) {
      const response = await ctx.call(path.replace('DIR', ctx.projectA), {
        method,
        ...(body ? { body: JSON.parse(JSON.stringify(body).replace('DIR', ctx.projectA)) } : {}),
      });
      expect([path, response.status]).toEqual([path, 503]);
      expect(await response.json()).toEqual({ error: { code: 'SANDBOX_UNAVAILABLE', reason: 'NO_LANDLOCK' } });
    }
    expect(ctx.launched).toEqual([]);
    expect(ctx.main.calls.filter((c) => c.command !== 'sessions.list')).toEqual([]);

    // Listing still works: it reads transcripts on disk and runs no Pi code.
    const list = await ctx.call(`/api/pi/sessions?directory=${ctx.projectA}`);
    expect(list.status).toBe(200);
    expect((await list.json()).sessions.map((item) => item.session.id)).toEqual(['s-1']);
  });

  it('fails closed with the launch failure code when the sandbox daemon cannot start', async () => {
    const ctx = await setup({ startError: 'DAEMON_START_TIMEOUT' });
    await ctx.sandboxOn();
    const response = await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'SANDBOX_UNAVAILABLE', reason: 'DAEMON_START_TIMEOUT' } });
    expect(ctx.main.commands()).not.toContain('sessions.open');
    expect(ctx.intakes[0].stopped).toBe(true);
    const projects = await (await ctx.call('/api/pi/sandbox/projects')).json();
    expect(projects.projects.find((p) => p.projectId === 'proj-a').availability)
      .toEqual({ state: 'unavailable', reason: 'DAEMON_START_TIMEOUT' });
  });

  it('routes a session command without a directory by the transcript\'s folder, so it cannot reach the main daemon', async () => {
    const ctx = await setup({ probe: { available: false, code: 'NOT_INSTALLED' } });
    await ctx.sandboxOn();
    const sessions = getPiSessionDirectory({ cwd: ctx.projectA, agentDir: ctx.agentDir });
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, '2026-01-01_s-9.jsonl'), `${JSON.stringify({ type: 'session', id: 's-9', cwd: ctx.projectA, timestamp: '2026-01-01T00:00:00.000Z' })}\n`);

    const response = await ctx.call('/api/pi/sessions/s-9');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'SANDBOX_UNAVAILABLE', reason: 'NOT_INSTALLED' } });
    expect(ctx.main.calls).toEqual([]);
  });

  it('reports the launcher status and re-checks it on request, without paths or raw nono output', async () => {
    const ctx = await setup({ probe: { available: false, code: 'NOT_INSTALLED' } });
    const first = await ctx.call('/api/pi/sandbox');
    expect(await first.json()).toEqual({ launchers: [{ id: 'nono', available: false, reason: 'NOT_INSTALLED' }] });
    ctx.launcher.probeResult = { available: true, version: '0.82.0', capabilities: ['landlock-abi-6'] };
    expect(await (await ctx.call('/api/pi/sandbox')).json()).toEqual({ launchers: [{ id: 'nono', available: false, reason: 'NOT_INSTALLED' }] });
    const rechecked = await ctx.call('/api/pi/sandbox/recheck', { method: 'POST' });
    expect(await rechecked.json()).toEqual({ launchers: [{ id: 'nono', available: true, version: '0.82.0' }] });
  });

  it('lists every project\'s sandbox state and refuses invalid settings or unknown projects', async () => {
    const ctx = await setup();
    await ctx.sandboxOn('proj-a');
    const listed = await (await ctx.call('/api/pi/sandbox/projects')).json();
    expect(listed).toEqual({
      projects: [
        { projectId: 'proj-a', mode: 'nono', launcher: 'nono', availability: { state: 'available' }, allowHosts: [], allowLocalPorts: [], extraFolders: [] },
        { projectId: 'proj-b', mode: 'off', launcher: null, availability: { state: 'off' }, allowHosts: [], allowLocalPorts: [], extraFolders: [] },
      ],
    });
    const body = JSON.stringify(listed);
    expect(body).not.toContain(ctx.root);

    expect((await ctx.sandboxOn('proj-a', { allowLocalPorts: [443] })).status).toBe(400);
    expect((await ctx.sandboxOn('proj-a', { mode: 'docker' })).status).toBe(400);
    expect((await ctx.sandboxOn('missing')).status).toBe(404);
  });

  it('turning a project off routes it back to the main daemon and stops its sandbox daemon', async () => {
    const ctx = await setup();
    await ctx.sandboxOn();
    await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    expect(await (await ctx.sandboxOn('proj-a', { mode: 'off' })).json()).toMatchObject({ project: { mode: 'off', availability: { state: 'off' } } });
    expect(ctx.launched[0].stopped).toBe(true);
    expect(ctx.intakes[0].stopped).toBe(true);
    const response = await ctx.call(`/api/pi/sessions/s-2?directory=${ctx.projectA}`);
    expect((await response.json()).session).toEqual(session('s-2', ctx.projectA));
    expect(ctx.main.calls.filter((c) => c.command === 'sessions.open').map((c) => c.payload.sessionId)).toEqual(['s-2']);
  });

  it('a project rewrite by a client cannot turn its sandbox off', async () => {
    const ctx = await setup({ probe: { available: false, code: 'NO_LANDLOCK' } });
    await ctx.sandboxOn();
    await ctx.call('/api/pi/ui-settings', { method: 'PUT', body: { projects: [{ id: 'proj-b', path: ctx.projectB }, { id: 'proj-a', path: ctx.projectA }] } });
    const response = await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    expect(response.status).toBe(503);
  });

  it('includes a running sandbox daemon in pending input, and stops it after an idle period with no resident sessions', async () => {
    let resident = 1;
    const ctx = await setup({
      idleStopMs: 10_000,
      sandboxAnswers: {
        'runtime.health': () => ({ state: 'ready', residentSessions: resident }),
        'sessions.pendingInput': { sessions: [], sequence: 1, streamEpoch: 'epoch-box' },
      },
      mainAnswers: { 'sessions.pendingInput': { sessions: [], sequence: 4, streamEpoch: 'epoch-main' } },
    });
    await ctx.sandboxOn();
    expect(ctx.pool.live().map((d) => d.key)).toEqual(['main']);
    await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    expect(ctx.pool.live()).toHaveLength(2);
    await ctx.call('/api/pi/sessions/pending-input');
    expect(ctx.launched[0].commands()).toContain('sessions.pendingInput');

    await ctx.tick(20_000);
    expect(ctx.launched[0].stopped).toBe(false);
    resident = 0;
    await ctx.tick(5_000);
    expect(ctx.launched[0].stopped).toBe(false);
    await ctx.tick(10_000);
    expect(ctx.launched[0].stopped).toBe(true);
    expect(ctx.intakes[0].stopped).toBe(true);
    expect(ctx.pool.live().map((d) => d.key)).toEqual(['main']);

    // The next open starts it again.
    await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    expect(ctx.launched).toHaveLength(2);
  });

  it('fails a sandbox start closed when the main daemon cannot name the provider hosts', async () => {
    const ctx = await setup({ mainAnswers: { 'providers.hosts': daemonError('DAEMON_UNAVAILABLE') } });
    await ctx.sandboxOn();
    const response = await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    expect(await response.json()).toEqual({ error: { code: 'SANDBOX_UNAVAILABLE', reason: 'PROVIDER_HOSTS_UNAVAILABLE' } });
    expect(ctx.launched).toEqual([]);
  });
});
