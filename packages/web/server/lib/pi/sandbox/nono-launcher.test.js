import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNonoLauncher } from './nono-launcher.js';

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
