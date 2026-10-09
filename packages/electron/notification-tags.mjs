// Bounded registry mapping notification tags to live Electron
// `Notification` handles, so `desktop_notification_close` can dismiss a
// previously shown notification by tag.
//
// Pure bookkeeping (no Electron import) so it stays unit-testable: the
// main process owns closing the handle, this module only owns the map.

export const MAX_NOTIFICATION_TAG_ENTRIES = 20;

const INPUT_NOTIFICATION_TAG_PREFIX = 'pichamber:input:';

const normalizeTag = (tag) => (typeof tag === 'string' ? tag.trim() : '');

// Only needs-input notifications need programmatic close (dismissed when
// the session is opened/answered). Completion/error notifications carry
// unique tags and must never be tracked: tracking them would evict (and
// force-close) the oldest still-unread notification past the bound.
export const isCloseableInputNotification = (tag, kind) => {
  if (kind !== 'input') return false;
  const key = normalizeTag(tag);
  return key.startsWith(INPUT_NOTIFICATION_TAG_PREFIX) && key.length > INPUT_NOTIFICATION_TAG_PREFIX.length;
};

export const createNotificationTagRegistry = (maxEntries = MAX_NOTIFICATION_TAG_ENTRIES) => {
  const limit = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : MAX_NOTIFICATION_TAG_ENTRIES;
  const byTag = new Map();

  const closeHandle = (handle) => {
    try {
      handle?.close?.();
    } catch {}
  };

  const set = (tag, handle) => {
    const key = normalizeTag(tag);
    if (!key || handle === undefined || handle === null) return;
    const existing = byTag.get(key);
    // Refresh recency: a re-shown tag moves to the newest position.
    byTag.delete(key);
    // A re-used tag replaces the previous notification (the OS replaces
    // same-tag notifications), so close the orphaned handle best-effort.
    if (existing !== undefined && existing !== handle) closeHandle(existing);
    byTag.set(key, handle);
    while (byTag.size > limit) {
      const oldest = byTag.keys().next().value;
      if (oldest === undefined) break;
      const evicted = byTag.get(oldest);
      byTag.delete(oldest);
      // An evicted entry could never be closed by tag again; close it
      // best-effort instead of orphaning it.
      closeHandle(evicted);
    }
  };

  const get = (tag) => {
    const key = normalizeTag(tag);
    if (!key) return undefined;
    return byTag.get(key);
  };

  /** Remove and return the handle for `tag` (`undefined` when absent). */
  const take = (tag) => {
    const key = normalizeTag(tag);
    if (!key) return undefined;
    const handle = byTag.get(key);
    byTag.delete(key);
    return handle;
  };

  const remove = (tag) => {
    const key = normalizeTag(tag);
    if (!key) return false;
    return byTag.delete(key);
  };

  /** Delete `tag` only when it still maps to `handle` (stale close/click
   *  handlers must not orphan the newer notification re-using the tag). */
  const release = (tag, handle) => {
    const key = normalizeTag(tag);
    if (!key) return false;
    if (byTag.get(key) !== handle) return false;
    byTag.delete(key);
    return true;
  };

  const clear = () => {
    byTag.clear();
  };

  const size = () => byTag.size;

  return { set, get, take, remove, release, clear, size };
};
