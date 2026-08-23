/// <reference lib="webworker" />

// NOTE: keep the Workbox injection point so vite-plugin-pwa can build.
// We intentionally do not use Workbox runtime helpers here: iOS Safari can be
// fragile with more complex SW bundles. For push notifications we only need a
// minimal SW.

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision?: string }>;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const __precacheManifest = self.__WB_MANIFEST;

type PushPayload = {
  title?: string;
  body?: string;
  tag?: string;
  data?: {
    url?: string;
    sessionId?: string;
    type?: string;
  };
  icon?: string;
  badge?: string;
};

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    const payload = (event.data?.json() ?? null) as PushPayload | null;
    if (!payload) {
      return;
    }

    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hasVisibleClient = clients.some((client) => client.visibilityState === 'visible' || client.focused);
    if (hasVisibleClient) {
      return;
    }

    const title = payload.title || 'PiChamber';
    const body = payload.body ?? '';
    const icon = payload.icon ?? '/apple-touch-icon-180x180.png';
    const badge = payload.badge ?? '/favicon-32.png';

    await self.registration.showNotification(title, {
      body,
      icon,
      badge,
      tag: payload.tag,
      data: payload.data,
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = (event.notification.data ?? null) as { url?: string } | null;
  const rawUrl = typeof data?.url === 'string' ? data.url : '';
  // Only same-origin relative paths and http(s) URLs may be opened. Push
  // payloads must not be able to aim the OS handler at other schemes.
  const isRelative = rawUrl.startsWith('/') && !rawUrl.startsWith('//');
  let url = '/';
  if (isRelative) {
    url = rawUrl;
  } else {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') url = rawUrl;
    } catch {
      // Malformed URLs fall back to '/'.
    }
  }

  event.waitUntil(self.clients.openWindow(url));
});
