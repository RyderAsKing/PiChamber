import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
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

  it('recovers from a forced daemon crash only after verifying the stale socket is unreachable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-supervisor-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    const env = {
      ...process.env,
      PI_OFFLINE: '1',
      OPENCHAMBER_DATA_DIR: join(root, 'data'),
      OPENCHAMBER_PI_AGENT_DIR: agentDir,
      XDG_RUNTIME_DIR: join(root, 'runtime'),
    };

    supervisor = createPiSessionDaemonSupervisor({ env, cwd });
    await supervisor.start();
    const state = JSON.parse(await readFile(supervisor.paths.stateFile, 'utf8'));
    process.kill(state.pid, 'SIGKILL');
    await waitForExit(state.pid);

    await expect(supervisor.health()).resolves.toMatchObject({
      state: 'unavailable',
      error: { code: 'DAEMON_UNAVAILABLE' },
    });
    await expect(supervisor.start()).resolves.toMatchObject({ state: 'ready', reused: false });
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
      OPENCHAMBER_DATA_DIR: join(root, 'data'),
      OPENCHAMBER_PI_AGENT_DIR: agentDir,
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
      OPENCHAMBER_DATA_DIR: join(root, 'data'),
      OPENCHAMBER_PI_AGENT_DIR: agentDir,
      XDG_RUNTIME_DIR: join(root, 'runtime'),
    };

    supervisor = createPiSessionDaemonSupervisor({ env, cwd });
    await expect(supervisor.start()).resolves.toMatchObject({ state: 'ready', reused: false, protocolVersion: 1 });
    await expect(supervisor.start()).resolves.toMatchObject({ state: 'ready', reused: true, protocolVersion: 1 });
    await expect(supervisor.health()).resolves.toEqual({
      state: 'ready',
      protocolVersion: 1,
      capabilities: ['projects.list', 'projects.select', 'sessions.list', 'sessions.create', 'sessions.open', 'sessions.rename', 'sessions.delete', 'sessions.tree', 'sessions.navigate', 'sessions.fork', 'sessions.clone', 'sessions.prompt', 'sessions.steer', 'sessions.followUp', 'sessions.abort', 'sessions.setModel', 'sessions.setThinking', 'sessions.compact'],
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
});
