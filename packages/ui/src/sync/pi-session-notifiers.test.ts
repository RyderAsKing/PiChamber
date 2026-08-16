import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { PiSessionStore } from '@/apps/pi-session-store';
import type { PiReducerMessage, PiReducerSessionState } from '@/lib/pi/event-reducer';
import type { PiSessionEvent } from '@/lib/pi/protocol';
import { useNotificationStore } from '@/sync/notification-store';
import { resetSessionOrdering } from '@/sync/session-ordering';
import { upsertStubRecord } from '@/sync/pi-session-catalog';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const reducerSession = (
  overrides: Partial<PiReducerSessionState> & Pick<PiReducerSessionState, 'sessionId'>,
): PiReducerSessionState => ({
  directory: '/repo',
  lastSequence: 0,
  lifecycle: 'idle',
  messages: new Map(),
  partOrder: new Map(),
  parts: new Map(),
  toolsByCallId: new Map(),
  streamingMessages: new Set(),
  queue: { steering: 0, followUp: 0 },
  ...overrides,
});

const reducerMessage = (
  overrides: Partial<PiReducerMessage> & Pick<PiReducerMessage, 'id' | 'role'>,
): PiReducerMessage => ({
  sessionId: 's1',
  directory: '/repo',
  createdAt: 1,
  text: '',
  thinking: '',
  streaming: false,
  ...overrides,
});

interface StoreInternal {
  state: ReturnType<PiSessionStore['getState']>;
  hydratedSessionIds: Set<string>;
  commitEvents: (events: readonly PiSessionEvent[]) => void;
}

const asInternal = (store: PiSessionStore): StoreInternal => store as unknown as StoreInternal;

/** Counter that records one count per listener invocation. */
const makeCounter = (): { count: number } => ({ count: 0 });

/** Seed a two-session resident cluster: A idle, B idle. Catalog rows exist. */
const seedCluster = (store: PiSessionStore, internal: StoreInternal, options?: { withMessages?: boolean }): void => {
  const messages = options?.withMessages ? new Map([
    ['u1', reducerMessage({ id: 'u1', role: 'user', text: 'hello' })],
  ]) : new Map();
  const sessionA = reducerSession({ sessionId: 'a', directory: '/repo', lastSequence: 1, messages });
  const sessionB = reducerSession({ sessionId: 'b', directory: '/repo', lastSequence: 1, messages });
  let catalog = (internal.state.catalog.byId ? internal.state.catalog : {
    byId: new Map(),
    byDirectory: new Map(),
    listStatusByDirectory: new Map(),
  });
  catalog = upsertStubRecord(
    { byId: new Map(), byDirectory: new Map(), listStatusByDirectory: new Map() },
    'a',
    '/repo',
    'idle',
    1,
  );
  catalog = upsertStubRecord(catalog, 'b', '/repo', 'idle', 1);
  internal.state = {
    ...store.getState(),
    directory: '/repo',
    connection: 'ready',
    selectedSessionId: 'a',
    sessions: [
      { session: { id: 'a', directory: '/repo' } as never, updatedAt: 1 },
      { session: { id: 'b', directory: '/repo' } as never, updatedAt: 1 },
    ],
    reducer: {
      bySession: new Map([['a', sessionA], ['b', sessionB]]),
      lastSequence: new Map([['a', 1], ['b', 1]]),
    },
    catalog,
  };
  internal.hydratedSessionIds = new Set(['a', 'b']);
};

const tickMicrotasks = async (count = 8) => {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
};

const assistantStart = (sessionId: string, sequence: number): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'assistant.message.start',
  sequence,
  sessionId,
  directory: '/repo',
  payload: {
    messageId: 'msg_1',
    role: 'assistant',
    startedAt: 1_000,
  },
});

const textDelta = (sessionId: string, sequence: number, delta: string): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'assistant.message.delta',
  sequence,
  sessionId,
  directory: '/repo',
  payload: { messageId: 'msg_1', contentIndex: 0, delta },
});

const lifecycle = (sessionId: string, sequence: number, state: 'busy' | 'idle' | 'retry' | 'error'): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'session.lifecycle',
  sequence,
  sessionId,
  directory: '/repo',
  payload: { state },
});

// ---------------------------------------------------------------------------
// Topic-isolated notifiers
// ---------------------------------------------------------------------------

describe('PiSessionStore topic-isolated notifiers', () => {
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
  });

  test('a token delta on B notifies session:B only; A, catalog, and chrome are silent', () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    seedCluster(store, internal);

    const aCounter = makeCounter();
    const bCounter = makeCounter();
    const catalogCounter = makeCounter();
    const chromeCounter = makeCounter();

    const unsubA = store.subscribe(() => { aCounter.count += 1; }, 'session:a');
    const unsubB = store.subscribe(() => { bCounter.count += 1; }, 'session:b');
    const unsubCatalog = store.subscribe(() => { catalogCounter.count += 1; }, 'catalog');
    const unsubChrome = store.subscribe(() => { chromeCounter.count += 1; }, 'chrome');

    const beforeA = store.getState().reducer.bySession.get('a');
    const beforeB = store.getState().reducer.bySession.get('b');

    internal.commitEvents([assistantStart('b', 2), textDelta('b', 3, 'hel'), textDelta('b', 4, 'lo')]);

    expect(bCounter.count).toBe(1);
    expect(aCounter.count).toBe(0);
    expect(catalogCounter.count).toBe(0);
    expect(chromeCounter.count).toBe(0);

    // Visible session's reducer record still gets a new reference so
    // the chat paints the new turn.
    const afterA = store.getState().reducer.bySession.get('a');
    const afterB = store.getState().reducer.bySession.get('b');
    expect(afterB).not.toBe(beforeB);
    expect(afterA).toBe(beforeA);

    unsubA(); unsubB(); unsubCatalog(); unsubChrome();
    store.dispose();
  });

  test('a lifecycle busy flip on B notifies session:B and catalog; chrome and A are silent', () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    seedCluster(store, internal);

    const aCounter = makeCounter();
    const bCounter = makeCounter();
    const catalogCounter = makeCounter();
    const chromeCounter = makeCounter();

    const unsubA = store.subscribe(() => { aCounter.count += 1; }, 'session:a');
    const unsubB = store.subscribe(() => { bCounter.count += 1; }, 'session:b');
    const unsubCatalog = store.subscribe(() => { catalogCounter.count += 1; }, 'catalog');
    const unsubChrome = store.subscribe(() => { chromeCounter.count += 1; }, 'chrome');

    internal.commitEvents([lifecycle('b', 2, 'busy')]);

    expect(bCounter.count).toBe(1);
    expect(catalogCounter.count).toBe(1);
    expect(aCounter.count).toBe(0);
    expect(chromeCounter.count).toBe(0);

    unsubA(); unsubB(); unsubCatalog(); unsubChrome();
    store.dispose();
  });

  test('a token event for a not-yet-listed session creates a busy stub (catalog fires; chrome and other sessions silent)', () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    // Seed only A — B has no catalog row yet.
    const sessionA = reducerSession({ sessionId: 'a', directory: '/repo', lastSequence: 1 });
    const catalog = upsertStubRecord(
      { byId: new Map(), byDirectory: new Map(), listStatusByDirectory: new Map() },
      'a',
      '/repo',
      'idle',
      1,
    );
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      selectedSessionId: 'a',
      sessions: [{ session: { id: 'a', directory: '/repo' } as never, updatedAt: 1 }],
      reducer: { bySession: new Map([['a', sessionA]]), lastSequence: new Map([['a', 1]]) },
      catalog,
    };
    internal.hydratedSessionIds = new Set(['a']);

    const bCounter = makeCounter();
    const catalogCounter = makeCounter();
    const chromeCounter = makeCounter();

    store.subscribe(() => { bCounter.count += 1; }, 'session:b');
    store.subscribe(() => { catalogCounter.count += 1; }, 'catalog');
    store.subscribe(() => { chromeCounter.count += 1; }, 'chrome');

    internal.commitEvents([assistantStart('b', 2)]);

    expect(bCounter.count).toBe(1);
    expect(catalogCounter.count).toBe(1);
    expect(chromeCounter.count).toBe(0);

    store.dispose();
  });

  test('no-op / stale event sequence commits nothing and notifies nothing', () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    seedCluster(store, internal);

    const bCounter = makeCounter();
    const catalogCounter = makeCounter();
    const chromeCounter = makeCounter();

    store.subscribe(() => { bCounter.count += 1; }, 'session:b');
    store.subscribe(() => { catalogCounter.count += 1; }, 'catalog');
    store.subscribe(() => { chromeCounter.count += 1; }, 'chrome');

    // sequence === 1 is already accepted; this is a stale event.
    internal.commitEvents([lifecycle('b', 1, 'busy')]);

    expect(bCounter.count).toBe(0);
    expect(catalogCounter.count).toBe(0);
    expect(chromeCounter.count).toBe(0);

    store.dispose();
  });

  test('subscribe() without a topic still broadcasts every commit (test compatibility)', () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    seedCluster(store, internal);

    const broadcast = makeCounter();
    const unsub = store.subscribe(() => { broadcast.count += 1; });

    internal.commitEvents([textDelta('b', 2, 'x')]);
    internal.commitEvents([textDelta('b', 3, 'y')]);

    expect(broadcast.count).toBe(2);

    unsub();
    store.dispose();
  });

  test('dedupe: a single listener registered in two topic buckets fires once per commit', () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    seedCluster(store, internal);

    // One listener reference, two subscriptions. Within a single
    // `emit(['catalog', 'session:b'])` call, the listener must fire once.
    const listener = () => { listenerCount.count += 1; };
    const listenerCount = makeCounter();
    Object.assign(globalThis, { __listenerCount: listenerCount });

    store.subscribe(listener, 'session:b');
    store.subscribe(listener, 'catalog');

    internal.commitEvents([lifecycle('b', 2, 'busy')]);

    expect(listenerCount.count).toBe(1);

    store.dispose();
  });

  test('a hydrate commit notifies session:{id}, chrome, and (when the hydrated flag flips) catalog', () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    // Seed only session A; B is in the catalog but not hydrated.
    const sessionA = reducerSession({ sessionId: 'a', directory: '/repo', lastSequence: 1 });
    let catalog = upsertStubRecord(
      { byId: new Map(), byDirectory: new Map(), listStatusByDirectory: new Map() },
      'a',
      '/repo',
      'idle',
      1,
    );
    catalog = upsertStubRecord(catalog, 'b', '/repo', 'idle', 1);
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      selectedSessionId: 'b',
      sessions: [
        { session: { id: 'a', directory: '/repo' } as never, updatedAt: 1 },
        { session: { id: 'b', directory: '/repo' } as never, updatedAt: 1 },
      ],
      reducer: { bySession: new Map([['a', sessionA]]), lastSequence: new Map([['a', 1]]) },
      catalog,
    };
    internal.hydratedSessionIds = new Set(['a']);

    const aCounter = makeCounter();
    const bCounter = makeCounter();
    const catalogCounter = makeCounter();
    const chromeCounter = makeCounter();

    store.subscribe(() => { aCounter.count += 1; }, 'session:a');
    store.subscribe(() => { bCounter.count += 1; }, 'session:b');
    store.subscribe(() => { catalogCounter.count += 1; }, 'catalog');
    store.subscribe(() => { chromeCounter.count += 1; }, 'chrome');

    // Drive `commitHydratedSession` directly via the store's internal.
    const hydrateInternal = store as unknown as {
      commitHydratedSession: (session: PiReducerSessionState, buffered?: readonly PiSessionEvent[]) => void;
    };
    hydrateInternal.commitHydratedSession(reducerSession({
      sessionId: 'b',
      directory: '/repo',
      lastSequence: 1,
    }));

    expect(bCounter.count).toBe(1);
    expect(aCounter.count).toBe(0);
    expect(chromeCounter.count).toBe(1);
    // B's row was just seeded with `hydrated: false`; flipping to true is a
    // catalog ref change so the catalog topic fires.
    expect(catalogCounter.count).toBe(1);

    store.dispose();
  });

  test('focusProject emits chrome (and catalog only when that directory list changed)', async () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    seedCluster(store, internal);

    const bCounter = makeCounter();
    const catalogCounter = makeCounter();
    const chromeCounter = makeCounter();

    store.subscribe(() => { bCounter.count += 1; }, 'session:b');
    store.subscribe(() => { catalogCounter.count += 1; }, 'catalog');
    store.subscribe(() => { chromeCounter.count += 1; }, 'chrome');

    await store.focusProject('/repo-b', null);
    await tickMicrotasks();

    expect(chromeCounter.count).toBeGreaterThanOrEqual(1);
    // B's session listener stays silent — a folder switch is chrome (and
    // maybe catalog), never session:{id}.
    expect(bCounter.count).toBe(0);

    store.dispose();
  });

  test('resetForRuntime broadcasts the empty state to every topic bucket', () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    seedCluster(store, internal);

    const broadcast = makeCounter();
    const chrome = makeCounter();
    const catalog = makeCounter();

    store.subscribe(() => { broadcast.count += 1; });
    store.subscribe(() => { chrome.count += 1; }, 'chrome');
    store.subscribe(() => { catalog.count += 1; }, 'catalog');

    (store as unknown as { resetForRuntime: () => void }).resetForRuntime();

    // The broadcast emit fires all buckets once; the subsequent
    // `start()` call (which `resetForRuntime` triggers) emits chrome
    // which in turn wakes the broadcast subscriber a second time.
    expect(broadcast.count).toBeGreaterThanOrEqual(1);
    expect(chrome.count).toBeGreaterThanOrEqual(1);
    expect(catalog.count).toBeGreaterThanOrEqual(1);

    store.dispose();
  });

  test('rename fires catalog (compare-before-assign regression guard)', async () => {
    // The bug this guards against: `this.state = { ..., catalog: next }`
    // followed by `if (next !== this.state.catalog)` — the comparison
    // is always false after the assignment. Rename is enough to detect
    // it because the helper returns a new catalog ref on a real change.
    const store = new PiSessionStore();
    const internal = asInternal(store);
    seedCluster(store, internal);
    const { piClient } = await import('@/lib/pi/client');
    const originalRename = piClient.renameSession.bind(piClient);
    piClient.renameSession = (async () => undefined) as typeof piClient.renameSession;
    try {
      const aCounter = makeCounter();
      const bCounter = makeCounter();
      const catalog = makeCounter();
      const chrome = makeCounter();

      store.subscribe(() => { aCounter.count += 1; }, 'session:a');
      store.subscribe(() => { bCounter.count += 1; }, 'session:b');
      store.subscribe(() => { catalog.count += 1; }, 'catalog');
      store.subscribe(() => { chrome.count += 1; }, 'chrome');

      await store.rename('b', 'A new title');

      expect(catalog.count).toBe(1);
      expect(chrome.count).toBe(1);
      expect(aCounter.count).toBe(0);
      expect(bCounter.count).toBe(0);
    } finally {
      piClient.renameSession = originalRename;
      store.dispose();
    }
  });

  test('archive fires catalog; chrome fires; session listeners stay silent', async () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    seedCluster(store, internal);
    const { piClient } = await import('@/lib/pi/client');
    const originalArchive = piClient.archiveSession.bind(piClient);
    piClient.archiveSession = (async () => undefined) as typeof piClient.archiveSession;
    try {
      const aCounter = makeCounter();
      const bCounter = makeCounter();
      const catalog = makeCounter();
      const chrome = makeCounter();

      store.subscribe(() => { aCounter.count += 1; }, 'session:a');
      store.subscribe(() => { bCounter.count += 1; }, 'session:b');
      store.subscribe(() => { catalog.count += 1; }, 'catalog');
      store.subscribe(() => { chrome.count += 1; }, 'chrome');

      await store.archive('b', true);

      expect(catalog.count).toBe(1);
      expect(chrome.count).toBe(1);
      expect(aCounter.count).toBe(0);
      expect(bCounter.count).toBe(0);
    } finally {
      piClient.archiveSession = originalArchive;
      store.dispose();
    }
  });

  test('remove fires session:B, catalog, and chrome', async () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    seedCluster(store, internal);
    const { piClient } = await import('@/lib/pi/client');
    const originalDelete = piClient.deleteSession.bind(piClient);
    piClient.deleteSession = (async () => true) as typeof piClient.deleteSession;
    try {
      const aCounter = makeCounter();
      const bCounter = makeCounter();
      const catalog = makeCounter();
      const chrome = makeCounter();

      store.subscribe(() => { aCounter.count += 1; }, 'session:a');
      store.subscribe(() => { bCounter.count += 1; }, 'session:b');
      store.subscribe(() => { catalog.count += 1; }, 'catalog');
      store.subscribe(() => { chrome.count += 1; }, 'chrome');

      await store.remove('b');

      expect(bCounter.count).toBe(1);
      expect(catalog.count).toBe(1);
      expect(chrome.count).toBe(1);
      expect(aCounter.count).toBe(0);
    } finally {
      piClient.deleteSession = originalDelete;
      store.dispose();
    }
  });

  test('prompt busy fires session:B and catalog (compare-before-assign regression guard)', async () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    // Seed with messages so `prompt` does not re-hydrate and add a second
    // chrome emit from `commitHydratedSession`.
    seedCluster(store, internal, { withMessages: true });
    const { piClient } = await import('@/lib/pi/client');
    const originalSendPrompt = piClient.sendPrompt.bind(piClient);
    piClient.sendPrompt = (async () => ({ accepted: true, messageId: 'msg_1' })) as typeof piClient.sendPrompt;
    try {
      const aCounter = makeCounter();
      const bCounter = makeCounter();
      const catalog = makeCounter();
      const chrome = makeCounter();

      store.subscribe(() => { aCounter.count += 1; }, 'session:a');
      store.subscribe(() => { bCounter.count += 1; }, 'session:b');
      store.subscribe(() => { catalog.count += 1; }, 'catalog');
      store.subscribe(() => { chrome.count += 1; }, 'chrome');

      await store.prompt('b', 'continue', 'prompt');

      expect(bCounter.count).toBeGreaterThanOrEqual(1);
      expect(catalog.count).toBe(1);
      expect(chrome.count).toBe(1);
      expect(aCounter.count).toBe(0);
    } finally {
      piClient.sendPrompt = originalSendPrompt;
      store.dispose();
    }
  });

  test('focusProject list settle fires catalog when the directory list changed', async () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    seedCluster(store, internal);
    const { piClient } = await import('@/lib/pi/client');
    const originalSelect = piClient.selectProject.bind(piClient);
    const originalList = piClient.listSessions.bind(piClient);
    piClient.selectProject = (async (directory: string) => ({ directory })) as typeof piClient.selectProject;
    piClient.listSessions = (async () => ({
      sessions: [
        { session: { id: 'a', directory: '/repo-b' }, updatedAt: 1 },
        { session: { id: 'b', directory: '/repo-b' }, updatedAt: 1 },
      ],
    })) as typeof piClient.listSessions;
    try {
      const catalog = makeCounter();
      const chrome = makeCounter();
      const aCounter = makeCounter();
      const bCounter = makeCounter();

      store.subscribe(() => { catalog.count += 1; }, 'catalog');
      store.subscribe(() => { chrome.count += 1; }, 'chrome');
      store.subscribe(() => { aCounter.count += 1; }, 'session:a');
      store.subscribe(() => { bCounter.count += 1; }, 'session:b');

      await store.focusProject('/repo-b', null);
      await tickMicrotasks();

      expect(catalog.count).toBeGreaterThanOrEqual(1);
      expect(chrome.count).toBeGreaterThanOrEqual(1);
      // session-level listeners stay silent on a folder switch — the
      // chat transcript does not change.
      expect(aCounter.count + bCounter.count).toBe(0);
    } finally {
      piClient.selectProject = originalSelect;
      piClient.listSessions = originalList;
      store.dispose();
    }
  });
});
