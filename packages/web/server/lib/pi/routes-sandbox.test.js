import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerPiRuntimeRoutes } from './routes.js';
import { createPiDaemonPool, publicDaemonStreamId } from './session-daemon/daemon-pool.js';
import { createPiUiSettingsStore } from './ui-settings-store.js';
import { createProjectSandboxManager } from './sandbox/project-sandbox-manager.js';
import { createTrustAskStore } from './sandbox/trust-ask.js';
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
  const subscriptions = [];
  return {
    name,
    calls,
    subscriptions,
    commands: () => calls.map((call) => call.command),
    // Event stream: each subscription is recorded; `emit` writes a frame to
    // every open one.
    subscribe: async (options) => {
      const record = { options, closed: false };
      subscriptions.push(record);
      return () => { record.closed = true; };
    },
    emit: (event, sequence, payload) => {
      for (const record of subscriptions.filter((item) => !item.closed)) {
        record.options.onEvent({ protocolVersion: 1, kind: 'event', event, sequence, streamEpoch: `epoch-${name}`, payload });
      }
    },
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
  'sessions.release': { released: [], pending: [] },
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

const buildSandboxRoutes = async ({ probe, mainAnswers = {}, sandboxAnswers = {}, startError, idleStopMs = 60_000, agentFiles = {} } = {}) => {
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
  const trustAsk = createTrustAskStore({ dataDir });
  let clock = 0;
  const timers = [];
  const manager = createProjectSandboxManager({
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
    trustAsk,
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
    trustAsk,
    archiveStore: { read: async () => ({}), set: async () => undefined },
  });
  const server = await listen(app);
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
  const moves = [];
  pool.onMove((sessionId, directory) => moves.push([sessionId, directory]));
  return { server, manager, root, dataDir, agentDir, projectA, projectB, worktree, gitId, main, pool, launcher, launched, intakes, call, sandboxOn, tick, uiSettingsStore, moves, trustAsk };
};


describe('Pi routes for sandboxed projects', () => {
  let server;
  let manager;
  afterEach(async () => {
    await manager?.stop();
    manager = undefined;
    await close(server);
    server = undefined;
  });

  const setup = async (options = {}) => {
    const built = await buildSandboxRoutes(options);
    server = built.server;
    manager = built.manager;
    return built;
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
    // Asking main to release the project's folders runs no Pi code.
    expect(ctx.main.calls.filter((c) => !['sessions.list', 'sessions.release'].includes(c.command))).toEqual([]);

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
    expect(ctx.main.commands()).toEqual(['sessions.release']);
  });

  it('stamps a session read routed by its transcript with the sandbox daemon\'s stream', async () => {
    // A daemon answers a directory-less read with the session's own folder.
    let sessionFolder;
    const ctx = await setup({ sandboxAnswers: { 'sessions.open': (p) => detail(p.sessionId, p.directory ?? sessionFolder) } });
    sessionFolder = ctx.projectA;
    await ctx.sandboxOn();
    const sessions = getPiSessionDirectory({ cwd: ctx.projectA, agentDir: ctx.agentDir });
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, '2026-01-01_s-9.jsonl'), `${JSON.stringify({ type: 'session', id: 's-9', cwd: ctx.projectA, timestamp: '2026-01-01T00:00:00.000Z' })}\n`);

    const response = await ctx.call('/api/pi/sessions/s-9');
    expect(response.status).toBe(200);
    // Its sequences belong to the sandbox daemon's stream, not the main one.
    expect((await response.json()).stream).toBe(publicDaemonStreamId('sandbox:proj-a'));
    expect(ctx.main.commands()).not.toContain('sessions.open');
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

  it('joins a started sandbox daemon to the merged event stream and leaves it when the daemon stops idle', async () => {
    let resident = 1;
    const ctx = await setup({
      idleStopMs: 10_000,
      sandboxAnswers: { 'runtime.health': () => ({ state: 'ready', residentSessions: resident }) },
    });
    await ctx.sandboxOn();
    const events = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/events?capabilities=events.streamEpoch`);
    const reader = events.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (predicate) => {
      for (let i = 0; i < 50 && !predicate(text); i += 1) {
        const next = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ timeout: true }), 100))]);
        if (next.done) break;
        if (!next.timeout) text += decoder.decode(next.value);
      }
      return text;
    };
    const waitFor = async (predicate) => {
      for (let i = 0; i < 50 && !predicate(); i += 1) await new Promise((r) => setTimeout(r, 10));
    };
    await waitFor(() => ctx.main.subscriptions.length > 0);
    // Not started yet, so nothing subscribes to it.
    expect(ctx.launched).toEqual([]);

    await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    const [daemon] = ctx.launched;
    await waitFor(() => daemon.subscriptions.some((item) => !item.closed));
    daemon.emit('session.updated', 1, { sessionId: 's-1', directory: ctx.projectA, title: 'Boxed' });
    const stream = publicDaemonStreamId('sandbox:proj-a');
    await readUntil((body) => body.includes('Boxed'));
    const frame = text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))
      .find((item) => item.payload?.title === 'Boxed');
    expect(frame).toMatchObject({ stream, sessionId: 's-1', payload: { title: 'Boxed' } });

    resident = 0;
    await ctx.tick(1_000);
    await ctx.tick(11_000);
    expect(daemon.stopped).toBe(true);
    await waitFor(() => daemon.subscriptions.every((item) => item.closed));
    expect(daemon.subscriptions.every((item) => item.closed)).toBe(true);
    // The main daemon's subscription is untouched.
    expect(ctx.main.subscriptions.filter((item) => !item.closed)).toHaveLength(1);
    await reader.cancel();
  });

  it('fails a sandbox start closed when the main daemon cannot name the provider hosts', async () => {
    const ctx = await setup({ mainAnswers: { 'providers.hosts': daemonError('DAEMON_UNAVAILABLE') } });
    await ctx.sandboxOn();
    const response = await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    expect(await response.json()).toEqual({ error: { code: 'SANDBOX_UNAVAILABLE', reason: 'PROVIDER_HOSTS_UNAVAILABLE' } });
    expect(ctx.launched).toEqual([]);
  });
});

describe('switching a project between daemons', () => {
  let server;
  let manager;
  afterEach(async () => {
    await manager?.stop();
    manager = undefined;
    await close(server);
    server = undefined;
  });

  // Same wiring as above, kept separate so switch tests can script the
  // old daemon's `sessions.release` answers.
  const setup = async (options = {}) => {
    const built = await buildSandboxRoutes(options);
    server = built.server;
    manager = built.manager;
    return built;
  };

  it('moves idle sessions at once and holds a busy one in the old daemon until its turn ends', async () => {
    // The main daemon runs s-idle (idle) and s-busy (mid-turn) in project A.
    let busy = true;
    const ctx = await setup({
      mainAnswers: {
        'sessions.release': (p) => (busy
          ? { released: [{ sessionId: 's-idle', directory: p.directories[0] }], pending: [{ sessionId: 's-busy', directory: p.directories[0] }], streamEpoch: 'epoch-main' }
          : { released: [{ sessionId: 's-busy', directory: p.directories[0] }], pending: [], streamEpoch: 'epoch-main' }),
        'sessions.list': (p) => ({
          sessions: [{ ...row('s-busy', p.directory), live: { lifecycle: 'busy', sequence: 7 } }, row('s-idle', p.directory)],
          streamEpoch: 'epoch-main',
        }),
      },
      sandboxAnswers: { 'sessions.list': (p) => ({ sessions: [row('s-busy', p.directory), row('s-idle', p.directory)], streamEpoch: 'epoch-box' }) },
    });
    const saved = await ctx.sandboxOn();
    expect(saved.status).toBe(200);

    // The old daemon was asked to let go of the project's folders.
    const release = ctx.main.calls.find((c) => c.command === 'sessions.release');
    expect(release.payload.directories).toEqual([ctx.projectA, join(ctx.dataDir, 'worktree', ctx.gitId)]);
    // Clients refetch both: the idle one from its new daemon, the busy one
    // to learn it switches after this turn.
    expect(ctx.moves.map(([id]) => id).sort()).toEqual(['s-busy', 's-idle']);

    // The list comes from the sandbox daemon; the busy row keeps its live
    // state from the main daemon and says it switches after this turn.
    const list = await (await ctx.call(`/api/pi/sessions?directory=${ctx.projectA}`)).json();
    const busyRow = list.sessions.find((item) => item.session.id === 's-busy');
    expect(busyRow).toMatchObject({ live: { lifecycle: 'busy', sequence: 7 }, stream: 'main', streamEpoch: 'epoch-main' });
    expect(busyRow.session.pendingSwitch).toEqual({ to: 'nono' });
    expect(busyRow.session.sandboxed).toBeUndefined();
    const idleRow = list.sessions.find((item) => item.session.id === 's-idle');
    expect(idleRow.session).toMatchObject({ sandboxed: true });
    expect(idleRow.session.pendingSwitch).toBeUndefined();

    // Reading and stopping the busy session reach the daemon running it.
    const detail = await ctx.call(`/api/pi/sessions/s-busy?directory=${ctx.projectA}`);
    const detailBody = await detail.json();
    expect(detailBody.session).toMatchObject({ id: 's-busy', pendingSwitch: { to: 'nono' } });
    expect(detailBody.stream).toBeUndefined();
    expect((await ctx.call(`/api/pi/sessions/s-busy/abort`, { method: 'POST', body: { directory: ctx.projectA } })).status).toBe(204);
    expect(ctx.main.calls.filter((c) => ['sessions.open', 'sessions.abort'].includes(c.command)).map((c) => c.payload.sessionId)).toEqual(['s-busy', 's-busy']);

    // New work for it is refused until it has moved.
    const prompt = await ctx.call('/api/pi/sessions/s-busy/prompt', { method: 'POST', body: { directory: ctx.projectA, text: 'more', streamEpoch: 'epoch-main' } });
    expect(prompt.status).toBe(409);
    expect(await prompt.json()).toEqual({ error: { code: 'SESSION_IN_USE' } });
    expect(ctx.main.commands()).not.toContain('sessions.prompt');

    // Its turn ends; the next drain check moves it.
    busy = false;
    ctx.moves.length = 0;
    await ctx.tick(1_000);
    expect(ctx.moves.map(([id]) => id)).toEqual(['s-busy']);
    const after = await (await ctx.call(`/api/pi/sessions?directory=${ctx.projectA}`)).json();
    expect(after.sessions.every((item) => item.session.pendingSwitch === undefined && item.session.sandboxed === true)).toBe(true);
    expect(ctx.pool.drainingFor(ctx.projectA)).toEqual([]);
    const reopened = await ctx.call(`/api/pi/sessions/s-busy?directory=${ctx.projectA}`);
    expect((await reopened.json()).stream).toBe(publicDaemonStreamId('sandbox:proj-a'));
  });

  it('turning a project off drains its sandbox daemon into the main daemon and resets the project\'s trust to ask', async () => {
    let busy = true;
    const ctx = await setup({
      sandboxAnswers: {
        'sessions.release': (p) => (busy
          ? { released: [], pending: [{ sessionId: 's-1', directory: p.directories[0] }], streamEpoch: 'epoch-box' }
          : { released: [{ sessionId: 's-1', directory: p.directories[0] }], pending: [], streamEpoch: 'epoch-box' }),
        'extensions.respond': (p) => ({ resolved: p.requestId === 'dialog-in-box' }),
      },
      mainAnswers: { 'extensions.respond': { resolved: false } },
    });
    await ctx.sandboxOn();
    await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    const [box] = ctx.launched;
    ctx.moves.length = 0;

    const off = await ctx.sandboxOn('proj-a', { mode: 'off' });
    expect(await off.json()).toMatchObject({ project: { mode: 'off' } });
    // Trust goes back to "ask" for the project and its worktrees, through
    // the main daemon, and stays recorded so auto-trust skips them.
    const trustCalls = ctx.main.calls.filter((c) => c.command === 'settings.set').map((c) => c.payload);
    expect(trustCalls).toEqual([
      { scope: 'project', directory: ctx.projectA, trust: null },
      { scope: 'project', directory: ctx.worktree, trust: null },
    ]);
    expect(await ctx.trustAsk.list()).toEqual([ctx.projectA, ctx.worktree]);

    // The sandbox daemon keeps running the busy session.
    expect(box.stopped).toBe(false);
    expect(ctx.moves).toEqual([['s-1', ctx.projectA]]);
    const detail = await (await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`)).json();
    expect(detail.session).toMatchObject({ sandboxed: true, pendingSwitch: { to: 'off' } });
    expect(detail.stream).toBe(publicDaemonStreamId('sandbox:proj-a'));
    // A dialog it shows is answered there.
    const respond = await ctx.call('/api/pi/extensions/respond', { method: 'POST', body: { requestId: 'dialog-in-box', directory: ctx.projectA, cancelled: true } });
    expect(respond.status).toBe(204);
    // New sessions in the project already run in the main daemon.
    await ctx.call(`/api/pi/sessions/s-2?directory=${ctx.projectA}`);
    expect(ctx.main.calls.filter((c) => c.command === 'sessions.open').map((c) => c.payload.sessionId)).toEqual(['s-2']);

    busy = false;
    await ctx.tick(1_000);
    expect(box.stopped).toBe(true);
    expect(ctx.intakes[0].stopped).toBe(true);
    expect(ctx.pool.live().map((d) => d.key)).toEqual(['main']);
    const moved = await (await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`)).json();
    expect(moved.session.sandboxed).toBeUndefined();
    expect(moved.session.pendingSwitch).toBeUndefined();
  });

  it('an explicit trust decision clears the recorded reset', async () => {
    const ctx = await setup({ mainAnswers: { 'settings.set': { global: {}, project: { trusted: true } } } });
    await ctx.sandboxOn();
    await ctx.sandboxOn('proj-a', { mode: 'off' });
    expect(await ctx.trustAsk.list()).toContain(ctx.projectA);
    await ctx.call('/api/pi/settings/pi', { method: 'PUT', body: { scope: 'project', directory: ctx.projectA, trust: true } });
    expect(await ctx.trustAsk.list()).not.toContain(ctx.projectA);
  });

  const waitFor = async (predicate) => {
    for (let i = 0; i < 100 && !predicate(); i += 1) await new Promise((r) => setTimeout(r, 5));
  };

  it('a models.json save replaces a running sandbox daemon at its next idle edge', async () => {
    let busy = true;
    const ctx = await setup({
      mainAnswers: { 'providers.models.set': { config: null } },
      sandboxAnswers: {
        'sessions.release': (p) => (busy
          ? { released: [], pending: [{ sessionId: 's-1', directory: p.directories[0] }], streamEpoch: 'epoch-box' }
          : { released: [{ sessionId: 's-1', directory: p.directories[0] }], pending: [], streamEpoch: 'epoch-box' }),
      },
    });
    await ctx.sandboxOn();
    await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    const [first] = ctx.launched;
    ctx.moves.length = 0;

    const saved = await ctx.call('/api/pi/providers/local/models', { method: 'PUT', body: { models: [] } });
    expect(saved.status).toBe(200);
    await waitFor(() => first.commands().includes('sessions.release'));
    // The busy session finishes in the old daemon; it is not a mode switch.
    expect(first.stopped).toBe(false);
    const detail = await (await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`)).json();
    expect(detail.session).toMatchObject({ sandboxed: true });
    expect(detail.session.pendingSwitch).toBeUndefined();
    expect(detail.stream).toBe(publicDaemonStreamId('sandbox:proj-a'));

    // Another session starts a fresh daemon that reads the new file.
    await ctx.call(`/api/pi/sessions/s-2?directory=${ctx.projectA}`);
    expect(ctx.launched).toHaveLength(2);
    expect(ctx.launched[1].commands()).toEqual(['sessions.open']);

    busy = false;
    await ctx.tick(1_000);
    expect(first.stopped).toBe(true);
    expect(ctx.moves).toEqual([['s-1', ctx.projectA]]);
    expect(ctx.pool.live().map((d) => d.key)).toEqual(['main', 'sandbox:proj-a:1']);
  });

  it('a Pi config file changed outside PiChamber replaces an idle sandbox daemon on the next check', async () => {
    const ctx = await setup();
    await writeFile(join(ctx.agentDir, 'models.json'), '{}');
    await ctx.sandboxOn();
    await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    await ctx.tick(60_000);
    expect(ctx.launched[0].stopped).toBe(false);

    await writeFile(join(ctx.agentDir, 'models.json.tmp'), '{"providers":{}}');
    await rename(join(ctx.agentDir, 'models.json.tmp'), join(ctx.agentDir, 'models.json'));
    await ctx.tick(60_000);
    expect(ctx.launched[0].commands()).toContain('sessions.release');
    expect(ctx.launched[0].stopped).toBe(true);
    await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    expect(ctx.launched).toHaveLength(2);
  });

  it('a worktree added after the daemon started starts a daemon that has it', async () => {
    const ctx = await setup();
    await ctx.sandboxOn();
    await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    const added = join(ctx.dataDir, 'worktree', ctx.gitId, 'second');
    await mkdir(added, { recursive: true });
    await ctx.call(`/api/pi/sessions/s-2?directory=${added}`);
    expect(ctx.launched).toHaveLength(2);
    expect(ctx.launched[0].stopped).toBe(true);
    expect(ctx.launched[1].calls.map((c) => c.payload?.sessionId)).toEqual(['s-2']);
    expect(ctx.launched[1].sandbox.grants).toEqual(expect.arrayContaining([
      { kind: 'readWrite', path: getPiSessionDirectory({ cwd: added, agentDir: ctx.agentDir }) },
    ]));
  });

  it('a changed setting drains the running daemon instead of cutting it off', async () => {
    const ctx = await setup({
      sandboxAnswers: { 'sessions.release': (p) => ({ released: [], pending: [{ sessionId: 's-1', directory: p.directories[0] }] }) },
    });
    await ctx.sandboxOn();
    await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    await ctx.sandboxOn('proj-a', { allowHosts: ['registry.npmjs.org'] });
    expect(ctx.launched[0].stopped).toBe(false);
    expect(ctx.launched[0].commands()).toContain('sessions.release');
    await ctx.call(`/api/pi/sessions/s-2?directory=${ctx.projectA}`);
    expect(ctx.launched[1].sandbox.network.allowHosts).toContain('registry.npmjs.org');
  });

  it('asks the main daemon to refresh OAuth tokens before a sandbox daemon starts, without making it stale', async () => {
    let agentDir;
    const ctx = await setup({
      mainAnswers: {
        // The refresh rewrites auth.json, as Pi does.
        'providers.oauth.refresh': async () => {
          await writeFile(join(agentDir, 'auth.json.tmp'), '{"anthropic":{"type":"oauth"}}');
          await rename(join(agentDir, 'auth.json.tmp'), join(agentDir, 'auth.json'));
          return {};
        },
      },
    });
    agentDir = ctx.agentDir;
    await ctx.sandboxOn();
    await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    expect(ctx.main.commands().filter((c) => ['providers.oauth.refresh', 'providers.hosts'].includes(c)))
      .toEqual(['providers.oauth.refresh', 'providers.hosts']);
    expect(ctx.main.calls.find((c) => c.command === 'providers.oauth.refresh').payload).toEqual({ minValidityMs: 30 * 60_000 });
    await ctx.tick(60_000);
    expect(ctx.launched[0].stopped).toBe(false);
  });

  it('starts the sandbox anyway when the main daemon cannot refresh OAuth tokens', async () => {
    const ctx = await setup({ mainAnswers: { 'providers.oauth.refresh': daemonError('UNKNOWN_COMMAND') } });
    await ctx.sandboxOn();
    const response = await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    expect(response.status).toBe(200);
  });

  it('a sandboxed turn that fails to refresh its OAuth token gets the main daemon to refresh and replaces the daemon', async () => {
    let agentDir;
    let refreshes = 0;
    const ctx = await setup({
      mainAnswers: {
        'providers.oauth.refresh': async () => {
          refreshes += 1;
          if (refreshes > 1) {
            await writeFile(join(agentDir, 'auth.json'), `{"refresh":${refreshes}}`);
          }
          return {};
        },
      },
    });
    agentDir = ctx.agentDir;
    await ctx.sandboxOn();
    await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    const [box] = ctx.launched;
    await waitFor(() => box.subscriptions.some((item) => !item.closed));
    // An unrelated error does nothing.
    box.emit('session.error', 3, { code: 'ASSISTANT_ERROR', message: 'Rate limited' });
    box.emit('session.error', 4, { code: 'ASSISTANT_ERROR', message: 'Credential store modify failed for anthropic' });
    await waitFor(() => box.stopped);
    expect(refreshes).toBe(2);
    expect(box.stopped).toBe(true);
    await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    expect(ctx.launched).toHaveLength(2);
  });

  it('accepts a send made with the old daemon\'s epoch right after its session moved', async () => {
    const ctx = await setup({
      mainAnswers: { 'sessions.release': (p) => ({ released: [{ sessionId: 's-1', directory: p.directories[0] }], pending: [], streamEpoch: 'epoch-main' }) },
      sandboxAnswers: {
        'runtime.health': { state: 'ready', residentSessions: 1, streamEpoch: 'epoch-box' },
        'sessions.prompt': (p) => {
          if (p.streamEpoch !== 'epoch-box') throw daemonError('STALE_STREAM_EPOCH');
          return { accepted: true, messageId: 'm-1' };
        },
      },
    });
    await ctx.sandboxOn();
    const send = (sessionId, streamEpoch) => ctx.call(`/api/pi/sessions/${sessionId}/prompt`, {
      method: 'POST',
      body: { directory: ctx.projectA, text: 'hi', streamEpoch },
    });
    expect((await send('s-1', 'epoch-main')).status).toBe(202);
    // Only the moved session, and only its old daemon's epoch.
    expect((await send('s-1', 'epoch-older')).status).toBe(409);
    expect((await send('s-2', 'epoch-main')).status).toBe(409);
  });

  it('looks up a send receipt in the daemon still running a session that waits to switch', async () => {
    const ctx = await setup({
      mainAnswers: {
        'sessions.release': (p) => ({ released: [], pending: [{ sessionId: 's-1', directory: p.directories[0] }], streamEpoch: 'epoch-main' }),
        'sessions.sendReceipt': { status: 'accepted', receipt: { messageId: 'm-1' } },
      },
    });
    await ctx.sandboxOn();
    const response = await ctx.call(`/api/pi/sessions/s-1/send-receipt?directory=${ctx.projectA}`, {
      method: 'POST',
      body: { kind: 'prompt', operationId: 'op-1', streamEpoch: 'epoch-main' },
    });
    expect(await response.json()).toEqual({ status: 'accepted', receipt: { messageId: 'm-1' } });
    expect(ctx.launched).toEqual([]);
  });
});
