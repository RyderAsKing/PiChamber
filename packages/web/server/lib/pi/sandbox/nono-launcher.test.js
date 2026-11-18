import { describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNonoLauncher, NONO_PROFILE_FILE, NONO_PROFILE_FILES } from './nono-launcher.js';

// A fake `nono` that answers `--version` and `setup --check-only` the way the
// real binary does (output captured from nono 0.82.0 on a Landlock V6 kernel
// and on this repo's no-Landlock development container).
const writeFakeNono = async ({ version = 'nono 0.82.0', versionCode = 0, setupOutput, setupCode = 0 }) => {
  const dir = await mkdtemp(join(tmpdir(), 'pichamber-fake-nono-'));
  const file = join(dir, 'nono');
  await writeFile(file, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    `  printf '%s\\n' '${version}'`,
    `  exit ${versionCode}`,
    'fi',
    'if [ "$1" = "setup" ] && [ "$2" = "--check-only" ]; then',
    `  printf '%s\\n' '${setupOutput.replace(/'/g, '')}'`,
    `  exit ${setupCode}`,
    'fi',
    'exit 64',
    '',
  ].join('\n'));
  await chmod(file, 0o755);
  return file;
};

const LANDLOCK_OK = [
  '[2/4] Testing sandbox support...',
  '  * Landlock enabled (syscall probe)',
  '  * Landlock V6',
].join('\n');

const NO_LANDLOCK = 'nono: Setup error: Landlock is not available: Sandbox initialization failed: No supported Landlock ABI detected';

describe('nono launcher probe', () => {
  it('reports an installed nono on a Landlock kernel as available with its version and ABI', async () => {
    const command = await writeFakeNono({ setupOutput: LANDLOCK_OK });
    const launcher = createNonoLauncher({ command, platform: 'linux', readProcVersion: async () => 'Linux version 6.12.0' });
    await expect(launcher.probe()).resolves.toEqual({
      available: true,
      version: '0.82.0',
      capabilities: ['landlock-abi-6'],
    });
  });

  it('maps a missing binary to NOT_INSTALLED', async () => {
    const launcher = createNonoLauncher({ command: join(tmpdir(), 'pichamber-no-such-nono', 'nono'), platform: 'linux', readProcVersion: async () => '' });
    await expect(launcher.probe()).resolves.toEqual({ available: false, code: 'NOT_INSTALLED' });
  });

  it('maps a version below 0.82.0 to TOO_OLD', async () => {
    const command = await writeFakeNono({ version: 'nono 0.81.9', setupOutput: LANDLOCK_OK });
    const launcher = createNonoLauncher({ command, platform: 'linux', readProcVersion: async () => '' });
    await expect(launcher.probe()).resolves.toEqual({ available: false, code: 'TOO_OLD' });
  });

  it('maps a kernel without Landlock to NO_LANDLOCK', async () => {
    const command = await writeFakeNono({ setupOutput: NO_LANDLOCK, setupCode: 1 });
    const launcher = createNonoLauncher({ command, platform: 'linux', readProcVersion: async () => '' });
    await expect(launcher.probe()).resolves.toEqual({ available: false, code: 'NO_LANDLOCK' });
  });

  it('maps any other failed setup check to SETUP_CHECK_FAILED', async () => {
    const command = await writeFakeNono({ setupOutput: 'nono: something else went wrong', setupCode: 2 });
    const launcher = createNonoLauncher({ command, platform: 'linux', readProcVersion: async () => '' });
    await expect(launcher.probe()).resolves.toEqual({ available: false, code: 'SETUP_CHECK_FAILED' });
  });

  it('maps unreadable version output to VERSION_UNKNOWN', async () => {
    const command = await writeFakeNono({ version: 'garbage', setupOutput: LANDLOCK_OK });
    const launcher = createNonoLauncher({ command, platform: 'linux', readProcVersion: async () => '' });
    await expect(launcher.probe()).resolves.toEqual({ available: false, code: 'VERSION_UNKNOWN' });
  });

  it('reports Windows as UNSUPPORTED_PLATFORM without running nono', async () => {
    const command = await writeFakeNono({ setupOutput: LANDLOCK_OK });
    const launcher = createNonoLauncher({ command, platform: 'win32', readProcVersion: async () => '' });
    await expect(launcher.probe()).resolves.toEqual({ available: false, code: 'UNSUPPORTED_PLATFORM' });
  });
});

const WSL_KERNEL = 'Linux version 6.18.33.2-microsoft-standard-WSL2';
// The lines nono 0.82.0 prints on macOS (`test_macos_seatbelt` in its setup.rs).
const SEATBELT_OK = [
  '[2/4] Testing sandbox support...',
  '  * macOS version: 15.5',
  '  * Seatbelt sandbox support verified',
  '  * File access restrictions: OK',
].join('\n');

const profileArg = async (launcher) => {
  const { args } = await launcher.prepare({ argv: ['node'], grants: [], network: { mode: 'none' }, tmpDir: '/tmp/x' });
  return args[args.indexOf('--profile') + 1];
};

describe('nono launcher on WSL2', () => {
  it('runs with the WSL2 profile and reports its Unix socket and proxy port limits', async () => {
    const command = await writeFakeNono({ setupOutput: LANDLOCK_OK });
    const launcher = createNonoLauncher({ command, platform: 'linux', readProcVersion: async () => WSL_KERNEL });
    await expect(launcher.probe()).resolves.toEqual({
      available: true,
      version: '0.82.0',
      capabilities: ['landlock-abi-6'],
      limits: ['UNIX_SOCKETS', 'PROXY_PORT'],
    });
    await expect(profileArg(launcher)).resolves.toBe(NONO_PROFILE_FILES.wsl2);
  });

  it('maps a WSL2 kernel without Landlock TCP rules (below V4) to WSL_KERNEL_TOO_OLD', async () => {
    const command = await writeFakeNono({ setupOutput: '  * Landlock enabled (syscall probe)\n  * Landlock V3' });
    const launcher = createNonoLauncher({ command, platform: 'linux', readProcVersion: async () => 'Linux version 6.6.87.2-microsoft-standard-WSL2' });
    await expect(launcher.probe()).resolves.toEqual({ available: false, code: 'WSL_KERNEL_TOO_OLD' });
  });

  it('keeps AF_UNIX mediation in the Linux profile and leaves it out only for WSL2', async () => {
    const linux = JSON.parse(await readFile(NONO_PROFILE_FILES.linux, 'utf8'));
    const wsl2 = JSON.parse(await readFile(NONO_PROFILE_FILES.wsl2, 'utf8'));
    expect(linux.linux).toEqual({ af_unix_mediation: 'pathname' });
    const { linux: _mediation, ...linuxWithoutMediation } = linux;
    expect(wsl2).toEqual(linuxWithoutMediation);
  });
});

describe('nono launcher on macOS', () => {
  it('reports a verified Seatbelt sandbox as available and runs with the macOS profile', async () => {
    const command = await writeFakeNono({ setupOutput: SEATBELT_OK });
    const launcher = createNonoLauncher({ command, platform: 'darwin' });
    await expect(launcher.probe()).resolves.toEqual({ available: true, version: '0.82.0', capabilities: ['seatbelt'] });
    await expect(profileArg(launcher)).resolves.toBe(NONO_PROFILE_FILES.macos);
  });

  it('maps a failed or unverified Seatbelt check to SETUP_CHECK_FAILED', async () => {
    for (const run of [
      { setupOutput: 'Seatbelt sandbox test failed. This may indicate a system configuration issue.', setupCode: 1 },
      { setupOutput: '  * macOS version: 15.5', setupCode: 0 },
    ]) {
      const launcher = createNonoLauncher({ command: await writeFakeNono(run), platform: 'darwin' });
      await expect(launcher.probe()).resolves.toEqual({ available: false, code: 'SETUP_CHECK_FAILED' });
    }
  });

  it('keeps temp folders out of the macOS profile, as the Linux one does', async () => {
    const macos = JSON.parse(await readFile(NONO_PROFILE_FILES.macos, 'utf8'));
    // system_write_macos would grant all of /tmp and /var/folders.
    expect(macos.groups.exclude).toEqual(['system_write_macos']);
    expect(macos.workdir).toEqual({ access: 'none' });
    expect(macos.security).toEqual({ signal_mode: 'isolated', capability_elevation: false });
  });

  it('grants local ports with --open-port, since nono refuses --allow-connect-port on macOS', async () => {
    const launcher = createNonoLauncher({ command: await writeFakeNono({ setupOutput: SEATBELT_OK }), platform: 'darwin' });
    await launcher.probe();
    const networkArgs = async (network) => {
      const { args } = await launcher.prepare({ argv: ['node'], grants: [], network, tmpDir: '/tmp/x' });
      return args.slice(args.indexOf('--no-diagnostics') + 1, args.indexOf('--'));
    };
    await expect(networkArgs({ mode: 'proxy', allowHosts: ['github.com'], allowLocalPorts: [8080] }))
      .resolves.toEqual(['--allow-domain', 'github.com', '--open-port', '8080']);
    // Blocked mode keeps the localhost port rules, so ports alone stay blocked otherwise.
    await expect(networkArgs({ mode: 'proxy', allowHosts: [], allowLocalPorts: [8080] }))
      .resolves.toEqual(['--block-net', '--open-port', '8080']);
    await expect(networkArgs({ mode: 'proxy', allowHosts: [], allowLocalPorts: [] })).resolves.toEqual(['--block-net']);
    await expect(networkArgs({ mode: 'proxy', allowHosts: [], allowLocalPorts: [443] })).rejects.toMatchObject({ code: 'SANDBOX_PORT_REFUSED' });
  });

  it('gives the same request a different identity on each host kind', async () => {
    const request = { grants: [], network: { mode: 'none' } };
    const linux = createNonoLauncher({ command: await writeFakeNono({ setupOutput: LANDLOCK_OK }), platform: 'linux', readProcVersion: async () => '' });
    const macos = createNonoLauncher({ command: await writeFakeNono({ setupOutput: SEATBELT_OK }), platform: 'darwin' });
    await linux.probe();
    await macos.probe();
    expect(linux.identity(request)).not.toBe(macos.identity(request));
  });
});

describe('nono launcher profile file', () => {
  // A packaged desktop app keeps the server package inside app.asar. Electron
  // reads files there, but nono is a separate binary and cannot, so the
  // profile is copied to a real file before launch.
  it('copies a profile that sits inside an asar archive to a real file nono can read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-nono-asar-'));
    const packaged = join(root, 'resources', 'app.asar', 'node_modules', '@pi-chamber', 'web', 'server', 'lib', 'pi', 'sandbox');
    await mkdir(packaged, { recursive: true });
    const profileFile = join(packaged, 'nono-profile.json');
    const policy = await readFile(NONO_PROFILE_FILE, 'utf8');
    await writeFile(profileFile, policy);
    const stageDir = join(root, 'data', 'pi', 'sandbox');
    const command = await writeFakeNono({ setupOutput: LANDLOCK_OK });
    const launcher = createNonoLauncher({ command, platform: 'linux', readProcVersion: async () => '', profileFile, stageDir });
    await launcher.probe();

    const { args } = await launcher.prepare({ argv: ['node', 'daemon.js'], grants: [], network: { mode: 'none' }, tmpDir: '/tmp/x' });
    const staged = args[args.indexOf('--profile') + 1];
    expect(staged.startsWith(`${stageDir}/`)).toBe(true);
    expect(staged).not.toMatch(/\.asar/);
    await expect(readFile(staged, 'utf8')).resolves.toBe(policy);
    expect((await stat(staged)).mode & 0o777).toBe(0o600);
  });

  it('passes a profile outside any archive unchanged', async () => {
    const command = await writeFakeNono({ setupOutput: LANDLOCK_OK });
    const stageDir = join(await mkdtemp(join(tmpdir(), 'pichamber-nono-stage-')), 'sandbox');
    const launcher = createNonoLauncher({ command, platform: 'linux', readProcVersion: async () => '', stageDir });
    await launcher.probe();
    const { args } = await launcher.prepare({ argv: ['node'], grants: [], network: { mode: 'none' }, tmpDir: '/tmp/x' });
    expect(args[args.indexOf('--profile') + 1]).toBe(NONO_PROFILE_FILE);
  });
  it('points tool caches at the sandbox cache folder, over anything inherited', async () => {
    const command = await writeFakeNono({ setupOutput: LANDLOCK_OK });
    const stageDir = join(await mkdtemp(join(tmpdir(), 'pichamber-nono-stage-')), 'sandbox');
    const launcher = createNonoLauncher({ command, platform: 'linux', readProcVersion: async () => '', stageDir });
    await launcher.probe();
    const { env } = await launcher.prepare({
      argv: ['node'],
      env: { XDG_CACHE_HOME: '/home/u/.cache', npm_config_cache: '/home/u/.npm', KEEP: '1' },
      grants: [],
      network: { mode: 'none' },
      tmpDir: '/data/sandbox/k/tmp',
      cacheDir: '/data/sandbox/k/cache',
    });
    expect(env).toMatchObject({
      KEEP: '1',
      TMPDIR: '/data/sandbox/k/tmp',
      XDG_CACHE_HOME: '/data/sandbox/k/cache',
      npm_config_cache: '/data/sandbox/k/cache/npm',
      PIP_CACHE_DIR: '/data/sandbox/k/cache/pip',
      UV_CACHE_DIR: '/data/sandbox/k/cache/uv',
      PLAYWRIGHT_BROWSERS_PATH: '/data/sandbox/k/cache/ms-playwright',
    });
    await expect(launcher.prepare({ argv: ['node'], grants: [], network: { mode: 'none' }, tmpDir: '/tmp/x', cacheDir: 'cache' }))
      .rejects.toMatchObject({ code: 'SANDBOX_INVALID_GRANT' });
  });

  // What is cached in the user's cache folders is run later by tools outside
  // the sandbox, and a pseudo-terminal the sandbox can write belongs to
  // someone's shell. No profile may grant either.
  it('grants no user cache folder and no writable pseudo-terminals in any profile', async () => {
    for (const file of Object.values(NONO_PROFILE_FILES)) {
      const profile = JSON.parse(await readFile(file, 'utf8'));
      const groups = profile.groups.include.map((group) => (typeof group === 'string' ? group : group.name));
      expect(groups.filter((name) => /cache/i.test(name))).toEqual([]);
      const paths = [...(profile.filesystem.allow ?? []), ...(profile.filesystem.allow_file ?? [])];
      expect(paths.filter((path) => /^\/dev\/(pts|ptmx)/.test(path) || /cache/i.test(path))).toEqual([]);
    }
  });
});

// A fake `nono` that also answers `profile validate --json <file>` the way
// nono 0.82.0 does: a JSON report on stdout, exit 1 when not valid. A profile
// naming `nope_group` is the invalid one.
const writeValidatingNono = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pichamber-fake-nono-'));
  const file = join(dir, 'nono');
  await writeFile(file, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "nono 0.82.0"; exit 0; fi',
    'if [ "$1" = "setup" ]; then echo "  * Landlock V6"; exit 0; fi',
    'if [ "$1" = "profile" ] && [ "$2" = "validate" ]; then',
    '  if grep -q nope_group "$4"; then',
    '    printf \'{"file":"%s","valid":false,"errors":["Group nope_group not found in %s"],"warnings":[]}\\n\' "$4" "$4"',
    '    echo "nono: Profile parse error: validation failed" >&2',
    '    exit 1',
    '  fi',
    '  printf \'{"file":"%s","valid":true,"errors":[],"warnings":[]}\\n\' "$4"',
    '  exit 0',
    'fi',
    'exit 64',
    '',
  ].join('\n'));
  await chmod(file, 0o755);
  return file;
};

describe('nono launcher custom profile', () => {
  const request = { grants: [], network: { mode: 'none' } };
  const prepareArgs = { argv: ['node'], grants: [], network: { mode: 'none' }, tmpDir: '/tmp/x' };
  const build = async ({ command } = {}) => {
    const dir = await mkdtemp(join(tmpdir(), 'pichamber-nono-custom-'));
    const customProfileFile = join(dir, 'sandbox', 'nono-profile.custom.json');
    const launcher = createNonoLauncher({
      command: command ?? await writeValidatingNono(),
      platform: 'linux',
      readProcVersion: async () => 'Linux version 6.12.0',
      customProfileFile,
    });
    return { dir, customProfileFile, launcher };
  };

  it('reports the built-in profile of this host kind until a custom one is saved', async () => {
    const { launcher, customProfileFile } = await build();
    const profile = await launcher.profile();
    expect(profile).toMatchObject({ hostKind: 'linux', custom: false, path: NONO_PROFILE_FILE, builtInPath: NONO_PROFILE_FILE, customPath: customProfileFile });
    expect(profile.content).toBe(await readFile(NONO_PROFILE_FILE, 'utf8'));
  });

  it('has no profile on a platform nono does not run on', async () => {
    const launcher = createNonoLauncher({ platform: 'win32', customProfileFile: '/nowhere/custom.json' });
    expect(await launcher.profile()).toBeNull();
  });

  it('uses a saved custom profile for launches, with its own identity, and the built-in one again after a reset', async () => {
    const { launcher, customProfileFile, dir } = await build();
    await launcher.probe();
    const builtIn = launcher.identity(request);
    const content = await readFile(NONO_PROFILE_FILE, 'utf8');
    const saved = await launcher.saveProfile(content);
    expect(saved).toMatchObject({ custom: true, path: customProfileFile, content });
    expect((await stat(customProfileFile)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(dir, 'sandbox'))).toEqual(['nono-profile.custom.json']);
    // The same text as the built-in profile is still a different identity:
    // a daemon started under one never passes for the other.
    expect(launcher.identity(request)).not.toBe(builtIn);
    const { args } = await launcher.prepare(prepareArgs);
    expect(args[args.indexOf('--profile') + 1]).toBe(customProfileFile);

    expect(await launcher.resetProfile()).toMatchObject({ custom: false, path: NONO_PROFILE_FILE });
    expect(launcher.identity(request)).toBe(builtIn);
    const again = await launcher.prepare(prepareArgs);
    expect(again.args[again.args.indexOf('--profile') + 1]).toBe(NONO_PROFILE_FILE);
  });

  it('refuses text that is not a JSON object or that nono does not accept, and keeps the profile it had', async () => {
    const { launcher, customProfileFile, dir } = await build();
    await expect(launcher.saveProfile('')).rejects.toMatchObject({ code: 'INVALID_SANDBOX_PROFILE' });
    await expect(launcher.saveProfile('{ nope')).rejects.toMatchObject({ code: 'INVALID_SANDBOX_PROFILE' });
    await expect(launcher.saveProfile('[]')).rejects.toMatchObject({ code: 'INVALID_SANDBOX_PROFILE', messages: ['The profile must be a JSON object.'] });
    await expect(launcher.saveProfile(JSON.stringify({ pad: 'x'.repeat(70 * 1024) }))).rejects.toMatchObject({ code: 'INVALID_SANDBOX_PROFILE' });
    await launcher.saveProfile('{"extends":"default"}');
    const refused = await launcher.saveProfile('{"groups":{"include":["nope_group"]}}').catch((error) => error);
    expect(refused).toMatchObject({ code: 'INVALID_SANDBOX_PROFILE' });
    // nono's message, without the temporary file it checked.
    expect(refused.messages).toEqual(['Group nope_group not found in the profile']);
    expect(await readFile(customProfileFile, 'utf8')).toBe('{"extends":"default"}');
    expect(await readdir(join(dir, 'sandbox'))).toEqual(['nono-profile.custom.json']);
  });

  it('saves on a JSON check alone when nono is not installed', async () => {
    const { launcher, customProfileFile } = await build({ command: join(tmpdir(), 'pichamber-no-such-nono', 'nono') });
    await launcher.saveProfile('{"groups":{"include":["nope_group"]}}');
    expect(await readFile(customProfileFile, 'utf8')).toContain('nope_group');
  });

  it('fails a launch closed when a custom profile edited on disk is not one nono accepts', async () => {
    const { launcher, customProfileFile } = await build();
    await launcher.probe();
    await mkdir(join(customProfileFile, '..'), { recursive: true });
    await writeFile(customProfileFile, '{"groups":{"include":["nope_group"]}}');
    await expect(launcher.prepare(prepareArgs)).rejects.toMatchObject({ code: 'SANDBOX_PROFILE_INVALID' });
    await writeFile(customProfileFile, 'not json');
    await expect(launcher.prepare(prepareArgs)).rejects.toMatchObject({ code: 'SANDBOX_PROFILE_INVALID' });
    await writeFile(customProfileFile, '{"extends":"default"}');
    const { args } = await launcher.prepare(prepareArgs);
    expect(args[args.indexOf('--profile') + 1]).toBe(customProfileFile);
  });

  it('never follows a symlink at the custom profile, and does not fall back to the built-in one', async () => {
    const { launcher, customProfileFile } = await build();
    await launcher.probe();
    await mkdir(join(customProfileFile, '..'), { recursive: true });
    await symlink(NONO_PROFILE_FILE, customProfileFile);
    expect(() => launcher.identity(request)).toThrow(expect.objectContaining({ code: 'SANDBOX_PROFILE_INVALID' }));
    await expect(launcher.prepare(prepareArgs)).rejects.toMatchObject({ code: 'SANDBOX_PROFILE_INVALID' });
    expect(await launcher.profile()).toMatchObject({ custom: true, unreadable: true, content: '' });
    expect(await launcher.resetProfile()).toMatchObject({ custom: false });
    expect(await readFile(NONO_PROFILE_FILE, 'utf8')).toContain('pichamber');
  });
});
