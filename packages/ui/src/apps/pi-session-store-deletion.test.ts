import { describe, expect, test } from 'bun:test';

import { PiSessionStore } from '@/apps/pi-session-store';
import { PiRequestError, piClient } from '@/lib/pi/client';
import type { PiReducerSessionState } from '@/lib/pi/event-reducer';
import { createReducerPartMap } from '@/lib/pi/event-reducer';
import type { PiSessionEvent } from '@/lib/pi/protocol';
import { initialCatalog, type LiveSessionRecord } from '@/sync/pi-session-catalog';

// Deterministic deletion-propagation coverage for the shared commit path:
// local initiator, event echo on a second client, duplicates/replay,
// in-flight detail/history/list resurrection guards, stale runtime
// generation with a reused session ID, selection, archive, failed local
// delete, and the missed-deletion baseline entry point.

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const tick = async (count = 8) => {
  for (let i = 0; i < count; i += 1) await Promise.resolve();
};

/** Deterministic bounded wait for an async condition (no fixed sleeps). */
const waitFor = async (predicate: () => boolean, timeoutMs = 500): Promise<boolean> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return true;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const listItem = (id: string, directory: string) => ({
  session: { id, directory, title: id, createdAt: 1, updatedAt: 1, parentId: null },
  updatedAt: 1,
});

const detail = (id: string, directory = '/repo-a') => ({
  session: { id, directory, title: id, createdAt: 1, updatedAt: 1 },
  lastSequence: 0,
  messages: [],
});

const deletionEvent = (sessionId: string, directory: string, sequence = 1): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'session.deleted',
  sequence,
  sessionId,
  directory,
  payload: {},
});

const lifecycleEvent = (sessionId: string, directory: string, sequence = 1): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'session.lifecycle',
  sequence,
  sessionId,
  directory,
  payload: { state: 'busy' },
});

const messageStartEvent = (sessionId: string, directory: string, sequence = 1): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'assistant.message.start',
  sequence,
  sessionId,
  directory,
  payload: { messageId: `m-${sessionId}-${sequence}`, role: 'user', startedAt: sequence },
});

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

const reducerSession = (
  sessionId: string,
  directory: string,
  overrides: Partial<PiReducerSessionState> = {},
): PiReducerSessionState => ({
  sessionId,
  directory,
  lastSequence: 1,
  lifecycle: 'idle',
  messages: new Map(),
  partOrder: new Map(),
  parts: createReducerPartMap(),
  toolsByCallId: new Map(),
  streamingMessages: new Set(),
  extensionStatuses: new Map(),
  extensionWidgets: new Map(),
  extensionDialogs: [],
  extensionNotices: [],
  extensionErrors: [],
  extensionPanels: new Map(),
  extensionApps: new Map(),
  queue: { steering: 0, followUp: 0 },
  ...overrides,
});

interface StoreInternal {
  state: ReturnType<PiSessionStore['getState']>;
  stream: { dispose: () => void } | null;
  streamEpoch: string | null;
  commitEvents: (events: PiSessionEvent[]) => void;
  queueSyncRecovery: (scope: { residents?: Iterable<string> }) => void;
}

const internal = (store: PiSessionStore): StoreInternal => store as unknown as StoreInternal;

interface SeedOptions {
  sessions?: string[];
  directory?: string;
  selectedSessionId?: string | null;
}

const seed = (store: PiSessionStore, options: SeedOptions = {}) => {
  const directory = options.directory ?? '/repo-a';
  const ids = options.sessions ?? ['s1'];
  const byId = new Map(ids.map((id) => [id, record(id, directory)]));
  internal(store).stream = { dispose: () => undefined };
  internal(store).state = {
    ...store.getState(),
    directory,
    connection: 'ready' as const,
    sessions: ids.map((id) => ({ session: { id, directory, title: id, createdAt: 1, updatedAt: 1 } }) as never),
    selectedSessionId: options.selectedSessionId !== undefined ? options.selectedSessionId : (ids[0] ?? null),
    catalog: {
      ...initialCatalog(),
      byId,
      byDirectory: new Map([ids.length > 0 ? [directory, ids] : ['__empty__', []]]),
      listStatusByDirectory: new Map([[directory, 'ready' as const]]),
    },
  };
};

interface StubOverrides {
  listSessions?: (scope: { directory?: string }) => Promise<{ sessions: ReturnType<typeof listItem>[]; streamEpoch?: string }>;
  getSession?: (id: string) => Promise<unknown>;
  getSessionMessages?: (id: string) => Promise<unknown>;
  deleteSession?: (input: { sessionId: string }) => Promise<unknown>;
  archiveSession?: (input: { sessionId: string; archived: boolean }) => Promise<unknown>;
  selectProject?: (directory: string) => Promise<{ directory: string }>;
  health?: () => Promise<unknown>;
}

const stubPiClient = (overrides: StubOverrides = {}) => {
  const originals = {
    listSessions: piClient.listSessions.bind(piClient),
    getSession: piClient.getSession.bind(piClient),
    getSessionMessages: piClient.getSessionMessages.bind(piClient),
    deleteSession: piClient.deleteSession.bind(piClient),
    archiveSession: piClient.archiveSession.bind(piClient),
    selectProject: piClient.selectProject.bind(piClient),
    health: piClient.health.bind(piClient),
  };
  piClient.listSessions = (async (scope: { directory?: string }) =>
    overrides.listSessions ? overrides.listSessions(scope) : { sessions: [] }) as typeof piClient.listSessions;
  piClient.getSession = (async (id: string) =>
    overrides.getSession ? overrides.getSession(id) : detail(id)) as typeof piClient.getSession;
  piClient.getSessionMessages = (async (id: string) =>
    overrides.getSessionMessages ? overrides.getSessionMessages(id) : detail(id)) as typeof piClient.getSessionMessages;
  piClient.deleteSession = (async (input: { sessionId: string }) =>
    overrides.deleteSession ? overrides.deleteSession(input) : { session: { id: input.sessionId } }) as typeof piClient.deleteSession;
  piClient.archiveSession = (async (input: { sessionId: string; archived: boolean }) =>
    overrides.archiveSession ? overrides.archiveSession(input) : { session: { id: input.sessionId } }) as typeof piClient.archiveSession;
  piClient.selectProject = (async (directory: string) =>
    overrides.selectProject ? overrides.selectProject(directory) : { directory }) as typeof piClient.selectProject;
  piClient.health = (async () => overrides.health
    ? overrides.health()
    : { state: 'ready', protocolVersion: 1, capabilities: [] }) as typeof piClient.health;
  return {
    restore: () => {
      piClient.listSessions = originals.listSessions;
      piClient.getSession = originals.getSession;
      piClient.getSessionMessages = originals.getSessionMessages;
      piClient.deleteSession = originals.deleteSession;
      piClient.archiveSession = originals.archiveSession;
      piClient.selectProject = originals.selectProject;
      piClient.health = originals.health;
    },
  };
};

const withStore = async (
  overrides: StubOverrides,
  run: (store: PiSessionStore) => Promise<void> | void,
) => {
  const store = new PiSessionStore();
  const { restore } = stubPiClient(overrides);
  try {
    await run(store);
  } finally {
    restore();
    store.dispose();
  }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('session deletion propagation', () => {
  test('initiator commits without the echo; a second client cleans via the echo', async () => {
    await withStore({}, async (other) => {
      const deletedIds: string[] = [];
      const { restore } = stubPiClient({
        deleteSession: async (input) => {
          deletedIds.push(input.sessionId);
          return { session: { id: input.sessionId } };
        },
      });
      const initiator = new PiSessionStore();
      try {
        seed(initiator, { sessions: ['s1', 's2'] });
        await initiator.remove('s1', '/repo-a');

        // Confirmed deletion committed locally, independent of any echo.
        expect(deletedIds).toEqual(['s1']);
        expect(initiator.isDeleted('s1')).toBe(true);
        expect(initiator.getState().catalog.byId.has('s1')).toBe(false);
        expect(initiator.getState().reducer.bySession.has('s1')).toBe(false);
        expect(initiator.getState().selectedSessionId).toBe('s2');

        // A second connected client drops the same session via the echo.
        seed(other, { sessions: ['s1', 's2'] });
        internal(other).commitEvents([deletionEvent('s1', '/repo-a', 1)]);
        expect(other.isDeleted('s1')).toBe(true);
        expect(other.getState().catalog.byId.has('s1')).toBe(false);
        expect(other.getState().reducer.bySession.has('s1')).toBe(false);
      } finally {
        restore();
        initiator.dispose();
      }
    });
  });

  test('duplicate deletion events are idempotent', () => {
    const store = new PiSessionStore();
    try {
      seed(store, { sessions: ['s1'] });
      internal(store).commitEvents([deletionEvent('s1', '/repo-a', 1)]);
      internal(store).commitEvents([deletionEvent('s1', '/repo-a', 1)]); // exact replay
      internal(store).commitEvents([deletionEvent('s1', '/repo-a', 2)]); // newer duplicate
      expect(store.deletedSessionCountForTests()).toBe(1);
      expect(store.isDeleted('s1')).toBe(true);
      expect(store.getState().catalog.byId.has('s1')).toBe(false);
      expect(store.getState().reducer.bySession.has('s1')).toBe(false);
    } finally {
      store.dispose();
    }
  });

  test('an old-epoch deletion in a mixed batch cannot tombstone the new-epoch baseline', () => {
    const store = new PiSessionStore();
    try {
      seed(store, { sessions: ['s1'] });
      internal(store).streamEpoch = 'epoch-old';
      internal(store).commitEvents([
        { ...deletionEvent('s1', '/repo-a', 2), streamEpoch: 'epoch-old' },
        {
          protocolVersion: 1,
          kind: 'event',
          name: 'session.snapshot',
          sequence: 1,
          streamEpoch: 'epoch-new',
          sessionId: 's1',
          directory: '/repo-a',
          payload: {
            snapshot: {
              sessionId: 's1',
              directory: '/repo-a',
              lastSequence: 1,
              isStreaming: false,
              lifecycle: 'idle',
              queue: { steering: 0, followUp: 0 },
            },
          },
        },
      ] as PiSessionEvent[]);

      expect(internal(store).streamEpoch).toBe('epoch-new');
      expect(store.isDeleted('s1')).toBe(false);
      expect(store.getState().reducer.bySession.has('s1')).toBe(true);
    } finally {
      store.dispose();
    }
  });

  test('replay and stale live events after deletion do not resurrect the session', () => {
    const store = new PiSessionStore();
    try {
      seed(store, { sessions: ['s1'] });
      internal(store).commitEvents([deletionEvent('s1', '/repo-a', 5)]);
      // Stale live events (sequence <= deletion cursor) are rejected.
      internal(store).commitEvents([messageStartEvent('s1', '/repo-a', 4)]);
      internal(store).commitEvents([lifecycleEvent('s1', '/repo-a', 5)]);
      // Replayed deletion stays a no-op.
      internal(store).commitEvents([deletionEvent('s1', '/repo-a', 5)]);
      expect(store.getState().reducer.bySession.has('s1')).toBe(false);
      expect(store.getState().catalog.byId.has('s1')).toBe(false);
      expect(store.deletedSessionCountForTests()).toBe(1);
    } finally {
      store.dispose();
    }
  });

  test('an in-flight detail response cannot resurrect a deleted session', async () => {
    const pending = deferred<unknown>();
    let getSessionCalls = 0;
    await withStore({
      getSession: () => {
        getSessionCalls += 1;
        return pending.promise;
      },
    }, async (store) => {
      seed(store, { sessions: ['s1'] });
      const hydrating = store.ensureHydrated('s1');
      expect(await waitFor(() => getSessionCalls >= 1)).toBe(true);
      const callsAtDeletion = getSessionCalls;

      internal(store).commitEvents([deletionEvent('s1', '/repo-a', 3)]);
      pending.resolve(detail('s1'));
      await hydrating;

      expect(getSessionCalls).toBe(callsAtDeletion); // no re-fetch after the deletion
      expect(store.isDeleted('s1')).toBe(true);
      expect(store.getState().catalog.byId.has('s1')).toBe(false);
      expect(store.getState().reducer.bySession.has('s1')).toBe(false);
    });
  });

  test('an accepted 404 detail commits deletion without depending on an echo', async () => {
    await withStore({
      getSession: async () => {
        throw new PiRequestError('INVALID_SESSION', 'missing');
      },
    }, async (store) => {
      seed(store, { sessions: ['s1'] });
      await store.ensureHydrated('s1');

      expect(store.isDeleted('s1')).toBe(true);
      expect(store.getState().catalog.byId.has('s1')).toBe(false);
      expect(store.getState().reducer.bySession.has('s1')).toBe(false);
      // The failed id stays selected (documented INVALID_SESSION behavior)
      // so the chat surfaces its load error instead of jumping elsewhere.
      expect(store.getState().selectedSessionId).toBe('s1');
      // The per-session load error still surfaces for the chat surface.
      expect(store.getState().sessionLoadErrorById.has('s1')).toBe(true);
    });
  });

  test('a recovery 404 commits a missed deletion and drains the impossible resident obligation', async () => {
    await withStore({
      getSession: async () => {
        throw new PiRequestError('INVALID_SESSION', 'missing');
      },
    }, async (store) => {
      seed(store, { sessions: ['s1'] });
      internal(store).queueSyncRecovery({ residents: ['s1'] });

      expect(await waitFor(() => store.isDeleted('s1'))).toBe(true);
      expect(await waitFor(() => store.getState().syncReadiness === 'ready')).toBe(true);
      expect(store.getState().syncRecovery.residents).toEqual([]);
      expect(store.getState().catalog.byId.has('s1')).toBe(false);
    });
  });

  test('a hydrate for an already-deleted session never starts a fetch', async () => {
    let getSessionCalls = 0;
    await withStore({
      getSession: (id) => {
        getSessionCalls += 1;
        return Promise.resolve(detail(id));
      },
    }, async (store) => {
      seed(store, { sessions: ['s1'] });
      internal(store).commitEvents([deletionEvent('s1', '/repo-a', 1)]);
      await store.ensureHydrated('s1');
      await store.select('s1', '/repo-a');
      expect(getSessionCalls).toBe(0);
      expect(store.getState().catalog.byId.has('s1')).toBe(false);
    });
  });

  test('an in-flight history page cannot resurrect a deleted session', async () => {
    const pending = deferred<unknown>();
    await withStore({
      getSessionMessages: () => pending.promise,
    }, async (store) => {
      seed(store, { sessions: ['s1'] });
      const resident = reducerSession('s1', '/repo-a', {
        lastSequence: 10,
        hasMoreBefore: true,
        beforeCursor: 'cursor-0',
      });
      const state = internal(store).state;
      internal(store).state = {
        ...state,
        reducer: {
          bySession: new Map(state.reducer.bySession).set('s1', resident),
          lastSequence: new Map(state.reducer.lastSequence).set('s1', 10),
        },
      };

      const page = store.loadOlderMessages('s1');
      await tick();
      internal(store).commitEvents([deletionEvent('s1', '/repo-a', 11)]);
      pending.resolve({ ...detail('s1'), hasMoreBefore: false, beforeCursor: null });
      expect(await page).toBe(false);

      expect(store.getState().reducer.bySession.has('s1')).toBe(false);
      expect(store.isDeleted('s1')).toBe(true);
    });
  });

  test('an in-flight directory list cannot resurrect a deleted session', async () => {
    const pending = deferred<{ sessions: ReturnType<typeof listItem>[] }>();
    await withStore({
      listSessions: () => pending.promise,
    }, async (store) => {
      seed(store, { sessions: ['s1'] });
      const refreshing = store.refreshDirectoryCatalog('/repo-a');
      await tick();

      internal(store).commitEvents([deletionEvent('s1', '/repo-a', 3)]);
      pending.resolve({ sessions: [listItem('s1', '/repo-a')] });
      await refreshing;

      expect(store.isDeleted('s1')).toBe(true);
      expect(store.getState().catalog.byId.has('s1')).toBe(false);
      expect(store.getState().catalog.byDirectory.get('/repo-a')).toBe(undefined);
      expect(store.getState().catalog.listStatusByDirectory.get('/repo-a')).toBe('ready');
    });
  });

  test('a list response from a previous runtime generation cannot resurrect the same session ID', async () => {
    const pending = deferred<{ sessions: ReturnType<typeof listItem>[] }>();
    await withStore({
      listSessions: () => pending.promise,
    }, async (store) => {
      seed(store, { sessions: ['s1'] });
      const refreshing = store.refreshDirectoryCatalog('/repo-a');
      await tick();

      // Runtime switch: tombstones reset, generation guards stale completions.
      store.clear();
      pending.resolve({ sessions: [listItem('s1', '/repo-a')] });
      await refreshing;

      expect(store.isDeleted('s1')).toBe(false);
      expect(store.getState().catalog.byId.has('s1')).toBe(false);
    });
  });

  test('same-runtime cluster rebuilds retain tombstones and filter stale bootstrap rows', async () => {
    await withStore({
      health: async () => ({
        state: 'ready',
        protocolVersion: 1,
        capabilities: ['events.streamEpoch'],
        streamEpoch: 'epoch-rebuild',
      }),
      listSessions: async () => ({
        sessions: [listItem('active', '/repo-a'), listItem('deleted', '/repo-a')],
        streamEpoch: 'epoch-rebuild',
      }),
      getSession: async () => ({
        ...detail('active', '/repo-a'),
        isStreaming: false,
        lifecycle: 'idle',
        streamEpoch: 'epoch-rebuild',
      }),
    }, async (store) => {
      seed(store, { sessions: ['deleted', 'active'], selectedSessionId: 'deleted' });
      internal(store).commitEvents([deletionEvent('deleted', '/repo-a', 1)]);
      internal(store).state = { ...store.getState(), connection: 'error' };

      await store.open('/repo-a', 'active');

      expect(store.isDeleted('deleted')).toBe(true);
      expect(store.getState().sessions.map((item) => item.session.id)).toEqual(['active']);
      expect(store.getState().reducer.lastSequence.has('deleted')).toBe(true);
    });
  });

  test('a tombstoned preferred session falls through to an active session on focus', async () => {
    await withStore({
      listSessions: async () => ({ sessions: [listItem('active', '/repo-b'), listItem('deleted', '/repo-b')] }),
    }, async (store) => {
      seed(store, { sessions: ['deleted', 'other'], selectedSessionId: 'deleted' });
      internal(store).commitEvents([deletionEvent('deleted', '/repo-a', 1)]);

      await store.focusProject('/repo-b', 'deleted');

      expect(store.getState().selectedSessionId).toBe('active');
      expect(store.getState().sessions.map((item) => item.session.id)).toEqual(['active']);
      expect(store.getState().catalog.byId.has('deleted')).toBe(false);
    });
  });

  test('deleting the selected session moves selection; deleting another session keeps it', () => {
    const store = new PiSessionStore();
    try {
      seed(store, { sessions: ['s1', 's2'], selectedSessionId: 's1' });
      internal(store).commitEvents([deletionEvent('s1', '/repo-a', 1)]);
      expect(store.getState().selectedSessionId).toBe('s2');

      seed(store, { sessions: ['s1', 's2'], selectedSessionId: 's1' });
      internal(store).commitEvents([deletionEvent('s2', '/repo-a', 1)]);
      expect(store.getState().selectedSessionId).toBe('s1');
      expect(store.getState().catalog.byId.has('s2')).toBe(false);
      expect(store.getState().catalog.byId.has('s1')).toBe(true);
    } finally {
      store.dispose();
    }
  });

  test('deleting the last active session does not auto-select an archived row', () => {
    const store = new PiSessionStore();
    try {
      seed(store, { sessions: ['active', 'archived'], selectedSessionId: 'active' });
      const archived = store.getState().sessions.map((item) => item.session.id === 'archived'
        ? { ...item, session: { ...item.session, archived: true } }
        : item);
      internal(store).state = { ...store.getState(), sessions: archived };

      internal(store).commitEvents([deletionEvent('active', '/repo-a', 1)]);

      expect(store.getState().selectedSessionId).toBeNull();
      expect(store.getState().sessions.map((item) => item.session.id)).toEqual(['archived']);
    } finally {
      store.dispose();
    }
  });

  test('runtime tombstones and deletion cursors stay memory-bounded', () => {
    const store = new PiSessionStore();
    try {
      for (let index = 0; index < 4_097; index += 1) {
        store.commitMissedDeletion(`deleted-${index}`, 'global');
      }
      expect(store.deletedSessionCountForTests()).toBe(4_096);
      expect(store.isDeleted('deleted-0')).toBe(false);
      expect(store.isDeleted('deleted-4096')).toBe(true);
    } finally {
      store.dispose();
    }
  });

  test('archive is not deletion: the row stays and no tombstone lands', async () => {
    await withStore({}, async (store) => {
      seed(store, { sessions: ['s1'] });
      await store.archive('s1', true, '/repo-a');
      expect(store.isDeleted('s1')).toBe(false);
      expect(store.deletedSessionCountForTests()).toBe(0);
      expect(store.getState().catalog.byId.has('s1')).toBe(true);
      expect(store.getState().catalog.byId.get('s1')?.archived).toBe(true);
    });
  });

  test('a failed local delete keeps the session and does not tombstone', async () => {
    await withStore({
      deleteSession: async () => {
        throw new Error('daemon unavailable');
      },
    }, async (store) => {
      seed(store, { sessions: ['s1'] });
      await expect(store.remove('s1')).rejects.toThrow('daemon unavailable');
      expect(store.isDeleted('s1')).toBe(false);
      expect(store.deletedSessionCountForTests()).toBe(0);
      expect(store.getState().catalog.byId.has('s1')).toBe(true);
    });
  });

  test('missed-deletion baseline cleanup lands a tombstone that blocks late list resurrection', async () => {
    const pending = deferred<{ sessions: ReturnType<typeof listItem>[] }>();
    await withStore({
      listSessions: () => pending.promise,
    }, async (store) => {
      seed(store, { sessions: ['s1'] });
      const refreshing = store.refreshDirectoryCatalog('/repo-a');
      await tick();

      // Baseline cleanup (complete authoritative snapshot omitted the
      // session) funnels through the shared commit.
      expect(store.commitMissedDeletion('s1', '/repo-a')).toBe(true);
      pending.resolve({ sessions: [listItem('s1', '/repo-a')] });
      await refreshing;

      expect(store.isDeleted('s1')).toBe(true);
      expect(store.getState().catalog.byId.has('s1')).toBe(false);
    });
  });

  test('duplicate missed-deletion commits are idempotent', () => {
    const store = new PiSessionStore();
    try {
      seed(store, { sessions: ['s1'] });
      expect(store.commitMissedDeletion('s1', '/repo-a')).toBe(true);
      expect(store.commitMissedDeletion('s1', '/repo-a')).toBe(false);
      expect(store.deletedSessionCountForTests()).toBe(1);
    } finally {
      store.dispose();
    }
  });
});
