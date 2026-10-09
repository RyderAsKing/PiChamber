// Per-sender dock-badge aggregation for `desktop_tray_update`.
//
// Multiple main windows (possibly on different hosts/origins) each report
// their own needs-input count. Last-writer-wins would let a window with 0
// hide another window's count, and an unmount/runtime-switch reset would
// clear the badge globally. Instead each sender keeps its own entry keyed
// by webContents id; windows on the same origin report the same count, so
// the aggregate takes the max per origin and sums across distinct origins.
//
// Pure bookkeeping (no Electron import) so it stays unit-testable: the
// main process owns `app.setBadgeCount` and the destroyed listener, this
// module only owns the map.

const normalizeCount = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
};

const normalizeOrigin = (origin) => {
  if (typeof origin === 'string' && origin.trim().length > 0) return origin.trim();
  return '__unknown__';
};

export const originOfUrl = (url) => {
  if (typeof url !== 'string' || url.trim().length === 0) return '__unknown__';
  try {
    return new URL(url.trim()).origin;
  } catch {
    return url.trim();
  }
};

export const createDockBadgeAggregator = () => {
  // senderId -> { origin, count }
  const bySender = new Map();

  const set = (senderId, origin, count) => {
    if ((typeof senderId !== 'number' && typeof senderId !== 'string') || senderId === '') return 0;
    bySender.set(senderId, { origin: normalizeOrigin(origin), count: normalizeCount(count) });
    return total();
  };

  const remove = (senderId) => {
    bySender.delete(senderId);
    return total();
  };

  const total = () => {
    const maxByOrigin = new Map();
    for (const { origin, count } of bySender.values()) {
      const current = maxByOrigin.get(origin) ?? 0;
      if (count > current) maxByOrigin.set(origin, count);
      else if (!maxByOrigin.has(origin)) maxByOrigin.set(origin, current);
    }
    let sum = 0;
    for (const count of maxByOrigin.values()) sum += count;
    return sum;
  };

  const size = () => bySender.size;

  const clear = () => {
    bySender.clear();
  };

  return { set, remove, total, size, clear };
};
