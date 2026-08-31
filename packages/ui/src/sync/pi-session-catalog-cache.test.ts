import { afterEach, describe, expect, test } from 'bun:test';

import { PiSessionStore } from '@/apps/pi-session-store';
import { piClient } from '@/lib/pi/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
  createPiSessionCatalogCache,
  type PiSessionCatalogCache,
} from '@/sync/pi-session-catalog-cache';
import {
  applyDirectoryListToCatalog,
  initialCatalog,
} from '@/sync/pi-session-catalog';

const createMemoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } as Storage;
};

const listedSession = (id: string, directory: string, updatedAt: number) => ({
  session: {
    id,
    directory,
    title: `Session ${id}`,
    parentId: null,
    createdAt: updatedAt - 1,
    updatedAt,
    messageCount: 2,
  },
  preview: `Preview ${id}`,
  updatedAt,
});

const authoritativeCatalog = (directory: string, ids: readonly string[]) => (
  applyDirectoryListToCatalog(
    initialCatalog(),
    directory,
    ids.map((id, index) => listedSession(id, directory, 100 + index)),
    200,
  )
);

const caches: PiSessionCatalogCache[] = [];
const cacheFor = (storage: Storage): PiSessionCatalogCache => {
  const cache = createPiSessionCatalogCache(storage, { flushDelayMs: 0 });
  caches.push(cache);
  return cache;
};

afterEach(() => {
  for (const cache of caches.splice(0)) cache.dispose();
});

describe('Pi session catalog startup cache', () => {
  test('hydrates cached rows before any authoritative directory request', () => {
    const storage = createMemoryStorage();
    const cache = cacheFor(storage);
    const runtimeKey = getRuntimeKey();
    cache.schedule(runtimeKey, authoritativeCatalog('/workspace/a', ['one', 'two']));
    cache.flush();
    expect(cache.read(runtimeKey)?.byId.size).toBe(2);

    let requestedRuntimeKey = '';
    const readSizes: number[] = [];
    const observingCache: PiSessionCatalogCache = {
      ...cache,
      read: (key) => {
        requestedRuntimeKey = key;
        const restored = cache.read(runtimeKey);
        readSizes.push(restored?.byId.size ?? -1);
        return restored;
      },
    };
    const store = new PiSessionStore(observingCache);
    try {
      expect(requestedRuntimeKey).toBe(runtimeKey);
      expect(readSizes).toEqual([2]);
      expect([...store.getState().catalog.byId.values()].map((row) => row.id)).toEqual(['one', 'two']);
      expect(store.getState().catalog.listStatusByDirectory.get('/workspace/a')).toBe('idle');
    } finally {
      store.dispose();
    }
  });

  test('successful empty revalidation replaces cached rows and persists an empty tombstone', async () => {
    const storage = createMemoryStorage();
    const cache = cacheFor(storage);
    const runtimeKey = getRuntimeKey();
    cache.schedule(runtimeKey, authoritativeCatalog('/workspace/a', ['one']));
    cache.flush();
    const originalListSessions = piClient.listSessions;
    piClient.listSessions = (async () => ({ sessions: [] })) as typeof piClient.listSessions;

    const store = new PiSessionStore(cache);
    try {
      await store.refreshDirectoryCatalog('/workspace/a');
      expect(store.getState().catalog.byId.size).toBe(0);
      expect(store.getState().catalog.byDirectory.get('/workspace/a')).toEqual([]);
      expect(store.getState().catalog.listStatusByDirectory.get('/workspace/a')).toBe('ready');
    } finally {
      piClient.listSessions = originalListSessions;
      store.dispose();
    }

    const restored = cache.read(runtimeKey);
    expect(restored?.byDirectory.get('/workspace/a')).toEqual([]);
    expect(restored?.listStatusByDirectory.get('/workspace/a')).toBe('idle');
  });

  test('failed revalidation preserves cached rows and the next warm-start snapshot', async () => {
    const storage = createMemoryStorage();
    const cache = cacheFor(storage);
    const runtimeKey = getRuntimeKey();
    cache.schedule(runtimeKey, authoritativeCatalog('/workspace/a', ['one']));
    cache.flush();
    const originalListSessions = piClient.listSessions;
    piClient.listSessions = (async () => { throw new Error('offline'); }) as typeof piClient.listSessions;

    const store = new PiSessionStore(cache);
    try {
      const result = await store.refreshDirectoryCatalog('/workspace/a');
      expect(result.ok).toBe(false);
      expect(store.getState().catalog.byId.has('one')).toBe(true);
      expect(store.getState().catalog.listStatusByDirectory.get('/workspace/a')).toBe('failed');
    } finally {
      piClient.listSessions = originalListSessions;
      store.dispose();
    }

    expect(cache.read(runtimeKey)?.byId.has('one')).toBe(true);
  });

  test('restores stable metadata but never restores historical live activity', () => {
    const storage = createMemoryStorage();
    const writer = cacheFor(storage);
    const catalog = authoritativeCatalog('/workspace/a', ['one']);
    const row = catalog.byId.get('one');
    expect(row).toBeDefined();
    const busyCatalog = {
      ...catalog,
      byId: new Map(catalog.byId).set('one', { ...row!, lifecycle: 'busy' as const, hydrated: true }),
    };
    writer.schedule('runtime-a', busyCatalog);
    writer.flush();

    const restored = writer.read('runtime-a');
    const restoredRow = restored?.byId.get('one');
    expect({
      title: restoredRow?.title,
      preview: restoredRow?.preview,
      messageCount: restoredRow?.messageCount,
      lifecycle: restoredRow?.lifecycle,
      hydrated: restoredRow?.hydrated,
    }).toEqual({
      title: 'Session one',
      preview: 'Preview one',
      messageCount: 2,
      lifecycle: 'idle',
      hydrated: false,
    });
    expect(restored?.listStatusByDirectory.get('/workspace/a')).toBe('idle');
  });

  test('distinguishes a missing runtime from a cached authoritative-empty directory', () => {
    const storage = createMemoryStorage();
    const cache = cacheFor(storage);
    const empty = applyDirectoryListToCatalog(initialCatalog(), '/workspace/empty', [], 100);
    cache.schedule('runtime-a', empty);
    cache.flush();

    expect(cache.read('missing-runtime')).toBeNull();
    const restored = cache.read('runtime-a');
    expect(restored).not.toBeNull();
    expect(restored?.byDirectory.get('/workspace/empty')).toEqual([]);
    expect(restored?.listStatusByDirectory.get('/workspace/empty')).toBe('idle');
  });

  test('rejects a malformed snapshot instead of granting it partial authority', () => {
    const storage = createMemoryStorage();
    storage.setItem('pichamber.piSessionCatalog.v1', JSON.stringify({
      version: 1,
      runtimes: {
        'runtime-a': {
          updatedAt: 1,
          directories: [{ directory: '/workspace/a', sessions: [{ id: '', title: 'broken' }] }],
        },
      },
    }));
    const cache = cacheFor(storage);

    expect(cache.read('runtime-a')).toBeNull();
  });

  test('serializes pending snapshots per runtime without cross-runtime replacement', () => {
    const storage = createMemoryStorage();
    const cache = cacheFor(storage);
    cache.schedule('runtime-a', authoritativeCatalog('/workspace/a', ['one']));
    cache.schedule('runtime-b', authoritativeCatalog('/workspace/b', ['two']));
    cache.flush();

    expect(cache.read('runtime-a')?.byId.has('one')).toBe(true);
    expect(cache.read('runtime-a')?.byId.has('two')).toBe(false);
    expect(cache.read('runtime-b')?.byId.has('two')).toBe(true);
    expect(cache.read('runtime-b')?.byId.has('one')).toBe(false);
  });
});
