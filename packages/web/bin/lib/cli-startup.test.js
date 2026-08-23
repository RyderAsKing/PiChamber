import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

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
