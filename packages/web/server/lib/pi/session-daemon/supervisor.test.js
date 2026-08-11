import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPiSessionDaemonSupervisor } from './supervisor.js';

describe('Pi session daemon supervisor', () => {
  let supervisor;

  afterEach(async () => {
    await supervisor?.stop().catch(() => {});
    supervisor = undefined;
  });

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
    await expect(supervisor.health()).resolves.toEqual({ state: 'ready', protocolVersion: 1, capabilities: [] });

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
