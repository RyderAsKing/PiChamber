import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { createTunnelService } from './tunnel-service.js';

const makeDataDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pichamber-tunnel-test-'));
  return dir;
};

describe('tunnel service', () => {
  let dataDir;

  beforeEach(async () => {
    dataDir = await makeDataDir();
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('validates managed-remote mode requires token and hostname', async () => {
    const service = createTunnelService({ dataDir, getPort: () => 3000, tunnelAuthController: { setActiveTunnel: () => {}, clearActiveTunnel: () => {}, issueBootstrapToken: () => ({ token: 't', expiresAt: Date.now() + 1000 }), listTunnelSessions: () => [] } });
    await expect(service.start({ mode: 'managed-remote', token: '', hostname: '' })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(service.start({ mode: 'managed-remote', token: 'tok', hostname: '' })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('returns status with required fields and handles missing cloudflared gracefully', async () => {
    const service = createTunnelService({ dataDir, getPort: () => 3000, tunnelAuthController: { listTunnelSessions: () => [] } });
    const status = await service.getStatus();
    expect(status).toHaveProperty('active');
    expect(status).toHaveProperty('url');
    expect(status).toHaveProperty('mode');
    expect(typeof status.active).toBe('boolean');
  });

  it('does not expose secrets in status or logs', async () => {
    const service = createTunnelService({ dataDir, getPort: () => 3000, tunnelAuthController: { listTunnelSessions: () => [] } });
    await service.saveManagedRemoteToken({ token: 'secret-token-12345', hostname: 'example.trycloudflare.com' });
    const status = await service.getStatus();
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('secret-token-12345');
    expect(status.hasManagedRemoteTunnelToken).toBe(true);
    expect(status.managedRemoteTunnelHostname).toBe('example.trycloudflare.com');
  });

  it('redacts tokens when formatting for display', async () => {
    const service = createTunnelService({ dataDir, getPort: () => 3000, tunnelAuthController: { listTunnelSessions: () => [] } });
    const redacted = service._internals.redactToken('my-super-secret-token-value');
    expect(redacted).not.toContain('super-secret');
    expect(redacted.length).toBeGreaterThan(0);
  });

  it('handles unsupported mode with clear error', async () => {
    const service = createTunnelService({ dataDir, getPort: () => 3000, tunnelAuthController: { setActiveTunnel: () => {}, clearActiveTunnel: () => {}, issueBootstrapToken: () => ({ token: 't', expiresAt: Date.now() + 1000 }), listTunnelSessions: () => [] } });
    await expect(service.start({ mode: 'unknown-mode' })).rejects.toThrow('Unsupported tunnel mode');
  });
});
