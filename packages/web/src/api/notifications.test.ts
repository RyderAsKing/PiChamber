import { afterEach, describe, expect, it, vi } from 'vitest';

const { runtimeFetchMock } = vi.hoisted(() => ({
  runtimeFetchMock: vi.fn(async () => new Response('{"ok":true,"publicKey":"key"}', { status: 200 })),
}));
vi.mock('@pichamber/ui/lib/runtime-fetch', () => ({ runtimeFetch: runtimeFetchMock }));

type MockNotificationConstructor = {
  new (title: string, options?: NotificationOptions): Notification;
  permission: NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
};

const originalNotification = globalThis.Notification;
const originalNavigator = globalThis.navigator;
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

const installNotificationMock = (onCreate: (title: string, options?: NotificationOptions) => void) => {
  const MockNotification = function Notification(this: Notification, title: string, options?: NotificationOptions) {
    onCreate(title, options);
    return this;
  } as unknown as MockNotificationConstructor;
  MockNotification.permission = 'granted';
  MockNotification.requestPermission = vi.fn(async () => 'granted' as NotificationPermission);

  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: MockNotification,
  });
};

const installWindowMock = () => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    },
  });
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: originalNotification });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});

describe('web notifications API', () => {
  it('provides the push API used by browser and native-mobile registration', async () => {
    const { createWebPushAPI } = await import('./push');
    const push = createWebPushAPI();

    await expect(push.getVapidPublicKey()).resolves.toEqual({ ok: true, publicKey: 'key' });
    await expect(push.registerApnsToken({ token: 'token', platform: 'ios' })).resolves.toEqual({ ok: true, publicKey: 'key' });

    expect(runtimeFetchMock).toHaveBeenNthCalledWith(1, '/api/push/vapid-public-key', undefined);
    expect(runtimeFetchMock).toHaveBeenNthCalledWith(2, '/api/push/apns-token', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ token: 'token', platform: 'ios' }),
    }));
  });

  it('deduplicates repeated foreground notifications by tag', async () => {
    installWindowMock();
    const created: Array<{ title: string; options?: NotificationOptions }> = [];
    installNotificationMock((title, options) => created.push({ title, options }));

    const { createWebNotificationsAPI } = await import('./notifications');
    const api = createWebNotificationsAPI();

    await expect(api.notify({ title: 'Ready', body: 'Done', tag: 'ready-session' })).resolves.toBe(true);
    await expect(api.notify({ title: 'Ready', body: 'Done', tag: 'ready-session' })).resolves.toBe(true);

    expect(created).toHaveLength(1);
    expect(created[0]?.title).toBe('Ready');
  });

  it('defers hidden-page notification delivery to active push subscription without claiming foreground delivery', async () => {
    installWindowMock();
    const created: Array<{ title: string; options?: NotificationOptions }> = [];
    installNotificationMock((title, options) => created.push({ title, options }));
    const showNotification = vi.fn(async () => undefined);
    let visibilityState: DocumentVisibilityState = 'hidden';
    let focused = false;

    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        get visibilityState() {
          return visibilityState;
        },
        hasFocus: () => focused,
      },
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        serviceWorker: {
          getRegistration: vi.fn(async () => ({
            active: {},
            showNotification,
            pushManager: {
              getSubscription: vi.fn(async () => ({ endpoint: 'https://push.example/subscription' })),
            },
          })),
        },
      },
    });

    const { createWebNotificationsAPI } = await import('./notifications');
    const api = createWebNotificationsAPI();

    await expect(api.notify({ title: 'Ready', body: 'Done', tag: 'ready-session' })).resolves.toBe(true);

    expect(showNotification).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);

    visibilityState = 'visible';
    focused = true;

    await expect(api.notify({ title: 'Ready', body: 'Done', tag: 'ready-session' })).resolves.toBe(true);

    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledWith('Ready', expect.objectContaining({ body: 'Done', tag: 'ready-session' }));
    expect(created).toHaveLength(0);
  });
});

describe('web notifications close and attention count', () => {
  const installClosableNotificationMock = (created: Array<{ close: () => void }>) => {
    const MockNotification = function Notification(this: Notification & { close: () => void }) {
      const close = vi.fn();
      created.push({ close });
      this.close = close;
      return this;
    } as unknown as MockNotificationConstructor;
    MockNotification.permission = 'granted';
    MockNotification.requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
    Object.defineProperty(globalThis, 'Notification', {
      configurable: true,
      value: MockNotification,
    });
  };

  it('closes a page-created notification by tag', async () => {
    installWindowMock();
    const created: Array<{ close: () => void }> = [];
    installClosableNotificationMock(created);

    const { createWebNotificationsAPI } = await import('./notifications');
    const api = createWebNotificationsAPI();

    await expect(api.notify({ title: 'Input needed', body: 'Session', tag: 'pichamber:input:s1:111' })).resolves.toBe(true);
    expect(created).toHaveLength(1);

    await api.close?.('pichamber:input:s1:111');
    expect(created[0]?.close).toHaveBeenCalledTimes(1);

    // Unknown tags are a quiet no-op.
    await api.close?.('pichamber:input:missing:0');
    await api.close?.('');
    expect(created[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('closes service-worker notifications by tag', async () => {
    installWindowMock();
    const created: Array<{ close: () => void }> = [];
    installClosableNotificationMock(created);
    const swClose = vi.fn();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        serviceWorker: {
          getRegistration: vi.fn(async () => ({
            active: {},
            showNotification: vi.fn(async () => undefined),
            getNotifications: vi.fn(async () => [{ close: swClose }]),
          })),
        },
      },
    });

    const { createWebNotificationsAPI } = await import('./notifications');
    const api = createWebNotificationsAPI();

    await api.close?.('pichamber:input:s1:222');
    expect(swClose).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(0);
  });

  it('routes close through desktop IPC when available', async () => {
    const invoke = vi.fn(async () => null);
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __PICHAMBER_DESKTOP__: { invoke } },
    });

    const { createWebNotificationsAPI } = await import('./notifications');
    const api = createWebNotificationsAPI();

    await api.close?.('pichamber:input:s1:333');
    expect(invoke).toHaveBeenCalledWith('desktop_notification_close', { tag: 'pichamber:input:s1:333' });
  });

  it('sends the attention count through desktop IPC when available', async () => {
    const invoke = vi.fn(async () => null);
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __PICHAMBER_DESKTOP__: { invoke } },
    });

    const { createWebNotificationsAPI } = await import('./notifications');
    const api = createWebNotificationsAPI();

    api.setAttentionCount?.(3);
    expect(invoke).toHaveBeenCalledWith('desktop_tray_update', { dockBadgeCount: 3 });
  });

  it('uses the app badge API on the web when supported', async () => {
    installWindowMock();
    const setAppBadge = vi.fn(async () => undefined);
    const clearAppBadge = vi.fn(async () => undefined);
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { setAppBadge, clearAppBadge },
    });

    const { createWebNotificationsAPI } = await import('./notifications');
    const api = createWebNotificationsAPI();

    api.setAttentionCount?.(2);
    await Promise.resolve();
    expect(setAppBadge).toHaveBeenCalledWith(2);
    expect(clearAppBadge).not.toHaveBeenCalled();

    api.setAttentionCount?.(0);
    await Promise.resolve();
    expect(clearAppBadge).toHaveBeenCalledTimes(1);
  });

  it('tolerates missing badge surfaces', async () => {
    installWindowMock();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {},
    });

    const { createWebNotificationsAPI } = await import('./notifications');
    const api = createWebNotificationsAPI();

    expect(() => api.setAttentionCount?.(2)).not.toThrow();
    expect(() => api.setAttentionCount?.(Number.NaN)).not.toThrow();
  });
});
