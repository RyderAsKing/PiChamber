import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { createPiDaemonPool } from '../session-daemon/daemon-pool.js';
import { createPiUiSettingsStore } from '../ui-settings-store.js';
import { createProjectSandboxManager } from './project-sandbox-manager.js';

const roots = [];
let manager;
afterEach(async () => {
  await manager?.stop();
  manager = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const isWithin = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
};

const setup = async ({ probe = { available: true, version: '0.82.0' }, corruptSetting = false } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'pichamber-sandbox-git-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  const projectA = join(root, 'code', 'a');
  const projectB = join(root, 'code', 'b');
  const gitId = 'e'.repeat(40);
  const worktree = join(dataDir, 'worktree', gitId, 'feature');
  await Promise.all([mkdir(join(projectA, '.git'), { recursive: true }), mkdir(projectB, { recursive: true }), mkdir(worktree, { recursive: true })]);
  await writeFile(join(projectA, '.git', 'pichamber'), gitId);
  const uiSettingsStore = createPiUiSettingsStore({ file: join(dataDir, 'settings.json') });
  await uiSettingsStore.write({ projects: [{ id: 'proj-a', path: projectA }, { id: 'proj-b', path: projectB }] });
  await uiSettingsStore.setProjectSandbox('proj-a', { mode: 'nono', allowHosts: ['github.com'], allowLocalPorts: [], extraFolders: [] });
  if (corruptSetting) {
    // A hand-edited or damaged host-local file.
    const stored = JSON.parse(await readFile(uiSettingsStore.runtimeFile, 'utf8'));
    stored.projects[0].sandbox.allowHosts = ['not a host'];
    await writeFile(uiSettingsStore.runtimeFile, JSON.stringify(stored));
  }

  const main = { request: async () => ({ hosts: ['api.anthropic.com'] }) };
  const pool = createPiDaemonPool({ getMainRuntime: () => main });
  const prepared = [];
  const launcher = {
    id: 'nono',
    probe: async () => probe,
    prepare: async (request) => {
      prepared.push(request);
      return { command: '/usr/bin/nono', args: ['run', '--', ...request.argv], env: { ...request.env, TMPDIR: request.tmpDir } };
    },
  };
  let supervisorsCreated = 0;
  manager = createProjectSandboxManager({
    daemonPool: pool,
    uiSettingsStore,
    launcher,
    dataDir,
    agentDir: join(root, 'agent'),
    getServerPort: () => 3000,
    setInterval: () => 1,
    clearInterval: () => {},
    createSupervisor: async () => { supervisorsCreated += 1; throw new Error('no daemon for git'); },
  });
  await manager.reconcile();
  return { dataDir, projectA, projectB, worktree, gitId, prepared, supervisorsCreated: () => supervisorsCreated };
};

describe('git launch for sandboxed projects', () => {
  it('gives no launch for an unsandboxed project, so its git is unchanged', async () => {
    const ctx = await setup();
    expect(await manager.gitLaunchFor(ctx.projectB)).toBeNull();
    expect(await manager.gitLaunchFor(join(ctx.projectB, 'src'))).toBeNull();
  });

  it('runs a sandboxed project\'s git through the launcher with the project\'s grants', async () => {
    const ctx = await setup();
    const launch = await manager.gitLaunchFor(join(ctx.projectA, 'src'));
    const result = await launch.prepare({ argv: ['git'], env: { HOME: '/home/u' } });

    expect(result).toMatchObject({ command: '/usr/bin/nono', args: ['run', '--', 'git'] });
    expect(result.env.HOME).toBe('/home/u');
    const [request] = ctx.prepared;
    expect(request.grants).toEqual(expect.arrayContaining([
      { kind: 'readWrite', path: ctx.projectA },
      { kind: 'readWrite', path: join(ctx.dataDir, 'worktree', ctx.gitId) },
    ]));
    // Git reaches only the project's own hosts, never the model providers'.
    expect(request.network).toEqual({ mode: 'proxy', allowHosts: ['github.com'], allowLocalPorts: [] });
    // The wrapper folder is outside everything the sandbox may write.
    for (const grant of request.grants.filter((item) => item.kind === 'readWrite')) {
      expect(isWithin(grant.path, launch.binDir)).toBe(false);
    }
    expect(ctx.supervisorsCreated()).toBe(0);
  });

  it('covers the project\'s managed worktrees', async () => {
    const ctx = await setup();
    const launch = await manager.gitLaunchFor(ctx.worktree);
    expect(launch).not.toBeNull();
  });

  it('fails closed with SANDBOX_UNAVAILABLE when the launcher is unavailable', async () => {
    const ctx = await setup({ probe: { available: false, code: 'NO_LANDLOCK' } });
    await expect(manager.gitLaunchFor(ctx.projectA)).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE', reason: 'NO_LANDLOCK' });
  });

  it('fails closed for an invalid stored setting', async () => {
    const ctx = await setup({ corruptSetting: true });
    await expect(manager.gitLaunchFor(ctx.projectA)).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE', reason: 'INVALID_SANDBOX_SETTING' });
  });
});
