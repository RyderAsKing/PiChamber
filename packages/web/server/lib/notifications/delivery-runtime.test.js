import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNotificationDeliveryRuntime } from './delivery-runtime.js';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const setup = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pichamber-notifications-'));
  directories.push(dataDir);
  const sendNotification = vi.fn(async () => undefined);
  const fetch = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
  const webPush = {
    generateVAPIDKeys: vi.fn(() => ({ publicKey: 'public-key', privateKey: 'private-key' })),
    setVapidDetails: vi.fn(),
    sendNotification,
  };
  return {
    dataDir,
    fetch,
    sendNotification,
    runtime: createNotificationDeliveryRuntime({ dataDir, webPush, crypto, fetch }),
  };
};

describe('notification delivery runtime', () => {
  it('persists subscriptions privately and fans out one terminal event', async () => {
    const { dataDir, fetch, runtime, sendNotification } = await setup();
    await runtime.addWebSubscription('client-1', {
      endpoint: 'https://push.example/subscription',
      p256dh: 'p256dh',
      auth: 'auth',
      platform: 'web',
    });
    await runtime.addNativeToken('client-1', {
      token: 'native-token',
      platform: 'ios',
      environment: 'production',
    });

    await runtime.send({
      title: 'Work completed',
      body: 'Session',
      tag: 'pichamber:completion:s1:7',
      data: { type: 'completion', sessionId: 's1' },
    });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toMatch(/register-token$/);
    expect(fetch.mock.calls[1][0]).toMatch(/\/send$/);
    const stored = JSON.parse(await readFile(join(dataDir, 'notifications.json'), 'utf8'));
    expect(stored.subscriptionsByClient['client-1']).toHaveLength(1);
    expect(stored.nativeTokensByClient['client-1']).toHaveLength(1);
    if (process.platform !== 'win32') {
      expect((await stat(join(dataDir, 'notifications.json'))).mode & 0o777).toBe(0o600);
    }
  });

  it('suppresses native fanout while an interactive client is visible', async () => {
    const { fetch, runtime } = await setup();
    await runtime.addNativeToken('mobile', {
      token: 'native-token',
      platform: 'ios',
      environment: 'production',
    });
    runtime.updateVisibility('desktop', true, 'desktop');

    await runtime.send({
      title: 'Work failed',
      body: 'Session',
      tag: 'pichamber:error:s1:9',
      data: { type: 'error', sessionId: 's1' },
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toMatch(/register-token$/);
  });
});
