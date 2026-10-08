// Bounded registry mapping notification tags to live Electron
// `Notification` handles, so `desktop_notification_close` can dismiss a
// previously shown notification by tag.
//
// Pure bookkeeping (no Electron import) so it stays unit-testable: the
// main process owns closing the handle, this module only owns the map.

export const MAX_NOTIFICATION_TAG_ENTRIES = 20;

const normalizeTag = (tag) => (typeof tag === 'string' ? tag.trim() : '');

export const createNotificationTagRegistry = (maxEntries = MAX_NOTIFICATION_TAG_ENTRIES) => {
  const limit = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : MAX_NOTIFICATION_TAG_ENTRIES;
  const byTag = new Map();

  const set = (tag, handle) => {
    const key = normalizeTag(tag);
    if (!key || handle === undefined || handle === null) return;
    // Refresh recency: a re-shown tag moves to the newest position.
    byTag.delete(key);
    byTag.set(key, handle);
    while (byTag.size > limit) {
      const oldest = byTag.keys().next().value;
      if (oldest === undefined) break;
      byTag.delete(oldest);
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

  const clear = () => {
    byTag.clear();
  };

  const size = () => byTag.size;

  return { set, get, take, remove, clear, size };
};
