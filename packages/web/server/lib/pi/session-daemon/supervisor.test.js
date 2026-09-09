import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getPiSessionDirectory } from './session-jsonl.js';
import { createPiSessionDaemonSupervisor } from './supervisor.js';

const waitForExit = async (pid) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The daemon process did not exit.');
};

describe('Pi session daemon supervisor', () => {
  let supervisor;

  afterEach(async () => {
    await supervisor?.stop().catch(() => {});
    supervisor = undefined;
  });

  it('recovers a forced daemon crash during the next health probe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-supervisor-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    const env = {
      ...process.env,
      PI_OFFLINE: '1',
      PICHAMBER_DATA_DIR: join(root, 'data'),
      PICHAMBER_PI_AGENT_DIR: agentDir,
      XDG_RUNTIME_DIR: join(root, 'runtime'),
    };

    supervisor = createPiSessionDaemonSupervisor({ env, cwd });
    await supervisor.start();
    const state = JSON.parse(await readFile(supervisor.paths.stateFile, 'utf8'));
    process.kill(state.pid, 'SIGKILL');
    await waitForExit(state.pid);

    await expect(supervisor.health()).resolves.toMatchObject({ state: 'ready' });
  }, 20_000);

  it('reports malformed Pi session JSONL as a stable startup failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-supervisor-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    const sessionDirectory = getPiSessionDirectory({ cwd, agentDir });
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, 'corrupt.jsonl'), '{"type":"session"}\nnot-json\n');
    const env = {
      ...process.env,
      PI_OFFLINE: '1',
      PICHAMBER_DATA_DIR: join(root, 'data'),
      PICHAMBER_PI_AGENT_DIR: agentDir,
      XDG_RUNTIME_DIR: join(root, 'runtime'),
    };

    supervisor = createPiSessionDaemonSupervisor({ env, cwd });
    await expect(supervisor.start()).rejects.toMatchObject({ code: 'MALFORMED_SESSION_JSONL' });
    await expect(supervisor.health()).resolves.toMatchObject({
      state: 'unavailable',
      error: { code: 'MALFORMED_SESSION_JSONL' },
    });
  }, 20_000);

  it('starts, reuses, health-checks, and stops a private daemon without exposing its credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-supervisor-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    const env = {
      ...process.env,
      PI_OFFLINE: '1',
      PICHAMBER_DATA_DIR: join(root, 'data'),
      PICHAMBER_PI_AGENT_DIR: agentDir,
      XDG_RUNTIME_DIR: join(root, 'runtime'),
    };

    supervisor = createPiSessionDaemonSupervisor({ env, cwd });
    await expect(supervisor.start()).resolves.toMatchObject({ state: 'ready', reused: false, protocolVersion: 1 });
    await expect(supervisor.start()).resolves.toMatchObject({ state: 'ready', reused: true, protocolVersion: 1 });
    await expect(supervisor.health()).resolves.toEqual({
      state: 'ready',
      protocolVersion: 1,
      capabilities: expect.arrayContaining(['projects.list', 'projects.select', 'sessions.list', 'sessions.create', 'sessions.open', 'sessions.rename', 'sessions.delete', 'sessions.tree', 'sessions.navigate', 'sessions.fork', 'sessions.clone', 'sessions.prompt', 'sessions.steer', 'sessions.followUp', 'sessions.abort', 'sessions.setModel', 'sessions.setThinking', 'sessions.compact', 'providers.list', 'providers.config.get', 'providers.models.set', 'providers.status', 'providers.login', 'providers.login.respond', 'providers.login.status', 'providers.logout', 'settings.get', 'settings.set', 'resources.list', 'resources.update', 'resources.prompts.create', 'resources.prompts.update', 'resources.prompts.delete', 'events.streamEpoch']),
      streamEpoch: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    await expect(supervisor.request('sessions.list')).resolves.toMatchObject({ sessions: expect.any(Array) });

    const credential = await readFile(supervisor.paths.credentialFile, 'utf8');
    expect(credential.trim()).toHaveLength(64);
    if (process.platform !== 'win32') {
      expect((await stat(supervisor.paths.credentialFile)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.stringify(await supervisor.health())).not.toContain(credential.trim());

    await expect(supervisor.stop()).resolves.toEqual({ state: 'stopped' });
    await expect(supervisor.stop()).resolves.toEqual({ state: 'stopped' });
    await expect(supervisor.health()).resolves.toMatchObject({
      state: 'unavailable',
      error: { code: 'DAEMON_UNAVAILABLE' },
    });
  }, 20_000);

  it('replaces a healthy daemon that predates entrypoint identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-supervisor-entrypoint-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    const env = {
      ...process.env,
      PI_OFFLINE: '1',
      PICHAMBER_DATA_DIR: join(root, 'data'),
      PICHAMBER_PI_AGENT_DIR: agentDir,
      XDG_RUNTIME_DIR: join(root, 'runtime'),
    };

    supervisor = createPiSessionDaemonSupervisor({ env, cwd });
    await expect(supervisor.start()).resolves.toMatchObject({ state: 'ready', reused: false });
    const first = JSON.parse(await readFile(supervisor.paths.stateFile, 'utf8'));
    expect(typeof first.entrypoint).toBe('string');
    const firstPid = first.pid;
    const { entrypoint: _entrypoint, ...legacyState } = first;
    await writeFile(supervisor.paths.stateFile, JSON.stringify(legacyState));

    await expect(supervisor.start()).resolves.toMatchObject({ state: 'ready', reused: false });
    await waitForExit(firstPid);
    const second = JSON.parse(await readFile(supervisor.paths.stateFile, 'utf8'));
    expect(second.pid).not.toBe(firstPid);
    expect(second.entrypoint).toBe(first.entrypoint);
  }, 20_000);

  it('spawns the daemon as Node when the parent process is Electron', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-supervisor-electron-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    const env = {
      ...process.env,
      PI_OFFLINE: '1',
      PICHAMBER_DATA_DIR: join(root, 'data'),
      PICHAMBER_PI_AGENT_DIR: agentDir,
      XDG_RUNTIME_DIR: join(root, 'runtime'),
    };
    let spawnEnv;
    supervisor = createPiSessionDaemonSupervisor({
      env,
      cwd,
      processLike: {
        versions: { electron: '41.2.1' },
        execPath: process.execPath,
        pid: process.pid,
        kill() {
          const error = new Error('ESRCH');
          error.code = 'ESRCH';
          throw error;
        },
      },
      spawn: (_command, _args, options) => {
        spawnEnv = options.env;
        return { pid: 1, unref() {} };
      },
      wait: async () => {},
      startupTimeoutMs: 50,
      daemonReadyTimeoutMs: 50,
      request: async () => {
        const error = new Error('refused');
        error.code = 'DAEMON_CONNECTION_REFUSED';
        throw error;
      },
    });

    await expect(supervisor.start()).rejects.toMatchObject({ code: 'DAEMON_START_TIMEOUT' });
    expect(spawnEnv?.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('uses a per-user Windows named pipe instead of a filesystem socket', () => {
    const windowsSupervisor = createPiSessionDaemonSupervisor({
      env: {
        PICHAMBER_DATA_DIR: join(tmpdir(), 'pichamber-win-data'),
        PICHAMBER_PI_AGENT_DIR: join(tmpdir(), 'pichamber-win-agent'),
      },
      cwd: join(tmpdir(), 'pichamber-win-project'),
      platform: 'win32',
    });
    expect(windowsSupervisor.paths.endpoint).toMatch(/^\\\\\.\\pipe\\pichamber-pi-session-daemon-[0-9a-f]{16}-web$/);
  });

  it('namespaces daemon sidecars per server profile', () => {
    const root = join(tmpdir(), 'pichamber-pi-supervisor-profiles-');
    const installed = createPiSessionDaemonSupervisor({
      env: { PICHAMBER_DATA_DIR: join(root, 'data') },
      cwd: join(root, 'project'),
      port: 3000,
    });
    const dev = createPiSessionDaemonSupervisor({
      env: { PICHAMBER_DATA_DIR: join(root, 'data'), PICHAMBER_SERVER_PROFILE_KIND: 'dev' },
      cwd: join(root, 'project'),
      port: 3000,
    });
    const otherPort = createPiSessionDaemonSupervisor({
      env: { PICHAMBER_DATA_DIR: join(root, 'data') },
      cwd: join(root, 'project'),
      port: 3902,
    });
    expect(installed.paths.profileKey).toBe('web-p3000');
    expect(dev.paths.profileKey).toBe('web-dev-p3000');
    for (const supervisor of [installed, dev, otherPort]) {
      expect(supervisor.paths.credentialFile).toContain(supervisor.paths.profileKey);
      expect(supervisor.paths.stateFile).toContain(supervisor.paths.profileKey);
      expect(supervisor.paths.lockFile).toContain(supervisor.paths.profileKey);
      expect(supervisor.paths.logFile).toContain(supervisor.paths.profileKey);
    }
    const paths = [installed, dev, otherPort].map((item) => item.paths.stateFile);
    expect(new Set(paths).size).toBe(3);
    expect(installed.paths.endpoint).not.toBe(dev.paths.endpoint);
    expect(installed.paths.credentialFile).not.toBe(otherPort.paths.credentialFile);
  });

  it('bounds an unresponsive Windows daemon probe by the supervisor operation timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-supervisor-hung-win-'));
    const dataDir = join(root, 'data');
    const piDataDir = join(dataDir, 'pi', 'daemons', 'web');
    await mkdir(piDataDir, { recursive: true });
    const daemonPid = 7_331;
    const processLike = {
      pid: 4_242,
      execPath: process.execPath,
      versions: { electron: '41.2.1' },
      kill(pid, signal) {
        if (pid === daemonPid && signal === 0) return;
        const error = new Error('ESRCH');
        error.code = 'ESRCH';
        throw error;
      },
    };
    const probeTimeoutMs = 20;
    const windowsSupervisor = createPiSessionDaemonSupervisor({
      env: { PICHAMBER_DATA_DIR: dataDir },
      cwd: root,
      dataDir,
      platform: 'win32',
      processLike,
      startupTimeoutMs: probeTimeoutMs,
      request: () => new Promise(() => {}),
    });
    await writeFile(windowsSupervisor.paths.credentialFile, `${'a'.repeat(64)}\n`);
    await writeFile(windowsSupervisor.paths.stateFile, JSON.stringify({
      protocolVersion: 1,
      pid: daemonPid,
      endpoint: windowsSupervisor.paths.endpoint,
      profileKey: windowsSupervisor.paths.profileKey,
      daemonId: 'daemon-hung',
      serverInstanceId: windowsSupervisor.paths.serverInstanceId,
      startedAt: new Date().toISOString(),
    }));

    const startedAt = Date.now();
    await expect(windowsSupervisor.health()).resolves.toMatchObject({
      state: 'unavailable',
      error: { code: 'DAEMON_UNAVAILABLE' },
    });
    expect(Date.now() - startedAt).toBeLessThan(probeTimeoutMs * 5);
  });

  it('recovers from a leftover empty daemon lock instead of failing as unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-supervisor-empty-lock-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const dataDir = join(root, 'data');
    await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(join(dataDir, 'pi', 'daemons', 'web'), { recursive: true })]);
    const lockFile = join(dataDir, 'pi', 'daemons', 'web', 'operation.lock');
    await writeFile(lockFile, '');
    const past = new Date(Date.now() - 1_000);
    await utimes(lockFile, past, past);
    const env = {
      ...process.env,
      PI_OFFLINE: '1',
      PICHAMBER_DATA_DIR: dataDir,
      PICHAMBER_PI_AGENT_DIR: agentDir,
      XDG_RUNTIME_DIR: join(root, 'runtime'),
    };

    supervisor = createPiSessionDaemonSupervisor({ env, cwd });
    await expect(supervisor.start()).resolves.toMatchObject({ state: 'ready', reused: false });
  }, 20_000);

  it('recovers from a malformed daemon lock instead of failing as unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-supervisor-bad-lock-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const dataDir = join(root, 'data');
    await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(join(dataDir, 'pi', 'daemons', 'web'), { recursive: true })]);
    const lockFile = join(dataDir, 'pi', 'daemons', 'web', 'operation.lock');
    await writeFile(lockFile, '{');
    const past = new Date(Date.now() - 1_000);
    await utimes(lockFile, past, past);
    const env = {
      ...process.env,
      PI_OFFLINE: '1',
      PICHAMBER_DATA_DIR: dataDir,
      PICHAMBER_PI_AGENT_DIR: agentDir,
      XDG_RUNTIME_DIR: join(root, 'runtime'),
    };

    supervisor = createPiSessionDaemonSupervisor({ env, cwd });
    await expect(supervisor.start()).resolves.toMatchObject({ state: 'ready', reused: false });
  }, 20_000);

  it('keeps per-profile daemons independent across one data directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-supervisor-profiles-run-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    const baseEnv = {
      ...process.env,
      PI_OFFLINE: '1',
      PICHAMBER_DATA_DIR: join(root, 'data'),
      PICHAMBER_PI_AGENT_DIR: agentDir,
      XDG_RUNTIME_DIR: join(root, 'runtime'),
    };

    const installed = createPiSessionDaemonSupervisor({ env: baseEnv, cwd, port: 3000 });
    const dev = createPiSessionDaemonSupervisor({
      env: { ...baseEnv, PICHAMBER_SERVER_PROFILE_KIND: 'dev' },
      cwd,
      port: 3000,
    });
    try {
      await installed.start();
      await dev.start();
      const installedState = JSON.parse(await readFile(installed.paths.stateFile, 'utf8'));
      const devState = JSON.parse(await readFile(dev.paths.stateFile, 'utf8'));
      expect(installedState.pid).not.toBe(devState.pid);
      expect(installedState.profileKey).toBe('web-p3000');
      expect(devState.profileKey).toBe('web-dev-p3000');

      const created = await installed.request('sessions.create', { cwd });
      const sessionDirectory = getPiSessionDirectory({ cwd, agentDir });
      await mkdir(sessionDirectory, { recursive: true });
      await writeFile(join(sessionDirectory, `lease_${created.session.id}.jsonl`), `${JSON.stringify({
        type: 'session',
        version: 3,
        id: created.session.id,
        timestamp: new Date().toISOString(),
        cwd,
      })}\n`);
      await expect(dev.request('sessions.open', { sessionId: created.session.id, directory: cwd }))
        .rejects.toMatchObject({ code: 'SESSION_IN_USE' });
      await expect(dev.request('sessions.delete', { sessionId: created.session.id, directory: cwd }))
        .rejects.toMatchObject({ code: 'SESSION_IN_USE' });

      // Stopping one profile must release only its own leases and leave the
      // other daemon running.
      await installed.stop();
      await expect(dev.health()).resolves.toMatchObject({ state: 'ready' });
      await expect(dev.request('sessions.open', { sessionId: created.session.id, directory: cwd }))
        .resolves.toMatchObject({ session: { id: created.session.id } });
      await dev.stop();
      await expect(dev.health()).resolves.toMatchObject({ state: 'unavailable' });
    } finally {
      await installed.stop().catch(() => {});
      await dev.stop().catch(() => {});
    }
  }, 60_000);

  it('refuses to claim a same-profile daemon while its server owner is alive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-supervisor-live-owner-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    const env = {
      ...process.env,
      PI_OFFLINE: '1',
      PICHAMBER_DATA_DIR: join(root, 'data'),
      PICHAMBER_PI_AGENT_DIR: agentDir,
      XDG_RUNTIME_DIR: join(root, 'runtime'),
    };

    const first = createPiSessionDaemonSupervisor({ env, cwd, port: 3000 });
    const peer = createPiSessionDaemonSupervisor({ env, cwd, port: 3000 });
    try {
      await first.start();
      await expect(peer.start()).rejects.toMatchObject({ code: 'DAEMON_PROFILE_IN_USE' });
      await expect(first.health()).resolves.toMatchObject({ state: 'ready' });
    } finally {
      await first.stop().catch(() => {});
      await peer.stop().catch(() => {});
    }
  }, 30_000);

  it('replaces a same-profile daemon when the PiChamber build changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-supervisor-build-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    const env = {
      ...process.env,
      PI_OFFLINE: '1',
      PICHAMBER_DATA_DIR: join(root, 'data'),
      PICHAMBER_PI_AGENT_DIR: agentDir,
      XDG_RUNTIME_DIR: join(root, 'runtime'),
    };
    const departedServerProcess = {
      pid: 987_654_321,
      execPath: process.execPath,
      versions: process.versions,
      kill(pid, signal) {
        return process.kill(pid, signal);
      },
    };
    const first = createPiSessionDaemonSupervisor({ env, cwd, port: 3000, version: '1.0.0', processLike: departedServerProcess });
    const upgraded = createPiSessionDaemonSupervisor({ env, cwd, port: 3000, version: '2.0.0' });
    try {
      await first.start();
      const firstState = JSON.parse(await readFile(first.paths.stateFile, 'utf8'));
      await expect(upgraded.start()).resolves.toMatchObject({ state: 'ready', reused: false });
      await waitForExit(firstState.pid);
      const upgradedState = JSON.parse(await readFile(upgraded.paths.stateFile, 'utf8'));
      expect(upgradedState.pid).not.toBe(firstState.pid);
      expect(upgradedState.buildId).toBe('2.0.0');
    } finally {
      await first.stop().catch(() => {});
      await upgraded.stop().catch(() => {});
    }
  }, 60_000);

  it('refuses a stale same-profile server stop after a newer instance claims the daemon', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-supervisor-claim-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    const env = {
      ...process.env,
      PI_OFFLINE: '1',
      PICHAMBER_DATA_DIR: join(root, 'data'),
      PICHAMBER_PI_AGENT_DIR: agentDir,
      XDG_RUNTIME_DIR: join(root, 'runtime'),
    };

    const departedServerProcess = {
      pid: 987_654_321,
      execPath: process.execPath,
      versions: process.versions,
      kill(pid, signal) {
        return process.kill(pid, signal);
      },
    };
    const first = createPiSessionDaemonSupervisor({ env, cwd, port: 3000, processLike: departedServerProcess });
    const second = createPiSessionDaemonSupervisor({ env, cwd, port: 3000 });
    try {
      await first.start();
      const firstState = JSON.parse(await readFile(first.paths.stateFile, 'utf8'));

      // A restarted server on the same profile claims the live daemon.
      await expect(second.start()).resolves.toMatchObject({ state: 'ready', reused: true });
      const claimedState = JSON.parse(await readFile(second.paths.stateFile, 'utf8'));
      expect(claimedState.pid).toBe(firstState.pid);
      expect(claimedState.serverInstanceId).toBe(second.paths.serverInstanceId);

      // The stale first server must not terminate the claimed daemon.
      await expect(first.stop()).rejects.toMatchObject({ code: 'DAEMON_OWNERSHIP_MISMATCH' });
      await expect(second.health()).resolves.toMatchObject({ state: 'ready' });
      await expect(second.stop()).resolves.toEqual({ state: 'stopped' });
    } finally {
      await first.stop().catch(() => {});
      await second.stop().catch(() => {});
    }
  }, 60_000);
});
