import { describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createNonoLauncher, NONO_PROFILE_FILE } from '../sandbox/nono-launcher.js';
import { prepareProjectSandbox } from '../sandbox/project-sandbox.js';
import { getPiSessionDirectory } from './session-jsonl.js';
import { createPiSessionDaemonSupervisor, createSandboxedPiSessionDaemonSupervisor } from './supervisor.js';

const DAEMON_ENTRYPOINT = fileURLToPath(new URL('./daemon-process.js', import.meta.url));

const writeFakeNono = async (dir, { setupOutput = '  * Landlock V6', setupCode = 0 } = {}) => {
  const file = join(dir, 'nono');
  await writeFile(file, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "nono 0.82.0"; exit 0; fi',
    `if [ "$1" = "setup" ]; then echo "${setupOutput}"; exit ${setupCode}; fi`,
    'exit 64',
    '',
  ].join('\n'));
  await chmod(file, 0o755);
  return file;
};

const refused = async () => {
  const error = new Error('refused');
  error.code = 'DAEMON_CONNECTION_REFUSED';
  throw error;
};

const fakeProcess = {
  execPath: '/opt/node/bin/node',
  pid: process.pid,
  versions: { node: '24.0.0' },
  kill() {
    const error = new Error('ESRCH');
    error.code = 'ESRCH';
    throw error;
  },
};

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'pichamber-sandbox-supervisor-'));
  const dataDir = join(root, 'data');
  const agentDir = join(root, 'home', '.pi', 'agent');
  const project = join(root, 'code', 'projA');
  const projectId = 'a'.repeat(40);
  const worktree = join(dataDir, 'worktree', projectId, 'feature');
  const shared = join(root, 'shared-docs');
  const scratch = join(root, 'scratch');
  await Promise.all([
    mkdir(join(agentDir, 'extensions'), { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(worktree, { recursive: true }),
    mkdir(shared, { recursive: true }),
    mkdir(scratch, { recursive: true }),
  ]);
  await writeFile(join(agentDir, 'settings.json'), '{}');
  await writeFile(join(agentDir, 'auth.json'), '{}');
  const nono = await writeFakeNono(root);
  // Short on purpose: the daemon socket path must fit a Unix socket address.
  const runtime = await mkdtemp('/tmp/pcx-');
  const env = {
    PATH: process.env.PATH,
    PICHAMBER_DATA_DIR: dataDir,
    PICHAMBER_PI_AGENT_DIR: agentDir,
    XDG_RUNTIME_DIR: runtime,
  };
  const sandboxOptions = {
    dataDir,
    agentDir,
    projectRoot: project,
    projectId,
    worktreeDirs: [worktree],
    serverPort: 3000,
    readRoots: ['/opt/node', '/opt/pichamber'],
    extraFolders: [{ path: shared, access: 'read' }, { path: scratch, access: 'readWrite' }],
    allowHosts: ['api.anthropic.com'],
    allowLocalPorts: [8080],
  };
  return { root, runtime, dataDir, agentDir, project, projectId, worktree, shared, scratch, nono, env, sandboxOptions };
};

const startCapturing = async ({ env, nono, sandbox, launcher }) => {
  const spawns = [];
  const supervisor = await createSandboxedPiSessionDaemonSupervisor({
    env,
    port: 3000,
    launcher: launcher ?? createNonoLauncher({ command: nono, platform: 'linux', readProcVersion: async () => '' }),
    sandbox,
    processLike: fakeProcess,
    spawn: (command, args, options) => {
      spawns.push({ command, args, options });
      return { pid: 1, unref() {} };
    },
    wait: async () => {},
    startupTimeoutMs: 50,
    daemonReadyTimeoutMs: 50,
    request: refused,
  });
  await expect(supervisor.start()).rejects.toMatchObject({ code: 'DAEMON_START_TIMEOUT' });
  return { supervisor, spawns };
};

describe('sandboxed Pi session daemon supervisor', () => {
  it('launches the unchanged daemon command inside nono run with the project grants, network and profile', async () => {
    const ctx = await setup();
    const sandbox = await prepareProjectSandbox(ctx.sandboxOptions);
    const { supervisor, spawns } = await startCapturing({ env: ctx.env, nono: ctx.nono, sandbox });

    expect(spawns).toHaveLength(1);
    const [{ command, args, options }] = spawns;
    const { paths } = supervisor;
    const shadow = join(ctx.dataDir, 'pi', 'sandbox', sandbox.projectKey, 'agent');
    const tmp = join(ctx.dataDir, 'pi', 'sandbox', sandbox.projectKey, 'tmp');

    expect(paths.profileKey).toMatch(new RegExp(`^web-p3000-sbx-${sandbox.projectKey}-[0-9a-f]{12}$`));
    expect(paths.profileDir).toBe(join(ctx.dataDir, 'pi', 'daemons', paths.profileKey));
    expect(command).toBe(ctx.nono);
    expect(args).toEqual([
      'run', '-s', '--profile', NONO_PROFILE_FILE, '--no-rollback', '--no-audit', '--no-diagnostics',
      '--read', '/opt/node',
      '--read', '/opt/pichamber',
      '--read', join(ctx.agentDir, 'extensions'),
      '--read', ctx.shared,
      '--read-file', join(ctx.agentDir, 'auth.json'),
      '--read-file', join(ctx.agentDir, 'settings.json'),
      ...[
        ctx.project,
        join(ctx.agentDir, '.pichamber', 'locks', 'sessions'),
        getPiSessionDirectory({ cwd: ctx.project, agentDir: ctx.agentDir }),
        getPiSessionDirectory({ cwd: ctx.worktree, agentDir: ctx.agentDir }),
        join(ctx.dataDir, 'pi', 'daemons', paths.profileKey),
        shadow,
        tmp,
        join(ctx.dataDir, 'worktree', ctx.projectId),
        ctx.scratch,
      ].sort().flatMap((path) => ['--allow', path]),
      '--allow-unix-socket-dir-bind', join(ctx.runtime, 'pichamber', 'pi-daemons', paths.profileKey),
      '--allow-domain', 'api.anthropic.com',
      '--allow-connect-port', '8080',
      '--',
      '/opt/node/bin/node', DAEMON_ENTRYPOINT,
      '--endpoint', join(ctx.runtime, 'pichamber', 'pi-daemons', paths.profileKey, 'daemon.sock'),
      '--credential-file', paths.credentialFile,
      '--state-file', paths.stateFile,
      '--cwd', ctx.project,
      '--profile-key', paths.profileKey,
      '--server-instance-id', paths.serverInstanceId,
      '--server-pid', String(process.pid),
      '--daemon-id', expect.stringMatching(/^[0-9a-f-]{36}$/),
      '--runtime', 'web',
      '--build-id', 'unknown',
      '--agent-dir', shadow,
      // Leases key on the real agent folder, so this daemon and the main
      // daemon exclude each other on the same session.
      '--lease-agent-dir', ctx.agentDir,
      '--open-url-socket', join(ctx.runtime, 'pichamber', 'pi-daemons', paths.profileKey, 'open-url.sock'),
    ]);
    expect(options).toMatchObject({ cwd: ctx.project, detached: true });
    expect(options.env).toMatchObject({
      NONO_NO_SAVE_PROMPT: '1',
      NONO_NO_UPDATE_CHECK: '1',
      TMPDIR: tmp,
      PATH: process.env.PATH,
    });
    expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();

    const profile = JSON.parse(await readFile(NONO_PROFILE_FILE, 'utf8'));
    expect(profile).toMatchObject({
      extends: 'default',
      groups: { exclude: ['system_write_linux'] },
      security: { signal_mode: 'isolated', capability_elevation: false },
      linux: { af_unix_mediation: 'pathname' },
      workdir: { access: 'none' },
    });
  });

  it('builds a shadow agent folder that links to the real Pi config, resources, session and lease folders', async () => {
    const ctx = await setup();
    const sandbox = await prepareProjectSandbox(ctx.sandboxOptions);
    const shadow = sandbox.agentDir;

    await expect(readlink(join(shadow, 'settings.json'))).resolves.toBe(join(ctx.agentDir, 'settings.json'));
    await expect(readlink(join(shadow, 'auth.json'))).resolves.toBe(join(ctx.agentDir, 'auth.json'));
    await expect(readlink(join(shadow, 'extensions'))).resolves.toBe(join(ctx.agentDir, 'extensions'));
    await expect(readlink(join(shadow, 'models.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readlink(getPiSessionDirectory({ cwd: ctx.project, agentDir: shadow })))
      .resolves.toBe(getPiSessionDirectory({ cwd: ctx.project, agentDir: ctx.agentDir }));
    await expect(readlink(getPiSessionDirectory({ cwd: ctx.worktree, agentDir: shadow })))
      .resolves.toBe(getPiSessionDirectory({ cwd: ctx.worktree, agentDir: ctx.agentDir }));
    await expect(readlink(join(shadow, '.pichamber', 'locks', 'sessions')))
      .resolves.toBe(join(ctx.agentDir, '.pichamber', 'locks', 'sessions'));

    // Preparing again (for example after a new worktree) keeps the folder valid.
    await expect(prepareProjectSandbox(ctx.sandboxOptions)).resolves.toMatchObject({ agentDir: shadow });
  });

  it('reuses the profile key for the same launch and uses a new one when the identity changes', async () => {
    const ctx = await setup();
    const first = await startCapturing({ env: ctx.env, nono: ctx.nono, sandbox: await prepareProjectSandbox(ctx.sandboxOptions) });
    const same = await startCapturing({ env: ctx.env, nono: ctx.nono, sandbox: await prepareProjectSandbox(ctx.sandboxOptions) });
    const otherHosts = await startCapturing({
      env: ctx.env,
      nono: ctx.nono,
      sandbox: await prepareProjectSandbox({ ...ctx.sandboxOptions, allowHosts: ['api.openai.com'] }),
    });
    const otherFolders = await startCapturing({
      env: ctx.env,
      nono: ctx.nono,
      sandbox: await prepareProjectSandbox({ ...ctx.sandboxOptions, extraFolders: [] }),
    });

    expect(same.supervisor.paths.profileKey).toBe(first.supervisor.paths.profileKey);
    expect(otherHosts.supervisor.paths.profileKey).not.toBe(first.supervisor.paths.profileKey);
    expect(otherFolders.supervisor.paths.profileKey).not.toBe(first.supervisor.paths.profileKey);
    const prefix = first.supervisor.paths.profileKey.replace(/-[0-9a-f]{12}$/, '');
    expect(otherHosts.supervisor.paths.profileKey.startsWith(prefix)).toBe(true);
  });

  it('refuses ports 80, 443 and the server port, and extra folders over PiChamber data or Pi config', async () => {
    const ctx = await setup();
    for (const port of [80, 443, 3000]) {
      await expect(prepareProjectSandbox({ ...ctx.sandboxOptions, allowLocalPorts: [port] }))
        .rejects.toMatchObject({ code: 'SANDBOX_PORT_REFUSED' });
    }
    for (const path of [ctx.root, ctx.dataDir, join(ctx.dataDir, 'pi'), ctx.agentDir, join(ctx.agentDir, 'extensions')]) {
      await expect(prepareProjectSandbox({ ...ctx.sandboxOptions, extraFolders: [{ path, access: 'read' }] }))
        .rejects.toMatchObject({ code: 'SANDBOX_GRANT_REFUSED' });
    }
  });

  it('refuses an extra folder that reaches PiChamber data or Pi config through a symlink', async () => {
    const ctx = await setup();
    const toData = join(ctx.root, 'code', 'projA', 'shared');
    const toAgent = join(ctx.root, 'alias-agent');
    await symlink(ctx.dataDir, toData);
    await symlink(join(ctx.agentDir, 'extensions'), toAgent);
    for (const path of [toData, toAgent]) {
      await expect(prepareProjectSandbox({ ...ctx.sandboxOptions, extraFolders: [{ path, access: 'read' }] }))
        .rejects.toMatchObject({ code: 'SANDBOX_GRANT_REFUSED' });
    }
  });

  it('refuses a project folder that holds or sits inside PiChamber data or Pi config, except a PiChamber worktree', async () => {
    const ctx = await setup();
    const alias = join(ctx.root, 'alias-root');
    await symlink(ctx.root, alias);
    for (const projectRoot of [ctx.root, alias, join(ctx.root, 'home'), ctx.dataDir, join(ctx.dataDir, 'pi'), join(ctx.agentDir, 'extensions')]) {
      await expect(prepareProjectSandbox({ ...ctx.sandboxOptions, projectRoot }))
        .rejects.toMatchObject({ code: 'SANDBOX_GRANT_REFUSED' });
    }
    await expect(prepareProjectSandbox({ ...ctx.sandboxOptions, projectRoot: ctx.worktree })).resolves.toMatchObject({ cwd: ctx.worktree });
  });

  it('fails closed with the launcher reason and never spawns when nono cannot sandbox', async () => {
    const ctx = await setup();
    const nono = await writeFakeNono(join(ctx.root, 'code'), {
      setupOutput: 'nono: Setup error: Landlock is not available: Sandbox initialization failed',
      setupCode: 1,
    });
    let spawned = false;
    await expect(createSandboxedPiSessionDaemonSupervisor({
      env: ctx.env,
      port: 3000,
      launcher: createNonoLauncher({ command: nono, platform: 'linux', readProcVersion: async () => '' }),
      sandbox: await prepareProjectSandbox(ctx.sandboxOptions),
      processLike: fakeProcess,
      spawn: () => {
        spawned = true;
        return { pid: 1, unref() {} };
      },
    })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE', reason: 'NO_LANDLOCK' });
    expect(spawned).toBe(false);
  });

  it('refuses a sandbox whose daemon socket path would not fit a Unix socket address', async () => {
    const ctx = await setup();
    let spawned = false;
    await expect(createSandboxedPiSessionDaemonSupervisor({
      env: { ...ctx.env, XDG_RUNTIME_DIR: join(ctx.root, 'r'.repeat(60)) },
      port: 3000,
      launcher: createNonoLauncher({ command: ctx.nono, platform: 'linux', readProcVersion: async () => '' }),
      sandbox: await prepareProjectSandbox(ctx.sandboxOptions),
      processLike: fakeProcess,
      spawn: () => {
        spawned = true;
        return { pid: 1, unref() {} };
      },
    })).rejects.toMatchObject({ code: 'SANDBOX_ENDPOINT_TOO_LONG' });
    expect(spawned).toBe(false);
  });

  it('keeps the unsandboxed launch as the plain daemon command', async () => {
    const ctx = await setup();
    const spawns = [];
    const supervisor = createPiSessionDaemonSupervisor({
      env: ctx.env,
      cwd: ctx.project,
      port: 3000,
      processLike: fakeProcess,
      spawn: (command, args, options) => {
        spawns.push({ command, args, options });
        return { pid: 1, unref() {} };
      },
      wait: async () => {},
      startupTimeoutMs: 50,
      daemonReadyTimeoutMs: 50,
      request: refused,
    });
    await expect(supervisor.start()).rejects.toMatchObject({ code: 'DAEMON_START_TIMEOUT' });
    expect(supervisor.paths.profileKey).toBe('web-p3000');
    expect(spawns[0].command).toBe('/opt/node/bin/node');
    expect(spawns[0].args.slice(0, 3)).toEqual([DAEMON_ENTRYPOINT, '--endpoint', supervisor.paths.endpoint]);
    expect(spawns[0].args).toContain(ctx.agentDir);
    expect(spawns[0].options.env).toEqual(ctx.env);
  });
});
