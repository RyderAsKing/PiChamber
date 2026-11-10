import { describe, expect, test } from 'bun:test';

import { PiSessionStore } from '@/apps/pi-session-store';
import { piClient } from '@/lib/pi/client';
import { initialCatalog, type LiveSessionRecord } from '@/sync/pi-session-catalog';

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
