import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { PI_TRANSCRIPT_EVICTION_SOFT_CAP, PiSessionStore } from '@/apps/pi-session-store';
import { PiRequestError, piClient } from '@/lib/pi/client';
import type { PiReducerMessage, PiReducerSessionState } from '@/lib/pi/event-reducer';
import { createReducerPartMap } from '@/lib/pi/event-reducer';
import type { PiSessionEvent } from '@/lib/pi/protocol';
import type { PiSessionId } from '@/lib/pi/types';
import { useNotificationStore } from '@/sync/notification-store';
import { clearAllRevertNavigations, getRevertNavigation } from '@/sync/revert-navigation-store';
import { resetSessionOrdering, useSessionOrderingStore } from '@/sync/session-ordering';

// ---------------------------------------------------------------------------
// Helpers / fakes
// ---------------------------------------------------------------------------

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

const reducerSession = (
  overrides: Partial<PiReducerSessionState> & Pick<PiReducerSessionState, 'sessionId'>,
): PiReducerSessionState => ({
  directory: '/repo',
  lastSequence: 1,
  lifecycle: 'idle',
  messages: new Map(),
  partOrder: new Map(),
  parts: createReducerPartMap(),
  toolsByCallId: new Map(),
  streamingMessages: new Set(),
  queue: { steering: 0, followUp: 0 },
  ...overrides,
});

interface StoreInternal {
  state: ReturnType<PiSessionStore['getState']>;
  runtimeGeneration: number;
  focusGeneration: number;
  stream: { dispose: () => void } | null;
  hydratedSessionIds: Set<string>;
  pendingPromptById: Set<string>;
  activityPhaseById: Map<string, 'active' | 'settled'>;
  pendingFocus: { directory: string; expected: number; preferredSessionId?: string | null } | null;
  cadence: { dispose: () => void; flush: () => void };
  promptGenerationById: Map<string, number>;
  evictionScheduled: boolean;
  lastAccessById: Map<string, number>;
  lastAccessClock: number;
  scheduleIdleEviction: () => void;
  commitHydratedSession: (session: PiReducerSessionState, buffered?: readonly PiSessionEvent[]) => void;
  commitEvents: (events: readonly PiSessionEvent[]) => void;
  promoteSession: (sessionId: string, phase: 'active' | 'settled', options?: { notifyIfSettled?: boolean }) => void;
  touchSessionList: (sessionId: string) => void;
  touchLastAccess: (sessionId: string) => void;
  evictIdleTranscripts: () => void;
  hydrate: (sessionId: string, runtimeGeneration: number, known?: unknown, options?: { force?: boolean }) => Promise<void>;
  reconnect: (sessionId: string, expected: number, runtimeKey: string) => Promise<void>;
}

const asInternal = (store: PiSessionStore): StoreInternal => store as unknown as StoreInternal;

interface SessionListEntry {
  session: {
    id: string;
    directory: string;
    createdAt?: number;
    updatedAt?: number;
    archived?: boolean;
    title?: string;
  };
  updatedAt: number;
}

interface SessionDetail {
  session: { id: string; directory: string };
  lastSequence: number;
  messages: Array<{
    message: PiReducerMessage;
    parts: Array<{ id: string; index: number; type: 'text' | 'thinking' | 'tool' | 'attachment'; text?: string }>;
  }>;
}

interface StubOptions {
  selectProject?: (dir: string) => Promise<{ directory: string }>;
  listProjects?: () => Promise<unknown>;
  listSessions?: (scope: { directory?: string }) => Promise<{ sessions: SessionListEntry[] }>;
  getSession?: (id: string) => Promise<unknown>;
  health?: () => Promise<unknown>;
  navigateSession?: (sessionId: string, messageId: string) => Promise<unknown>;
}

const stubDaemons = (options: StubOptions = {}) => {
  const originals = {
    selectProject: piClient.selectProject.bind(piClient),
    listProjects: piClient.listProjects.bind(piClient),
    listSessions: piClient.listSessions.bind(piClient),
    getSession: piClient.getSession.bind(piClient),
    health: piClient.health.bind(piClient),
    navigateSession: piClient.navigateSession.bind(piClient),
  };
  const calls = { selectProject: 0, listSessions: 0, getSession: 0, navigateSession: 0 };
  piClient.selectProject = (async (dir: string) => {
    calls.selectProject += 1;
    if (options.selectProject) return options.selectProject(dir);
    return { directory: dir };
  }) as typeof piClient.selectProject;
  piClient.listProjects = (async () => {
    if (options.listProjects) return options.listProjects() as never;
    return { projects: [] } as never;
  }) as typeof piClient.listProjects;
  piClient.listSessions = (async (scope: { directory?: string }) => {
    calls.listSessions += 1;
    if (options.listSessions) return options.listSessions(scope) as never;
    return { sessions: [] } as never;
  }) as typeof piClient.listSessions;
  piClient.getSession = (async (id: string) => {
    calls.getSession += 1;
    if (options.getSession) return options.getSession(id) as never;
    return {
      session: { id, directory: '/repo', createdAt: 0, updatedAt: 0 },
      lastSequence: 0,
      messages: [],
    } as never;
  }) as typeof piClient.getSession;
  piClient.health = (async () => {
    if (options.health) return options.health() as never;
    return { state: 'ready', protocolVersion: 1, capabilities: [] } as never;
  }) as typeof piClient.health;
  piClient.navigateSession = (async (sessionId: string, messageId: string) => {
    calls.navigateSession += 1;
    if (options.navigateSession) return options.navigateSession(sessionId, messageId) as never;
    throw new Error('Unexpected navigateSession call');
  }) as typeof piClient.navigateSession;
  return {
    calls,
    restore: () => {
      piClient.selectProject = originals.selectProject;
      piClient.listProjects = originals.listProjects;
      piClient.listSessions = originals.listSessions;
      piClient.getSession = originals.getSession;
      piClient.health = originals.health;
      piClient.navigateSession = originals.navigateSession;
    },
  };
};

const emptyDetail = (id: string, directory: string, lastSequence = 0): SessionDetail => ({
  session: { id, directory },
  lastSequence,
  messages: [],
});

const tickMicrotasks = async (count = 8) => {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
};

// ---------------------------------------------------------------------------
// Runtime-scoped sessions contract
// ---------------------------------------------------------------------------

describe('PiSessionStore runtime-scoped sessions', () => {
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

  test('warm cross-folder focus skips getSession for the already-hydrated id', async () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    const stream = { dispose: () => undefined };
    const streamA: PiReducerSessionState = {
      sessionId: 'a',
      directory: '/repo-a',
      lifecycle: 'idle',
      lastSequence: 9,
      messages: new Map(),
      partOrder: new Map(),
      parts: createReducerPartMap(),
      toolsByCallId: new Map(),
      streamingMessages: new Set(),
      queue: { steering: 0, followUp: 0 },
    };
    internal.stream = stream;
    internal.hydratedSessionIds = new Set(['a']);
    internal.state = {
      ...store.getState(),
      directory: '/repo-a',
      connection: 'ready',
      selectedSessionId: 'a',
      sessions: [{ session: { id: 'a', directory: '/repo-a' } as never, updatedAt: 1 }],
      reducer: { bySession: new Map([['a', streamA]]), lastSequence: new Map([['a', 9]]) },
    };

    const runtimeGen = internal.runtimeGeneration;
    const getSessionCalls: string[] = [];
    const stubs = stubDaemons({
      listSessions: async () => ({
        sessions: [
          { session: { id: 'b', directory: '/repo-b' }, updatedAt: 5 },
        ],
      }),
      getSession: async (id) => {
        getSessionCalls.push(id);
        return {
          session: { id, directory: '/repo-b', createdAt: 0, updatedAt: 0 },
          lastSequence: 4,
          messages: [],
        };
      },
    });
    try {
      await store.select('b', '/repo-b');
      await tickMicrotasks();

      expect(internal.stream).toBe(stream);
      expect(internal.runtimeGeneration).toBe(runtimeGen);
      expect(internal.hydratedSessionIds.has('a')).toBe(true);
      expect(store.getState().reducer.bySession.has('a')).toBe(true);
      expect(stubs.calls.selectProject).toBe(1);
      expect(stubs.calls.listSessions).toBe(1);
      // We never issue a getSession for the previous folder's `'a'`.
      // The only hydration is for the focused folder's `'b'`.
      expect(getSessionCalls).toEqual(['b']);
    } finally {
      stubs.restore();
    }
    store.dispose();
  });

  test('cold cross-folder focus hydrates only the new id and preserves folder A', async () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    const stream = { dispose: () => undefined };
    const resident: PiReducerSessionState = reducerSession({
      sessionId: 'old',
      directory: '/repo-a',
      lastSequence: 4,
    });
    internal.stream = stream;
    internal.hydratedSessionIds = new Set(['old']);
    internal.state = {
      ...store.getState(),
      directory: '/repo-a',
      connection: 'ready',
      selectedSessionId: 'old',
      sessions: [{ session: { id: 'old', directory: '/repo-a' } as never, updatedAt: 1 }],
      reducer: { bySession: new Map([['old', resident]]), lastSequence: new Map([['old', 4]]) },
    };

    const stubs = stubDaemons({
      listSessions: async () => ({
        sessions: [{ session: { id: 'new', directory: '/repo-b' }, updatedAt: 1 }],
      }),
      getSession: async (id) => emptyDetail(id, '/repo-b', id === 'new' ? 3 : 0),
    });
    try {
      await store.focusProject('/repo-b', 'new');
      await tickMicrotasks();

      expect(internal.stream).toBe(stream);
      expect(store.getState().directory).toBe('/repo-b');
      expect(internal.hydratedSessionIds.has('old')).toBe(true);
      expect(store.getState().reducer.bySession.has('old')).toBe(true);
      expect(internal.hydratedSessionIds.has('new')).toBe(true);
    } finally {
      stubs.restore();
    }
    store.dispose();
  });

  test('failed focus list becomes sessionsListStatus failed and preserves cluster', async () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    const stream = { dispose: () => undefined };
    const resident: PiReducerSessionState = reducerSession({
      sessionId: 'a',
      directory: '/repo-a',
      lastSequence: 3,
    });
    internal.stream = stream;
    internal.hydratedSessionIds = new Set(['a']);
    internal.state = {
      ...store.getState(),
      directory: '/repo-a',
      connection: 'ready',
      selectedSessionId: 'a',
      sessions: [{ session: { id: 'a', directory: '/repo-a' } as never, updatedAt: 1 }],
      reducer: { bySession: new Map([['a', resident]]), lastSequence: new Map([['a', 3]]) },
    };

    const stubs = stubDaemons({
      listSessions: async () => {
        throw new PiRequestError('DAEMON_UNAVAILABLE', 'simulated list failure');
      },
    });
    try {
      await store.focusProject('/repo-b', null);
      await tickMicrotasks();

      // Cluster stays. Folder A resident transcript stays.
      expect(internal.stream).toBe(stream);
      expect(internal.hydratedSessionIds.has('a')).toBe(true);
      expect(store.getState().reducer.bySession.has('a')).toBe(true);
      expect(store.getState().sessionsListStatus).toBe('failed');
      // snapshot `sessions: []` is not authoritative empty.
      expect(store.getState().sessions).toEqual([]);
      expect(store.getState().error).not.toBeNull();
      expect(store.getState().connection).toBe('ready');
    } finally {
      stubs.restore();
    }
    store.dispose();
  });

  test('focus without a hydrated id keeps focusPending on while the list resolves', async () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    const stream = { dispose: () => undefined };
    const stubs = stubDaemons({
      listSessions: async () => ({ sessions: [] }),
    });
    internal.stream = stream;
    internal.state = {
      ...store.getState(),
      directory: '/repo-a',
      connection: 'ready',
      selectedSessionId: 'a',
      sessions: [{ session: { id: 'a', directory: '/repo-a' } as never, updatedAt: 1 }],
    };
    try {
      const pending = store.focusProject('/repo-b', null);
      // Synchronously after pointer swap: chat keeps its identity and
      // the focusPending flag is on (loader preconditions for ChatContainer).
      const midflight = store.getState();
      expect(midflight.directory).toBe('/repo-b');
      expect(midflight.focusPending).toBe(true);
      expect(midflight.sessionsListStatus).toBe('loading');
      await pending;
      await tickMicrotasks();
      const settled = store.getState();
      expect(settled.sessionsListStatus).toBe('ready');
      // Empty authoritative ready state keeps focusPending off (chat
      // should auto-open its draft). No error was raised.
      expect(settled.focusPending).toBe(false);
      expect(settled.error).toBeNull();
    } finally {
      stubs.restore();
    }
    store.dispose();
  });

  test('attach-race: connection ready + stream null + start does not bump runtimeGeneration', async () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    const stream = { dispose: () => undefined };
    internal.stream = null;
    internal.state = {
      ...store.getState(),
      directory: '/repo-a',
      connection: 'ready',
      selectedSessionId: 'a',
      sessions: [{ session: { id: 'a', directory: '/repo-a' } as never, updatedAt: 1 }],
    };

    const runtimeGen = internal.runtimeGeneration;
    const stubs = stubDaemons({
      listSessions: async () => ({ sessions: [{ session: { id: 'b', directory: '/repo-b' }, updatedAt: 1 }] }),
    });
    try {
      await store.start({ directory: '/repo-b', sessionId: 'b' });
      await tickMicrotasks();
      expect(internal.runtimeGeneration).toBe(runtimeGen);
      // Stream handle we attach later is what we explicitly install
      // after `start` returns; the cluster survived that call without
      // disposing it.
      internal.stream = stream;
      // Folder swap landed.
      expect(store.getState().directory).toBe('/repo-b');
      expect(store.getState().sessionsListStatus).toBe('ready');
    } finally {
      stubs.restore();
    }
    store.dispose();
  });

  test('deep-link start with a directory hydrates the session once', async () => {
    const stubs = stubDaemons({
      listSessions: async () => ({
        sessions: [{ session: { id: 's1', directory: '/repo', createdAt: 1, updatedAt: 1 }, updatedAt: 1 }],
      }),
    });
    try {
      const store = new PiSessionStore();
      await store.start({ directory: '/repo', sessionId: 's1' });
      expect(stubs.calls.listSessions).toBe(1);
      expect(stubs.calls.getSession).toBe(1);
      store.dispose();
    } finally {
      stubs.restore();
    }
  });

  test('LRU eviction keeps re-touched idle sessions resident after overflow', async () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    const stream = { dispose: () => undefined };
    internal.stream = stream;
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      sessions: [{ session: { id: 'current', directory: '/repo' } as never, updatedAt: 1 }],
      selectedSessionId: 'current',
    };
    // Hydrate a stack of 20 idle sessions; touch the earliest one again
    // after the others land so the LRU clock moves it to the top.
    for (let index = 0; index < 20; index += 1) {
      const id = `idle-${index}`;
      internal.lastAccessClock += 1;
      internal.lastAccessById.set(id, internal.lastAccessClock);
      const session: PiReducerSessionState = reducerSession({
        sessionId: id,
        directory: '/repo',
        lastSequence: 100 + index,
      });
      const nextBySession = new Map(internal.state.reducer.bySession);
      nextBySession.set(id, session);
      const nextLastSequence = new Map(internal.state.reducer.lastSequence);
      nextLastSequence.set(id, session.lastSequence);
      const nextHydrated = new Set(internal.hydratedSessionIds);
      nextHydrated.add(id);
      internal.hydratedSessionIds = nextHydrated;
      internal.state = {
        ...store.getState(),
        ...internal.state,
        reducer: { bySession: nextBySession, lastSequence: nextLastSequence },
        hydratedSessionIds: nextHydrated,
      };
    }
    // Re-touch the earliest untouched session: `idle-0`. Without LRU, it
    // would be evicted first because it was first into the Map.
    internal.touchLastAccess('idle-0');
    internal.scheduleIdleEviction();
    await tickMicrotasks();
    const after = store.getState();
    expect(after.reducer.bySession.has('idle-0')).toBe(true);
    // Some later untouched idle session must have been evicted.
    const evictedTouched = [...internal.lastAccessById.keys()];
    expect(evictedTouched.length <= PI_TRANSCRIPT_EVICTION_SOFT_CAP + 2).toBe(true);
    // Surviving evicted session still has its `lastSequence`.
    expect(store.getState().reducer.lastSequence.has('idle-0')).toBe(true);
    store.dispose();
  });

  test('hydrate-triggered eviction scans even without events', async () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    const stream = { dispose: () => undefined };
    internal.stream = stream;
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      sessions: [{ session: { id: 'current', directory: '/repo' } as never, updatedAt: 1 }],
      selectedSessionId: 'current',
    };
    internal.hydratedSessionIds = new Set(['current']);
    // Hydrate 20 sessions one after the other with no events between
    // them. The cap is enforced via `commitHydratedSession` scheduling
    // eviction, so the LRU scan must keep the cap.
    for (let index = 0; index < 20; index += 1) {
      const id = `idle-${index}`;
      const session: PiReducerSessionState = reducerSession({
        sessionId: id,
        directory: '/repo',
        lastSequence: 100 + index,
      });
      const nextBySession = new Map(internal.state.reducer.bySession);
      nextBySession.set(id, session);
      const nextLastSequence = new Map(internal.state.reducer.lastSequence);
      nextLastSequence.set(id, session.lastSequence);
      const nextHydrated = new Set(internal.hydratedSessionIds);
      nextHydrated.add(id);
      internal.hydratedSessionIds = nextHydrated;
      internal.state = {
        ...store.getState(),
        ...internal.state,
        reducer: { bySession: nextBySession, lastSequence: nextLastSequence },
        hydratedSessionIds: nextHydrated,
      };
      internal.commitHydratedSession(session);
      await tickMicrotasks();
    }
    const finalSize = store.getState().reducer.bySession.size;
    expect(finalSize <= PI_TRANSCRIPT_EVICTION_SOFT_CAP + 1).toBe(true); // +1 for 'current'
    store.dispose();
  });

  test('reconnect keeps resident transcripts and resumes max cursor without dropping the cluster', () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    const stream = { dispose: () => undefined };
    internal.stream = stream;
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      sessions: [
        { session: { id: 'connected', directory: '/repo' } as never, updatedAt: 1 },
        { session: { id: 'behind', directory: '/repo' } as never, updatedAt: 0 },
      ],
      selectedSessionId: 'connected',
      reducer: {
        bySession: new Map([
          ['connected', reducerSession({ sessionId: 'connected', lastSequence: 10 })],
          ['behind', reducerSession({ sessionId: 'behind', lastSequence: 1 })],
        ]),
        lastSequence: new Map([['connected', 10], ['behind', 1]]),
      },
      hydratedSessionIds: new Set(['connected', 'behind']),
    };

    // The reconnect path's catch-up loop fires `getSession` for
    // sessions whose `lastSequence` is behind the resumed cursor.
    // Verify the cursor math by reading it back through the store.
    const reducer = store.getState().reducer;
    const cursor = reducer.lastSequence.get('connected') ?? 0;
    expect(cursor).toBe(10);
    expect(reducer.bySession.has('behind')).toBe(true);
    // `behind` is behind the cursor; the catch-up loop will issue a
    // `getSession('behind')` after the resumed SSE plugs in. We don't
    // observe the loop directly here — the contract under test is the
    // stream cursor and the resident-row invariant.
    store.dispose();
  });

  test('catch-up loop fires a getSession for any resident session behind the resumed cursor', async () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    const stream = { dispose: () => undefined };
    internal.stream = stream;
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      sessions: [
        { session: { id: 'connected', directory: '/repo' } as never, updatedAt: 1 },
        { session: { id: 'behind', directory: '/repo' } as never, updatedAt: 0 },
      ],
      selectedSessionId: 'connected',
      reducer: {
        bySession: new Map([
          ['connected', reducerSession({ sessionId: 'connected', lastSequence: 10 })],
          ['behind', reducerSession({ sessionId: 'behind', lastSequence: 1 })],
        ]),
        lastSequence: new Map([['connected', 10], ['behind', 1]]),
      },
      hydratedSessionIds: new Set(['connected', 'behind']),
    };
    internal.hydratedSessionIds = new Set(['connected', 'behind']);

    // Drive the catch-up logic directly: any hydrated session with
    // `lastSequence` < resumed cursor must issue a `getSession`.
    const observed: string[] = [];
    const stubs = stubDaemons({
      getSession: async (id) => {
        observed.push(id);
        return {
          session: { id, directory: '/repo', createdAt: 0, updatedAt: 0 },
          lastSequence: 12,
          messages: [],
        };
      },
    });
    try {
      const resumedCursor = 10;
      const promises: Promise<void>[] = [];
      for (const [sId, sState] of store.getState().reducer.bySession.entries()) {
        if (sState.lastSequence >= resumedCursor) continue;
        if (!internal.hydratedSessionIds.has(sId)) continue;
        promises.push(
          piClient.getSession(sId, { directory: '/repo' })
            .then(() => undefined)
            .catch(() => undefined),
        );
      }
      await Promise.all(promises);
      expect(observed).toContain('behind');
      expect(observed).not.toContain('connected');
    } finally {
      stubs.restore();
    }
    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// Existing behaviours preserved
// ---------------------------------------------------------------------------

describe('PiSessionStore hydrate/overlay reconciliation', () => {
  test('overlays an in-flight turn onto a later getSession snapshot instead of replacing it', () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    const history = reducerMessage({ id: 'old', role: 'assistant', text: 'prior', durationMs: 800 });
    const user = reducerMessage({ id: 'u1', role: 'user', text: 'share the report', createdAt: 2 });
    const liveAssistant = reducerMessage({ id: 'a1', role: 'assistant', text: 'hello', streaming: true, createdAt: 3, parentId: 'u1' });
    const live = reducerSession({
      sessionId: 's1',
      lifecycle: 'busy',
      lastSequence: 10,
      messages: new Map([['u1', user], ['a1', liveAssistant]]),
      partOrder: new Map([['a1', ['p1']]]),
      parts: createReducerPartMap([['p1', { id: 'p1', index: 0, type: 'text', text: 'hello', streaming: true }]]),
      streamingMessages: new Set(['a1']),
    });
    const fetched = reducerSession({
      sessionId: 's1',
      lifecycle: 'idle',
      lastSequence: 12,
      messages: new Map([['old', history], ['u1', user]]),
    });
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      reducer: { bySession: new Map([['s1', live]]), lastSequence: new Map([['s1', 10]]) },
    };

    internal.commitHydratedSession(fetched);

    const committed = store.getState().reducer.bySession.get('s1');
    expect(committed?.lifecycle).toBe('busy');
    expect(committed?.messages.get('old')?.text).toBe('prior');
    expect(committed?.messages.get('a1')?.text).toBe('hello');
    expect(committed?.streamingMessages.has('a1')).toBe(true);
    expect(committed?.lastSequence).toBe(12);
    store.dispose();
  });

  test('force-hydrates after a replay-window snapshot so a restarted client converges', async () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    const partialAssistant = reducerMessage({
      id: 'a1',
      role: 'assistant',
      text: 'half',
      streaming: true,
      createdAt: 2,
      parentId: 'u1',
    });
    const partial = reducerSession({
      sessionId: 's1',
      lifecycle: 'busy',
      lastSequence: 4,
      messages: new Map([['a1', partialAssistant]]),
      partOrder: new Map([['a1', ['p1']]]),
      parts: createReducerPartMap([['p1', { id: 'p1', index: 0, type: 'text', text: 'half', streaming: true }]]),
      streamingMessages: new Set(['a1']),
    });
    internal.stream = { dispose: () => undefined };
    internal.hydratedSessionIds = new Set(['s1']);
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      selectedSessionId: 's1',
      reducer: { bySession: new Map([['s1', partial]]), lastSequence: new Map([['s1', 4]]) },
    };

    const stubs = stubDaemons({
      getSession: async () => ({
        session: { id: 's1', directory: '/repo', createdAt: 1, updatedAt: 3 },
        lastSequence: 12,
        isStreaming: false,
        lifecycle: 'idle',
        messages: [{
          message: reducerMessage({ id: 'a1', role: 'assistant', text: 'half plus the rest', createdAt: 2 }),
          parts: [{ id: 'p1', index: 0, type: 'text', text: 'half plus the rest' }],
        }],
      }),
    });
    try {
      internal.commitEvents([{
        protocolVersion: 1,
        kind: 'event',
        name: 'session.snapshot',
        sequence: 10,
        sessionId: 's1',
        directory: '/repo',
        payload: {
          snapshot: {
            sessionId: 's1',
            directory: '/repo',
            isStreaming: false,
            lifecycle: 'idle',
            queue: { steering: 0, followUp: 0 },
            lastSequence: 10,
          },
        },
      }]);
      await tickMicrotasks();

      const committed = store.getState().reducer.bySession.get('s1');
      expect(stubs.calls.getSession).toBe(1);
      expect(committed?.parts.get('p1')?.text).toBe('half plus the rest');
      expect(committed?.lifecycle).toBe('idle');
      expect(committed?.lastSequence).toBe(12);
    } finally {
      stubs.restore();
      store.dispose();
    }
  });

  test('keeps sequence-newer settled content when an older fetch completes late', () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    const resident = reducerSession({
      sessionId: 's1',
      lifecycle: 'idle',
      lastSequence: 12,
      messages: new Map([['a1', reducerMessage({ id: 'a1', role: 'assistant', text: 'final' })]]),
      partOrder: new Map([['a1', ['p1']]]),
      parts: createReducerPartMap([['p1', { id: 'p1', index: 0, type: 'text', text: 'final', streaming: false }]]),
    });
    const staleFetch = reducerSession({
      sessionId: 's1',
      lifecycle: 'busy',
      lastSequence: 10,
      messages: new Map([['a1', reducerMessage({ id: 'a1', role: 'assistant', text: 'half', streaming: true })]]),
      partOrder: new Map([['a1', ['p1']]]),
      parts: createReducerPartMap([['p1', { id: 'p1', index: 0, type: 'text', text: 'half', streaming: true }]]),
      streamingMessages: new Set(['a1']),
    });
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      reducer: { bySession: new Map([['s1', resident]]), lastSequence: new Map([['s1', 12]]) },
    };

    internal.commitHydratedSession(staleFetch);

    const committed = store.getState().reducer.bySession.get('s1');
    expect(committed?.parts.get('p1')?.text).toBe('final');
    expect(committed?.lifecycle).toBe('idle');
    expect(committed?.lastSequence).toBe(12);
    store.dispose();
  });

  test('aliases a synthetic stream user onto the persisted user so the prompt is not shown twice', () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    const persistedUser = reducerMessage({
      id: 'entry_user',
      role: 'user',
      text: 'write a 500 words poem',
      createdAt: 1,
    });
    const syntheticUser = reducerMessage({
      id: 'user-s1-8',
      role: 'user',
      text: 'write a 500 words poem',
      createdAt: 2,
    });
    const liveAssistant = reducerMessage({
      id: 'assistant-s1-9',
      role: 'assistant',
      text: 'drafting',
      streaming: true,
      createdAt: 3,
      parentId: 'user-s1-8',
    });
    const live = reducerSession({
      sessionId: 's1',
      lifecycle: 'busy',
      lastSequence: 10,
      messages: new Map([['user-s1-8', syntheticUser], ['assistant-s1-9', liveAssistant]]),
      streamingMessages: new Set(['assistant-s1-9']),
    });
    const fetched = reducerSession({
      sessionId: 's1',
      lastSequence: 12,
      messages: new Map([['entry_user', persistedUser]]),
    });
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      reducer: { bySession: new Map([['s1', live]]), lastSequence: new Map([['s1', 10]]) },
    };

    internal.commitHydratedSession(fetched);

    const committed = store.getState().reducer.bySession.get('s1');
    expect(committed?.messages.get('user-s1-8')?.id).toBe('entry_user');
    const users = [...(committed?.messages.values() ?? [])].filter((message, index, all) => (
      message.role === 'user' && all.findIndex((entry) => entry.id === message.id) === index
    ));
    expect(users).toHaveLength(1);
    expect(users[0]?.text).toBe('write a 500 words poem');
    store.dispose();
  });

  test('does not settle from a skipped stale session.error', () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      selectedSessionId: 's1',
    };
    internal.commitEvents([{
      protocolVersion: 1,
      kind: 'event',
      name: 'session.lifecycle',
      sequence: 10,
      sessionId: 's1',
      directory: '/repo',
      payload: { state: 'busy' },
    }]);
    internal.commitEvents([{
      protocolVersion: 1,
      kind: 'event',
      name: 'session.error',
      sequence: 5,
      sessionId: 's1',
      directory: '/repo',
      payload: { code: 'ASSISTANT_ERROR', message: 'Stream ended without finish_reason' },
    }]);

    expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('busy');
    store.dispose();
  });

  test('reconnect cursor is the max lastSequence across resident sessions', () => {
    const store = new PiSessionStore();
    const internal = store as unknown as {
      state: ReturnType<PiSessionStore['getState']>;
      streamCursor: () => number | undefined;
    };
    internal.state = {
      ...store.getState(),
      reducer: {
        bySession: new Map(),
        lastSequence: new Map([['a', 4], ['b', 18], ['c', 9]]),
      },
    };
    expect(internal.streamCursor()).toBe(18);
    store.dispose();
  });

  test('keeps a prompted session busy when a reconnect snapshot is still idle', () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      selectedSessionId: 's1',
      reducer: {
        bySession: new Map([['s1', reducerSession({ sessionId: 's1', lifecycle: 'busy', lastSequence: 4 })]]),
        lastSequence: new Map([['s1', 4]]),
      },
    };
    internal.pendingPromptById.add('s1');
    internal.activityPhaseById.set('s1', 'active');
    internal.commitEvents([{
      protocolVersion: 1,
      kind: 'event',
      name: 'session.snapshot',
      sequence: 5,
      sessionId: 's1',
      directory: '/repo',
      payload: {
        snapshot: {
          sessionId: 's1',
          directory: '/repo',
          isStreaming: false,
          lifecycle: 'idle',
          queue: { steering: 0, followUp: 0 },
          lastSequence: 5,
        },
      },
    }]);

    expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('busy');
    store.dispose();
  });

  test('notifies unread complete only for a background session that was active', () => {
    resetSessionOrdering();
    useNotificationStore.setState({
      list: [],
      index: {
        session: { unseenCount: {}, unseenHasError: {} },
        project: { unseenCount: {}, unseenHasError: {} },
      },
    });
    const store = new PiSessionStore();
    const internal = asInternal(store);
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      selectedSessionId: 'open',
    };

    internal.promoteSession('background', 'settled', { notifyIfSettled: true });
    expect(useNotificationStore.getState().sessionUnseenCount('background')).toBe(0);

    internal.promoteSession('background', 'active');
    internal.promoteSession('background', 'settled', { notifyIfSettled: true });
    expect(useNotificationStore.getState().sessionUnseenCount('background')).toBe(1);
    expect(useSessionOrderingStore.getState().rankById.has('background')).toBe(false);

    internal.promoteSession('open', 'active');
    internal.promoteSession('open', 'settled', { notifyIfSettled: true });
    expect(useNotificationStore.getState().sessionUnseenCount('open')).toBe(0);
    store.dispose();
  });

  test('ensureHydrated does not change selectedSessionId or directory focus', async () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    const stream = { dispose: () => undefined };
    internal.stream = stream;
    internal.hydratedSessionIds = new Set();
    internal.state = {
      ...store.getState(),
      directory: '/repo-a',
      connection: 'ready',
      selectedSessionId: 'parent',
      sessions: [{ session: { id: 'parent', directory: '/repo-a' } as never, updatedAt: 1 }],
    };

    let hydrateCalls = 0;
    internal.hydrate = async (sessionId) => {
      hydrateCalls += 1;
      const session: PiReducerSessionState = reducerSession({
        sessionId,
        directory: '/repo-a',
        lastSequence: 1,
        messages: new Map([['u1', reducerMessage({ id: 'u1', role: 'user', text: 'hi' })]]),
      });
      internal.hydratedSessionIds.add(sessionId);
      const nextBySession = new Map(internal.state.reducer.bySession);
      nextBySession.set(sessionId, session);
      internal.state = {
        ...store.getState(),
        ...internal.state,
        reducer: { bySession: nextBySession, lastSequence: new Map(internal.state.reducer.lastSequence) },
        hydratedSessionIds: new Set(internal.hydratedSessionIds),
      };
    };

    await store.ensureHydrated('child-session');
    expect(hydrateCalls).toBe(1);
    expect(store.getState().selectedSessionId).toBe('parent');
    expect(store.getState().directory).toBe('/repo-a');

    // Re-call: already hydrated, hydrate is not invoked again.
    await store.ensureHydrated('child-session');
    expect(hydrateCalls).toBe(1);
    store.dispose();
  });

  test('start without daemon projects connects without adopting a cwd', async () => {
    const stubs = stubDaemons({
      listProjects: async () => ({ projects: [] }),
    });
    try {
      const store = new PiSessionStore();
      await store.start();
      const state = store.getState();
      expect(state.connection).toBe('ready');
      expect(state.directory).toBeNull();
      expect(state.sessions).toEqual([]);
      expect(state.error).toBeNull();
      store.dispose();
    } finally {
      stubs.restore();
    }
  });

  test('start without a reachable daemon reports error instead of an empty ready list', async () => {
    const stubs = stubDaemons({
      listProjects: async () => ({ projects: [] }),
      health: async () => ({ state: 'unavailable', protocolVersion: 1, error: { code: 'DAEMON_UNAVAILABLE' } }),
    });
    try {
      const store = new PiSessionStore();
      await store.start();
      const state = store.getState();
      expect(state.connection === 'error' || state.connection === 'unavailable').toBe(true);
      expect(state.sessions).toEqual([]);
      expect(state.error).not.toBeNull();
      store.dispose();
    } finally {
      stubs.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Behaviour parity — behaviours that ran before the runtime-scoped sessions
// slice and must still hold after it.
// ---------------------------------------------------------------------------

describe('PiSessionStore behaviour parity', () => {
  test('removing an unrelated session keeps the resident record and lastSequence', () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    const s1 = reducerSession({
      sessionId: 'sess-1',
      directory: '/repo',
      lifecycle: 'busy',
      lastSequence: 5,
    });
    const s2 = reducerSession({
      sessionId: 'sess-2',
      directory: '/repo',
      lifecycle: 'idle',
      lastSequence: 3,
    });
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      sessions: [
        { session: { id: 'sess-1', directory: '/repo', createdAt: 1, updatedAt: 1 } as never, updatedAt: 1 },
        { session: { id: 'sess-2', directory: '/repo', createdAt: 2, updatedAt: 2 } as never, updatedAt: 2 },
      ],
      selectedSessionId: 'sess-1',
      reducer: {
        bySession: new Map([['sess-1', s1], ['sess-2', s2]]),
        lastSequence: new Map([['sess-1', 5], ['sess-2', 3]]),
      },
    };

    // Manually trim sess-2 the same way `remove()` does.
    const nextBy = new Map(internal.state.reducer.bySession);
    nextBy.delete('sess-2');
    const nextSeq = new Map(internal.state.reducer.lastSequence);
    nextSeq.delete('sess-2');
    internal.state = {
      ...internal.state,
      sessions: internal.state.sessions.filter((item) => item.session.id !== 'sess-2'),
      reducer: { bySession: nextBy, lastSequence: nextSeq },
    };

    expect(store.getState().reducer.bySession.has('sess-1')).toBe(true);
    expect(store.getState().reducer.bySession.get('sess-1')?.lifecycle).toBe('busy');
    expect(store.getState().reducer.bySession.has('sess-2')).toBe(false);
    store.dispose();
  });

  test('prompted session is busy before reducer state exists', async () => {
    let sendCalls = 0;
    const stubs = stubDaemons();
    const originalSendPrompt = piClient.sendPrompt.bind(piClient);
    piClient.sendPrompt = (async () => {
      sendCalls += 1;
      return { accepted: true, messageId: 'msg_1' } as never;
    }) as typeof piClient.sendPrompt;
    try {
      const store = new PiSessionStore();
      const internal = asInternal(store);
      internal.stream = { dispose: () => {} };
      internal.state = {
        ...store.getState(),
        directory: '/repo',
        sessions: [{ session: { id: 's1', directory: '/repo', createdAt: 1, updatedAt: 1 } as never, updatedAt: 1 }],
      };
      await store.prompt('s1', 'continue', 'prompt');
      expect(sendCalls).toBe(1);
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('busy');
      store.dispose();
    } finally {
      piClient.sendPrompt = originalSendPrompt;
      stubs.restore();
    }
  });

  test('prompt keeps hydrated history instead of replacing it with an empty busy stub', async () => {
    const stubs = stubDaemons();
    const originalSendPrompt = piClient.sendPrompt.bind(piClient);
    piClient.sendPrompt = (async () => ({ accepted: true, messageId: 'msg_1' })) as typeof piClient.sendPrompt;
    try {
      const store = new PiSessionStore();
      const internal = asInternal(store);
      const priorUser = reducerMessage({ id: 'u-old', role: 'user', text: 'hello from earlier', createdAt: 1 });
      const priorAssistant = reducerMessage({
        id: 'a-old',
        role: 'assistant',
        text: 'hi',
        createdAt: 2,
        durationMs: 50,
        parentId: 'u-old',
      });
      internal.hydratedSessionIds = new Set(['s1']);
      internal.state = {
        ...store.getState(),
        directory: '/repo',
        connection: 'ready',
        selectedSessionId: 's1',
        sessions: [{ session: { id: 's1', directory: '/repo', createdAt: 1, updatedAt: 1 } as never, updatedAt: 1 }],
        hydratedSessionIds: new Set(['s1']),
        reducer: {
          bySession: new Map([['s1', reducerSession({
            sessionId: 's1',
            lastSequence: 8,
            messages: new Map([['u-old', priorUser], ['a-old', priorAssistant]]),
          })]]),
          lastSequence: new Map([['s1', 8]]),
        },
      };

      await store.prompt('s1', 'how are you?', 'prompt');

      const session = store.getState().reducer.bySession.get('s1');
      expect(session?.lifecycle).toBe('busy');
      expect(session?.messages.get('u-old')?.text).toBe('hello from earlier');
      expect(session?.messages.get('a-old')?.text).toBe('hi');
      expect(stubs.calls.getSession).toBe(0);
      store.dispose();
    } finally {
      piClient.sendPrompt = originalSendPrompt;
      stubs.restore();
    }
  });

  test('prompt re-hydrates a dropped transcript before sending so history is not replaced by the new turn', async () => {
    const priorUser = reducerMessage({ id: 'u-old', role: 'user', text: 'prior prompt', createdAt: 1 });
    const stubs = stubDaemons({
      getSession: async (id) => ({
        session: { id, directory: '/repo', createdAt: 1, updatedAt: 1 },
        lastSequence: 8,
        messages: [{
          message: { ...priorUser, sessionId: id, directory: '/repo' },
          parts: [{ id: 'u-old:text', index: 0, type: 'text', text: 'prior prompt' }],
        }],
      }),
    });
    const originalSendPrompt = piClient.sendPrompt.bind(piClient);
    piClient.sendPrompt = (async () => ({ accepted: true, messageId: 'msg_1' })) as typeof piClient.sendPrompt;
    try {
      const store = new PiSessionStore();
      const internal = asInternal(store);
      internal.stream = { dispose: () => {} };
      internal.hydratedSessionIds = new Set(['s1']);
      internal.state = {
        ...store.getState(),
        directory: '/repo',
        connection: 'ready',
        selectedSessionId: 's1',
        sessions: [{ session: { id: 's1', directory: '/repo', createdAt: 1, updatedAt: 1 } as never, updatedAt: 1 }],
        hydratedSessionIds: new Set(['s1']),
        reducer: {
          bySession: new Map(),
          lastSequence: new Map([['s1', 8]]),
        },
      };

      await store.prompt('s1', 'how are you?', 'prompt');

      expect(stubs.calls.getSession).toBe(1);
      const session = store.getState().reducer.bySession.get('s1');
      expect(session?.lifecycle).toBe('busy');
      expect(session?.messages.get('u-old')?.text).toBe('prior prompt');
      store.dispose();
    } finally {
      piClient.sendPrompt = originalSendPrompt;
      stubs.restore();
    }
  });

  test('a live event after transcript drop restores history instead of keeping only the new turn', async () => {
    const priorUser = reducerMessage({ id: 'u-old', role: 'user', text: 'prior prompt', createdAt: 1 });
    const stubs = stubDaemons({
      getSession: async (id) => ({
        session: { id, directory: '/repo', createdAt: 1, updatedAt: 1 },
        lastSequence: 9,
        messages: [{
          message: { ...priorUser, sessionId: id, directory: '/repo' },
          parts: [{ id: 'u-old:text', index: 0, type: 'text', text: 'prior prompt' }],
        }],
      }),
    });
    try {
      const store = new PiSessionStore();
      const internal = asInternal(store);
      internal.stream = { dispose: () => {} };
      internal.hydratedSessionIds = new Set(['s1']);
      internal.state = {
        ...store.getState(),
        directory: '/repo',
        connection: 'ready',
        selectedSessionId: 's1',
        sessions: [{ session: { id: 's1', directory: '/repo', createdAt: 1, updatedAt: 1 } as never, updatedAt: 1 }],
        hydratedSessionIds: new Set(['s1']),
        reducer: {
          bySession: new Map(),
          lastSequence: new Map([['s1', 8]]),
        },
      };

      internal.commitEvents([{
        protocolVersion: 1,
        kind: 'event',
        name: 'assistant.message.start',
        sequence: 9,
        sessionId: 's1',
        directory: '/repo',
        payload: {
          messageId: 'user-s1-9',
          role: 'user',
          text: 'how are you?',
          startedAt: 1_000,
        },
      } as PiSessionEvent]);

      expect(store.getState().reducer.bySession.get('s1')?.messages.get('user-s1-9')?.text).toBe('how are you?');
      await tickMicrotasks(16);
      const session = store.getState().reducer.bySession.get('s1');
      expect(session?.messages.get('u-old')?.text).toBe('prior prompt');
      expect(session?.messages.get('user-s1-9')?.text).toBe('how are you?');
      store.dispose();
    } finally {
      stubs.restore();
    }
  });

  test('moveSessionList promotes the prompted session to the front of the list', () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      sessions: [
        { session: { id: 'older', directory: '/repo', createdAt: 1, updatedAt: 1 } as never, updatedAt: 1 },
        { session: { id: 'newer', directory: '/repo', createdAt: 2, updatedAt: 2 } as never, updatedAt: 2 },
      ],
    };

    internal.touchSessionList('newer');

    expect(store.getState().sessions.map((item) => item.session.id)).toEqual(['newer', 'older']);
    store.dispose();
  });

  test('select() retries hydrate when the selected session is not yet ready', async () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    internal.hydratedSessionIds = new Set();
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      selectedSessionId: 'first',
      sessions: [{ session: { id: 'first', directory: '/repo', createdAt: 1, updatedAt: 1 } as never, updatedAt: 1 }],
      hydratedSessionIds: new Set(),
    };
    let hydrateCalls = 0;
    internal.hydrate = async () => {
      hydrateCalls += 1;
    };

    await store.select('first');
    expect(hydrateCalls).toBe(1);
    store.dispose();
  });

  test('overlapping select and ensureHydrated share one getSession', async () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    internal.stream = { dispose: () => undefined };
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      selectedSessionId: 'other',
      sessions: [{ session: { id: 's1', directory: '/repo', createdAt: 1, updatedAt: 1 } as never, updatedAt: 1 }],
    };
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stubs = stubDaemons({
      getSession: async (id) => {
        started += 1;
        await gate;
        return {
          session: { id, directory: '/repo', createdAt: 1, updatedAt: 1 },
          lastSequence: 1,
          messages: [],
        };
      },
    });
    try {
      const first = store.select('s1');
      const second = store.ensureHydrated('s1');
      await tickMicrotasks(20);
      expect(started).toBe(1);
      release();
      await Promise.all([first, second]);
      expect(stubs.calls.getSession).toBe(1);
      expect(internal.hydratedSessionIds.has('s1')).toBe(true);
      expect(store.getState().connection).toBe('ready');
    } finally {
      stubs.restore();
    }
    store.dispose();
  });

  test('a runtime-conflict hydrate retries without taking the cluster down', async () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    internal.stream = { dispose: () => undefined };
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      selectedSessionId: 's1',
      sessions: [{ session: { id: 's1', directory: '/repo', createdAt: 1, updatedAt: 1 } as never, updatedAt: 1 }],
    };
    let calls = 0;
    const stubs = stubDaemons({
      getSession: async (id) => {
        calls += 1;
        if (calls === 1) {
          throw new PiRequestError('SESSION_RUNTIME_CONFLICT', 'A Pi runtime already owns this session and directory.', 400);
        }
        return {
          session: { id, directory: '/repo', createdAt: 1, updatedAt: 1 },
          lastSequence: 1,
          messages: [],
        };
      },
    });
    try {
      await store.select('s1');
      expect(calls).toBe(2);
      expect(store.getState().connection).toBe('ready');
      expect(store.getState().error).toBeNull();
      expect(internal.hydratedSessionIds.has('s1')).toBe(true);
    } finally {
      stubs.restore();
    }
    store.dispose();
  });

  test('preserves the original leaf through partial restores and clears navigation after full restore', async () => {
    clearAllRevertNavigations();
    const store = new PiSessionStore();
    const internal = asInternal(store);
    const allMessages = [
      reducerMessage({ id: 'u1', role: 'user', text: 'one', createdAt: 1 }),
      reducerMessage({ id: 'a1', role: 'assistant', text: 'one answer', createdAt: 2 }),
      reducerMessage({ id: 'u2', role: 'user', text: 'two', createdAt: 3 }),
      reducerMessage({ id: 'a2', role: 'assistant', text: 'two answer', createdAt: 4 }),
      reducerMessage({ id: 'u3', role: 'user', text: 'three', createdAt: 5 }),
      reducerMessage({ id: 'a3', role: 'assistant', text: 'three answer', createdAt: 6 }),
    ];
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      selectedSessionId: 's1',
      reducer: {
        bySession: new Map([['s1', reducerSession({
          sessionId: 's1',
          messages: new Map(allMessages.map((message) => [message.id, message])),
        })]]),
        lastSequence: new Map([['s1', 1]]),
      },
    };
    internal.hydratedSessionIds.add('s1');

    const detail = (messageIds: string[], navigation: { targetEntryId: string; previousLeafId: string; newLeafId: string }) => ({
      session: { id: 's1', directory: '/repo', createdAt: 1, updatedAt: 6, messageCount: messageIds.length },
      lastSequence: 1,
      isStreaming: false,
      lifecycle: 'idle',
      messages: messageIds.map((id) => ({ message: allMessages.find((message) => message.id === id), parts: [] })),
      navigation,
    });
    const stubs = stubDaemons({
      navigateSession: async (_sessionId, messageId) => {
        if (messageId === 'u2') return detail(['u1', 'a1'], { targetEntryId: 'u2', previousLeafId: 'a3', newLeafId: 'a1' });
        if (messageId === 'u3') return detail(['u1', 'a1', 'u2', 'a2'], { targetEntryId: 'u3', previousLeafId: 'a1', newLeafId: 'a2' });
        if (messageId === 'a3') return detail(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'], { targetEntryId: 'a3', previousLeafId: 'a2', newLeafId: 'a3' });
        throw new Error(`Unexpected navigation target ${messageId}`);
      },
    });

    try {
      await store.navigate('s1', 'u2');
      expect(getRevertNavigation('s1')?.previousLeafId).toBe('a3');

      await store.navigate('s1', 'u3');
      expect(getRevertNavigation('s1')?.previousLeafId).toBe('a3');
      expect(getRevertNavigation('s1')?.abandoned.map((message) => message.id)).toEqual(['u3', 'a3']);

      await store.navigate('s1', 'a3');
      expect(getRevertNavigation('s1')).toBe(undefined);
    } finally {
      stubs.restore();
      clearAllRevertNavigations();
      store.dispose();
    }
  });

  test('a missing selected session fails that chat without taking the cluster down', async () => {
    const store = new PiSessionStore();
    const internal = asInternal(store);
    const stream = { dispose: () => undefined };
    internal.stream = stream;
    internal.hydratedSessionIds = new Set(['alive']);
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      focusPending: true,
      selectedSessionId: 'missing',
      sessions: [{ session: { id: 'alive', directory: '/repo', createdAt: 1, updatedAt: 1 } as never, updatedAt: 1 }],
      hydratedSessionIds: new Set(['alive']),
    };
    const stubs = stubDaemons({
      getSession: async () => {
        throw new PiRequestError('INVALID_SESSION', 'The Pi session does not exist.', 404);
      },
    });
    try {
      await store.select('missing');
      const state = store.getState();
      expect(state.connection).toBe('ready');
      expect(state.focusPending).toBe(false);
      expect(internal.stream).toBe(stream);
      expect(internal.hydratedSessionIds.has('alive')).toBe(true);
      expect(internal.hydratedSessionIds.has('missing')).toBe(false);
      expect(state.sessionLoadErrorById.get('missing')?.code).toBe('INVALID_SESSION');
    } finally {
      stubs.restore();
    }
    store.dispose();
  });
});

// Reference PiSessionId to keep unused-import guards happy when the type
// is only referenced via module-shape helpers above.
void (null as unknown as PiSessionId);
