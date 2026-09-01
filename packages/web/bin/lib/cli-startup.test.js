import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

describe('systemd startup activation', () => {
  it('enables and restarts a system service so updated settings take effect', async () => {
    const { activateSystemdStartupService } = await import('./cli-startup.js');
    const calls = [];

    activateSystemdStartupService(true, (command, args) => calls.push([command, args]));

    expect(calls).toEqual([
      ['systemctl', ['daemon-reload']],
      ['systemctl', ['enable', 'pichamber.service']],
      ['systemctl', ['restart', 'pichamber.service']],
    ]);
  });

  it('enables and restarts a user service so updated settings take effect', async () => {
    const { activateSystemdStartupService } = await import('./cli-startup.js');
    const calls = [];

    activateSystemdStartupService(false, (command, args) => calls.push([command, args]));

    expect(calls).toEqual([
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', 'pichamber.service']],
      ['systemctl', ['--user', 'restart', 'pichamber.service']],
    ]);
  });
});

describe('startup service paths', () => {
  const originalPlatform = process.platform;
  const originalGetuid = process.getuid;
  let tmpHome;

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(os.tmpdir(), 'pichamber-startup-test-'));
    vi.stubEnv('HOME', tmpHome);
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    if (originalGetuid) process.getuid = originalGetuid;
    else delete process.getuid;
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('uses user service path for non-root', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.getuid = () => 1000;
    const { getStartupServicePaths } = await import('./cli-startup.js?user');
    const result = getStartupServicePaths();
    expect(result.servicePath).toContain('.config/systemd/user/pichamber.service');
  });

  it('uses system service path for root', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.getuid = () => 0;
    // Need to re-import fresh module to pick up new getuid
    vi.resetModules();
    const { getStartupServicePaths } = await import('./cli-startup.js?root');
    const result = getStartupServicePaths();
    expect(result.servicePath).toBe('/etc/systemd/system/pichamber.service');
  });
});
