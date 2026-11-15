import assert from 'node:assert/strict';
import test from 'node:test';

import { installLinuxPackageUpdate } from './linux-package-update.mjs';

test('keeps the Electron event loop available during a privileged Linux package install', async () => {
  const commands = [];
  let heartbeat = false;

  const installation = installLinuxPackageUpdate({
    packageType: 'deb',
    installerPath: '/tmp/PiChamber-update.deb',
    isRoot: false,
    commandExists: async (command) => command === 'dpkg' || command === 'pkexec',
    runCommand: async (command, args) => {
      commands.push({ command, args });
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { code: 0, signal: null };
    },
  });

  setTimeout(() => {
    heartbeat = true;
  }, 5);

  await installation;

  assert.equal(heartbeat, true);
  assert.deepEqual(commands, [
    {
      command: 'pkexec',
      args: ['--disable-internal-agent', 'dpkg', '-i', '/tmp/PiChamber-update.deb'],
    },
  ]);
});

test('repairs a failed dpkg configuration asynchronously', async () => {
  const commands = [];
  const result = await installLinuxPackageUpdate({
    packageType: 'deb',
    installerPath: '/tmp/PiChamber update.deb',
    isRoot: true,
    commandExists: async (command) => command === 'dpkg',
    runCommand: async (command, args) => {
      commands.push({ command, args });
      return commands.length === 1 ? { code: 1, signal: null } : { code: 0, signal: null };
    },
  });

  assert.deepEqual(result, { packageManager: 'dpkg', repaired: true });
  assert.deepEqual(commands, [
    { command: 'dpkg', args: ['-i', '/tmp/PiChamber update.deb'] },
    { command: 'apt-get', args: ['install', '-f', '-y'] },
  ]);
});

test('installs a pacman update with pacman -U through the elevation helper', async () => {
  const commands = [];
  const result = await installLinuxPackageUpdate({
    packageType: 'pacman',
    installerPath: '/tmp/PiChamber-1.0.8-linux-x64.pacman',
    isRoot: false,
    commandExists: async (command) => command === 'pacman' || command === 'pkexec',
    runCommand: async (command, args) => {
      commands.push({ command, args });
      return { code: 0, signal: null };
    },
  });

  assert.equal(result.packageManager, 'pacman');
  assert.deepEqual(commands, [
    {
      command: 'pkexec',
      args: ['--disable-internal-agent', 'pacman', '-U', '--noconfirm', '/tmp/PiChamber-1.0.8-linux-x64.pacman'],
    },
  ]);
});

test('restores paths escaped by electron-updater', async () => {
  const { unescapeUpdaterInstallerPath } = await import('./linux-package-update.mjs');
  assert.equal(
    unescapeUpdaterInstallerPath('/home/ryder/My\\ App/updates/PiChamber\\ 0.9.3.deb'),
    '/home/ryder/My App/updates/PiChamber 0.9.3.deb',
  );
});
