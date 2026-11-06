import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendToIntake } from './browser-handler.mjs';
import { createOpenUrlIntake } from './intake.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const startIntake = async ({ publish, hasConnectedDevices }) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pc-intake-'));
  const socketPath = path.join(dir, 'run', 'open-url.sock');
  const intake = createOpenUrlIntake({ socketPath, publish, hasConnectedDevices, platform: 'linux' });
  await expect(intake.start()).resolves.toBe(true);
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  cleanups.push(() => intake.stop());
  return { socketPath, intake };
};

describe.skipIf(process.platform === 'win32')('open-url intake', () => {
  it('reports delivered when a device is connected and the daemon published', async () => {
    const publish = vi.fn().mockResolvedValue({ published: true });
    const { socketPath } = await startIntake({ publish, hasConnectedDevices: () => true });
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    await expect(sendToIntake({ socketPath, url: 'http://localhost:3000/', sessionId: 's-1' })).resolves.toBe(true);
    expect(publish).toHaveBeenCalledWith({ url: 'http://localhost:3000/', sessionId: 's-1' });
  });

  it('does not publish when no device is connected', async () => {
    const publish = vi.fn();
    const { socketPath } = await startIntake({ publish, hasConnectedDevices: () => false });
    await expect(sendToIntake({ socketPath, url: 'http://localhost:3000/' })).resolves.toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it('reports not delivered when the daemon rejects or has no session', async () => {
    const publish = vi.fn()
      .mockRejectedValueOnce(new Error('UNKNOWN_COMMAND'))
      .mockResolvedValueOnce({ published: false });
    const { socketPath } = await startIntake({ publish, hasConnectedDevices: () => true });
    await expect(sendToIntake({ socketPath, url: 'http://localhost:3000/' })).resolves.toBe(false);
    await expect(sendToIntake({ socketPath, url: 'http://localhost:3000/' })).resolves.toBe(false);
  });

  it('restarts on the same path and removes its socket on stop', async () => {
    const first = await startIntake({ publish: vi.fn(), hasConnectedDevices: () => false });
    const second = createOpenUrlIntake({
      socketPath: first.socketPath, publish: vi.fn().mockResolvedValue({ published: true }), hasConnectedDevices: () => true, platform: 'linux',
    });
    await first.intake.stop();
    await expect(second.start()).resolves.toBe(true);
    await expect(sendToIntake({ socketPath: first.socketPath, url: 'http://x.test/' })).resolves.toBe(true);
    await second.stop();
    await expect(stat(first.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('binds again when its runtime directory is removed while running', async () => {
    const publish = vi.fn().mockResolvedValue({ published: true });
    const { socketPath, intake } = await startIntake({ publish, hasConnectedDevices: () => true });
    await rm(path.dirname(socketPath), { recursive: true, force: true });
    await expect(sendToIntake({ socketPath, url: 'http://x.test/' })).resolves.toBe(false);
    await intake.rebindIfMissing();
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    await expect(sendToIntake({ socketPath, url: 'http://x.test/' })).resolves.toBe(true);
  });

  it('is unavailable when the socket is missing', async () => {
    await expect(sendToIntake({ socketPath: path.join(os.tmpdir(), 'pc-missing', 'x.sock'), url: 'http://x.test/' }))
      .resolves.toBe(false);
  });
});
