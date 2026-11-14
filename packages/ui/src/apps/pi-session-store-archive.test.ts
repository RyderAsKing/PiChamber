import { describe, expect, test } from 'bun:test';

import { PiSessionStore } from '@/apps/pi-session-store';
import { piClient } from '@/lib/pi/client';
import { getTimelineBoundaries, groupTimelineItems } from '@/components/session/sidebar/timelineBuckets';
import { initialCatalog, liveSessionRecordToUiSession, type LiveSessionRecord } from '@/sync/pi-session-catalog';

// Archive is optimistic: the row leaves the sidebar at once, and a failed
// write puts it back unless a newer archive change replaced it.

type StoreInternal = { state: ReturnType<PiSessionStore['getState']> };

const record = (id: string): LiveSessionRecord => ({
  id,
  directory: '/repo',
  parentId: null,
  title: id,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  lifecycle: 'idle',
  hydrated: false,
});

const seededStore = () => {
  const store = new PiSessionStore();
  (store as unknown as StoreInternal).state = {
    ...store.getState(),
    directory: '/repo',
    connection: 'ready',
    catalog: {
      ...initialCatalog(),
      byId: new Map([['s-1', record('s-1')]]),
      byDirectory: new Map([['/repo', ['s-1']]]),
      listStatusByDirectory: new Map([['/repo', 'ready']]),
    },
  };
  return store;
};

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const withArchiveStub = async (
  impl: (input: { sessionId: string; archived: boolean }) => Promise<void>,
  run: () => Promise<void>,
) => {
  const original = piClient.archiveSession.bind(piClient);
  piClient.archiveSession = ((input: { sessionId: string; archived: boolean }) => impl(input)) as typeof piClient.archiveSession;
  try {
    await run();
  } finally {
    piClient.archiveSession = original;
  }
};

const archivedOf = (store: PiSessionStore) => store.getState().catalog.byId.get('s-1')?.archived;
const rowOf = (store: PiSessionStore) => store.getState().catalog.byId.get('s-1');

describe('PiSessionStore.archive', () => {
  test('marks the row archived before the server answers', async () => {
    const store = seededStore();
    const write = deferred();
    await withArchiveStub(() => write.promise, async () => {
      const pending = store.archive('s-1', true);
      expect(archivedOf(store)).toBe(true);
      write.resolve();
      await pending;
      expect(archivedOf(store)).toBe(true);
    });
  });

  test('a failed write rolls the row back and rethrows', async () => {
    const store = seededStore();
    await withArchiveStub(async () => {
      throw new Error('offline');
    }, async () => {
      await expect(store.archive('s-1', true)).rejects.toThrow('offline');
      expect(archivedOf(store)).toBe(false);
    });
  });

  // Archive state is not activity: last-prompt recency (`updatedAt`) never
  // moves, so Timeline and the session order keep the real date.
  test('archive and unarchive keep updatedAt; archive stamps archivedAt', async () => {
    const store = seededStore();
    await withArchiveStub(async () => undefined, async () => {
      const before = Date.now();
      await store.archive('s-1', true);
      expect(rowOf(store)?.updatedAt).toBe(2);
      expect(rowOf(store)?.archivedAt).toBeGreaterThanOrEqual(before);
      await store.archive('s-1', false);
      expect(rowOf(store)?.archived).toBe(false);
      expect(rowOf(store)?.updatedAt).toBe(2);
      expect(rowOf(store)?.archivedAt).toBeUndefined();
    });
  });

  test('a failed archive restores the flag without touching updatedAt', async () => {
    const store = seededStore();
    await withArchiveStub(async () => {
      throw new Error('offline');
    }, async () => {
      await expect(store.archive('s-1', true)).rejects.toThrow('offline');
      expect(rowOf(store)?.archived).toBe(false);
      expect(rowOf(store)?.archivedAt).toBeUndefined();
      expect(rowOf(store)?.updatedAt).toBe(2);
    });
  });

  test('a failed unarchive restores the archive time without touching updatedAt', async () => {
    const store = seededStore();
    const internal = store as unknown as StoreInternal;
    const catalog = internal.state.catalog;
    internal.state = {
      ...internal.state,
      catalog: { ...catalog, byId: new Map([['s-1', { ...record('s-1'), archived: true, archivedAt: 40 }]]) },
    };
    await withArchiveStub(async () => {
      throw new Error('offline');
    }, async () => {
      await expect(store.archive('s-1', false)).rejects.toThrow('offline');
      expect(rowOf(store)?.archived).toBe(true);
      expect(rowOf(store)?.archivedAt).toBe(40);
      expect(rowOf(store)?.updatedAt).toBe(2);
    });
  });

  test('Timeline groups an old session under its real date after archiving', async () => {
    const now = Date.now();
    const boundaries = getTimelineBoundaries(now, 1);
    const store = seededStore();
    const internal = store as unknown as StoreInternal;
    const catalog = internal.state.catalog;
    const oldAt = boundaries.startOfLastWeek - 30 * 24 * 60 * 60 * 1000;
    internal.state = {
      ...internal.state,
      catalog: { ...catalog, byId: new Map([['s-1', { ...record('s-1'), updatedAt: oldAt }]]) },
    };
    await withArchiveStub(async () => undefined, async () => {
      await store.archive('s-1', true);
      await store.archive('s-1', false);
      await store.archive('s-1', true);
    });
    const row = rowOf(store);
    if (!row) throw new Error('row missing');
    const session = liveSessionRecordToUiSession(row);
    const groups = groupTimelineItems([session], {
      getTimestamp: (item) => item.time?.updated || item.time?.created || 0,
      isPinned: () => false,
      boundaries,
    });
    expect(groups.map((group) => group.id)).toEqual(['older']);
  });

  test('a late failure does not undo a newer archive change', async () => {
    const store = seededStore();
    const first = deferred();
    const calls: boolean[] = [];
    await withArchiveStub((input) => {
      calls.push(input.archived);
      return calls.length === 1 ? first.promise : Promise.resolve();
    }, async () => {
      const archiving = store.archive('s-1', true);
      await store.archive('s-1', false);
      first.reject(new Error('late'));
      await expect(archiving).rejects.toThrow('late');
      expect(archivedOf(store)).toBe(false);
    });
  });
});
