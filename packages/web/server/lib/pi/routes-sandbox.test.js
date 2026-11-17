import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { registerPiRuntimeRoutes } from './routes.js';
import { createPiDaemonPool, publicDaemonStreamId } from './session-daemon/daemon-pool.js';
import { createPiUiSettingsStore } from './ui-settings-store.js';
import { createProjectSandboxManager } from './sandbox/project-sandbox-manager.js';
import { createTrustAskStore } from './sandbox/trust-ask.js';
import { sandboxedFoldersFile } from './sandbox/sandboxed-folders.js';
import { ownWorktreeId, worktreeIdsFile } from './sandbox/worktree-ids.js';
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
  'sessions.readPersisted': (p) => ({ ...detail(p.sessionId, p.directory), lastSequence: -1, isStreaming: false, lifecycle: 'idle', readOnly: true }),
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
    // The profile seam of the nono launcher: a built-in text, and a custom
    // one that replaces it. Text holding `nope` is what nono refuses.
    customProfile: null,
    profile: async () => (launcher.customProfile === null
      ? { hostKind: 'linux', builtInPath: '/app/nono-profile.json', customPath: '/data/custom.json', custom: false, path: '/app/nono-profile.json', content: '{"built":"in"}', hash: 'built-in' }
      : { hostKind: 'linux', builtInPath: '/app/nono-profile.json', customPath: '/data/custom.json', custom: true, path: '/data/custom.json', content: launcher.customProfile, hash: `custom:${launcher.customProfile}` }),
    saveProfile: async (content) => {
      if (typeof content !== 'string' || content.includes('nope')) {
        throw Object.assign(new Error('invalid'), { code: 'INVALID_SANDBOX_PROFILE', messages: ['Group nope not found'] });
      }
      launcher.customProfile = content;
    },
    resetProfile: async () => {
      launcher.customProfile = null;
    },
  };
  return launcher;
};

// Transcript reads (session detail and older pages) are answered read-only
// from JSONL while the sandbox cannot run; see the fail-closed tests.
const PI_RUNNING = [
  ['GET', '/api/pi/sessions/s-1/tree?directory=DIR'],
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
  ['POST', '/api/pi/extensions/control', { sessionId: 's-1', id: 'mode', directory: 'DIR' }],
  ['POST', '/api/pi/sessions/s-1/discard-draft?directory=DIR'],
  ['GET', '/api/pi/extensions/config?directory=DIR'],
];

const buildSandboxRoutes = async ({ probe, mainAnswers = {}, sandboxAnswers = {}, startError, onStart, idleStopMs = 60_000, agentFiles = {}, beforeReconcile, supervisorOptions } = {}) => {
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
    ...(supervisorOptions ? { supervisorOptions } : {}),
    createIntake: ({ socketPath, publish }) => {
      const intake = { socketPath, publish, started: false, stopped: false };
      intakes.push(intake);
      return {
        start: async () => { intake.started = true; return true; },
        stop: async () => { intake.stopped = true; },
      };
    },
    createSupervisor: async ({ sandbox, launcher: used, ...options }) => {
      const probed = await used.probe();
      if (!probed.available) throw Object.assign(daemonError('SANDBOX_UNAVAILABLE'), { reason: probed.code });
      const daemon = fakeDaemon(`sandbox-${launched.length}`, daemonAnswers(sandboxAnswers));
      daemon.sandbox = sandbox;
      daemon.options = options;
      daemon.stopped = false;
      daemon.paths = { openUrlSocket: join(root, 'run', `${launched.length}`, 'open-url.sock') };
      daemon.start = async () => {
        if (startError) throw daemonError(startError);
        await onStart?.(daemon);
      };
      daemon.stop = async () => { daemon.stopped = true; };
      launched.push(daemon);
      return daemon;
    },
  });
  await beforeReconcile?.({ trustAsk, projectA, projectB });
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
        choice: 'nono',
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

  it('routes composer controls, draft discards and project extension config to the sandbox, and gives it only its own folders\' plugin config', async () => {
    const configResult = { project: { available: true, trusted: true }, packages: [], extensions: [], installFailures: [] };
    const ctx = await setup({
      supervisorOptions: ({ roots } = {}) => ({ port: 3000, roots }),
      mainAnswers: { 'extensions.config.set': configResult, 'extensions.packages.remove': configResult },
      sandboxAnswers: { 'extensions.control': { ran: true }, 'sessions.discardDraft': { discarded: true }, 'extensions.config.list': configResult, 'extensions.config.set': configResult },
    });
    await ctx.sandboxOn();

    // A draft has no transcript yet, so the folder the client names decides.
    const control = await ctx.call('/api/pi/extensions/control', { method: 'POST', body: { sessionId: 's-draft', id: 'mode', value: 'fast', directory: ctx.projectA } });
    expect(await control.json()).toEqual({ ran: true });
    const discarded = await ctx.call(`/api/pi/sessions/s-draft/discard-draft?directory=${ctx.projectA}`, { method: 'POST' });
    expect(await discarded.json()).toEqual({ discarded: true });
    expect((await ctx.call(`/api/pi/extensions/config?directory=${ctx.projectA}`)).status).toBe(200);
    const id = 'a'.repeat(43);
    const projectSet = await ctx.call(`/api/pi/extensions/config/${id}`, { method: 'PUT', body: { scope: 'project', state: 'unload', directory: ctx.projectA } });
    expect(projectSet.status).toBe(200);
    // Pi's agent folder is read-only in a sandbox: global choices and package
    // removal stay with the main daemon.
    const globalSet = await ctx.call(`/api/pi/extensions/config/${id}`, { method: 'PUT', body: { scope: 'global', enabled: false, directory: ctx.projectA } });
    expect(globalSet.status).toBe(200);
    expect((await ctx.call(`/api/pi/extensions/packages/${id}?directory=${ctx.projectA}`, { method: 'DELETE' })).status).toBe(200);

    expect(ctx.launched).toHaveLength(1);
    const [daemon] = ctx.launched;
    expect(daemon.commands()).toEqual(['extensions.control', 'sessions.discardDraft', 'extensions.config.list', 'extensions.config.set']);
    expect(daemon.calls[0].payload).toEqual({ sessionId: 's-draft', id: 'mode', value: 'fast' });
    expect(ctx.main.commands().filter((command) => command.startsWith('extensions.') || command === 'sessions.discardDraft'))
      .toEqual(['extensions.config.set', 'extensions.packages.remove']);
    // Per-daemon options (the plugin config) are built for the folders the
    // daemon owns.
    expect(daemon.options.port).toBe(3000);
    expect(daemon.options.roots).toEqual(expect.arrayContaining([ctx.projectA, join(ctx.dataDir, 'worktree', ctx.gitId)]));
    expect(daemon.options.roots.some((root) => root.startsWith(ctx.projectB))).toBe(false);
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

  it('keeps routing a session by its transcript after the file was first found, and follows it when it is gone', async () => {
    const ctx = await setup({ probe: { available: false, code: 'NOT_INSTALLED' } });
    await ctx.sandboxOn();
    const sessions = getPiSessionDirectory({ cwd: ctx.projectA, agentDir: ctx.agentDir });
    await mkdir(sessions, { recursive: true });
    const file = join(sessions, '2026-01-01_s-9.jsonl');
    await writeFile(file, `${JSON.stringify({ type: 'session', id: 's-9', cwd: ctx.projectA, timestamp: '2026-01-01T00:00:00.000Z' })}\n`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await ctx.call('/api/pi/sessions/s-9/tree')).status).toBe(503);
    }
    // The file now holds another session: s-9 has no transcript, so the
    // request's own folder decides.
    await writeFile(file, `${JSON.stringify({ type: 'session', id: 's-other', cwd: ctx.projectA, timestamp: '2026-01-01T00:00:00.000Z' })}\n`);
    expect(ctx.main.commands()).not.toContain('sessions.tree');
    await ctx.call(`/api/pi/sessions/s-9/tree?directory=${ctx.projectB}`);
    expect(ctx.main.commands().filter((command) => command === 'sessions.tree')).toHaveLength(1);
    await rm(file);
    await ctx.call(`/api/pi/sessions/s-9/tree?directory=${ctx.projectB}`);
    expect(ctx.main.commands().filter((command) => command === 'sessions.tree')).toHaveLength(2);
  });

  it('fails closed: an unavailable launcher answers SANDBOX_UNAVAILABLE for every Pi-running command and never uses the main daemon', async () => {
    const ctx = await setup({
      probe: { available: false, code: 'NO_LANDLOCK' },
      mainAnswers: {
        'sessions.list': (p) => ({
          sessions: [{ ...row('s-1', p.directory), live: { lifecycle: 'idle', sequence: 3 }, inputState: { pending: null, sequence: 3 } }],
          streamEpoch: 'epoch-main',
        }),
      },
    });
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

    // Transcripts stay readable: main reads the JSONL and starts no runtime.
    for (const path of ['/api/pi/sessions/s-1', '/api/pi/sessions/s-1/messages']) {
      const read = await ctx.call(`${path}?directory=${ctx.projectA}`);
      expect([path, read.status]).toEqual([path, 200]);
      const body = await read.json();
      // Metadata only: no epoch or input state, the project's stream named,
      // and the row still sandboxed (a send fails with SANDBOX_UNAVAILABLE).
      expect(body).toMatchObject({ readOnly: true, readOnlyReason: 'NO_LANDLOCK', lastSequence: -1, lifecycle: 'idle', session: { id: 's-1' } });
      if (path === '/api/pi/sessions/s-1') expect(body.session.sandboxed).toBe(true);
      expect(body.stream).toBe(publicDaemonStreamId('sandbox:proj-a'));
      expect(body).not.toHaveProperty('streamEpoch');
      expect(body).not.toHaveProperty('inputState');
    }
    expect(ctx.main.commands()).not.toContain('sessions.open');
    expect(ctx.main.commands()).not.toContain('sessions.messages');
    expect(ctx.main.calls.filter((c) => c.command === 'sessions.readPersisted').map((c) => c.payload))
      .toEqual([{ sessionId: 's-1', directory: ctx.projectA }, { sessionId: 's-1', directory: ctx.projectA }]);

    // Listing still works: it reads transcripts on disk and runs no Pi code.
    const list = await ctx.call(`/api/pi/sessions?directory=${ctx.projectA}`);
    expect(list.status).toBe(200);
    // The list names the project's stream but carries no epoch and no live
    // state (both are the main daemon's), so clients commit its rows as
    // metadata only. A row says sandboxed: opening it runs in the sandbox
    // or fails with SANDBOX_UNAVAILABLE, never on the main daemon.
    const listed = await list.json();
    expect(typeof listed.stream).toBe('string');
    expect(listed.stream).not.toBe('main');
    expect(listed.streamEpoch).toBeUndefined();
    expect(listed.sessions).toEqual([{ session: { ...session('s-1', ctx.projectA), sandboxed: true }, updatedAt: 2 }]);
  });

  it('fails closed with the launch failure code when the sandbox daemon cannot start', async () => {
    const ctx = await setup({ startError: 'DAEMON_START_TIMEOUT' });
    await ctx.sandboxOn();
    const response = await ctx.call(`/api/pi/sessions/s-1/prompt`, { method: 'POST', body: { directory: ctx.projectA, text: 'hi', streamEpoch: 'epoch-1' } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'SANDBOX_UNAVAILABLE', reason: 'DAEMON_START_TIMEOUT' } });
    expect(ctx.main.commands()).not.toContain('sessions.prompt');
    expect(ctx.intakes[0].stopped).toBe(true);
    const projects = await (await ctx.call('/api/pi/sandbox/projects')).json();
    expect(projects.projects.find((p) => p.projectId === 'proj-a').availability)
      .toEqual({ state: 'unavailable', reason: 'DAEMON_START_TIMEOUT' });
  });

  it('routes a session command without a directory by the transcript\'s folder, so it cannot reach the main daemon', async () => {
    // Main finds a directory-less read's transcript itself and answers with
    // the session's own folder.
    let sessionFolder;
    const ctx = await setup({
      probe: { available: false, code: 'NOT_INSTALLED' },
      mainAnswers: { 'sessions.readPersisted': (p) => ({ ...detail(p.sessionId, p.directory ?? sessionFolder), lastSequence: -1, readOnly: true }) },
    });
    sessionFolder = ctx.projectA;
    await ctx.sandboxOn();
    const sessions = getPiSessionDirectory({ cwd: ctx.projectA, agentDir: ctx.agentDir });
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, '2026-01-01_s-9.jsonl'), `${JSON.stringify({ type: 'session', id: 's-9', cwd: ctx.projectA, timestamp: '2026-01-01T00:00:00.000Z' })}\n`);

    const response = await ctx.call('/api/pi/sessions/s-9/tree');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'SANDBOX_UNAVAILABLE', reason: 'NOT_INSTALLED' } });
    expect(ctx.main.commands()).toEqual(['sessions.release']);

    // A read of it is answered from its transcript, stamped with the
    // project's stream.
    const read = await ctx.call('/api/pi/sessions/s-9');
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ readOnly: true, stream: publicDaemonStreamId('sandbox:proj-a') });
    expect(ctx.main.commands()).toEqual(['sessions.release', 'sessions.readPersisted']);
  });

  it('routes by the transcript\'s folder even when the request names another folder, so a wrong hint cannot unsandbox a session', async () => {
    // The UI sends its current folder; a deep link opened while another
    // folder is selected names the wrong one. The main daemon would find the
    // session by id anyway and run its agent outside the sandbox.
    const ctx = await setup({
      probe: { available: false, code: 'NOT_INSTALLED' },
      mainAnswers: { 'sessions.readPersisted': (p) => ({ ...detail(p.sessionId, ctx.projectA), lastSequence: -1, readOnly: true }) },
    });
    await ctx.sandboxOn();
    const sessions = getPiSessionDirectory({ cwd: ctx.projectA, agentDir: ctx.agentDir });
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, '2026-01-01_s-9.jsonl'), `${JSON.stringify({ type: 'session', id: 's-9', cwd: ctx.projectA, timestamp: '2026-01-01T00:00:00.000Z' })}\n`);

    const prompt = await ctx.call(`/api/pi/sessions/s-9/prompt`, { method: 'POST', body: { directory: ctx.projectB, text: 'hi', streamEpoch: 'epoch-1' } });
    expect(prompt.status).toBe(503);
    expect(await prompt.json()).toEqual({ error: { code: 'SANDBOX_UNAVAILABLE', reason: 'NOT_INSTALLED' } });
    const opened = await ctx.call(`/api/pi/sessions/s-9?directory=${ctx.projectB}`);
    expect(await opened.json()).toMatchObject({ readOnly: true, stream: publicDaemonStreamId('sandbox:proj-a') });
    for (const command of ['sessions.prompt', 'sessions.open']) expect(ctx.main.commands()).not.toContain(command);
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

  it('forgets a failed start on Check again, so the project is not left unavailable for a one-off timeout', async () => {
    const ctx = await setup({ startError: 'DAEMON_START_TIMEOUT' });
    await ctx.sandboxOn();
    await ctx.call(`/api/pi/sessions/s-1/prompt`, { method: 'POST', body: { directory: ctx.projectA, text: 'hi', streamEpoch: 'epoch-1' } });
    const before = await (await ctx.call('/api/pi/sandbox/projects')).json();
    expect(before.projects[0].availability).toEqual({ state: 'unavailable', reason: 'DAEMON_START_TIMEOUT' });
    await ctx.call('/api/pi/sandbox/recheck', { method: 'POST' });
    const after = await (await ctx.call('/api/pi/sandbox/projects')).json();
    expect(after.projects[0].availability).toEqual({ state: 'available' });
  });

  it('shows the profile in use, saves a custom one and resets it, replacing the running sandbox each time', async () => {
    const ctx = await setup();
    const builtIn = { launcher: 'nono', custom: false, path: '/app/nono-profile.json', builtInPath: '/app/nono-profile.json', customPath: '/data/custom.json', content: '{"built":"in"}' };
    expect(await (await ctx.call('/api/pi/sandbox/profile')).json()).toEqual({ profile: builtIn });
    await ctx.sandboxOn();
    const prompt = () => ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    expect((await prompt()).status).toBe(200);
    expect(ctx.launched).toHaveLength(1);

    const refused = await ctx.call('/api/pi/sandbox/profile', { method: 'PUT', body: { content: '{"nope":1}' } });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: { code: 'INVALID_SANDBOX_PROFILE', messages: ['Group nope not found'] } });
    expect((await ctx.call('/api/pi/sandbox/profile', { method: 'PUT', body: {} })).status).toBe(400);
    // A refused profile changes nothing: the same daemon answers.
    expect((await prompt()).status).toBe(200);
    expect(ctx.launched).toHaveLength(1);

    const saved = await ctx.call('/api/pi/sandbox/profile', { method: 'PUT', body: { content: '{"mine":1}' } });
    expect(await saved.json()).toEqual({ profile: { ...builtIn, custom: true, path: '/data/custom.json', content: '{"mine":1}' } });
    expect((await prompt()).status).toBe(200);
    expect(ctx.launched).toHaveLength(2);

    const reset = await ctx.call('/api/pi/sandbox/profile', { method: 'DELETE' });
    expect(await reset.json()).toEqual({ profile: builtIn });
    expect((await prompt()).status).toBe(200);
    expect(ctx.launched).toHaveLength(3);
  });

  it('replaces a running sandbox whose custom profile was edited on disk', async () => {
    const ctx = await setup();
    await ctx.sandboxOn();
    const prompt = () => ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    await prompt();
    await ctx.manager.checkIdle();
    await prompt();
    expect(ctx.launched).toHaveLength(1);
    ctx.launcher.customProfile = '{"edited":"by hand"}';
    await ctx.manager.checkIdle();
    await prompt();
    expect(ctx.launched).toHaveLength(2);
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

  it('runs no sandbox on a host with limits until its owner accepts them, and retires sandboxes when acceptance is withdrawn', async () => {
    const ctx = await setup({ probe: { available: true, version: '0.82.0', capabilities: ['landlock-abi-7'], limits: ['UNIX_SOCKETS', 'PROXY_PORT'] } });
    const prompt = () => ctx.call('/api/pi/sessions/s-1/prompt', { method: 'POST', body: { directory: ctx.projectA, text: 'hi', streamEpoch: 'epoch-1' } });
    const saved = await (await ctx.sandboxOn()).json();
    expect(saved.project.availability).toEqual({ state: 'unavailable', reason: 'SANDBOX_LIMITS_NOT_ACCEPTED' });
    expect(await (await ctx.call('/api/pi/sandbox')).json()).toEqual({
      launchers: [{ id: 'nono', available: true, version: '0.82.0', limits: ['UNIX_SOCKETS', 'PROXY_PORT'], limitsAccepted: false }],
    });
    const refused = await prompt();
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: { code: 'SANDBOX_UNAVAILABLE', reason: 'SANDBOX_LIMITS_NOT_ACCEPTED' } });
    expect(ctx.launched).toEqual([]);

    const put = (body) => ctx.call('/api/pi/sandbox/defaults', { method: 'PUT', body });
    // Every limit must be accepted.
    const partly = await (await put({ acceptedLimits: ['UNIX_SOCKETS'] })).json();
    expect(partly.projects[0].availability).toEqual({ state: 'unavailable', reason: 'SANDBOX_LIMITS_NOT_ACCEPTED' });
    expect((await prompt()).status).toBe(503);
    expect(ctx.launched).toEqual([]);
    const accepted = await (await put({ acceptedLimits: ['PROXY_PORT', 'UNIX_SOCKETS'] })).json();
    expect(accepted.defaults).toEqual({ mode: 'off', allowHosts: [], acceptedLimits: ['UNIX_SOCKETS', 'PROXY_PORT'] });
    expect(accepted.projects[0].availability).toEqual({ state: 'available' });
    expect((await (await ctx.call('/api/pi/sandbox')).json()).launchers[0].limitsAccepted).toBe(true);
    await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    expect(ctx.launched).toHaveLength(1);

    // Withdrawn: the running daemon is retired and the next command fails closed.
    await put({ acceptedLimits: [] });
    expect(ctx.launched[0].stopped).toBe(true);
    expect((await prompt()).status).toBe(503);
    expect(ctx.launched).toHaveLength(1);

    expect((await put({ acceptedLimits: ['EVERYTHING'] })).status).toBe(400);
  });

  it('lists every project\'s sandbox state and refuses invalid settings or unknown projects', async () => {
    const ctx = await setup();
    await ctx.sandboxOn('proj-a');
    const listed = await (await ctx.call('/api/pi/sandbox/projects')).json();
    expect(listed).toEqual({
      projects: [
        { projectId: 'proj-a', mode: 'nono', launcher: 'nono', availability: { state: 'available' }, choice: 'nono', allowHosts: [], allowLocalPorts: [], extraFolders: [] },
        { projectId: 'proj-b', mode: 'off', launcher: null, availability: { state: 'off' }, choice: 'default', allowHosts: [], allowLocalPorts: [], extraFolders: [] },
      ],
    });
    const body = JSON.stringify(listed);
    expect(body).not.toContain(ctx.root);

    const refusedPort = await ctx.sandboxOn('proj-a', { allowLocalPorts: [443] });
    expect(refusedPort.status).toBe(400);
    expect(await refusedPort.json()).toEqual({ error: { code: 'INVALID_SANDBOX_SETTING', reason: 'REFUSED_PORT' } });
    const unknownMode = await ctx.sandboxOn('proj-a', { mode: 'docker' });
    expect(unknownMode.status).toBe(400);
    expect(await unknownMode.json()).toEqual({ error: { code: 'INVALID_SANDBOX_SETTING' } });
    expect((await ctx.sandboxOn('missing')).status).toBe(404);
  });

  it('sandboxes every project that follows the host default, keeps an explicit off off, and adds the shared hosts', async () => {
    const ctx = await setup();
    expect(await (await ctx.call('/api/pi/sandbox/defaults')).json()).toEqual({ defaults: { mode: 'off', allowHosts: [], acceptedLimits: [] } });
    await ctx.call('/api/pi/sandbox/projects/proj-b', { method: 'PUT', body: { mode: 'off' } });
    const saved = await ctx.call('/api/pi/sandbox/defaults', { method: 'PUT', body: { mode: 'nono', allowHosts: ['GitHub.com', 'github.com'] } });
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body.defaults).toEqual({ mode: 'nono', allowHosts: ['github.com'], acceptedLimits: [] });
    expect(body.projects.map((p) => [p.projectId, p.mode, p.choice])).toEqual([['proj-a', 'nono', 'default'], ['proj-b', 'off', 'off']]);
    // proj-a has no setting of its own, yet runs sandboxed with the shared host.
    await ctx.call(`/api/pi/sessions/s-1/prompt`, { method: 'POST', body: { directory: ctx.projectA, text: 'hi', streamEpoch: 'epoch-1' } });
    expect(ctx.launched).toHaveLength(1);
    expect(ctx.launched[0].sandbox.network.allowHosts).toContain('github.com');
    expect(ctx.main.commands()).not.toContain('sessions.prompt');
    // The project's own hosts add to the shared ones.
    await ctx.call('/api/pi/sandbox/projects/proj-a', { method: 'PUT', body: { mode: 'default', allowHosts: ['registry.npmjs.org'] } });
    expect((await (await ctx.call('/api/pi/sandbox/projects')).json()).projects[0]).toMatchObject({ mode: 'nono', choice: 'default', allowHosts: ['registry.npmjs.org'] });

    // Turning the default off unsandboxes only the projects that follow it.
    await ctx.call('/api/pi/sandbox/defaults', { method: 'PUT', body: { mode: 'off', allowHosts: [] } });
    expect((await (await ctx.call('/api/pi/sandbox/projects')).json()).projects.map((p) => p.mode)).toEqual(['off', 'off']);
    expect((await ctx.call('/api/pi/sandbox/defaults', { method: 'PUT', body: { mode: 'default' } })).status).toBe(400);
  });

  it('keeps the default out of ordinary settings writes, so a client cannot change it that way', async () => {
    const ctx = await setup();
    await ctx.uiSettingsStore.write({ sandboxDefaults: { mode: 'nono', allowHosts: [] } });
    expect(await (await ctx.call('/api/pi/sandbox/defaults')).json()).toEqual({ defaults: { mode: 'off', allowHosts: [], acceptedLimits: [] } });
    await ctx.call('/api/pi/sandbox/defaults', { method: 'PUT', body: { mode: 'nono', allowHosts: [] } });
    await ctx.uiSettingsStore.write({ sandboxDefaults: { mode: 'off', allowHosts: [] }, projects: [{ id: 'proj-a', path: ctx.projectA }, { id: 'proj-b', path: ctx.projectB }] });
    expect((await (await ctx.call('/api/pi/sandbox/defaults')).json()).defaults.mode).toBe('nono');
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
    const response = await ctx.call('/api/pi/sessions', { method: 'POST', body: { cwd: ctx.projectA } });
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
    // One read stays pending across timeouts, so no chunk is taken by an
    // abandoned read and lost.
    let pendingRead = null;
    const readUntil = async (predicate) => {
      for (let i = 0; i < 50 && !predicate(text); i += 1) {
        pendingRead ??= reader.read();
        const next = await Promise.race([pendingRead, new Promise((r) => setTimeout(() => r({ timeout: true }), 100))]);
        if (next.timeout) continue;
        pendingRead = null;
        if (next.done) break;
        text += decoder.decode(next.value);
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

  it('leaves a provider on the server machine or local network out of the allowed hosts instead of failing the start', async () => {
    const ctx = await setup({ mainAnswers: { 'providers.hosts': { hosts: ['api.anthropic.com', 'ollama', 'nas.local'] } } });
    await ctx.sandboxOn();
    expect((await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`)).status).toBe(200);
    expect(ctx.launched[0].sandbox.network.allowHosts).toEqual(['api.anthropic.com']);
  });

  it('fails a sandbox start closed when the main daemon cannot name the provider hosts', async () => {
    const ctx = await setup({ mainAnswers: { 'providers.hosts': daemonError('DAEMON_UNAVAILABLE') } });
    await ctx.sandboxOn();
    const response = await ctx.call('/api/pi/sessions', { method: 'POST', body: { cwd: ctx.projectA } });
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
    expect(await prompt.json()).toEqual({ error: { code: 'SESSION_IN_USE', reason: 'SESSION_SWITCHING' } });
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
    // The server checks the released session against its transcripts first.
    await waitFor(() => ctx.pool.live().length === 1);
    expect(box.stopped).toBe(true);
    expect(ctx.intakes[0].stopped).toBe(true);
    expect(ctx.pool.live().map((d) => d.key)).toEqual(['main']);
    const moved = await (await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`)).json();
    expect(moved.session.sandboxed).toBeUndefined();
    expect(moved.session.pendingSwitch).toBeUndefined();
  });

  it('answers a dialog of a session still finishing in the main daemon without starting the sandbox', async () => {
    // Turned on while s-busy shows a dialog in the main daemon, on a host
    // where nono cannot run: the answer must reach the main daemon, or the
    // session could never end its turn.
    const ctx = await setup({
      probe: { available: false, code: 'NOT_INSTALLED' },
      mainAnswers: {
        'sessions.release': (p) => ({ released: [], pending: [{ sessionId: 's-busy', directory: p.directories[0] }], streamEpoch: 'epoch-main' }),
        'extensions.respond': (p) => ({ resolved: p.requestId === 'dialog-in-main' }),
      },
    });
    await ctx.sandboxOn();
    const respond = await ctx.call('/api/pi/extensions/respond', { method: 'POST', body: { requestId: 'dialog-in-main', directory: ctx.projectA, cancelled: true } });
    expect(respond.status).toBe(204);
    expect(ctx.launched).toEqual([]);
    // A dialog nobody holds is still asked of the folder's owner, which
    // fails closed.
    const other = await ctx.call('/api/pi/extensions/respond', { method: 'POST', body: { requestId: 'unknown', directory: ctx.projectA, cancelled: true } });
    expect(other.status).toBe(503);
  });

  it('turning a project off again while its session still runs in the main daemon leaves the session there', async () => {
    const ctx = await setup({
      mainAnswers: {
        'sessions.release': (p) => ({ released: [], pending: [{ sessionId: 's-busy', directory: p.directories[0] }], streamEpoch: 'epoch-main' }),
      },
    });
    await ctx.sandboxOn();
    expect((await (await ctx.call(`/api/pi/sessions/s-busy?directory=${ctx.projectA}`)).json()).session.pendingSwitch).toEqual({ to: 'nono' });
    ctx.moves.length = 0;

    await ctx.sandboxOn('proj-a', { mode: 'off' });
    // Clients refetch it: it no longer waits to switch, and takes new work.
    expect(ctx.moves).toEqual([['s-busy', ctx.projectA]]);
    expect(ctx.pool.drainingFor(ctx.projectA)).toEqual([]);
    const detail = await (await ctx.call(`/api/pi/sessions/s-busy?directory=${ctx.projectA}`)).json();
    expect(detail.session.pendingSwitch).toBeUndefined();
    expect(detail.session.sandboxed).toBeUndefined();
    const followUp = await ctx.call('/api/pi/sessions/s-busy/follow-up', { method: 'POST', body: { directory: ctx.projectA, text: 'more', streamEpoch: 'epoch-main' } });
    expect(followUp.status).not.toBe(409);
    expect(ctx.main.commands()).toContain('sessions.followUp');
    // The main daemon is not asked to release the folder any more.
    const releases = ctx.main.calls.filter((c) => c.command === 'sessions.release').length;
    await ctx.tick(1_000);
    expect(ctx.main.calls.filter((c) => c.command === 'sessions.release')).toHaveLength(releases);
  });

  it('turning a project on again while its session still runs in the old sandbox shows no switch', async () => {
    const ctx = await setup({
      sandboxAnswers: {
        'sessions.release': (p) => ({ released: [], pending: [{ sessionId: 's-1', directory: p.directories[0] }], streamEpoch: 'epoch-box' }),
      },
    });
    await ctx.sandboxOn();
    await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    await ctx.sandboxOn('proj-a', { mode: 'off' });
    expect((await (await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`)).json()).session).toMatchObject({ sandboxed: true, pendingSwitch: { to: 'off' } });

    await ctx.sandboxOn();
    const detail = await (await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`)).json();
    expect(detail.session.sandboxed).toBe(true);
    expect(detail.session.pendingSwitch).toBeUndefined();
    // It is still served by the daemon running it.
    expect(detail.stream).toBe(publicDaemonStreamId('sandbox:proj-a'));
  });

  it('records the trust reset on a later check when the first write fails, without unsetting trust again', async () => {
    const ctx = await setup();
    await ctx.sandboxOn();
    const add = ctx.trustAsk.add;
    ctx.trustAsk.add = async () => {
      ctx.trustAsk.add = add;
      throw new Error('disk full');
    };
    await ctx.sandboxOn('proj-a', { mode: 'off' });
    expect(await ctx.trustAsk.list()).toEqual([]);
    const resets = () => ctx.main.calls.filter((c) => c.command === 'settings.set').length;
    expect(resets()).toBe(2);
    await ctx.tick(1_000);
    expect(await ctx.trustAsk.list()).toEqual([ctx.projectA, ctx.worktree]);
    expect(resets()).toBe(2);
  });

  it('keeps a draining daemon that holds a busy session through a few failed checks', async () => {
    let answer = 'busy';
    const ctx = await setup({
      sandboxAnswers: {
        'sessions.release': (p) => {
          if (answer === 'fail') throw daemonError('DAEMON_TIMEOUT');
          return answer === 'busy'
            ? { released: [], pending: [{ sessionId: 's-1', directory: p.directories[0] }], streamEpoch: 'epoch-box' }
            : { released: [{ sessionId: 's-1', directory: p.directories[0] }], pending: [], streamEpoch: 'epoch-box' };
        },
      },
    });
    await ctx.sandboxOn();
    await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    const [box] = ctx.launched;
    await ctx.sandboxOn('proj-a', { mode: 'off' });
    answer = 'fail';
    for (let i = 0; i < 5; i += 1) await ctx.tick(1_000);
    expect(box.stopped).toBe(false);
    answer = 'done';
    await ctx.tick(1_000);
    expect(box.stopped).toBe(true);
  });

  it('refuses a daemon whose setting changed while it was starting, so removed access is not kept', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let starts = 0;
    const ctx = await setup({ onStart: () => { starts += 1; return starts === 1 ? gate : undefined; } });
    await ctx.sandboxOn('proj-a', { allowHosts: ['registry.npmjs.org'] });
    const first = ctx.call(`/api/pi/sessions/s-1/tree?directory=${ctx.projectA}`);
    for (let i = 0; i < 100 && starts === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(starts).toBe(1);
    // The host is removed while the daemon that was granted it still starts.
    await ctx.sandboxOn('proj-a', { allowHosts: [] });
    release();
    const refused = await first;
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: { code: 'SANDBOX_UNAVAILABLE', reason: 'SANDBOX_SETTING_CHANGED' } });
    expect(ctx.launched[0].stopped).toBe(true);
    await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    expect(ctx.launched).toHaveLength(2);
    expect(ctx.launched[1].sandbox.network.allowHosts).toEqual(['api.anthropic.com']);
    expect(ctx.launched[1].stopped).toBe(false);
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
    await waitFor(() => ctx.manager.drainingSession('s-1'));
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

  it('a replaced daemon never takes the pool key of one that is still draining', async () => {
    let busy = true;
    const ctx = await setup({
      mainAnswers: { 'providers.models.set': { config: null } },
      sandboxAnswers: {
        'sessions.release': (p) => (busy
          ? { released: [], pending: [{ sessionId: 's-1', directory: p.directories[0] }], streamEpoch: 'epoch-box' }
          : { released: [{ sessionId: 's-1', directory: p.directories[0] }], pending: [], streamEpoch: 'epoch-box' }),
      },
    });
    const replace = async () => {
      expect((await ctx.call('/api/pi/providers/local/models', { method: 'PUT', body: { models: [] } })).status).toBe(200);
    };
    await ctx.sandboxOn();
    await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    // Replaced once: the first daemon drains and finishes, the project moves
    // to the second key.
    await replace();
    await waitFor(() => ctx.manager.drainingSession('s-1'));
    busy = false;
    await ctx.tick(1_000);
    expect(ctx.launched[0].stopped).toBe(true);
    await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    expect(ctx.pool.live().map((d) => d.key)).toEqual(['main', 'sandbox:proj-a:1']);

    // Turned off mid-turn: that daemon drains under the second key. Turned
    // on again, the project gets the first key back, which is free.
    busy = true;
    await ctx.sandboxOn('proj-a', { mode: 'off' });
    await ctx.sandboxOn();
    await ctx.call(`/api/pi/sessions/s-2?directory=${ctx.projectA}`);
    expect(ctx.pool.live().map((d) => d.key).sort()).toEqual(['main', 'sandbox:proj-a', 'sandbox:proj-a:1']);

    // Replaced again: the next key is the draining daemon's, so it is skipped.
    await replace();
    await waitFor(() => ctx.launched[2].commands().includes('sessions.release'));
    await ctx.call(`/api/pi/sessions/s-3?directory=${ctx.projectA}`);
    expect(ctx.launched).toHaveLength(4);
    expect(ctx.launched[1].stopped).toBe(false);
    expect(ctx.pool.live().map((d) => d.key).sort()).toEqual(['main', 'sandbox:proj-a', 'sandbox:proj-a:1', 'sandbox:proj-a:2']);
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
    // Both name the sandboxed folders, so the main daemon starts no runtime there to answer.
    const exclude = [ctx.projectA, join(ctx.dataDir, 'worktree', ctx.gitId)];
    // The main daemon also reads them from the server's record before it starts any runtime.
    expect(JSON.parse(await readFile(sandboxedFoldersFile(ctx.dataDir), 'utf8')).directories).toEqual([...exclude].sort());
    expect(ctx.main.calls.find((c) => c.command === 'providers.oauth.refresh').payload).toEqual({ minValidityMs: 30 * 60_000, exclude });
    expect(ctx.main.calls.find((c) => c.command === 'providers.hosts').payload).toEqual({ exclude });
    await ctx.tick(60_000);
    expect(ctx.launched[0].stopped).toBe(false);
    // Turned off, the project is the main daemon's again.
    await ctx.sandboxOn('proj-a', { mode: 'off' });
    expect(JSON.parse(await readFile(sandboxedFoldersFile(ctx.dataDir), 'utf8')).directories).toEqual([]);
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

  // The manager recognises Pi's own error text. Produce it with the pi-ai
  // the Pi SDK actually loads (its `refreshStoredOAuthCredential`, not part
  // of pi-ai's public exports), so a rewording upstream fails this test.
  it('recognises the OAuth refresh failures pi-ai reports', async () => {
    let sdkDir = await realpath(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
    while (!sdkDir.endsWith('/pi-coding-agent')) sdkDir = dirname(sdkDir);
    const { refreshStoredOAuthCredential } = await import(pathToFileURL(join(dirname(sdkDir), 'pi-ai', 'dist', 'auth', 'resolve.js')).href);
    const piError = async (credentials) => {
      try {
        await refreshStoredOAuthCredential(
          credentials,
          'anthropic',
          { refresh: async () => { throw new Error('invalid_grant'); } },
          () => true,
          new AbortController().signal,
        );
      } catch (error) {
        return error.message;
      }
      throw new Error('pi-ai did not fail the refresh');
    };
    const messages = [
      // The provider refused the refresh.
      await piError({ modify: async (_id, update) => update({ type: 'oauth', expires: 0 }) }),
      // auth.json is read-only in the sandbox: the store cannot be modified.
      await piError({ modify: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } }),
    ];
    // pi-ai appends the cause (`...: invalid_grant`).
    expect(messages[0]).toMatch(/^OAuth refresh failed for anthropic\b/);
    expect(messages[1]).toMatch(/^Credential store modify failed for anthropic\b/);

    let refreshes = 0;
    const ctx = await setup({ mainAnswers: { 'providers.oauth.refresh': async () => { refreshes += 1; return {}; } } });
    await ctx.sandboxOn();
    await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    const [box] = ctx.launched;
    const waitFor = async (predicate) => {
      for (let tries = 0; tries < 200 && !predicate(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    };
    await waitFor(() => box.subscriptions.some((item) => !item.closed));
    expect(refreshes).toBe(1);
    for (const [index, message] of messages.entries()) {
      box.emit('session.error', 10 + index, { code: 'ASSISTANT_ERROR', message });
      await waitFor(() => refreshes === index + 2);
      expect(refreshes).toBe(index + 2);
      // Let the shared (single-flight) refresh settle before the next error.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
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

describe('keeping a sandboxed project owned', () => {
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

  const transcript = async (ctx, storedFor, id, headerCwd) => {
    const sessions = getPiSessionDirectory({ cwd: storedFor, agentDir: ctx.agentDir });
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, `2026-01-01_${id}.jsonl`), `${JSON.stringify({ type: 'session', id, cwd: headerCwd, timestamp: '2026-01-01T00:00:00.000Z' })}\n`);
  };

  const until = async (predicate) => {
    for (let attempt = 0; attempt < 400 && !await predicate(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  };

  // A sandbox daemon is not trusted to say which sessions are its own.
  it('ignores another project\'s session in a draining sandbox daemon\'s answer', async () => {
    let busy = true;
    const ctx = await setup({
      sandboxAnswers: {
        'sessions.release': (p) => ({
          released: [],
          // s-1 is its own; s-b belongs to the unsandboxed project B, and
          // the daemon claims it runs in its own folder.
          pending: busy
            ? [{ sessionId: 's-1', directory: p.directories[0] }, { sessionId: 's-b', directory: p.directories[0] }]
            : [{ sessionId: 's-b', directory: p.directories[0] }],
          streamEpoch: 'epoch-box',
        }),
      },
    });
    await transcript(ctx, ctx.projectB, 's-b', ctx.projectB);
    await ctx.sandboxOn();
    await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    await ctx.sandboxOn('proj-a', { mode: 'off' });
    await until(() => ctx.manager.drainingSession('s-1'));

    expect(ctx.manager.drainingSession('s-b')).toBeNull();
    expect(await ctx.manager.sessionOnDaemon('sandbox:proj-a', 's-b', ctx.projectA)).toBe(false);
    expect(await ctx.manager.sessionOnDaemon('sandbox:proj-a', 's-1', ctx.projectA)).toBe(true);
    // Project B's session still runs in the main daemon.
    await ctx.call('/api/pi/sessions/s-b/prompt', { method: 'POST', body: { directory: ctx.projectB, text: 'hi', streamEpoch: 'epoch-1' } });
    expect(ctx.main.commands()).toContain('sessions.prompt');
    expect(ctx.launched[0].commands()).not.toContain('sessions.prompt');

    // The claim does not keep the drain open either.
    busy = false;
    await ctx.tick(1_000);
    await until(() => ctx.pool.live().length === 1);
    expect(ctx.launched[0].stopped).toBe(true);
  });

  it('routes a session by its real transcript when a sandboxed project holds a planted copy', async () => {
    const ctx = await setup({ probe: { available: false, code: 'NOT_INSTALLED' } });
    await ctx.sandboxOn();
    // Project A's sandbox wrote a transcript with the id of B's session.
    await transcript(ctx, ctx.projectA, 's-b', ctx.projectA);
    await transcript(ctx, ctx.projectB, 's-b', ctx.projectB);
    expect(await ctx.manager.directoryForSession('s-b')).toBe(ctx.projectB);
    const response = await ctx.call('/api/pi/sessions/s-b/prompt', { method: 'POST', body: { text: 'hi', streamEpoch: 'epoch-1' } });
    // The fake daemon's answer is not a real one; that it was asked is the point.
    expect((await response.json()).error?.code).not.toBe('SANDBOX_UNAVAILABLE');
    expect(ctx.main.commands()).toContain('sessions.prompt');
  });

  it('tells the main daemon to stay out of a project before it asks it to let go', async () => {
    let recorded;
    const ctx = await setup({
      mainAnswers: {
        'sessions.release': () => {
          recorded ??= JSON.parse(readFileSync(sandboxedFoldersFile(recordDataDir), 'utf8'));
          return { released: [], pending: [] };
        },
      },
    });
    const recordDataDir = ctx.dataDir;
    await ctx.sandboxOn();
    expect(JSON.stringify(recorded)).toContain(ctx.projectA);
  });

  it.skipIf(process.platform === 'win32')('does not wait on a project id file the sandbox turned into a FIFO', async () => {
    const ctx = await setup();
    await rm(join(ctx.projectB, '.git', 'pichamber'), { force: true });
    await mkdir(join(ctx.projectB, '.git'), { recursive: true });
    execFileSync('mkfifo', [join(ctx.projectB, '.git', 'pichamber')]);
    const saved = await Promise.race([
      ctx.sandboxOn('proj-b'),
      new Promise((resolve) => setTimeout(() => resolve('stuck'), 3_000)),
    ]);
    expect(saved).not.toBe('stuck');
    expect(saved.status).toBe(200);
    expect(ctx.manager.sandboxFor(ctx.projectB)).toEqual({ launcher: 'nono' });
  });

  it('two saves applied at once leave the project owned by its sandbox', async () => {
    const ctx = await setup();
    await ctx.sandboxOn();
    // Off then on, overlapping: the last stored setting is on.
    const [off, on] = await Promise.all([ctx.sandboxOn('proj-a', { mode: 'off' }), ctx.sandboxOn()]);
    expect([off.status, on.status]).toEqual([200, 200]);
    expect(ctx.manager.sandboxFor(ctx.projectA)).toEqual({ launcher: 'nono' });
    await ctx.call(`/api/pi/sessions/s-1/prompt`, { method: 'POST', body: { directory: ctx.projectA, text: 'hi', streamEpoch: 'epoch-1' } });
    expect(ctx.main.commands()).not.toContain('sessions.prompt');
    expect(ctx.launched.at(-1).commands()).toContain('sessions.prompt');
  });

  it('routes a transcript stored in a sandboxed project\'s folder to its sandbox even when its header names another folder', async () => {
    const ctx = await setup({ probe: { available: false, code: 'NOT_INSTALLED' } });
    await ctx.sandboxOn();
    // The sandboxed agent can rewrite the header of its own transcript.
    await transcript(ctx, ctx.projectA, 's-9', ctx.projectB);
    for (const body of [{ text: 'hi', streamEpoch: 'epoch-1' }, { directory: ctx.projectB, text: 'hi', streamEpoch: 'epoch-1' }]) {
      const response = await ctx.call('/api/pi/sessions/s-9/prompt', { method: 'POST', body });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: 'SANDBOX_UNAVAILABLE', reason: 'NOT_INSTALLED' } });
    }
    expect(ctx.main.commands()).not.toContain('sessions.prompt');
  });

  it('routes a folder spelled with spaces or through a symlink to the project\'s sandbox', async () => {
    const ctx = await setup();
    await ctx.sandboxOn();
    const link = join(ctx.root, 'link-to-a');
    await symlink(ctx.projectA, link);
    await ctx.call('/api/pi/sessions', { method: 'POST', body: { cwd: `  ${ctx.projectA}  ` } });
    await ctx.call('/api/pi/sessions', { method: 'POST', body: { cwd: link } });
    await ctx.call(`/api/pi/sessions/s-1/prompt`, { method: 'POST', body: { directory: ` ${ctx.projectA}`, text: 'hi', streamEpoch: 'epoch-1' } });
    const listed = await (await ctx.call(`/api/pi/sessions?directory=${encodeURIComponent(link)}`)).json();
    // The answer names the sandbox daemon's stream, not the main one.
    expect(listed.stream).toBe(publicDaemonStreamId('sandbox:proj-a'));
    await ctx.call(`/api/pi/resources?directory=${encodeURIComponent(`${ctx.projectA} `)}`);
    for (const command of ['sessions.create', 'sessions.prompt', 'sessions.list', 'resources.list']) {
      expect(ctx.main.commands()).not.toContain(command);
    }
    expect(ctx.launched).toHaveLength(1);
    expect(ctx.launched[0].commands().filter((command) => command === 'sessions.create')).toHaveLength(2);
  });

  it('refuses a folder that is not an absolute path while a project is sandboxed', async () => {
    const ctx = await setup();
    await ctx.sandboxOn();
    const created = await ctx.call('/api/pi/sessions', { method: 'POST', body: { cwd: 'code/a' } });
    expect(created.status).toBe(400);
    const prompted = await ctx.call('/api/pi/sessions/s-1/prompt', { method: 'POST', body: { directory: './a', text: 'hi', streamEpoch: 'epoch-1' } });
    expect(prompted.status).toBe(400);
    expect(ctx.main.commands()).toEqual(['sessions.release']);
    expect(ctx.launched).toEqual([]);
  });

  it('gives a project that had no worktrees when it was sandboxed a worktree folder of its own', async () => {
    const ctx = await setup();
    await ctx.sandboxOn('proj-b');
    // Remembered at once, from the project's path: the Git panel files the
    // project's first worktree there, whatever the agent writes meanwhile.
    const id = ownWorktreeId(ctx.projectB);
    expect(JSON.parse(await readFile(worktreeIdsFile(ctx.dataDir), 'utf8')).projects).toEqual({ [ctx.projectB]: id });
    await mkdir(join(ctx.projectB, '.git'), { recursive: true });
    await writeFile(join(ctx.projectB, '.git', 'pichamber'), 'e'.repeat(40));
    const added = join(ctx.dataDir, 'worktree', id, 'feature');
    await mkdir(added, { recursive: true });
    await ctx.call(`/api/pi/sessions/s-1/prompt`, { method: 'POST', body: { directory: added, text: 'hi', streamEpoch: 'epoch-1' } });
    expect(ctx.main.commands()).not.toContain('sessions.prompt');
    expect(ctx.launched).toHaveLength(1);
    expect(ctx.launched[0].sandbox.grants).toEqual(expect.arrayContaining([{ kind: 'readWrite', path: join(ctx.dataDir, 'worktree', id) }]));
  });

  it('keeps a project\'s worktrees when its id file is rewritten or deleted', async () => {
    const ctx = await setup();
    await ctx.sandboxOn();
    const other = 'a'.repeat(40);
    const foreign = join(ctx.dataDir, 'worktree', other, 'x');
    await mkdir(foreign, { recursive: true });
    for (const change of [() => writeFile(join(ctx.projectA, '.git', 'pichamber'), other), () => rm(join(ctx.projectA, '.git', 'pichamber'))]) {
      await change();
      await ctx.manager.reconcile();
      expect(ctx.manager.sandboxFor(ctx.worktree)).toEqual({ launcher: 'nono' });
      // The rewritten id names another project's worktrees; they are not taken.
      expect(ctx.manager.sandboxFor(foreign)).toBeNull();
    }
    // A restart reads the remembered id, not the file.
    expect(JSON.parse(await readFile(worktreeIdsFile(ctx.dataDir), 'utf8')).projects).toEqual({ [ctx.projectA]: ctx.gitId });
  });

  it('needs a reconcile before the first one has run, so a request at server start cannot reach the main daemon', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-routes-sandbox-'));
    const fresh = createProjectSandboxManager({
      daemonPool: createPiDaemonPool({ getMainRuntime: () => null }),
      uiSettingsStore: createPiUiSettingsStore({ file: join(root, 'data', 'settings.json') }),
      launcher: fakeLauncher(),
      dataDir: join(root, 'data'),
      agentDir: join(root, 'agent'),
      getServerPort: () => 3000,
      setInterval: () => 0,
      clearInterval: () => {},
    });
    expect(fresh.needsReconcile()).toBe(true);
    await fresh.reconcile();
    expect(fresh.needsReconcile()).toBe(false);
    await fresh.stop?.();
  });

  it('resets trust again after a restart for folders still marked to ask', async () => {
    // An earlier server process recorded the mark, then stopped before the
    // main daemon had taken the reset.
    const ctx = await setup({ beforeReconcile: ({ trustAsk, projectB }) => trustAsk.add([projectB]) });
    const resets = () => ctx.main.calls.filter((c) => c.command === 'settings.set').map((c) => c.payload);
    expect(resets()).toEqual([{ scope: 'project', directory: ctx.projectB, trust: null }]);
    // Done once; later passes do not repeat it.
    await ctx.manager.reconcile();
    await ctx.tick(1000);
    expect(resets()).toHaveLength(1);
    expect(await ctx.trustAsk.list()).toEqual([ctx.projectB]);
  });

  it('keeps two clones of one repository apart: the sandboxed one gets a worktree folder of its own', async () => {
    const ctx = await setup();
    // Project B is a second clone of A's repository: both files name the
    // repository's root commit, and B (not sandboxed) has a worktree there.
    await mkdir(join(ctx.projectB, '.git'), { recursive: true });
    await writeFile(join(ctx.projectB, '.git', 'pichamber'), ctx.gitId);
    await ctx.sandboxOn();
    const own = join(ctx.dataDir, 'worktree', ownWorktreeId(ctx.projectA));
    await mkdir(join(own, 'new'), { recursive: true });

    const listed = await (await ctx.call('/api/pi/sandbox/projects')).json();
    expect(listed.projects.find((project) => project.projectId === 'proj-a').availability).toEqual({ state: 'available' });
    // The shared folder stays the other clone's; A's sandbox is not granted it.
    expect(ctx.manager.sandboxFor(ctx.worktree)).toBeNull();
    expect(ctx.manager.sandboxFor(join(own, 'new'))).toEqual({ launcher: 'nono' });
    await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectA}`);
    const paths = ctx.launched[0].sandbox.grants.map((grant) => grant.path);
    expect(paths).toContain(own);
    expect(paths.some((path) => path.startsWith(join(ctx.dataDir, 'worktree', ctx.gitId)))).toBe(false);
    await ctx.call(`/api/pi/sessions/s-2/prompt`, { method: 'POST', body: { directory: ctx.worktree, text: 'hi', streamEpoch: 'epoch-1' } });
    expect(ctx.main.commands()).toContain('sessions.prompt');
  });

  it('runs nothing in a worktree the sandboxed project made before it had its own folder', async () => {
    const ctx = await setup();
    await mkdir(join(ctx.projectB, '.git'), { recursive: true });
    await writeFile(join(ctx.projectB, '.git', 'pichamber'), ctx.gitId);
    // One worktree in the shared folder is project A's, one is B's.
    const mine = join(ctx.dataDir, 'worktree', ctx.gitId, 'mine');
    await mkdir(mine, { recursive: true });
    await writeFile(join(mine, '.git'), `gitdir: ${join(ctx.projectA, '.git', 'worktrees', 'mine')}\n`);
    await writeFile(join(ctx.worktree, '.git'), `gitdir: ${join(ctx.projectB, '.git', 'worktrees', 'feature')}\n`);
    await ctx.sandboxOn();

    expect(ctx.manager.sandboxFor(mine)).toEqual({ launcher: 'nono' });
    expect(ctx.manager.sandboxFor(ctx.worktree)).toBeNull();
    const refused = await ctx.call(`/api/pi/sessions/s-1/prompt`, { method: 'POST', body: { directory: mine, text: 'hi', streamEpoch: 'epoch-1' } });
    expect(await refused.json()).toEqual({ error: { code: 'SANDBOX_UNAVAILABLE', reason: 'SANDBOX_WORKTREE_OUTSIDE_FOLDER' } });
    expect(ctx.main.commands()).not.toContain('sessions.prompt');
    expect(ctx.launched).toHaveLength(0);
    // Its sessions are still listed, by the main daemon.
    expect((await ctx.call(`/api/pi/sessions?directory=${mine}`)).status).toBe(200);
    expect(ctx.launched).toHaveLength(0);
  });

  it('starts no sandbox on an id it cannot check against the remembered ones, and keeps those worktrees off the main daemon', async () => {
    const ctx = await setup();
    // The sandboxed agent can write this file; the record that would
    // confirm it is unreadable.
    const id = 'e'.repeat(40);
    await mkdir(join(ctx.projectB, '.git'), { recursive: true });
    await writeFile(join(ctx.projectB, '.git', 'pichamber'), id);
    const claimed = join(ctx.dataDir, 'worktree', id, 'feature');
    await mkdir(claimed, { recursive: true });
    await mkdir(dirname(worktreeIdsFile(ctx.dataDir)), { recursive: true });
    await writeFile(worktreeIdsFile(ctx.dataDir), '{');
    await ctx.sandboxOn('proj-b');
    const listed = await (await ctx.call('/api/pi/sandbox/projects')).json();
    expect(listed.projects.find((project) => project.projectId === 'proj-b').availability)
      .toEqual({ state: 'unavailable', reason: 'SANDBOX_WORKTREE_IDS_UNREADABLE' });
    for (const directory of [ctx.projectB, claimed]) {
      const refused = await ctx.call(`/api/pi/sessions/s-1/prompt`, { method: 'POST', body: { directory, text: 'hi', streamEpoch: 'epoch-1' } });
      expect(await refused.json()).toEqual({ error: { code: 'SANDBOX_UNAVAILABLE', reason: 'SANDBOX_WORKTREE_IDS_UNREADABLE' } });
    }
    expect(ctx.main.commands()).not.toContain('sessions.prompt');
    expect(ctx.launched).toHaveLength(0);
    // Once the record can be read again the project runs.
    await rm(worktreeIdsFile(ctx.dataDir));
    await ctx.manager.reconcile();
    await ctx.call(`/api/pi/sessions/s-1/prompt`, { method: 'POST', body: { directory: ctx.projectB, text: 'hi', streamEpoch: 'epoch-1' } });
    expect(ctx.launched).toHaveLength(1);
  });

  it('refuses Pi-running commands while the stored settings could not be applied, and recovers on the next request', async () => {
    const ctx = await setup();
    await ctx.sandboxOn();
    const read = ctx.uiSettingsStore.read;
    ctx.uiSettingsStore.read = async () => { throw new Error('unreadable'); };
    await expect(ctx.manager.reconcile()).rejects.toThrow();
    const refused = await ctx.call(`/api/pi/sessions/s-1/prompt`, { method: 'POST', body: { directory: ctx.projectB, text: 'hi', streamEpoch: 'epoch-1' } });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: { code: 'SANDBOX_UNAVAILABLE', reason: 'SANDBOX_SETTINGS_UNREADABLE' } });
    expect(ctx.main.commands()).not.toContain('sessions.prompt');
    // The sandbox pages stay reachable so the cause can be seen and fixed.
    expect((await ctx.call('/api/pi/sandbox')).status).toBe(200);

    ctx.uiSettingsStore.read = read;
    const served = await ctx.call(`/api/pi/sessions/s-1?directory=${ctx.projectB}`);
    expect(served.status).toBe(200);
    expect(ctx.manager.needsReconcile()).toBe(false);
  });

  it('answers a stored save as saved when applying it fails, and applies it before the next Pi command', async () => {
    const ctx = await setup();
    const register = ctx.pool.register;
    ctx.pool.register = () => {
      ctx.pool.register = register;
      throw new Error('register failed');
    };
    const saved = await ctx.sandboxOn();
    expect(saved.status).toBe(200);
    expect(ctx.manager.needsReconcile()).toBe(true);
    await ctx.call(`/api/pi/sessions/s-1/prompt`, { method: 'POST', body: { directory: ctx.projectA, text: 'hi', streamEpoch: 'epoch-1' } });
    expect(ctx.main.commands()).not.toContain('sessions.prompt');
    expect(ctx.launched).toHaveLength(1);
  });

  it('changes only the fields a default save names', async () => {
    const ctx = await setup();
    const put = (body) => ctx.call('/api/pi/sandbox/defaults', { method: 'PUT', body });
    await put({ mode: 'nono', allowHosts: ['github.com'] });
    // A page loaded before the default was turned on adds a host.
    expect((await (await put({ allowHosts: ['github.com', 'registry.npmjs.org'] })).json()).defaults)
      .toEqual({ mode: 'nono', allowHosts: ['github.com', 'registry.npmjs.org'], acceptedLimits: [] });
    expect((await (await put({ mode: 'off' })).json()).defaults)
      .toEqual({ mode: 'off', allowHosts: ['github.com', 'registry.npmjs.org'], acceptedLimits: [] });
    expect((await ctx.call('/api/pi/sandbox/defaults', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: undefined })).status).toBe(400);
    expect((await put({ note: 'x' })).status).toBe(400);
    expect((await put({ mode: 'nono', allowHosts: 'github.com' })).status).toBe(400);
  });
});
