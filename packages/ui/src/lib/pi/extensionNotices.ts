/**
 * Per-device "recent extension notices" read state and presentation helpers.
 *
 * The daemon keeps up to 20 notices per session for 24 h; a device that was
 * offline misses the live `extension.notify` events but still receives the
 * history through snapshots and session details. This module owns the
 * device-local last-seen marker that drives the unread dot on the
 * "Recent notices" button:
 *
 * - One localStorage entry (`pichamber.extensionNoticesSeen.v1`) holds a
 *   bounded map of `${runtimeKey}:${sessionId}` → newest seen `createdAt`.
 * - Malformed storage reads as empty; storage failure never breaks rendering.
 * - Live notices toasted while the app is focused mark themselves seen
 *   (the user saw them); history entries stay unread until the list opens.
 */

import type { PiReducerExtensionNotice } from './reducers/reducerTypes';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { getRuntimeKey } from '@/lib/runtime-switch';

export const EXTENSION_NOTICES_SEEN_KEY = 'pichamber.extensionNoticesSeen.v1';

/** Max `${runtimeKey}:${sessionId}` entries; oldest-written drops first. */
export const MAX_EXTENSION_NOTICES_SEEN_ENTRIES = 200;

/** Live server-stamped notices older than this never toast (replay-burst guard). */
export const STALE_LIVE_NOTICE_TOAST_GUARD_MS = 5 * 60 * 1000;

export type ExtensionNoticesSeenMap = Record<string, number>;

const extensionNoticesSeenKeyFor = (runtimeKey: string, sessionId: string): string =>
  `${runtimeKey}:${sessionId}`;

/** Best-effort runtime key; storage must never throw, so fall back to `'local'`. */
export const safeRuntimeKeyForNotices = (): string => {
  try {
    return getRuntimeKey();
  } catch {
    return 'local';
  }
};

/** Read the seen map defensively: malformed storage is empty, never an error. */
export const readExtensionNoticesSeen = (): ExtensionNoticesSeenMap => {
  let raw: string | null = null;
  try {
    raw = getSafeStorage().getItem(EXTENSION_NOTICES_SEEN_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const seen: ExtensionNoticesSeenMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) seen[key] = value;
    }
    return seen;
  } catch {
    return {};
  }
};

const writeExtensionNoticesSeen = (seen: ExtensionNoticesSeenMap): void => {
  try {
    getSafeStorage().setItem(EXTENSION_NOTICES_SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Best-effort convenience cache — the network state stays authoritative.
  }
};

const seenListeners = new Set<() => void>();

/**
 * Subscribe to seen-marker writes in this tab. The toast effect and the
 * Recent notices button commit in the same render pass, so the button
 * cannot rely on re-reading storage when the notice list changes.
 */
export const subscribeExtensionNoticesSeen = (listener: () => void): (() => void) => {
  seenListeners.add(listener);
  return () => {
    seenListeners.delete(listener);
  };
};

/** Newest seen `createdAt` for a session, or `undefined` when never seen. */
export const getExtensionNoticesSeenAt = (
  seen: ExtensionNoticesSeenMap,
  runtimeKey: string,
  sessionId: string,
): number | undefined => {
  const value = seen[extensionNoticesSeenKeyFor(runtimeKey, sessionId)];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
};

/**
 * Record `createdAt` as seen for a session. Refreshes the entry's recency
 * and drops the least recently written entries past the bound.
 */
export const markExtensionNoticesSeen = (
  runtimeKey: string,
  sessionId: string,
  createdAt: number,
): ExtensionNoticesSeenMap => {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return readExtensionNoticesSeen();
  const seen = readExtensionNoticesSeen();
  const key = extensionNoticesSeenKeyFor(runtimeKey, sessionId);
  // Re-insert to refresh recency (plain objects preserve insertion order).
  delete seen[key];
  seen[key] = createdAt;
  const keys = Object.keys(seen);
  if (keys.length > MAX_EXTENSION_NOTICES_SEEN_ENTRIES) {
    for (const oldest of keys.slice(0, keys.length - MAX_EXTENSION_NOTICES_SEEN_ENTRIES)) {
      delete seen[oldest];
    }
  }
  writeExtensionNoticesSeen(seen);
  for (const listener of [...seenListeners]) {
    try {
      listener();
    } catch {
      // A failing subscriber must not block the others.
    }
  }
  return seen;
};

/** Notices newer than the device's last-seen marker, newest first. */
export const selectUnreadExtensionNotices = (
  notices: readonly PiReducerExtensionNotice[],
  seenAt: number | undefined,
): PiReducerExtensionNotice[] => {
  const threshold = seenAt ?? 0;
  return notices.filter((notice) => notice.createdAt > threshold).reverse();
};

/** Newest `createdAt` in the list, or `undefined` when empty. */
export const newestExtensionNoticeAt = (
  notices: readonly PiReducerExtensionNotice[],
): number | undefined => {
  let newest: number | undefined;
  for (const notice of notices) {
    if (typeof notice.createdAt === 'number' && Number.isFinite(notice.createdAt) && (newest === undefined || notice.createdAt > newest)) {
      newest = notice.createdAt;
    }
  }
  return newest;
};

/**
 * Whether a notice may toast. Only live entries toast, and only once per
 * entry (callers track shown ids). A live server-stamped entry older than
 * the guard is a replay after reconnect — list it, do not burst-toast it.
 * The guard applies only when `createdAt` came from the server so client
 * clock skew never swallows a genuinely fresh notice; when the reducer
 * recorded a skew-corrected receive time (`toastAgeBase`, resolved from the
 * event's `serverNow` sample) the guard measures against that instead of
 * `createdAt`, so a skewed client clock neither swallows fresh notices nor
 * replays stale ones. Without the sample the legacy `createdAt` behavior
 * is kept. `createdAt` itself is never adjusted: seen markers compare
 * server `createdAt` values.
 */
export const shouldToastExtensionNotice = (
  notice: PiReducerExtensionNotice,
  now: number = Date.now(),
): boolean => {
  if (notice.origin !== 'live') return false;
  if (!notice.serverTimestamp) return true;
  const ageBase = notice.toastAgeBase ?? notice.createdAt;
  return now - ageBase <= STALE_LIVE_NOTICE_TOAST_GUARD_MS;
};

/** Short relative labels (`just now` / `5 min ago` / `2 h ago` / `3 d ago`). */
export const formatExtensionNoticeTime = (createdAt: number, now: number = Date.now()): string => {
  const diffMs = now - createdAt;
  if (!Number.isFinite(diffMs) || diffMs < 60_000) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return minutes === 1 ? '1 min ago' : `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 h ago' : `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 d ago' : `${days} d ago`;
};
