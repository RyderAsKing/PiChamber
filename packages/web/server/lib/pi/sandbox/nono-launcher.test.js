import { describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNonoLauncher, NONO_PROFILE_FILE } from './nono-launcher.js';

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

  it('reports macOS, Windows and WSL2 as UNSUPPORTED_PLATFORM without running nono', async () => {
    const command = await writeFakeNono({ setupOutput: LANDLOCK_OK });
    for (const platform of ['darwin', 'win32']) {
      const launcher = createNonoLauncher({ command, platform, readProcVersion: async () => '' });
      await expect(launcher.probe()).resolves.toEqual({ available: false, code: 'UNSUPPORTED_PLATFORM' });
    }
    const wsl = createNonoLauncher({
      command,
      platform: 'linux',
      readProcVersion: async () => 'Linux version 6.6.87.2-microsoft-standard-WSL2',
    });
    await expect(wsl.probe()).resolves.toEqual({ available: false, code: 'UNSUPPORTED_PLATFORM' });
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
});
