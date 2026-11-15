import { describe, expect, mock, test } from 'bun:test';

// Sessions on project daemons (sandboxed projects) arrive on the same
// merged event stream as the main daemon's, numbered by their own daemon's
// stream (`stream` + its own `streamEpoch`). These tests cover the store's
// side of that contract: per-stream epochs, the main cursor staying in the
// main sequence space, the opaque project cursor on reconnect, scoped resets
// for a restarted project daemon and for `session.moved`, and stamped
// responses from a project daemon. Self-contained (bun test --isolate).

let reconnectImpl: (options: Record<string, unknown>) => Promise<Record<string, unknown>> = async () => {
  throw new Error('reconnectPiSession not configured for this test');
};

mock.module('@/lib/pi/reconnect', () => ({
  reconnectPiSession: (options: Record<string, unknown>) => reconnectImpl(options),
}));

const storeModule = await import('@/apps/pi-session-store');
const PiSessionStore = storeModule.PiSessionStore;
type PiSessionStore = InstanceType<typeof storeModule.PiSessionStore>;
const { piClient } = await import('@/lib/pi/client');
const { createReducerPartMap } = await import('@/lib/pi/event-reducer');
type PiReducerSessionState = import('@/lib/pi/event-reducer').PiReducerSessionState;
const { initialCatalog } = await import('@/sync/pi-session-catalog');
type LiveSessionRecord = import('@/sync/pi-session-catalog').LiveSessionRecord;
const { getRuntimeKey } = await import('@/lib/runtime-switch');
const { getObservedPiStreamEpoch, observePiStreamEpoch } = await import('@/lib/pi/transport');
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

const BOX = 'box-stream-id-01';

const boxEvent = (event: PiSessionEvent, epoch: string, cursor?: string): PiSessionEvent => ({
  ...event,
  streamEpoch: epoch,
  stream: BOX,
  ...(cursor ? { cursor } : {}),
} as PiSessionEvent);

const movedEvent = (sessionId: string, directory: string): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'session.moved',
  sequence: 0,
  sessionId,
  directory,
  payload: {},
} as PiSessionEvent);

describe('project daemon streams', () => {
  test('project frames apply in their own sequence space without touching the main epoch or cursor', async () => {
    await withStore(async (store) => {
      seed(store, { residents: ['s1'], cursor: 50, streamEpoch: 'epoch-main' });
      internal(store).commitEvents([
        boxEvent(snapshotEvent('b1', '/box', 900), 'box-1'),
        boxEvent(messageStartEvent('b1', '/box', 901), 'box-1'),
      ]);
      expect(internal(store).streamEpoch).toBe('epoch-main');
      expect(store.getState().reducer.bySession.get('b1')?.lastSequence).toBe(901);
      expect(store.getState().reducer.bySession.get('s1')?.lastSequence).toBe(50);
      // A main frame still applies after a higher project sequence.
      internal(store).commitEvents([messageStartEvent('s1', '/repo-a', 51, 'epoch-main')]);
      expect(store.getState().reducer.bySession.get('s1')?.lastSequence).toBe(51);
    });
  });

  test('reconnect resumes main from main sessions only and passes the newest project cursor', async () => {
    await withStore(async (store) => {
      seed(store, { residents: ['s1'], cursor: 50, streamEpoch: 'epoch-main' });
      const internals = store as unknown as { apply: (event: PiSessionEvent) => void; cadence: { flush: () => void } };
      internals.apply(boxEvent(snapshotEvent('b1', '/box', 900), 'box-1', 'cursor-a'));
      internals.apply(boxEvent(messageStartEvent('b1', '/box', 901), 'box-1', 'cursor-b'));
      internals.cadence.flush();
      let options: Record<string, unknown> | null = null;
      reconnectImpl = async (received) => {
        options = received;
        return readyResult({ epoch: 'epoch-main', lastSequence: 50 });
      };
      const stubs = stubPiClient();
      try {
        await internal(store).reconnect('s1', store.getRuntimeGeneration(), getRuntimeKey());
        expect(options).not.toBeNull();
        expect(options!.lastKnownSequence).toBe(50);
        expect(options!.streamEpoch).toBe('epoch-main');
        expect(options!.cursor).toBe('cursor-b');
      } finally {
        stubs.restore();
      }
    });
  });

  test('a restarted project daemon resets only its own sessions', async () => {
    await withStore(async (store) => {
      seed(store, { residents: ['s1'], cursor: 50, streamEpoch: 'epoch-main' });
      internal(store).commitEvents([boxEvent(snapshotEvent('b1', '/box', 900), 'box-1')]);
      internal(store).hydratedSessionIds.add('b1');
      const stubs = stubPiClient({
        getSession: async (id, directory) => ({ ...detail(id, directory || '/box', 3, 'box-2'), stream: BOX }),
        listSessions: async (directory) => (directory === '/box' ? { sessions: [], streamEpoch: 'box-2', stream: BOX } : { sessions: [], streamEpoch: 'epoch-main' }),
      });
      try {
        // The restarted daemon numbers from 1 again.
        internal(store).commitEvents([boxEvent(snapshotEvent('b1', '/box', 2), 'box-2')]);
        expect(store.getState().reducer.bySession.get('b1')?.lastSequence).toBe(2);
        expect(store.getState().reducer.bySession.get('s1')?.lastSequence).toBe(50);
        expect(internal(store).streamEpoch).toBe('epoch-main');
        expect(store.getState().syncRecovery.residents).toEqual(['b1']);
        // A late frame from the retired project lifetime is dropped.
        internal(store).commitEvents([boxEvent(messageStartEvent('b1', '/box', 950), 'box-1')]);
        expect(store.getState().reducer.bySession.get('b1')?.lastSequence).toBe(2);
        expect(await waitFor(() => store.getState().syncReadiness === 'ready')).toBe(true);
        // Only the restarted daemon's session is re-read; main sessions keep
        // their state.
        expect(new Set(stubs.calls.getSession)).toEqual(new Set(['b1']));
        expect(stubs.calls.listDirectories).not.toContain('/repo-a');
      } finally {
        stubs.restore();
      }
    });
  });

  test('session.moved drops only that session\'s live state and refetches it from its new owner', async () => {
    await withStore(async (store) => {
      seed(store, { residents: ['s1', 's2'], cursor: 5_000, streamEpoch: 'epoch-main' });
      const stubs = stubPiClient({
        getSession: async (id, directory) => ({ ...detail(id, directory || '/repo-a', 4, 'box-1'), stream: BOX }),
        listSessions: async () => ({ sessions: [listItem('s1', '/repo-a'), listItem('s2', '/repo-a')], streamEpoch: 'box-1', stream: BOX }),
      });
      try {
        internal(store).commitEvents([movedEvent('s1', '/repo-a')]);
        expect(store.getState().reducer.bySession.has('s1')).toBe(false);
        expect(store.getState().reducer.bySession.get('s2')?.lastSequence).toBe(5_000);
        expect(internal(store).streamEpoch).toBe('epoch-main');
        expect(store.getState().syncRecovery.residents).toEqual(['s1']);
        expect(store.getState().syncRecovery.directories).toEqual(['/repo-a']);
        expect(await waitFor(() => store.getState().syncReadiness === 'ready')).toBe(true);
        expect(stubs.calls.getSession).toEqual(['s1']);
        // The refetched detail is numbered by the project daemon.
        expect(store.getState().reducer.bySession.get('s1')?.lastSequence).toBe(4);
        internal(store).commitEvents([boxEvent(messageStartEvent('s1', '/repo-a', 5), 'box-1')]);
        expect(store.getState().reducer.bySession.get('s1')?.lastSequence).toBe(5);
      } finally {
        stubs.restore();
      }
    });
  });

  test('a session whose frames switch daemons without a notice is reset before the new frame applies', async () => {
    await withStore(async (store) => {
      seed(store, { residents: ['s1'], cursor: 5_000, streamEpoch: 'epoch-main' });
      const stubs = stubPiClient();
      try {
        internal(store).commitEvents([boxEvent(snapshotEvent('s1', '/repo-a', 3), 'box-1')]);
        expect(store.getState().reducer.bySession.get('s1')?.lastSequence).toBe(3);
      } finally {
        stubs.restore();
      }
    });
  });

  test('details and lists from a project daemon are checked against that daemon\'s epoch', async () => {
    await withStore(async (store) => {
      seed(store, { residents: [], streamEpoch: 'epoch-main' });
      internal(store).commitEvents([boxEvent(snapshotEvent('b0', '/box', 1), 'box-2')]);
      const stubs = stubPiClient({
        getSession: async (id) => ({ ...detail(id, '/box', 40, id === 'b1' ? 'box-2' : 'box-1'), stream: BOX }),
        listSessions: async () => ({ sessions: [listItem('b1', '/box')], streamEpoch: 'box-2', stream: BOX }),
      });
      try {
        await store.ensureHydrated('b1');
        await flushMicrotasks();
        expect(store.getState().reducer.bySession.get('b1')?.lastSequence).toBe(40);
        // Retired? No: box-1 was never seen, but it is not the current epoch
        // either, so a detail stamped with it is not committed.
        await store.ensureHydrated('b2');
        await flushMicrotasks();
        expect(store.getState().reducer.bySession.has('b2')).toBe(false);
        await store.refreshDirectoryCatalog('/box');
        expect(store.getState().catalog.listStatusByDirectory.get('/box')).toBe('ready');
        expect(store.getState().catalog.byId.has('b1')).toBe(true);
      } finally {
        stubs.restore();
      }
    });
  });

  test('a reconnect whose selected session is on a project daemon keeps the main epoch', async () => {
    await withStore(async (store) => {
      seed(store, { residents: ['s1'], cursor: 50, streamEpoch: 'epoch-main' });
      internal(store).commitEvents([boxEvent(snapshotEvent('b1', '/box', 2), 'box-1')]);
      reconnectImpl = async () => ({
        ...readyResult({ epoch: 'epoch-main', reducerState: [reducerSession('b1', '/box', 30)], lastSequence: 50 }),
        sessionStream: { stream: BOX, epoch: 'box-1' },
      });
      const stubs = stubPiClient();
      try {
        await internal(store).reconnect('b1', store.getRuntimeGeneration(), getRuntimeKey());
        expect(internal(store).streamEpoch).toBe('epoch-main');
        expect(store.getState().reducer.bySession.get('b1')?.lastSequence).toBe(30);
        expect(store.getState().reducer.bySession.get('s1')?.lastSequence).toBe(50);
      } finally {
        stubs.restore();
      }
    });
  });

  test('sends to a project-daemon session are bound to that daemon\'s epoch', async () => {
    await withStore(async (store) => {
      seed(store, { residents: ['s1'], cursor: 50, streamEpoch: 'epoch-main' });
      observePiStreamEpoch(getRuntimeKey(), 'epoch-main');
      internal(store).commitEvents([boxEvent(snapshotEvent('b1', '/box', 2), 'box-1')]);
      expect(getObservedPiStreamEpoch(getRuntimeKey(), 'b1')).toBe('box-1');
      expect(getObservedPiStreamEpoch(getRuntimeKey(), 's1')).toBe('epoch-main');
      expect(getObservedPiStreamEpoch(getRuntimeKey())).toBe('epoch-main');
      // After the session moves, its next send waits for the new owner.
      internal(store).commitEvents([movedEvent('b1', '/box')]);
      expect(getObservedPiStreamEpoch(getRuntimeKey(), 'b1')).toBe('epoch-main');
      internal(store).commitEvents([boxEvent(snapshotEvent('b1', '/box', 1), 'box-2')]);
      expect(getObservedPiStreamEpoch(getRuntimeKey(), 'b1')).toBe('box-2');
    });
  });
});
