import { beforeEach, describe, expect, mock, test } from 'bun:test';

const requestedUrls: string[] = [];
let localDesktop = false;
let capacitorApp = false;
// When set, fetches wait on it, so a test can hold one check in flight.
let fetchGate: Promise<void> | null = null;

mock.module('@/lib/device', () => ({
  getDeviceInfo: () => ({ deviceType: 'desktop' }),
}));

mock.module('@/lib/platform', () => ({
  getClientPlatform: () => 'web',
  isCapacitorApp: () => capacitorApp,
}));

mock.module('@/lib/desktop', () => ({
  checkForDesktopUpdates: async () => ({
    available: false,
    currentVersion: '1.2.0',
  }),
  downloadDesktopUpdate: async () => true,
  restartToApplyUpdate: async () => true,
  isDesktopLocalOriginActive: () => localDesktop,
  isElectronShell: () => !capacitorApp,
  isWebRuntime: () => false,
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (url: string) => {
    requestedUrls.push(url);
    const gate = fetchGate;
    if (gate) await gate;
    const isMobileAppCheck = url.includes('appType=mobile-capacitor');
    const isRcAppCheck = isMobileAppCheck && url.includes('channel=rc');
    return new Response(JSON.stringify({
      available: !isMobileAppCheck || isRcAppCheck,
      currentVersion: isMobileAppCheck ? '1.1.0' : '1.0.0',
      version: isRcAppCheck ? '1.2.0-rc.1' : '1.1.0',
      channel: isRcAppCheck ? 'rc' : 'stable',
      nextSuggestedCheckInSec: 3600,
    }), { status: 200 });
  },
}));

const { useUpdateStore } = await import('./useUpdateStore');

describe('useUpdateStore remote Electron checks', () => {
  beforeEach(() => {
    requestedUrls.length = 0;
    localDesktop = false;
    capacitorApp = false;
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

describe('useUpdateStore native mobile checks', () => {
  beforeEach(() => {
    requestedUrls.length = 0;
    localDesktop = false;
    capacitorApp = true;
    useUpdateStore.getState().reset();
  });

  test('checks the app and its connected server separately', async () => {
    await useUpdateStore.getState().checkForUpdates();

    const state = useUpdateStore.getState();
    expect(state.runtimeType).toBe('mobile');
    expect(state.info).toMatchObject({ available: false, currentVersion: '1.1.0' });
    expect(state.serverInfo).toMatchObject({ available: true, currentVersion: '1.0.0', version: '1.1.0' });
    // The app toast keys off `available`, so a server update must not raise it.
    expect(state.available).toBe(false);

    expect(requestedUrls).toHaveLength(2);
    const appCheck = requestedUrls.find((url) => url.includes('appType=mobile-capacitor'));
    const serverCheck = requestedUrls.find((url) => url.includes('appType=web'));
    expect(appCheck).toBeDefined();
    expect(serverCheck).toBeDefined();
    expect(serverCheck).not.toContain('currentVersion=');
  });

  test("sends the app's own update channel, and none for the server check", async () => {
    // Bun runs this without a DOM; the app's channel lives in localStorage.
    const stored = new Map([['pichamber.mobileUpdateChannel', 'rc']]);
    (globalThis as { window?: unknown }).window = {
      localStorage: { getItem: (key: string) => stored.get(key) ?? null },
    };
    try {
      await useUpdateStore.getState().checkForUpdates();
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }

    const appCheck = requestedUrls.find((url) => url.includes('appType=mobile-capacitor'));
    const serverCheck = requestedUrls.find((url) => url.includes('appType=web'));
    expect(appCheck).toContain('channel=rc');
    // The server reads its own channel for web checks.
    expect(serverCheck).not.toContain('channel=');
  });

  test('drops a check that finishes after a newer one on another channel', async () => {
    const stored = new Map([['pichamber.mobileUpdateChannel', 'rc']]);
    (globalThis as { window?: unknown }).window = {
      localStorage: { getItem: (key: string) => stored.get(key) ?? null },
    };
    let releaseRcCheck = () => {};
    fetchGate = new Promise<void>((resolve) => {
      releaseRcCheck = resolve;
    });
    try {
      const rcCheck = useUpdateStore.getState().checkForUpdates();
      fetchGate = null;
      stored.set('pichamber.mobileUpdateChannel', 'stable');
      useUpdateStore.getState().reset();
      await useUpdateStore.getState().checkForUpdates();
      releaseRcCheck();
      expect(await rcCheck).toBeNull();
    } finally {
      fetchGate = null;
      delete (globalThis as { window?: unknown }).window;
    }

    const state = useUpdateStore.getState();
    expect(state.checking).toBe(false);
    expect(state.available).toBe(false);
    expect(state.info).toMatchObject({ channel: 'stable', version: '1.1.0' });
  });
});
