import { describe, expect, test } from 'bun:test';

import { PiSessionStore } from '@/apps/pi-session-store';
import { piClient } from '@/lib/pi/client';
import { initialCatalog, type LiveSessionRecord } from '@/sync/pi-session-catalog';

type StoreInternal = {
  state: ReturnType<PiSessionStore['getState']>;
};

const asInternal = (store: PiSessionStore): StoreInternal =>
  store as unknown as StoreInternal;

const record = (id: string, directory: string): LiveSessionRecord => ({
  id,
  directory,
  parentId: null,
  title: id,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  lifecycle: 'idle',
  hydrated: false,
});

const seed = (store: PiSessionStore) => {
  asInternal(store).state = {
    ...store.getState(),
    directory: '/focused',
    connection: 'ready',
    sessions: [{ session: { id: 'focused-1', directory: '/focused' } } as never],
    catalog: {
      ...initialCatalog(),
      byId: new Map([
        ['foreign-1', record('foreign-1', '/other')],
        ['focused-1', record('focused-1', '/focused')],
      ]),
      byDirectory: new Map([
        ['/other', ['foreign-1']],
        ['/focused', ['focused-1']],
      ]),
      listStatusByDirectory: new Map([
        ['/other', 'ready'],
        ['/focused', 'ready'],
      ]),
    },
  };
};

const stubArchive = (captured: Array<string | undefined>) => {
  const original = piClient.archiveSession.bind(piClient);
  piClient.archiveSession = (async (_input, scope) => {
    captured.push(scope?.directory);
  }) as typeof piClient.archiveSession;
  return () => {
    piClient.archiveSession = original;
  };
};

const stubDelete = (captured: Array<string | undefined>) => {
  const original = piClient.deleteSession.bind(piClient);
  piClient.deleteSession = (async (_input, scope) => {
    captured.push(scope?.directory);
    return true;
  }) as typeof piClient.deleteSession;
  return () => {
    piClient.deleteSession = original;
  };
};

describe('retention directory threading', () => {
  test('archive uses catalog directory for foreign sessions, not focused dir', async () => {
    const store = new PiSessionStore();
    const captured: Array<string | undefined> = [];
    const restore = stubArchive(captured);
    try {
      seed(store);
      await store.archive('foreign-1', true);
      expect(captured).toEqual(['/other']);
    } finally {
      restore();
      store.dispose();
    }
  });

  test('archive prefers explicit directory over catalog', async () => {
    const store = new PiSessionStore();
    const captured: Array<string | undefined> = [];
    const restore = stubArchive(captured);
    try {
      seed(store);
      await store.archive('foreign-1', true, '/explicit');
      expect(captured).toEqual(['/explicit']);
    } finally {
      restore();
      store.dispose();
    }
  });

  test('remove forwards owning directory for foreign sessions', async () => {
    const store = new PiSessionStore();
    const captured: Array<string | undefined> = [];
    const restore = stubDelete(captured);
    try {
      seed(store);
      await store.remove('foreign-1');
      expect(captured).toEqual(['/other']);
    } finally {
      restore();
      store.dispose();
    }
  });

  test('remove prefers explicit directory over catalog', async () => {
    const store = new PiSessionStore();
    const captured: Array<string | undefined> = [];
    const restore = stubDelete(captured);
    try {
      seed(store);
      await store.remove('foreign-1', '/explicit');
      expect(captured).toEqual(['/explicit']);
    } finally {
      restore();
      store.dispose();
    }
  });
});
