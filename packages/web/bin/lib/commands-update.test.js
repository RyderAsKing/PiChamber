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

describe('update command', () => {
  it('uses the package-manager helpers on the update-available path', async () => {
    await withTempPiChamberDataDir(async () => {
      const originalWrite = process.stdout.write;
      process.stdout.write = vi.fn(() => true);
      const executeUpdate = vi.fn(() => ({ success: true, exitCode: 0 }));
      const updateCommand = createUpdateCommand({
        packageManagerPath: '/fake/package-manager.js',
        serveCommand: vi.fn(),
        importFromFilePath: vi.fn(async () => ({
          checkForUpdates: vi.fn(async () => ({ available: true, version: '9.9.9' })),
          detectPackageManager: vi.fn(() => 'npm'),
          executeUpdate,
          getCurrentVersion: vi.fn(() => '1.0.0'),
        })),
      });

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
      const executeUpdate = vi.fn(() => ({ success: false, exitCode: 1 }));
      const updateCommand = createUpdateCommand({
        packageManagerPath: '/fake/package-manager.js',
        serveCommand: vi.fn(),
        importFromFilePath: vi.fn(async () => ({
          checkForUpdates: vi.fn(async () => ({ available: true, version: '9.9.9' })),
          detectPackageManager: vi.fn(() => 'npm'),
          executeUpdate,
          getCurrentVersion: vi.fn(() => '1.0.0'),
        })),
      });

      await expect(updateCommand({ quiet: true })).rejects.toThrow('Update failed with exit code 1');
      expect(executeUpdate).toHaveBeenCalledWith('npm', { silent: true });
    });
  });

  it('skips in-app update when running inside a systemd service unit', async () => {
    await withTempPiChamberDataDir(async () => {
      const prevInvocationId = process.env.INVOCATION_ID;
      process.env.INVOCATION_ID = 'test-invocation-123';
      try {
        const executeUpdate = vi.fn();
        const updateCommand = createUpdateCommand({
          packageManagerPath: '/fake/package-manager.js',
          serveCommand: vi.fn(),
          importFromFilePath: vi.fn(async () => ({
            checkForUpdates: vi.fn(async () => ({ available: true, version: '9.9.9' })),
            detectPackageManager: vi.fn(() => 'npm'),
            executeUpdate,
            getCurrentVersion: vi.fn(() => '1.0.0'),
          })),
        });

        await expect(updateCommand({ quiet: true })).rejects.toThrow('systemd deployments must be updated through package management');
        expect(executeUpdate).not.toHaveBeenCalled();
      } finally {
        if (typeof prevInvocationId === 'string') {
          process.env.INVOCATION_ID = prevInvocationId;
        } else {
          delete process.env.INVOCATION_ID;
        }
      }
    });
  });
});
