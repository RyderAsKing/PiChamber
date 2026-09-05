import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { createUpdateCommand } from './commands-update.js';

async function withTempPiChamberDataDir(fn) {
  const previous = process.env.PICHAMBER_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pichamber-update-test-'));
  process.env.PICHAMBER_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (typeof previous === 'string') {
      process.env.PICHAMBER_DATA_DIR = previous;
    } else {
      delete process.env.PICHAMBER_DATA_DIR;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createTestUpdateCommand(overrides = {}) {
  const executeUpdate = overrides.executeUpdate || vi.fn(() => ({ success: true, exitCode: 0 }));
  const getCurrentVersion = overrides.getCurrentVersion || vi.fn()
    .mockReturnValueOnce('1.0.0')
    .mockReturnValue('9.9.9');
  const serveCommand = overrides.serveCommand || vi.fn();
  const restartUserStartupService = overrides.restartUserStartupService || vi.fn();
  const updateCommand = createUpdateCommand({
    packageManagerPath: '/fake/package-manager.js',
    serveCommand,
    isInsideSystemdService: overrides.isInsideSystemdService || (() => false),
    isUserStartupServiceActive: overrides.isUserStartupServiceActive || (() => false),
    restartUserStartupService,
    discoverInstances: overrides.discoverInstances,
    requestShutdown: overrides.requestShutdown,
    stopProcess: overrides.stopProcess,
    importFromFilePath: vi.fn(async () => ({
      checkForUpdates: overrides.checkForUpdates || vi.fn(async () => ({ available: true, version: '9.9.9' })),
      resolveTrustedUpdatePackageManager: overrides.resolveTrustedUpdatePackageManager || vi.fn(() => 'npm'),
      executeUpdate,
      getCurrentVersion,
    })),
  });
  return { updateCommand, executeUpdate, serveCommand, restartUserStartupService };
}

describe('update command', () => {
  it('uses the package-manager helpers on the update-available path', async () => {
    await withTempPiChamberDataDir(async () => {
      const originalWrite = process.stdout.write;
      process.stdout.write = vi.fn(() => true);
      const { updateCommand, executeUpdate } = createTestUpdateCommand();

      try {
        await updateCommand({ json: true });

        expect(executeUpdate).toHaveBeenCalledWith('npm', { silent: true });
      } finally {
        process.stdout.write = originalWrite;
      }
    });
  });

  it('reports the version before and after a successful update', async () => {
    await withTempPiChamberDataDir(async () => {
      const output = [];
      const originalWrite = process.stdout.write;
      process.stdout.write = vi.fn((chunk) => {
        output.push(String(chunk));
        return true;
      });
      const { updateCommand } = createTestUpdateCommand();

      try {
        await updateCommand({ json: true });
        expect(JSON.parse(output.join(''))).toMatchObject({
          status: 'ok',
          previousVersion: '1.0.0',
          currentVersion: '9.9.9',
          latestVersion: '9.9.9',
          versionVerified: true,
          updated: true,
        });
      } finally {
        process.stdout.write = originalWrite;
      }
    });
  });

  it('reports a version mismatch as a warning', async () => {
    await withTempPiChamberDataDir(async () => {
      const output = [];
      const originalWrite = process.stdout.write;
      process.stdout.write = vi.fn((chunk) => {
        output.push(String(chunk));
        return true;
      });
      const { updateCommand } = createTestUpdateCommand({
        getCurrentVersion: vi.fn().mockReturnValueOnce('1.0.0').mockReturnValue('1.0.0'),
      });

      try {
        await updateCommand({ json: true });
        expect(JSON.parse(output.join(''))).toMatchObject({
          status: 'warning',
          previousVersion: '1.0.0',
          currentVersion: '1.0.0',
          versionVerified: false,
        });
      } finally {
        process.stdout.write = originalWrite;
      }
    });
  });

  it('reports partial instance restart failures without losing successful results', async () => {
    await withTempPiChamberDataDir(async (dir) => {
      const firstOptions = path.join(dir, 'first.json');
      const secondOptions = path.join(dir, 'second.json');
      fs.writeFileSync(firstOptions, JSON.stringify({ port: 3001, launchMode: 'daemon', apiOnly: true }));
      fs.writeFileSync(secondOptions, JSON.stringify({ port: 3002, launchMode: 'daemon' }));
      const output = [];
      const originalWrite = process.stdout.write;
      process.stdout.write = vi.fn((chunk) => {
        output.push(String(chunk));
        return true;
      });
      const { updateCommand, serveCommand } = createTestUpdateCommand({
        discoverInstances: async () => [
          { port: 3001, pid: 101, instanceFilePath: firstOptions, pidFilePath: path.join(dir, 'first.pid') },
          { port: 3002, pid: 102, instanceFilePath: secondOptions, pidFilePath: path.join(dir, 'second.pid') },
        ],
        requestShutdown: async () => true,
        stopProcess: async (pid) => pid === 101,
        serveCommand: vi.fn(async (options) => options.port),
      });

      try {
        const result = await updateCommand({ json: true });
        const payload = JSON.parse(output.join(''));
        expect(result).toMatchObject({ exitCode: 1 });
        expect(payload).toMatchObject({ status: 'warning', restartedCount: 1 });
        expect(payload.restartResults).toEqual([
          expect.objectContaining({ port: 3001, restartedPort: 3001, ok: true }),
          expect.objectContaining({ port: 3002, ok: false, reason: 'stop-failed' }),
        ]);
        expect(serveCommand).toHaveBeenCalledWith(expect.objectContaining({ port: 3001, apiOnly: true }));
      } finally {
        process.stdout.write = originalWrite;
      }
    });
  });

  it('handles failed update execution safely without touching instances', async () => {
    await withTempPiChamberDataDir(async () => {
      const { updateCommand, executeUpdate, serveCommand, restartUserStartupService } = createTestUpdateCommand({
        executeUpdate: vi.fn(() => ({ success: false, exitCode: 1 })),
      });

      await expect(updateCommand({ quiet: true })).rejects.toThrow('Update failed with exit code 1');
      expect(executeUpdate).toHaveBeenCalledWith('npm', { silent: true });
      expect(serveCommand).not.toHaveBeenCalled();
      expect(restartUserStartupService).not.toHaveBeenCalled();
    });
  });

  it('skips in-app update when running inside a systemd service unit', async () => {
    await withTempPiChamberDataDir(async () => {
      const { updateCommand, executeUpdate } = createTestUpdateCommand({
        isInsideSystemdService: () => true,
      });

      await expect(updateCommand({ quiet: true })).rejects.toThrow('pichamber update cannot replace this process while it is running as a systemd service');
      expect(executeUpdate).not.toHaveBeenCalled();
    });
  });

  it('refuses to guess a package manager when the running copy is not a global install', async () => {
    await withTempPiChamberDataDir(async () => {
      const { updateCommand, executeUpdate } = createTestUpdateCommand({
        resolveTrustedUpdatePackageManager: vi.fn(() => null),
      });

      await expect(updateCommand({ quiet: true })).rejects.toThrow('This PiChamber copy is not a global package-manager install.');
      expect(executeUpdate).not.toHaveBeenCalled();
    });
  });

  it('restarts a systemd user unit instead of spawning a new server', async () => {
    await withTempPiChamberDataDir(async () => {
      const originalWrite = process.stdout.write;
      process.stdout.write = vi.fn(() => true);
      const { updateCommand, serveCommand, restartUserStartupService } = createTestUpdateCommand({
        isUserStartupServiceActive: () => true,
      });

      try {
        await updateCommand({ json: true });
        expect(restartUserStartupService).toHaveBeenCalledTimes(1);
        expect(serveCommand).not.toHaveBeenCalled();
      } finally {
        process.stdout.write = originalWrite;
      }
    });
  });
});
