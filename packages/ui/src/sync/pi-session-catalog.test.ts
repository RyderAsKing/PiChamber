import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { getPiSessionStore, PiSessionStore } from '@/apps/pi-session-store';
import { PiRequestError, piClient } from '@/lib/pi/client';
import type { PiSessionEvent } from '@/lib/pi/protocol';
import { useNotificationStore } from '@/sync/notification-store';
import { resetSessionOrdering } from '@/sync/session-ordering';
import {
  applyDirectoryListToCatalog,
  applyLifecycleChange,
  initialCatalog,
  liveSessionRecordToUiSession,
  mapDirectoriesWithRefreshSlot,
  markDirectoryFailed,
  removeRecord,
  upsertRecord,
  __resetDirectoryRefreshSchedulerForTests,
  withDirectoryRefreshSlot,
  type LiveSessionRecord,
} from '@/sync/pi-session-catalog';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const listItem = (id: string, directory: string, overrides?: {
  title?: string;
  archived?: boolean;
  timeArchived?: number;
  updatedAt?: number;
  createdAt?: number;
  parentId?: string | null;
  preview?: string;
  messageCount?: number;
}) => ({
  session: {
    id,
    directory,
    title: overrides?.title ?? id,
    createdAt: overrides?.createdAt ?? 1,
    updatedAt: overrides?.updatedAt ?? 1,
    parentId: overrides?.parentId ?? null,
    ...(overrides?.archived !== undefined ? { archived: overrides.archived } : {}),
    ...(overrides?.timeArchived !== undefined ? { timeArchived: overrides.timeArchived } : {}),
    ...(overrides?.messageCount !== undefined ? { messageCount: overrides.messageCount } : {}),
  },
  updatedAt: overrides?.updatedAt ?? 1,
  ...(overrides?.preview !== undefined ? { preview: overrides.preview } : {}),
});

const lifecycleEvent = (sessionId: string, directory: string, state: 'idle' | 'busy' | 'retry' | 'error', sequence = 1): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'session.lifecycle',
  sequence,
  sessionId,
  directory,
  payload: { state },
});

interface StubOptions {
  selectProject?: (dir: string) => Promise<{ directory: string }>;
  listSessions?: (scope: { directory?: string }) => Promise<{ sessions: ReturnType<typeof listItem>[] }>;
  getSession?: (id: string) => Promise<unknown>;
  health?: () => Promise<unknown>;
  getSettings?: () => Promise<unknown>;
  createSession?: (input: unknown) => Promise<{ session: ReturnType<typeof listItem>['session'] }>;
  renameSession?: (input: { sessionId: string; title: string }) => Promise<unknown>;
  archiveSession?: (input: { sessionId: string; archived: boolean }) => Promise<unknown>;
  deleteSession?: (input: { sessionId: string }) => Promise<unknown>;
}

const stubDaemons = (options: StubOptions = {}) => {
  const originals = {
    selectProject: piClient.selectProject.bind(piClient),
    listSessions: piClient.listSessions.bind(piClient),
    getSession: piClient.getSession.bind(piClient),
    health: piClient.health.bind(piClient),
    getSettings: piClient.getSettings.bind(piClient),
    createSession: piClient.createSession.bind(piClient),
    renameSession: piClient.renameSession.bind(piClient),
    archiveSession: piClient.archiveSession.bind(piClient),
    deleteSession: piClient.deleteSession.bind(piClient),
  };
  piClient.selectProject = (async (dir: string) =>
    options.selectProject ? options.selectProject(dir) : { directory: dir }) as typeof piClient.selectProject;
  piClient.listSessions = (async (scope: { directory?: string }) => {
    if (options.listSessions) return options.listSessions(scope);
    return { sessions: [] };
  }) as typeof piClient.listSessions;
  piClient.getSession = (async (id: string) => {
    if (options.getSession) return options.getSession(id);
    return {
      session: { id, directory: '/repo', createdAt: 0, updatedAt: 0 },
      lastSequence: 0,
      messages: [],
    };
  }) as typeof piClient.getSession;
  piClient.health = (async () =>
    options.health ? options.health() : { state: 'ready', protocolVersion: 1, capabilities: [] }) as typeof piClient.health;
  piClient.getSettings = (async () =>
    options.getSettings ? options.getSettings() : {
      pi: { global: {}, project: { trusted: true } },
      pichamber: { version: 1 },
    }) as typeof piClient.getSettings;
  piClient.createSession = (async (input: unknown) => {
    if (options.createSession) return options.createSession(input);
    const sessionId = (input as { cwd?: string }).cwd ? `created-${Math.random().toString(36).slice(2, 8)}` : 'created';
    return {
      session: {
        id: sessionId,
        directory: (input as { cwd: string }).cwd,
        title: (input as { title?: string }).title ?? 'Untitled',
        createdAt: 1,
        updatedAt: 1,
      },
      lastSequence: 0,
      messages: [],
    };
  }) as typeof piClient.createSession;
  piClient.renameSession = (async (input: { sessionId: string; title: string }) => {
    if (options.renameSession) return options.renameSession(input);
    return { session: { id: input.sessionId, title: input.title } };
  }) as typeof piClient.renameSession;
  piClient.archiveSession = (async (input: { sessionId: string; archived: boolean }) => {
    if (options.archiveSession) return options.archiveSession(input);
    return { session: { id: input.sessionId, archived: input.archived } };
  }) as typeof piClient.archiveSession;
  piClient.deleteSession = (async (input: { sessionId: string }) => {
    if (options.deleteSession) return options.deleteSession(input);
    return { session: { id: input.sessionId } };
  }) as typeof piClient.deleteSession;
  return {
    restore: () => {
      piClient.selectProject = originals.selectProject;
      piClient.listSessions = originals.listSessions;
      piClient.getSession = originals.getSession;
      piClient.health = originals.health;
      piClient.getSettings = originals.getSettings;
      piClient.createSession = originals.createSession;
      piClient.renameSession = originals.renameSession;
      piClient.archiveSession = originals.archiveSession;
      piClient.deleteSession = originals.deleteSession;
    },
  };
};

const tickMicrotasks = async (count = 8) => {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
};

beforeEach(() => {
  resetSessionOrdering();
  useNotificationStore.setState({
    list: [],
    index: {
      session: { unseenCount: {}, unseenHasError: {} },
      project: { unseenCount: {}, unseenHasError: {} },
    },
  });
});

afterEach(() => {
  resetSessionOrdering();
  __resetDirectoryRefreshSchedulerForTests();
});

// ---------------------------------------------------------------------------
// Pure helper contract — LiveSessionRecord + structural no-op rules.
// ---------------------------------------------------------------------------

describe('pi-session-catalog helpers', () => {
  test('applyDirectoryListToCatalog replaces that directory\u2019s membership and preserves others', () => {
    const initial = applyDirectoryListToCatalog(initialCatalog(), '/repo-a', [
      listItem('a-1', '/repo-a'),
      listItem('a-2', '/repo-a'),
    ], 100);
    expect([...initial.byDirectory.get('/repo-a') ?? []]).toEqual(['a-1', 'a-2']);
    expect(initial.listStatusByDirectory.get('/repo-a')).toBe('ready');

    const next = applyDirectoryListToCatalog(initial, '/repo-a', [
      listItem('a-1', '/repo-a'),
      listItem('a-3', '/repo-a'),
    ], 200);
    expect([...next.byDirectory.get('/repo-a') ?? []]).toEqual(['a-1', 'a-3']);
    // a-2 dropped from byId and from /repo-a membership.
    expect(next.byId.has('a-2')).toBe(false);
    expect(next.byId.has('a-1')).toBe(true);
    expect(next.byId.has('a-3')).toBe(true);
  });

  test('applyDirectoryListToCatalog ignores cross-directory leakage', () => {
    const state = applyDirectoryListToCatalog(initialCatalog(), '/repo-a', [
      listItem('rogue', '/repo-b'),
      listItem('a-1', '/repo-a'),
    ], 100);
    expect(state.byId.has('rogue')).toBe(false);
    expect(state.byId.has('a-1')).toBe(true);
    expect([...state.byDirectory.get('/repo-a') ?? []]).toEqual(['a-1']);
    expect(state.byDirectory.has('/repo-b')).toBe(false);
  });

  test('classifies restored sessions (timeArchived === 0) as active', () => {
    const state = applyDirectoryListToCatalog(initialCatalog(), '/repo-a', [
      listItem('active', '/repo-a'),
      listItem('restored', '/repo-a', { archived: true, timeArchived: 0 }),
      listItem('archived', '/repo-a', { archived: true, timeArchived: 5 }),
    ], 100);
    expect(state.byId.get('active')?.archived).toBe(false);
    expect(state.byId.get('restored')?.archived).toBe(false);
    expect(state.byId.get('archived')?.archived).toBe(true);
  });

  test('applyLifecycleChange is a no-op when the value matches', () => {
    const seeded = applyDirectoryListToCatalog(initialCatalog(), '/repo-a', [listItem('s', '/repo-a')], 100);
    const same = applyLifecycleChange(seeded, 's', 'idle');
    expect(same).toBe(seeded);
    const flipped = applyLifecycleChange(seeded, 's', 'busy');
    expect(flipped).not.toBe(seeded);
    expect(flipped.byId.get('s')?.lifecycle).toBe('busy');
    // Other entries keep their reference.
    expect(flipped.byId.get('s')).not.toBe(seeded.byId.get('s'));
  });

  test('removeRecord drops both byId and byDirectory membership', () => {
    const seeded = applyDirectoryListToCatalog(initialCatalog(), '/repo-a', [
      listItem('a-1', '/repo-a'),
      listItem('a-2', '/repo-a'),
    ], 100);
    const next = removeRecord(seeded, 'a-1');
    expect(next.byId.has('a-1')).toBe(false);
    expect([...next.byDirectory.get('/repo-a') ?? []]).toEqual(['a-2']);
  });

  test('upsertRecord puts a newly created session at the front of its directory', () => {
    const seeded = applyDirectoryListToCatalog(initialCatalog(), '/repo-a', [
      listItem('a-1', '/repo-a'),
      listItem('a-2', '/repo-a'),
    ], 100);
    const freshRecord: LiveSessionRecord = {
      id: 'a-new',
      directory: '/repo-a',
      parentId: null,
      title: 'fresh',
      archived: false,
      createdAt: 10,
      updatedAt: 10,
      lifecycle: 'idle',
      hydrated: false,
    };
    const next = upsertRecord(seeded, freshRecord);
    expect([...next.byDirectory.get('/repo-a') ?? []]).toEqual(['a-new', 'a-1', 'a-2']);
    expect(next.byId.get('a-new')?.title).toBe('fresh');
  });

  test('markDirectoryFailed preserves existing rows; failure is not empty success', () => {
    const seeded = applyDirectoryListToCatalog(initialCatalog(), '/repo-a', [
      listItem('a-1', '/repo-a'),
    ], 100);
    const failed = markDirectoryFailed(seeded, '/repo-a');
    expect(failed.listStatusByDirectory.get('/repo-a')).toBe('failed');
    expect(failed.byId.has('a-1')).toBe(true);
  });

  test('liveSessionRecordToUiSession drops time.archived for restored sessions', () => {
    const record: LiveSessionRecord = {
      id: 'restored',
      directory: '/repo-a',
      parentId: null,
      title: 'restored',
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      lifecycle: 'idle',
      hydrated: false,
    };
    const ui = liveSessionRecordToUiSession(record);
    expect(ui.time?.archived).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Concurrency-2 scheduler — same rule the retiring global store used.
// ---------------------------------------------------------------------------

describe('pi-session-catalog concurrency scheduler', () => {
  test('runs at most two tasks in flight at any moment', async () => {
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 6 }, (_, index) => async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 8));
      active -= 1;
      return index;
    });
    const results = await mapDirectoriesWithRefreshSlot(tasks, async (task) => task());
    expect(results).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak <= 2).toBe(true);
  });

  test('withDirectoryRefreshSlot releases the slot on error', async () => {
    let active = 0;
    let peak = 0;
    const failing = withDirectoryRefreshSlot(async () => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        throw new Error('boom');
      } finally {
        active -= 1;
      }
    });
    await expect(failing).rejects.toThrow('boom');
    // Subsequent tasks should still get a slot.
    const after = await withDirectoryRefreshSlot(async () => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        return 'ok';
      } finally {
        active -= 1;
      }
    });
    expect(after).toBe('ok');
    expect(peak <= 2).toBe(true);
    expect(active).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Store integration — catalog fills from per-directory listings; events
// mirror into the catalog; partial failure does not erase other
// directories; reference identity is preserved for unaffected rows.
// ---------------------------------------------------------------------------

describe('PiSessionStore catalog', () => {
  test('lists A and B while focused on A; catalog holds both directories', async () => {
    const stubs = stubDaemons({
      listSessions: async (scope) => {
        const directory = scope.directory ?? '';
        if (directory === '/repo-a') {
          return { sessions: [listItem('a-1', '/repo-a', { updatedAt: 1 })] };
        }
        if (directory === '/repo-b') {
          return { sessions: [listItem('b-1', '/repo-b', { updatedAt: 2 })] };
        }
        return { sessions: [] };
      },
      getSession: async (id) => ({
        session: { id, directory: id.startsWith('a-') ? '/repo-a' : '/repo-b', createdAt: 0, updatedAt: 0 },
        lastSequence: 0,
        messages: [],
      }),
    });

    const store = new PiSessionStore();
    try {
      await store.start({ directory: '/repo-a' });
      await tickMicrotasks();
      await store.refreshDirectoryCatalog('/repo-b');
      await tickMicrotasks();

      const catalog = store.getState().catalog;
      expect(catalog.byId.has('a-1')).toBe(true);
      expect(catalog.byId.has('b-1')).toBe(true);
      expect(catalog.listStatusByDirectory.get('/repo-a')).toBe('ready');
      expect(catalog.listStatusByDirectory.get('/repo-b')).toBe('ready');
    } finally {
      stubs.restore();
      store.dispose();
    }
  });

  test('a busy event for B updates B\u2019s lifecycle without rebuilding A\u2019s row', async () => {
    const stubs = stubDaemons({
      listSessions: async (scope) => {
        const directory = scope.directory ?? '';
        return {
          sessions: directory === '/repo-a'
            ? [listItem('a-1', '/repo-a')]
            : [listItem('b-1', '/repo-b')],
        };
      },
      getSession: async (id) => ({
        session: { id, directory: id.startsWith('a-') ? '/repo-a' : '/repo-b', createdAt: 0, updatedAt: 0 },
        lastSequence: 0,
        messages: [],
      }),
    });

    const store = new PiSessionStore();
    try {
      await store.start({ directory: '/repo-a' });
      await tickMicrotasks();
      await store.refreshDirectoryCatalog('/repo-b');
      await tickMicrotasks();

      const aRowBefore = store.getState().catalog.byId.get('a-1');
      expect(aRowBefore?.lifecycle).toBe('idle');

      // Drive a busy event for the unfocused B session.
      const internal = store as unknown as { commitEvents: (events: PiSessionEvent[]) => void };
      internal.commitEvents([lifecycleEvent('b-1', '/repo-b', 'busy', 5)]);
      await tickMicrotasks();

      const catalog = store.getState().catalog;
      expect(catalog.byId.get('b-1')?.lifecycle).toBe('busy');
      // A's catalog record reference is unchanged \u2014 narrow no-op.
      expect(catalog.byId.get('a-1')).toBe(aRowBefore);
    } finally {
      stubs.restore();
      store.dispose();
    }
  });

  test('a failed list for C does not drop A or B; status flips to failed for C only', async () => {
    const stubs = stubDaemons({
      listSessions: async (scope) => {
        const directory = scope.directory ?? '';
        if (directory === '/repo-c') {
          throw new PiRequestError('DAEMON_UNAVAILABLE', 'simulated list failure');
        }
        return {
          sessions: directory === '/repo-a'
            ? [listItem('a-1', '/repo-a')]
            : [listItem('b-1', '/repo-b')],
        };
      },
      getSession: async (id) => ({
        session: { id, directory: id.startsWith('a-') ? '/repo-a' : '/repo-b', createdAt: 0, updatedAt: 0 },
        lastSequence: 0,
        messages: [],
      }),
    });

    const store = new PiSessionStore();
    try {
      await store.start({ directory: '/repo-a' });
      await tickMicrotasks();
      await store.refreshDirectoryCatalog('/repo-b');
      await tickMicrotasks();
      const result = await store.refreshDirectoryCatalog('/repo-c');
      await tickMicrotasks();

      expect(result.ok).toBe(false);
      const catalog = store.getState().catalog;
      expect(catalog.byId.has('a-1')).toBe(true);
      expect(catalog.byId.has('b-1')).toBe(true);
      expect(catalog.listStatusByDirectory.get('/repo-a')).toBe('ready');
      expect(catalog.listStatusByDirectory.get('/repo-b')).toBe('ready');
      expect(catalog.listStatusByDirectory.get('/repo-c')).toBe('failed');
    } finally {
      stubs.restore();
      store.dispose();
    }
  });

  test('create/rename/archive/remove update the catalog membership and metadata', async () => {
    const stubs = stubDaemons({
      listSessions: async () => ({ sessions: [listItem('seed', '/repo-a', { updatedAt: 1 })] }),
      getSession: async (id) => ({
        session: { id, directory: '/repo-a', createdAt: 0, updatedAt: 0 },
        lastSequence: 0,
        messages: [],
      }),
    });

    const store = new PiSessionStore();
    try {
      await store.start({ directory: '/repo-a' });
      await tickMicrotasks();

      const createdId = await store.create('New chat');
      await tickMicrotasks();
      const afterCreate = store.getState().catalog.byId.get(createdId);
      expect(afterCreate?.title).toBe('New chat');
      expect(afterCreate?.archived).toBe(false);

      await store.rename(createdId, 'Renamed');
      const afterRename = store.getState().catalog.byId.get(createdId);
      expect(afterRename?.title).toBe('Renamed');

      await store.archive(createdId, true);
      const afterArchive = store.getState().catalog.byId.get(createdId);
      expect(afterArchive?.archived).toBe(true);

      await store.remove(createdId);
      const afterRemove = store.getState().catalog.byId.get(createdId);
      expect(afterRemove).toBeFalsy();
      expect(store.getState().catalog.byDirectory.get('/repo-a')).not.toContain(createdId);
    } finally {
      stubs.restore();
      store.dispose();
    }
  });

  test('LRU eviction flips the catalog\u2019s hydrated flag without dropping the row', async () => {
    // Build enough sessions to overflow the soft cap (16) so the eviction
    // pass actually has work to do.
    const sessionIds = Array.from({ length: 24 }, (_, index) => `idle-${index}`);
    const stubs = stubDaemons({
      listSessions: async () => ({
        sessions: sessionIds.map((id, index) => listItem(id, '/repo', { updatedAt: index + 1 })),
      }),
      getSession: async (id) => ({
        session: { id, directory: '/repo', createdAt: 0, updatedAt: 0 },
        lastSequence: 0,
        messages: [],
      }),
    });

    const store = new PiSessionStore();
    try {
      await store.start({ directory: '/repo' });
      await tickMicrotasks();
      // Force hydrate each session so the catalog rows flip to hydrated
      // and the reducer's bySession map holds every one of them.
      for (const id of sessionIds) {
        await store.ensureHydrated(id);
      }
      await tickMicrotasks();

      const internal = store as unknown as {
        state: ReturnType<PiSessionStore['getState']>;
        evictIdleTranscripts: () => void;
      };
      internal.evictIdleTranscripts();

      const catalog = store.getState().catalog;
      const evicted = sessionIds.filter((id) => {
        const row = catalog.byId.get(id);
        return row && row.hydrated === false;
      });
      const retained = sessionIds.filter((id) => {
        const row = catalog.byId.get(id);
        return row && row.hydrated === true;
      });
      // The store holds 24 idle sessions; after eviction some should be
      // dropped from bySession and have their catalog `hydrated` flag
      // flipped to false, while survivors keep `hydrated: true`.
      expect(evicted.length).toBeGreaterThan(0);
      expect(retained.length).toBeGreaterThan(0);
    } finally {
      stubs.restore();
      store.dispose();
    }
  });

  test('runtime switch resets the catalog via dispose / resetForRuntime', async () => {
    const stubs = stubDaemons({
      listSessions: async () => ({ sessions: [listItem('a-1', '/repo-a')] }),
      getSession: async (id) => ({
        session: { id, directory: '/repo-a', createdAt: 0, updatedAt: 0 },
        lastSequence: 0,
        messages: [],
      }),
    });

    const store = new PiSessionStore();
    try {
      await store.start({ directory: '/repo-a' });
      await tickMicrotasks();
      expect(store.getState().catalog.byId.has('a-1')).toBe(true);

      store.clear();
      const cleared = store.getState().catalog;
      expect(cleared.byId.size).toBe(0);
      expect(cleared.byDirectory.size).toBe(0);
      expect(cleared.listStatusByDirectory.size).toBe(0);
    } finally {
      stubs.restore();
      store.dispose();
    }
  });
});

void getPiSessionStore;