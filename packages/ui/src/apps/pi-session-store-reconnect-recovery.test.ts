import { describe, expect, mock, test } from 'bun:test';

// Complete reconnect recovery (PR #119 finding #5) on top of the
// restart-safe stream epoch (#1) and transport lifecycle (#6) base.
// `reconnectPiSession` is replaced with a controllable mock so the
// reconnect sequence, resync snapshots, and epoch transitions are
// deterministic; the file is self-contained (bun test --isolate).
//
// Scope: transport-ready vs authoritative baseline, contiguous same-epoch
// replay, resync/epoch-change bounded recovery, parked retry obligations,
// `syncReadiness: 'recovering'`, and safe transcript/cursor reset that
// preserves optimistic/local state. Excludes deletion tombstones, send
// identity/config/queue, mobile, terminal, auth/file, and unrelated work.

let reconnectImpl: (options: Record<string, unknown>) => Promise<Record<string, unknown>> = async () => {
  throw new Error('reconnectPiSession not configured for this test');
};

mock.module('@/lib/pi/reconnect', () => ({
  reconnectPiSession: (options: Record<string, unknown>) => reconnectImpl(options),
}));

const storeModule = await import('@/apps/pi-session-store');
const PiSessionStore = storeModule.PiSessionStore;
type PiSessionStore = InstanceType<typeof storeModule.PiSessionStore>;
const { piClient, PiRequestError } = await import('@/lib/pi/client');
const { createReducerPartMap } = await import('@/lib/pi/event-reducer');
type PiReducerSessionState = import('@/lib/pi/event-reducer').PiReducerSessionState;
const { initialCatalog } = await import('@/sync/pi-session-catalog');
type LiveSessionRecord = import('@/sync/pi-session-catalog').LiveSessionRecord;
const { getRuntimeKey } = await import('@/lib/runtime-switch');
type PiSessionEvent = import('@/lib/pi/protocol').PiSessionEvent;

/** Deterministic bounded wait for an async condition (no fixed sleeps). */
const waitFor = async (predicate: () => boolean, timeoutMs = 4_000): Promise<boolean> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return true;
};

const flushMicrotasks = async (count = 12) => {
  for (let i = 0; i < count; i += 1) await Promise.resolve();
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const detail = (id: string, directory = '/repo-a', lastSequence = 10, streamEpoch?: string) => ({
  session: { id, directory, title: id, createdAt: 1, updatedAt: 1 },
  lastSequence,
  messages: [],
  ...(streamEpoch ? { streamEpoch } : {}),
});

const listItem = (id: string, directory: string) => ({
  session: { id, directory, title: id, createdAt: 1, updatedAt: 1, parentId: null },
  updatedAt: 1,
});

const lifecycleEvent = (sessionId: string, directory: string, sequence = 1, streamEpoch?: string): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'session.lifecycle',
  sequence,
  sessionId,
  directory,
  payload: { state: 'busy' },
  ...(streamEpoch ? { streamEpoch } : {}),
} as PiSessionEvent);

const messageStartEvent = (sessionId: string, directory: string, sequence = 1, streamEpoch?: string): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'assistant.message.start',
  sequence,
  sessionId,
  directory,
  payload: { messageId: `m-${sessionId}-${sequence}`, role: 'user', startedAt: sequence },
  ...(streamEpoch ? { streamEpoch } : {}),
} as PiSessionEvent);

const snapshotEvent = (
  sessionId: string,
  directory: string,
  sequence: number,
  options: { streamEpoch?: string; resync?: boolean; lastSequence?: number } = {},
): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'session.snapshot',
  sequence,
  sessionId,
  directory,
  payload: {
    snapshot: {
      sessionId,
      directory,
      lastSequence: options.lastSequence ?? sequence,
      isStreaming: false,
      lifecycle: 'idle',
      queue: { steering: 0, followUp: 0 },
      ...(options.resync ? { resync: true } : {}),
    },
  },
  ...(options.streamEpoch ? { streamEpoch: options.streamEpoch } : {}),
} as PiSessionEvent);

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
  lastSequence: number,
): PiReducerSessionState => ({
  sessionId,
  directory,
  lastSequence,
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
});

interface StoreInternal {
  state: ReturnType<PiSessionStore['getState']>;
  commitEvents: (events: PiSessionEvent[]) => void;
  stream: { dispose: () => void } | null;
  streamEpoch: string | null;
  streamGeneration: number;
  hydratedSessionIds: Set<string>;
  pendingPromptById: Set<string>;
  queueSyncRecovery: (scope: { directories?: 'all-known' | Iterable<string>; residents?: Iterable<string> }) => void;
  markStreamReconnected: (expected: number, runtimeKey: string, streamGeneration: number) => void;
  reconnect: (sessionId: string, expected: number, runtimeKey: string) => Promise<void>;
  resetForRuntime: () => void;
}

const internal = (store: PiSessionStore): StoreInternal => store as unknown as StoreInternal;

interface SeedOptions {
  directory?: string;
  residents?: string[];
  selectedSessionId?: string;
  cursor?: number;
  streamEpoch?: string;
}

/** Seed an attached cluster with hydrated residents across two directories. */
const seed = (store: PiSessionStore, options: SeedOptions = {}) => {
  const directory = options.directory ?? '/repo-a';
  const residents = options.residents ?? ['s1'];
  const cursor = options.cursor ?? 5_000;
  const bySession = new Map(residents.map((id) => [id, reducerSession(id, directory, cursor)]));
  const lastSequence = new Map(residents.map((id) => [id, cursor]));
  const hydrated = new Set(residents);
  const storeInternal = internal(store);
  storeInternal.hydratedSessionIds = hydrated;
  const catalog = {
    ...initialCatalog(),
    byId: new Map(residents.map((id) => [id, record(id, directory)])),
    byDirectory: new Map([[directory, [...residents]] as const]),
    listStatusByDirectory: new Map([
      [directory, 'ready' as const],
      ['/repo-b', 'ready' as const],
    ] as const),
  };
  storeInternal.state = {
    ...store.getState(),
    directory,
    connection: 'ready' as const,
    sessions: residents.map((id) => ({ session: { id, directory, title: id, createdAt: 1, updatedAt: 1 } }) as never),
    selectedSessionId: options.selectedSessionId ?? residents[0],
    reducer: { bySession, lastSequence },
    hydratedSessionIds: new Set(hydrated),
    catalog,
    syncReadiness: 'ready' as const,
    syncRecovery: { directories: [], residents: [] },
  };
  storeInternal.stream = { dispose: () => undefined };
  storeInternal.streamEpoch = options.streamEpoch ?? 'epoch-1';
  storeInternal.streamGeneration = 7;
};

interface ClientCalls {
  listSessions: number;
  getSession: string[];
  listDirectories: string[];
}

const stubPiClient = (options: {
  getSession?: (id: string, directory: string) => Promise<unknown>;
  listSessions?: (directory: string) => Promise<unknown>;
} = {}) => {
  const calls: ClientCalls = { listSessions: 0, getSession: [], listDirectories: [] };
  const originals = {
    listSessions: piClient.listSessions.bind(piClient),
    getSession: piClient.getSession.bind(piClient),
  };
  piClient.getSession = (async (id: string, scope?: { directory?: string }) => {
    calls.getSession.push(id);
    return options.getSession
      ? options.getSession(id, scope?.directory ?? '')
      : detail(id, scope?.directory ?? '/repo-a', 10, 'epoch-1');
  }) as typeof piClient.getSession;
  piClient.listSessions = (async (scope?: { directory?: string }) => {
    calls.listSessions += 1;
    calls.listDirectories.push(scope?.directory ?? '');
    return options.listSessions
      ? options.listSessions(scope?.directory ?? '')
      : { sessions: [], streamEpoch: 'epoch-1' };
  }) as typeof piClient.listSessions;
  return {
    calls,
    restore: () => {
      piClient.listSessions = originals.listSessions;
      piClient.getSession = originals.getSession;
    },
  };
};

const withStore = async (
  run: (store: PiSessionStore) => Promise<void> | void,
) => {
  const store = new PiSessionStore();
  try {
    await run(store);
  } finally {
    store.dispose();
  }
};

// ---------------------------------------------------------------------------
// Safe transcript/cursor reset on verified epoch change
// ---------------------------------------------------------------------------

describe('reconnect recovery: epoch-change transcript reset', () => {
  test('a verified epoch change accepts a lower snapshot baseline and resets residents and cursors', () => {
    const store = new PiSessionStore();
    try {
      seed(store, { residents: ['s1', 's2'], cursor: 5_000, streamEpoch: 'epoch-1' });
      // Local optimistic state survives the epoch change (pending prompt
      // lives in the optimistic map; drafts/navigation live in dedicated stores).
      internal(store).pendingPromptById.add('s1');
      const selectedBefore = store.getState().selectedSessionId;
      const catalogBefore = store.getState().catalog;

      internal(store).commitEvents([
        snapshotEvent('s1', '/repo-a', 7, { streamEpoch: 'epoch-2' }),
      ]);

      expect(internal(store).streamEpoch).toBe('epoch-2');
      // The lower snapshot baseline is accepted (cursor 5_000 would have
      // rejected sequence 7 without the epoch reset).
      const resident = store.getState().reducer.bySession.get('s1');
      expect(resident?.lastSequence).toBe(7);
      // The retained optimistic pending prompt keeps the row visibly busy
      // across the restart (existing pending-prompt snapshot behavior).
      expect(resident?.lifecycle).toBe('busy');
      // All old-epoch cursors are gone.
      expect(store.getState().reducer.lastSequence.get('s2')).toBe(undefined);
      expect(store.getState().reducer.bySession.has('s2')).toBe(false);
      // Optimistic and navigation state preserved.
      expect(internal(store).pendingPromptById.has('s1')).toBe(true);
      expect(store.getState().selectedSessionId).toBe(selectedBefore);
      // Catalog metadata survives (recovery re-validates it).
      expect(store.getState().catalog.byId.get('s1')?.id).toBe(catalogBefore.byId.get('s1')?.id);
      // Recovery is queued for the former residents.
      expect(store.getState().syncReadiness).toBe('recovering');
      expect([...store.getState().syncRecovery.residents].sort()).toEqual(['s1', 's2']);
      expect([...store.getState().syncRecovery.directories].sort()).toEqual(['/repo-a', '/repo-b']);
    } finally {
      store.dispose();
    }
  });

  test('old-epoch events are rejected after the epoch change; same-epoch events stay efficient', () => {
    const store = new PiSessionStore();
    try {
      seed(store, { residents: ['s2'], cursor: 5_000, streamEpoch: 'epoch-2' });
      // Old daemon event (high stale sequence) must not resurrect anything.
      internal(store).commitEvents([messageStartEvent('s2', '/repo-a', 9_999, 'epoch-1')]);
      expect(store.getState().reducer.bySession.get('s2')?.lastSequence).toBe(5_000);
      // Same-epoch event applies normally.
      internal(store).commitEvents([messageStartEvent('s2', '/repo-a', 5_001, 'epoch-2')]);
      expect(store.getState().reducer.bySession.get('s2')?.lastSequence).toBe(5_001);
    } finally {
      store.dispose();
    }
  });

  test('a retired epoch snapshot cannot downgrade an established baseline', () => {
    const store = new PiSessionStore();
    const stubs = stubPiClient();
    try {
      seed(store, { residents: ['s1', 's2'], cursor: 5_000, streamEpoch: 'epoch-1' });
      // Verified transition to a new daemon lifetime (as the store performs
      // after a health-verified onEpochChange or reconnect result).
      internal(store).commitEvents([snapshotEvent('s1', '/repo-a', 7, { streamEpoch: 'epoch-2' })]);
      expect(internal(store).streamEpoch).toBe('epoch-2');
      expect(store.getState().reducer.bySession.get('s1')?.lastSequence).toBe(7);

      // A late frame (even a snapshot) stamped with the retired epoch must
      // be rejected wholesale: epochs are opaque, so retirement — not
      // numeric comparison — prevents the downgrade.
      internal(store).commitEvents([snapshotEvent('s1', '/repo-a', 5_000, { streamEpoch: 'epoch-1', lastSequence: 5_000 })]);
      expect(internal(store).streamEpoch).toBe('epoch-2');
      expect(store.getState().reducer.bySession.get('s1')?.lastSequence).toBe(7);
      // New-epoch events still apply after the stale frame was rejected.
      internal(store).commitEvents([messageStartEvent('s2', '/repo-a', 5_002, 'epoch-2')]);
      expect(store.getState().reducer.bySession.get('s2')?.lastSequence).toBe(5_002);
    } finally {
      stubs.restore();
      store.dispose();
    }
  });

  test('a detail response from a previous epoch is rejected and cannot commit a foreign cursor', async () => {
    await withStore(async (store) => {
      seed(store, { residents: [], streamEpoch: 'epoch-2' });
      const stale = stubPiClient({
        getSession: async (id) => detail(id, '/repo-a', 4_000, 'epoch-1'),
      });
      try {
        await store.ensureHydrated('s1');
        await flushMicrotasks();
        // Nothing committed: the response predates the daemon restart.
        expect(store.getState().reducer.bySession.has('s1')).toBe(false);
        expect(store.getState().hydratedSessionIds.has('s1')).toBe(false);
      } finally {
        stale.restore();
      }
    });
  });

  test('a directory list from a previous epoch is rejected; prior rows survive and the directory fails', async () => {
    await withStore(async (store) => {
      seed(store, { residents: ['s1'], streamEpoch: 'epoch-2' });
      const stale = stubPiClient({
        listSessions: async () => ({ sessions: [listItem('intruder', '/repo-a')], streamEpoch: 'epoch-1' }),
      });
      try {
        await store.refreshDirectoryCatalog('/repo-a');
        const status = store.getState().catalog.listStatusByDirectory.get('/repo-a');
        expect(status).toBe('failed');
        expect(store.getState().catalog.byId.has('intruder')).toBe(false);
        expect(store.getState().catalog.byId.has('s1')).toBe(true);
      } finally {
        stale.restore();
      }
    });
  });

  test('non-snapshot events from an unseen epoch are rejected; only a snapshot establishes the new baseline', async () => {
    await withStore(async (store) => {
      seed(store, { residents: ['s1'], cursor: 100, streamEpoch: 'epoch-1' });
      // A live lifecycle frame from a restarted daemon must not apply into
      // the old sequence space; the snapshot below establishes the new one.
      internal(store).commitEvents([lifecycleEvent('s1', '/repo-a', 101, 'epoch-9')]);
      expect(store.getState().reducer.bySession.get('s1')?.lastSequence).toBe(100);
      expect(internal(store).streamEpoch).toBe('epoch-1');
      internal(store).commitEvents([snapshotEvent('s1', '/repo-a', 5, { streamEpoch: 'epoch-9' })]);
      expect(internal(store).streamEpoch).toBe('epoch-9');
      expect(store.getState().reducer.bySession.get('s1')?.lastSequence).toBe(5);
    });
  });
});

// ---------------------------------------------------------------------------
// Reconnect recovery: replay-driven bounded recovery
// ---------------------------------------------------------------------------

const readyResult = (options: {
  epoch?: string;
  reducerState?: PiReducerSessionState[];
  lastSequence?: number;
}) => ({
  phase: 'ready' as const,
  snapshotState: { bySession: new Map(), lastSequence: new Map() },
  reducerState: {
    bySession: new Map((options.reducerState ?? []).map((session) => [session.sessionId, session])),
    lastSequence: new Map((options.reducerState ?? []).map((session) => [session.sessionId, session.lastSequence])),
  },
  stream: { dispose: () => undefined },
  lastSequence: options.lastSequence ?? -1,
  ...(options.epoch ? { epoch: options.epoch } : {}),
});

describe('reconnect recovery: replay-driven bounded recovery', () => {
  test('a contiguous same-epoch replay reloads nothing (quiet background resident untouched)', async () => {
    await withStore(async (store) => {
      seed(store, { residents: ['s1', 's2'], cursor: 100, streamEpoch: 'epoch-1' });
      const stubs = stubPiClient();
      let captured: Record<string, unknown> | null = null;
      reconnectImpl = async (options) => {
        captured = options;
        return readyResult({ epoch: 'epoch-1' });
      };
      try {
        await internal(store).reconnect('s1', store.getRuntimeGeneration(), getRuntimeKey());
        // No resync snapshot arrives: contiguous replay covers the gap.
        expect(store.getState().syncReadiness).toBe('ready');
        expect(store.getState().syncRecovery.residents).toHaveLength(0);
        expect(store.getState().syncRecovery.directories).toHaveLength(0);
        // No resident re-fetch, no catalog reload — the second device's
        // quiet background session is not re-downloaded.
        await flushMicrotasks();
        expect(stubs.calls.getSession).toEqual([]);
        expect(stubs.calls.listSessions).toBe(0);
        expect(store.getState().reducer.bySession.has('s2')).toBe(true);
        expect(captured).not.toBeNull();
      } finally {
        stubs.restore();
        reconnectImpl = async () => {
          throw new Error('not configured');
        };
      }
    });
  });

  test('transport-ready is not baseline proof: syncReadiness stays recovering while obligations are outstanding', async () => {
    await withStore(async (store) => {
      seed(store, { residents: ['s1'], cursor: 100, streamEpoch: 'epoch-1' });
      const stubs = stubPiClient({
        listSessions: async () => {
          throw new PiRequestError('DAEMON_REQUEST_FAILED', 'down');
        },
      });
      try {
        internal(store).queueSyncRecovery({ directories: ['/repo-a'], residents: [] });
        const recovering = await waitFor(() => store.getState().syncReadiness === 'recovering');
        expect(recovering).toBe(true);
        // The transport is alive (`connection: 'ready'`) but the baseline
        // is not current — readiness and connectivity are separate.
        expect(store.getState().connection).toBe('ready');
        expect(store.getState().syncRecovery.directories).toContain('/repo-a');
      } finally {
        stubs.restore();
      }
    });
  });

  test('a resync snapshot (replay miss) reconciles residents (selected first) and known directories', async () => {
    await withStore(async (store) => {
      seed(store, { residents: ['s1', 's2'], cursor: 100, streamEpoch: 'epoch-1' });
      const stubs = stubPiClient({
        // Same epoch: authoritative details sit ahead of the stale cursor.
        getSession: async (id, directory) => detail(id, directory || '/repo-a', 150, 'epoch-1'),
      });
      let onEvent: ((event: PiSessionEvent) => void) | null = null;
      reconnectImpl = async (options) => {
        onEvent = options.onEvent as (event: PiSessionEvent) => void;
        return readyResult({ epoch: 'epoch-1' });
      };
      try {
        await internal(store).reconnect('s1', store.getRuntimeGeneration(), getRuntimeKey());
        // The daemon could not replay the requested cursor: it sends a
        // resync snapshot first.
        onEvent!(snapshotEvent('s1', '/repo-a', 120, { streamEpoch: 'epoch-1', resync: true }));
        const drained = await waitFor(() => store.getState().syncReadiness === 'ready');
        expect(drained).toBe(true);
        // Affected residents reconciled (the snapshot itself also force-
        // hydrates the selected session, so s1 may appear twice).
        expect([...new Set(stubs.calls.getSession)].sort()).toEqual(['s1', 's2']);
        // Known directory catalogs reconciled.
        expect([...stubs.calls.listDirectories].sort()).toEqual(['/repo-a', '/repo-b']);
        // The quiet background resident now carries fresh authoritative data.
        expect(store.getState().reducer.bySession.get('s2')?.lastSequence).toBe(150);
      } finally {
        stubs.restore();
        reconnectImpl = async () => {
          throw new Error('not configured');
        };
      }
    });
  });

  test('a failed recovery scope keeps its retry obligation while successful scopes commit (partial success is not empty)', async () => {
    await withStore(async (store) => {
      seed(store, { residents: ['s1', 's2'], cursor: 100, streamEpoch: 'epoch-1' });
      let listFailForB = true;
      const stubs = stubPiClient({
        listSessions: async (directory) => {
          if (directory === '/repo-b' && listFailForB) throw new PiRequestError('DAEMON_REQUEST_FAILED', 'down');
          return { sessions: [listItem('b-1', '/repo-b')], streamEpoch: 'epoch-1' };
        },
      });
      reconnectImpl = async () => readyResult({ epoch: 'epoch-1' });
      try {
        await internal(store).reconnect('s1', store.getRuntimeGeneration(), getRuntimeKey());
        internal(store).queueSyncRecovery({ directories: 'all-known', residents: ['s1', 's2'] });
        // First pass: residents and /repo-a succeed; /repo-b fails. Detect
        // the completed failure through the directory's 'failed' status —
        // the obligation itself is visible from the moment it is queued.
        const failedB = await waitFor(() =>
          store.getState().catalog.listStatusByDirectory.get('/repo-b') === 'failed');
        expect(failedB).toBe(true);
        expect(store.getState().syncReadiness).toBe('recovering');
        expect(store.getState().syncRecovery.directories).toContain('/repo-b');
        // Partial success committed: /repo-a drained and its catalog updated,
        // while the failed /repo-b must not be treated as an empty success.
        expect(store.getState().catalog.byId.has('b-1')).toBe(false);
        // The bounded retry cycle re-runs the failed scope and drains it.
        listFailForB = false;
        const drained = await waitFor(() => store.getState().syncReadiness === 'ready');
        expect(drained).toBe(true);
        expect(store.getState().catalog.byId.has('b-1')).toBe(true);
        expect(stubs.calls.listDirectories.filter((directory) => directory === '/repo-b').length).toBeGreaterThanOrEqual(2);
      } finally {
        stubs.restore();
        reconnectImpl = async () => {
          throw new Error('not configured');
        };
      }
    });
  });

  test('an epoch change at reconnect resets residents, accepts the lower baseline, and reconciles', async () => {
    await withStore(async (store) => {
      seed(store, { residents: ['s1', 's2'], cursor: 5_000, streamEpoch: 'epoch-1' });
      const stubs = stubPiClient({
        getSession: async (id, directory) => detail(id, directory || '/repo-a', 9, 'epoch-2'),
        listSessions: async () => ({ sessions: [], streamEpoch: 'epoch-2' }),
      });
      reconnectImpl = async () => readyResult({
        epoch: 'epoch-2',
        reducerState: [reducerSession('s1', '/repo-a', 7)],
        lastSequence: 7,
      });
      try {
        await internal(store).reconnect('s1', store.getRuntimeGeneration(), getRuntimeKey());
        expect(internal(store).streamEpoch).toBe('epoch-2');
        // The lower new-epoch baseline was accepted (no stale-cursor reject).
        const resident = store.getState().reducer.bySession.get('s1');
        expect(resident?.lastSequence).toBe(7);
        const drained = await waitFor(() => store.getState().syncReadiness === 'ready');
        expect(drained).toBe(true);
        // Former residents re-fetched from the new daemon, selected first.
        expect(stubs.calls.getSession[0]).toBe('s1');
        expect([...stubs.calls.getSession].sort()).toEqual(['s1', 's2']);
        expect([...stubs.calls.listDirectories].sort()).toEqual(['/repo-a', '/repo-b']);
        expect(store.getState().reducer.bySession.get('s2')?.lastSequence).toBe(9);
      } finally {
        stubs.restore();
        reconnectImpl = async () => {
          throw new Error('not configured');
        };
      }
    });
  });

  test('a newer recovery signal during an in-flight pass forces a fresh authoritative read', async () => {
    await withStore(async (store) => {
      seed(store, { residents: ['s1'], cursor: 100, streamEpoch: 'epoch-1' });
      const firstRead = deferred<ReturnType<typeof detail>>();
      let reads = 0;
      const stubs = stubPiClient({
        getSession: async (id, directory) => {
          reads += 1;
          if (reads === 1) return firstRead.promise;
          return detail(id, directory, 130, 'epoch-1');
        },
      });
      try {
        internal(store).queueSyncRecovery({ residents: ['s1'] });
        expect(await waitFor(() => reads === 1)).toBe(true);
        // The same scope is already in the set, but this newer baseline signal
        // must prevent the first read from draining it.
        internal(store).queueSyncRecovery({ residents: ['s1'] });
        firstRead.resolve(detail('s1', '/repo-a', 120, 'epoch-1'));
        expect(await waitFor(() => reads === 2)).toBe(true);
        expect(await waitFor(() => store.getState().syncReadiness === 'ready')).toBe(true);
        expect(store.getState().reducer.bySession.get('s1')?.lastSequence).toBe(130);
      } finally {
        stubs.restore();
      }
    });
  });

  test('callbacks from a reconnect superseded by a runtime reset cannot mutate the new store', async () => {
    await withStore(async (store) => {
      seed(store, { residents: ['s1'], cursor: 100, streamEpoch: 'epoch-1' });
      let callbacks: Record<string, unknown> | null = null;
      reconnectImpl = async (options) => {
        callbacks = options;
        return readyResult({ epoch: 'epoch-1' });
      };
      try {
        await internal(store).reconnect('s1', store.getRuntimeGeneration(), getRuntimeKey());
        internal(store).resetForRuntime();
        (callbacks!.onEpochChange as (epoch: string) => void)('epoch-stale');
        (callbacks!.onEvent as (event: PiSessionEvent) => void)(
          snapshotEvent('s1', '/repo-a', 1, { streamEpoch: 'epoch-stale', resync: true }),
        );
        expect(internal(store).streamEpoch).toBeNull();
        expect(store.getState().syncReadiness).toBe('ready');
        expect(store.getState().reducer.bySession.size).toBe(0);
      } finally {
        reconnectImpl = async () => { throw new Error('not configured'); };
      }
    });
  });

  test('an auth callback is not overwritten by the reconnect result error', async () => {
    await withStore(async (store) => {
      seed(store, { residents: ['s1'], cursor: 100, streamEpoch: 'epoch-1' });
      reconnectImpl = async (options) => {
        (options.onAuthRequired as () => void)();
        return {
          phase: 'failed',
          error: { code: 'DAEMON_UNAVAILABLE', message: 'generic failure' },
          reducerState: { bySession: new Map(), lastSequence: new Map() },
          snapshotState: { bySession: new Map(), lastSequence: new Map() },
          stream: null,
          lastSequence: -1,
        };
      };
      try {
        await internal(store).reconnect('s1', store.getRuntimeGeneration(), getRuntimeKey());
        expect(store.getState().error?.code).toBe('DAEMON_AUTH_FAILED');
      } finally {
        reconnectImpl = async () => { throw new Error('not configured'); };
      }
    });
  });

  test('unstamped events are rejected after an epoch-capable daemon establishes its lifetime', () => {
    const store = new PiSessionStore();
    try {
      seed(store, { residents: ['s1'], cursor: 100, streamEpoch: 'epoch-1' });
      internal(store).commitEvents([messageStartEvent('s1', '/repo-a', 101)]);
      expect(store.getState().reducer.bySession.get('s1')?.lastSequence).toBe(100);
    } finally {
      store.dispose();
    }
  });

  test('stream health re-queues parked obligations but never clears or supersedes them', async () => {
    await withStore(async (store) => {
      seed(store, { residents: ['s1'], cursor: 100, streamEpoch: 'epoch-1' });
      let failLists = true;
      const stubs = stubPiClient({
        listSessions: async () => {
          if (failLists) throw new PiRequestError('DAEMON_REQUEST_FAILED', 'down');
          return { sessions: [], streamEpoch: 'epoch-1' };
        },
      });
      try {
        internal(store).queueSyncRecovery({ directories: ['/repo-a'], residents: [] });
        // Wait until only the failing directory remains.
        const parked = await waitFor(() =>
          store.getState().syncReadiness === 'recovering'
          && store.getState().syncRecovery.directories.length === 1
          && store.getState().syncRecovery.residents.length === 0);
        expect(parked).toBe(true);
        const scopesBeforeHealth = [...store.getState().syncRecovery.directories];
        // A healthy stream signal must not mark the baseline complete.
        internal(store).markStreamReconnected(store.getRuntimeGeneration(), getRuntimeKey(), internal(store).streamGeneration);
        expect(store.getState().syncReadiness).toBe('recovering');
        expect([...store.getState().syncRecovery.directories]).toEqual(scopesBeforeHealth);
        // Recovery succeeds after the daemon returns.
        failLists = false;
        const drained = await waitFor(() => store.getState().syncReadiness === 'ready');
        expect(drained).toBe(true);
      } finally {
        stubs.restore();
      }
    });
  });
});
