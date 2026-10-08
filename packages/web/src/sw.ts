/// <reference lib="webworker" />

// NOTE: keep the Workbox injection point so vite-plugin-pwa can build.
// We intentionally do not use Workbox runtime helpers here: iOS Safari can be
// fragile with more complex SW bundles. This is a minimal SW: precache support
// plus a click handler for locally shown notifications.

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision?: string }>;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const __precacheManifest = self.__WB_MANIFEST;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = (event.notification.data ?? null) as { url?: string } | null;
  const rawUrl = typeof data?.url === 'string' ? data.url : '';
  // Only same-origin relative paths and http(s) URLs may be opened. Notification
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
