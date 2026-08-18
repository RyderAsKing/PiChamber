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
  const serveCommand = overrides.serveCommand || vi.fn();
  const restartUserStartupService = overrides.restartUserStartupService || vi.fn();
  const updateCommand = createUpdateCommand({
    packageManagerPath: '/fake/package-manager.js',
    serveCommand,
    isInsideSystemdService: overrides.isInsideSystemdService || (() => false),
    isUserStartupServiceActive: overrides.isUserStartupServiceActive || (() => false),
    restartUserStartupService,
    importFromFilePath: vi.fn(async () => ({
      checkForUpdates: overrides.checkForUpdates || vi.fn(async () => ({ available: true, version: '9.9.9' })),
      resolveTrustedUpdatePackageManager: overrides.resolveTrustedUpdatePackageManager || vi.fn(() => 'npm'),
      executeUpdate,
      getCurrentVersion: vi.fn(() => '1.0.0'),
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
