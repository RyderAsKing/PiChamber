import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPiSessionDaemonSupervisor } from '../pi/session-daemon/supervisor.js';
import { createPluginDaemonSync } from './daemon-sync.js';

const waitForExit = async (pid) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
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

describe('plugin push through the daemon supervisor', () => {
  let supervisor;

  afterEach(async () => {
    await supervisor?.stop().catch(() => {});
    supervisor = undefined;
  });

  it('configures a daemon before its first request and again after it restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-plugin-sync-'));
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
    const buildConfig = vi.fn(async () => ({ plugins: [] }));
    const sync = createPluginDaemonSync({ buildConfig, refresh: () => supervisor.health(), logger: { warn: vi.fn() } });
    const onDaemonReady = vi.fn(sync.onDaemonReady);
    supervisor = createPiSessionDaemonSupervisor({ env, cwd, onDaemonReady });

    await supervisor.start();
    await expect(supervisor.request('sessions.list')).resolves.toMatchObject({ sessions: expect.any(Array) });
    expect(buildConfig).toHaveBeenCalledTimes(1);
    await supervisor.request('sessions.list');
    expect(buildConfig).toHaveBeenCalledTimes(1);

    // A change pushes through a health probe.
    sync.changed();
    await vi.waitFor(() => expect(buildConfig).toHaveBeenCalledTimes(2));

    // A new daemon process (new stream epoch) is configured before the request.
    const firstEpoch = onDaemonReady.mock.calls.at(-1)[0].health.streamEpoch;
    const state = JSON.parse(await readFile(supervisor.paths.stateFile, 'utf8'));
    process.kill(state.pid, 'SIGKILL');
    await waitForExit(state.pid);
    await supervisor.request('sessions.list');
    expect(buildConfig).toHaveBeenCalledTimes(3);
    expect(onDaemonReady.mock.calls.at(-1)[0].health.streamEpoch).not.toBe(firstEpoch);
  }, 30_000);

  it('never fails the request when the hook throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-plugin-sync-'));
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
    supervisor = createPiSessionDaemonSupervisor({ env, cwd, onDaemonReady: async () => { throw new Error('hook failed'); } });
    await supervisor.start();
    await expect(supervisor.request('sessions.list')).resolves.toMatchObject({ sessions: expect.any(Array) });
  }, 30_000);
});
