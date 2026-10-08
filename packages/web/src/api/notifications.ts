import type { NotificationPayload, NotificationsAPI } from '@pichamber/ui/lib/api/types';

const SW_READY_TIMEOUT_MS = 1500;
const NOTIFICATION_DEDUPE_TTL_MS = 5000;
const NOTIFICATION_DEDUPE_STORAGE_PREFIX = 'pichamber-notification-claim:';
const MAX_PAGE_NOTIFICATIONS = 20;

const notificationClaims = new Map<string, number>();

/** Page-created `Notification` objects keyed by tag, so `close(tag)` can
 *  dismiss them. Bounded: the oldest entry is dropped past the cap. */
const pageNotificationsByTag = new Map<string, Notification>();

const trackPageNotification = (tag: string | undefined, notification: Notification): void => {
  if (!tag) return;
  pageNotificationsByTag.delete(tag);
  pageNotificationsByTag.set(tag, notification);
  while (pageNotificationsByTag.size > MAX_PAGE_NOTIFICATIONS) {
    const oldest = pageNotificationsByTag.keys().next().value;
    if (oldest === undefined) break;
    pageNotificationsByTag.delete(oldest);
  }
};

const isClientFocused = (): boolean => {
  if (typeof document === 'undefined') return true;
  return document.visibilityState === 'visible' && document.hasFocus();
};

const getNotificationClaimKey = (payload?: NotificationPayload): string => {
  const tag = typeof payload?.tag === 'string' ? payload.tag.trim() : '';
  if (tag) return tag;

  return [payload?.sessionId, payload?.kind, payload?.title, payload?.body]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
    .join('|');
};

const pruneNotificationClaims = (now: number): void => {
  for (const [key, claimedAt] of notificationClaims) {
    if (now - claimedAt > NOTIFICATION_DEDUPE_TTL_MS) {
      notificationClaims.delete(key);
    }
  }
};

const claimNotificationPayload = (payload?: NotificationPayload): boolean => {
  const key = getNotificationClaimKey(payload);
  if (!key) return true;

  const now = Date.now();
  pruneNotificationClaims(now);

  const claimedAt = notificationClaims.get(key) ?? 0;
  if (now - claimedAt < NOTIFICATION_DEDUPE_TTL_MS) {
    return false;
  }

  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const storageKey = `${NOTIFICATION_DEDUPE_STORAGE_PREFIX}${key}`;
      const stored = Number(window.localStorage.getItem(storageKey) ?? '0');
      if (Number.isFinite(stored) && now - stored < NOTIFICATION_DEDUPE_TTL_MS) {
        notificationClaims.set(key, stored);
        return false;
      }
      if (Number.isFinite(stored) && stored > 0) {
        window.localStorage.removeItem(storageKey);
      }
      window.localStorage.setItem(storageKey, String(now));
    }
  } catch {
    // Storage is best-effort; in-memory dedupe still covers duplicate streams in this tab.
  }

  notificationClaims.set(key, now);
  return true;
};

const getNotificationRegistration = async (): Promise<ServiceWorkerRegistration | null> => {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }

  let existing: ServiceWorkerRegistration | null = null;
  try {
    existing = (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    existing = null;
  }

  if (existing?.active) {
    return existing;
  }

  if (!existing) {
    return null;
  }

  try {
    const ready = await Promise.race<ServiceWorkerRegistration | null>([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), SW_READY_TIMEOUT_MS);
      }),
    ]);

    return ready ?? existing;
  } catch {
    return existing;
  }
};

const notifyWithServiceWorker = async (payload?: NotificationPayload): Promise<boolean> => {
  const registration = await getNotificationRegistration();
  if (!registration || typeof registration.showNotification !== 'function') {
    return false;
  }

  try {
    await registration.showNotification(payload?.title ?? 'PiChamber', {
      body: payload?.body,
      tag: payload?.tag,
    });
    return true;
  } catch (error) {
    console.warn('Failed to send notification via service worker', error);
    return false;
  }
};

const hasActivePushSubscription = async (): Promise<boolean> => {
  const registration = await getNotificationRegistration();
  if (!registration || !('pushManager' in registration) || !registration.pushManager) {
    return false;
  }

  try {
    return Boolean(await registration.pushManager.getSubscription());
  } catch {
    return false;
  }
};

const notifyWithWebAPI = async (payload?: NotificationPayload): Promise<boolean> => {
  if (payload?.requireHidden && typeof document !== 'undefined' && document.hasFocus()) {
    return true;
  }

  if (typeof Notification === 'undefined') {
    console.info('Notifications not supported in this environment', payload);
    return false;
  }

  if (Notification.permission === 'default') {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.warn('Notification permission not granted');
      return false;
    }
  }

  if (Notification.permission !== 'granted') {
    console.warn('Notification permission not granted');
    return false;
  }

  // Background push is the delivery channel when the web/PWA client is not
  // focused. Keep notification preferences enabled, but avoid also showing the
  // same foreground notification from a hidden page.
  if (!isClientFocused() && await hasActivePushSubscription()) {
    return true;
  }

  if (!claimNotificationPayload(payload)) {
    return true;
  }

  try {
    // Some installed PWAs expose Notification.permission but only allow
    // notifications through an active service worker registration.
    if (await notifyWithServiceWorker(payload)) {
      return true;
    }

    const created = new Notification(payload?.title ?? 'PiChamber', {
      body: payload?.body,
      tag: payload?.tag,
    });
    trackPageNotification(payload?.tag, created);
    created.onclose = () => {
      if (payload?.tag) pageNotificationsByTag.delete(payload.tag);
    };
    // Focus the app and route through the same `pichamber:open-session`
    // navigation the full app shell listens for.
    created.onclick = () => {
      try {
        if (typeof window !== 'undefined') window.focus();
      } catch {
        // ignore
      }
      try {
        if (typeof window !== 'undefined' && payload?.sessionId) {
          window.dispatchEvent(new CustomEvent('pichamber:open-session', {
            detail: { sessionId: payload.sessionId, directory: payload.directory ?? '' },
          }));
        }
      } catch {
        // ignore
      }
      created.close();
    };
    return true;
  } catch (error) {
    console.warn('Failed to send notification', error);
    return false;
  }
};

const notifyWithDesktop = async (payload?: NotificationPayload): Promise<boolean> => {
  if (typeof window === 'undefined') {
    return false;
  }

  const desktop = (window as unknown as { __PICHAMBER_DESKTOP__?: DesktopBridgeGlobal }).__PICHAMBER_DESKTOP__;
  if (!desktop?.invoke) {
    return false;
  }

  try {
    await desktop.invoke('desktop_notify', {
      payload: {
        title: payload?.title,
        body: payload?.body,
        tag: payload?.tag,
        kind: payload?.kind,
        sessionId: payload?.sessionId,
        directory: payload?.directory,
        requireHidden: payload?.requireHidden,
      },
    });
    return true;
  } catch (error) {
    console.warn('Failed to send native notification (desktop)', error);
    return false;
  }
};

export const createWebNotificationsAPI = (): NotificationsAPI => ({
  async notify(payload?: NotificationPayload): Promise<boolean> {
    return (await notifyWithDesktop(payload)) || (await notifyWithWebAPI(payload));
  },
  canNotify: () => {
    if (typeof window !== 'undefined') {
      const desktop = (window as unknown as { __PICHAMBER_DESKTOP__?: DesktopBridgeGlobal }).__PICHAMBER_DESKTOP__;
      if (desktop?.invoke) {
        return true;
      }
    }
    return typeof Notification !== 'undefined' ? Notification.permission === 'granted' : false;
  },
  async close(tag: string): Promise<void> {
    if (typeof tag !== 'string' || tag.trim().length === 0) return;
    const trimmed = tag.trim();
    // In Electron the shown notification lives in the main process; close it there.
    if (typeof window !== 'undefined') {
      const desktop = (window as unknown as { __PICHAMBER_DESKTOP__?: DesktopBridgeGlobal }).__PICHAMBER_DESKTOP__;
      if (desktop?.invoke) {
        try {
          await desktop.invoke('desktop_notification_close', { tag: trimmed });
        } catch (error) {
          console.warn('Failed to close native notification (desktop)', error);
        }
        return;
      }
    }
    const pageNotification = pageNotificationsByTag.get(trimmed);
    if (pageNotification) {
      pageNotificationsByTag.delete(trimmed);
      try {
        pageNotification.close();
      } catch {
        // ignore
      }
    }
    try {
      const registration = await getNotificationRegistration();
      const shown = typeof registration?.getNotifications === 'function'
        ? await registration.getNotifications({ tag: trimmed })
        : [];
      for (const notification of shown ?? []) {
        try {
          notification.close();
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  },
  setAttentionCount(count: number): void {
    const normalized = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    // In Electron the dock badge lives in the main process.
    if (typeof window !== 'undefined') {
      const desktop = (window as unknown as { __PICHAMBER_DESKTOP__?: DesktopBridgeGlobal }).__PICHAMBER_DESKTOP__;
      if (desktop?.invoke) {
        void desktop.invoke('desktop_tray_update', { dockBadgeCount: normalized }).catch((error: unknown) => {
          console.warn('Failed to update desktop attention count', error);
        });
        return;
      }
    }
    // Badging API (ChromiumPWAs / supported mobile browsers). Feature-detect and swallow.
    try {
      const nav = typeof navigator !== 'undefined' ? navigator as Navigator & {
        setAppBadge?: (count: number) => Promise<void>;
        clearAppBadge?: () => Promise<void>;
      } : null;
      if (!nav) return;
      if (normalized > 0 && typeof nav.setAppBadge === 'function') {
        void nav.setAppBadge(normalized).catch(() => undefined);
      } else if (normalized === 0 && typeof nav.clearAppBadge === 'function') {
        void nav.clearAppBadge().catch(() => undefined);
      }
    } catch {
      // ignore
    }
  },
});
type DesktopBridgeGlobal = {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};
