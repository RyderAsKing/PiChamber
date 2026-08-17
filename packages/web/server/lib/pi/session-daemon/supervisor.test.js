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
      capabilities: expect.arrayContaining(['projects.list', 'projects.select', 'sessions.list', 'sessions.create', 'sessions.open', 'sessions.rename', 'sessions.delete', 'sessions.tree', 'sessions.navigate', 'sessions.fork', 'sessions.clone', 'sessions.prompt', 'sessions.steer', 'sessions.followUp', 'sessions.abort', 'sessions.setModel', 'sessions.setThinking', 'sessions.compact', 'providers.list', 'providers.config.get', 'providers.models.set', 'providers.status', 'providers.login', 'providers.login.respond', 'providers.login.status', 'providers.logout', 'settings.get', 'settings.set', 'resources.list', 'resources.update', 'resources.prompts.create', 'resources.prompts.delete']),
    });
    await expect(supervisor.request('sessions.list')).resolves.toMatchObject({ sessions: expect.any(Array) });

    const credential = await readFile(supervisor.paths.credentialFile, 'utf8');
    expect(credential.trim()).toHaveLength(64);
    expect((await stat(supervisor.paths.credentialFile)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(await supervisor.health())).not.toContain(credential.trim());

    await expect(supervisor.stop()).resolves.toEqual({ state: 'stopped' });
    await expect(supervisor.health()).resolves.toMatchObject({
      state: 'unavailable',
      error: { code: 'DAEMON_UNAVAILABLE' },
    });
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

  it('recovers from a leftover empty daemon lock instead of failing as unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-supervisor-empty-lock-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const dataDir = join(root, 'data');
    await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(join(dataDir, 'pi'), { recursive: true })]);
    const lockFile = join(dataDir, 'pi', 'session-daemon.lock');
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
    await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(join(dataDir, 'pi'), { recursive: true })]);
    const lockFile = join(dataDir, 'pi', 'session-daemon.lock');
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
});
