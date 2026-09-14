import { beforeEach, describe, expect, mock, test } from 'bun:test';

const requestedUrls: string[] = [];
let localDesktop = false;

mock.module('@/lib/device', () => ({
  getDeviceInfo: () => ({ deviceType: 'desktop' }),
}));

mock.module('@/lib/platform', () => ({
  getClientPlatform: () => 'web',
  isCapacitorApp: () => false,
}));

mock.module('@/lib/desktop', () => ({
  checkForDesktopUpdates: async () => ({
    available: false,
    currentVersion: '1.2.0',
  }),
  downloadDesktopUpdate: async () => true,
  restartToApplyUpdate: async () => true,
  isDesktopLocalOriginActive: () => localDesktop,
  isElectronShell: () => true,
  isWebRuntime: () => false,
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (url: string) => {
    requestedUrls.push(url);
    return new Response(JSON.stringify({
      available: true,
      currentVersion: '1.0.0',
      version: '1.1.0',
      channel: 'stable',
      nextSuggestedCheckInSec: 3600,
    }), { status: 200 });
  },
}));

const { useUpdateStore } = await import('./useUpdateStore');

describe('useUpdateStore remote Electron checks', () => {
  beforeEach(() => {
    requestedUrls.length = 0;
    localDesktop = false;
    useUpdateStore.getState().reset();
  });

  test('keeps client and connected-server update results separate', async () => {
    await useUpdateStore.getState().checkForUpdates();

    const state = useUpdateStore.getState();

    expect(state.info).toMatchObject({ available: false, currentVersion: '1.2.0' });
    expect(state.serverInfo).toMatchObject({
      available: true,
      currentVersion: '1.0.0',
      version: '1.1.0',
    });
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain('appType=web');
    expect(requestedUrls[0]).toContain('instanceMode=unknown');
    expect(requestedUrls[0]).not.toContain('currentVersion=');
  });

  test('keeps the single desktop updater result on the local instance', async () => {
    localDesktop = true;

    await useUpdateStore.getState().checkForUpdates();

    const state = useUpdateStore.getState();
    expect(state.info).toMatchObject({ available: false, currentVersion: '1.2.0' });
    expect(state.serverInfo).toBeNull();
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain('appType=desktop-electron');
    expect(requestedUrls[0]).toContain('instanceMode=local');
  });
});
