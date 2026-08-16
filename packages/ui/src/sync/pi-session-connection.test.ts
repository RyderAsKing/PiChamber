import { describe, expect, test } from 'bun:test';

import { PiSessionStore } from '@/apps/pi-session-store';
import { PiRequestError, piClient } from '@/lib/pi/client';
import type { PiReducerMessage, PiReducerSessionState } from '@/lib/pi/event-reducer';
import type { PiSessionEvent } from '@/lib/pi/protocol';
import { useNotificationStore } from '@/sync/notification-store';
import { resetSessionOrdering, useSessionOrderingStore } from '@/sync/session-ordering';

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
  parts: new Map(),
  toolsByCallId: new Map(),
  streamingMessages: new Set(),
  queue: { steering: 0, followUp: 0 },
  ...overrides,
});

describe('PiSessionStore connection and selection', () => {
  test('does not re-hydrate a resident session and keeps directory generation', async () => {
    const store = new PiSessionStore();
    const internal = store as unknown as {
      state: ReturnType<PiSessionStore['getState']>;
      generation: number;
      stream: { dispose: () => void } | null;
      hydratedSessionIds: Set<string>;
      hydrate: (sessionId: string, generation: number) => Promise<void>;
    };
    const resident = {
      sessionId: 'first',
      directory: '/repo',
      lifecycle: 'idle' as const,
      messages: new Map(),
      partOrder: new Map(),
      parts: new Map(),
      toolsByCallId: new Map(),
      streamingMessages: new Set<string>(),
      queue: { steering: 0, followUp: 0 },
      lastSequence: 4,
    };
    internal.stream = { dispose: () => undefined };
    internal.hydratedSessionIds = new Set(['first', 'initial']);
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      selectedSessionId: 'initial',
      reducer: {
        bySession: new Map([['first', resident], ['initial', { ...resident, sessionId: 'initial' }]]),
        lastSequence: new Map([['first', 4], ['initial', 1]]),
      },
    };
    const generation = internal.generation;
    let hydrateCalls = 0;
    internal.hydrate = async () => {
      hydrateCalls += 1;
    };

    await store.select('first');

    expect(store.getState().selectedSessionId).toBe('first');
    expect(hydrateCalls).toBe(0);
    expect(internal.generation).toBe(generation);
    expect(internal.stream).not.toBeNull();
    store.dispose();
  });

  test('hydrates an unknown session without disposing the live directory stream', async () => {
    const store = new PiSessionStore();
    const internal = store as unknown as {
      state: ReturnType<PiSessionStore['getState']>;
      generation: number;
      stream: { dispose: () => void } | null;
      hydrate: (sessionId: string, generation: number) => Promise<void>;
    };
    const stream = { dispose: () => undefined };
    internal.stream = stream;
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      selectedSessionId: 'initial',
    };
    const generation = internal.generation;
    const calls: string[] = [];
    internal.hydrate = async (sessionId, expected) => {
      calls.push(sessionId);
      expect(expected).toBe(generation);
    };

    await store.select('next');

    expect(calls).toEqual(['next']);
    expect(internal.stream).toBe(stream);
    expect(internal.generation).toBe(generation);
    store.dispose();
  });

  test('records the latest preferred session while its directory is opening', async () => {
    const store = new PiSessionStore();
    const internal = store as unknown as { state: ReturnType<PiSessionStore['getState']> };
    internal.state = { ...store.getState(), directory: '/repo', connection: 'loading' };

    await store.open('/repo', 'preferred');

    expect(store.getState().selectedSessionId).toBe('preferred');
    store.dispose();
  });

  test('retains preferred session ID during initial directory opening state', async () => {
    const store = new PiSessionStore();
    const internal = store as unknown as { state: ReturnType<PiSessionStore['getState']> };
    internal.state = { ...store.getState(), directory: '/repo-1', connection: 'ready', selectedSessionId: 'sess-1' };

    // When opening a new directory with a preferred session, the loading state preserves that session
    const openPromise = store.open('/repo-2', 'sess-2-target');
    const loadingState = store.getState();

    expect(loadingState.directory).toBe('/repo-2');
    expect(loadingState.selectedSessionId).toBe('sess-2-target');
    expect(loadingState.connection).toBe('loading');

    await openPromise.catch(() => undefined);
    store.dispose();
  });

  test('start without a daemon reports error instead of an empty ready list', async () => {
    const store = new PiSessionStore();
    await store.start();
    const state = store.getState();
    expect(state.connection === 'error' || state.connection === 'unavailable' || state.connection === 'loading').toBe(true);
    if (state.connection === 'error' || state.connection === 'unavailable') {
      expect(state.sessions).toEqual([]);
      expect(state.error).not.toBeNull();
    }
    store.dispose();
  });

  test('preserves existing sessions in reducer when removing an unrelated session', async () => {
    const store = new PiSessionStore();
    const internal = store as unknown as {
      state: ReturnType<PiSessionStore['getState']>;
    };
    const s1 = { sessionId: 'sess-1', directory: '/repo', lifecycle: 'busy' as const, messages: new Map(), partOrder: new Map(), parts: new Map(), toolsByCallId: new Map(), streamingMessages: new Set(['m1']), queue: { steering: 0, followUp: 0 }, lastSequence: 5 };
    const s2 = { sessionId: 'sess-2', directory: '/repo', lifecycle: 'idle' as const, messages: new Map(), partOrder: new Map(), parts: new Map(), toolsByCallId: new Map(), streamingMessages: new Set(), queue: { steering: 0, followUp: 0 }, lastSequence: 3 };
    const bySession = new Map();
    bySession.set('sess-1', s1);
    bySession.set('sess-2', s2);
    const lastSequence = new Map();
    lastSequence.set('sess-1', 5);
    lastSequence.set('sess-2', 3);

    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      sessions: [
        { session: { id: 'sess-1', directory: '/repo', archived: false } as never, updatedAt: 1 },
        { session: { id: 'sess-2', directory: '/repo', archived: false } as never, updatedAt: 2 },
      ],
      selectedSessionId: 'sess-1',
      reducer: { bySession, lastSequence },
    };

    // Remove sess-2
    const nextBySession = new Map(internal.state.reducer.bySession);
    nextBySession.delete('sess-2');
    const nextLastSequence = new Map(internal.state.reducer.lastSequence);
    nextLastSequence.delete('sess-2');
    internal.state = {
      ...internal.state,
      sessions: internal.state.sessions.filter((item) => item.session.id !== 'sess-2'),
      reducer: { bySession: nextBySession, lastSequence: nextLastSequence },
    };

    expect(store.getState().reducer.bySession.has('sess-1')).toBe(true);
    expect(store.getState().reducer.bySession.get('sess-1')?.lifecycle).toBe('busy');
    expect(store.getState().reducer.bySession.has('sess-2')).toBe(false);
    store.dispose();
  });

  test('overlays an in-flight turn onto a later getSession snapshot instead of replacing it', () => {
    const store = new PiSessionStore();
    const internal = store as unknown as {
      state: ReturnType<PiSessionStore['getState']>;
      commitHydratedSession: (session: PiReducerSessionState) => void;
    };
    const history = reducerMessage({ id: 'old', role: 'assistant', text: 'prior', durationMs: 800 });
    const user = reducerMessage({ id: 'u1', role: 'user', text: 'share the report', createdAt: 2 });
    const liveAssistant = reducerMessage({ id: 'a1', role: 'assistant', text: 'hello', streaming: true, createdAt: 3, parentId: 'u1' });
    const live = reducerSession({
      sessionId: 's1',
      lifecycle: 'busy',
      lastSequence: 10,
      messages: new Map([['u1', user], ['a1', liveAssistant]]),
      partOrder: new Map([['a1', ['p1']]]),
      parts: new Map([['p1', { id: 'p1', index: 0, type: 'text', text: 'hello', streaming: true }]]),
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

  test('aliases a synthetic stream user onto the persisted user so the prompt is not shown twice', () => {
    const store = new PiSessionStore();
    const internal = store as unknown as {
      state: ReturnType<PiSessionStore['getState']>;
      commitHydratedSession: (session: PiReducerSessionState) => void;
    };
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

  test('keeps local busy when a send has not produced messages yet', () => {
    const store = new PiSessionStore();
    const internal = store as unknown as {
      state: ReturnType<PiSessionStore['getState']>;
      commitHydratedSession: (session: PiReducerSessionState) => void;
    };
    const history = reducerMessage({ id: 'old', role: 'assistant', text: 'prior', durationMs: 800 });
    const existing = reducerSession({
      sessionId: 's1',
      lifecycle: 'busy',
      lastSequence: 4,
      messages: new Map([['old', history]]),
    });
    const fetched = reducerSession({
      sessionId: 's1',
      lastSequence: 9,
      messages: new Map([['old', { ...history }]]),
    });
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      reducer: { bySession: new Map([['s1', existing]]), lastSequence: new Map([['s1', 4]]) },
    };

    internal.commitHydratedSession(fetched);

    expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('busy');
    store.dispose();
  });

  test('does not let a stale getSession blank existing transcript text', () => {
    const store = new PiSessionStore();
    const internal = store as unknown as {
      state: ReturnType<PiSessionStore['getState']>;
      commitHydratedSession: (session: PiReducerSessionState) => void;
    };
    const prior = reducerMessage({ id: 'old', role: 'assistant', text: 'keep this report', durationMs: 800 });
    const user = reducerMessage({ id: 'u1', role: 'user', text: 'again', createdAt: 2 });
    const existing = reducerSession({
      sessionId: 's1',
      lifecycle: 'busy',
      lastSequence: 10,
      messages: new Map([['old', prior], ['u1', user]]),
      partOrder: new Map([['old', ['p-old']]]),
      parts: new Map([['p-old', { id: 'p-old', index: 0, type: 'text', text: 'keep this report', streaming: false }]]),
    });
    const fetched = reducerSession({
      sessionId: 's1',
      lastSequence: 12,
      messages: new Map([
        ['old', reducerMessage({ id: 'old', role: 'assistant', text: '', durationMs: 800 })],
        ['u1', reducerMessage({ id: 'u1', role: 'user', text: '', createdAt: 2 })],
      ]),
    });
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      reducer: { bySession: new Map([['s1', existing]]), lastSequence: new Map([['s1', 10]]) },
    };

    internal.commitHydratedSession(fetched);

    const committed = store.getState().reducer.bySession.get('s1');
    expect(committed?.messages.get('old')?.text).toBe('keep this report');
    expect(committed?.parts.get('p-old')?.text).toBe('keep this report');
    expect(committed?.messages.get('u1')?.text).toBe('again');
    expect(committed?.lifecycle).toBe('busy');
    expect(store.getState().hydratedSessionIds.has('s1')).toBe(true);
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

  test('does not overlay another session\'s live transcript onto a fetched session', () => {
    const store = new PiSessionStore();
    const internal = store as unknown as {
      state: ReturnType<PiSessionStore['getState']>;
      commitHydratedSession: (session: PiReducerSessionState) => void;
    };
    const foreign = reducerMessage({ id: 'u-check', role: 'user', text: 'check CSEO structure', createdAt: 1 });
    const fetchedUser = reducerMessage({ id: 'u-look', role: 'user', text: 'Take a look at CSEO', createdAt: 2 });
    const misplaced = reducerSession({
      sessionId: 's-check',
      messages: new Map([['u-check', foreign]]),
    });
    const fetched = reducerSession({
      sessionId: 's-look',
      messages: new Map([['u-look', fetchedUser]]),
    });
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      reducer: {
        bySession: new Map([['s-look', misplaced]]),
        lastSequence: new Map([['s-look', 1]]),
      },
    };

    internal.commitHydratedSession(fetched);

    const committed = store.getState().reducer.bySession.get('s-look');
    expect(committed?.sessionId).toBe('s-look');
    expect(committed?.messages.get('u-look')?.text).toBe('Take a look at CSEO');
    expect(committed?.messages.has('u-check')).toBe(false);
    store.dispose();
  });

  test('retries hydrate when the selected session is not yet ready', async () => {
    const store = new PiSessionStore();
    const internal = store as unknown as {
      state: ReturnType<PiSessionStore['getState']>;
      hydratedSessionIds: Set<string>;
      hydrate: (sessionId: string, generation: number) => Promise<void>;
    };
    internal.hydratedSessionIds = new Set();
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      connection: 'ready',
      selectedSessionId: 'first',
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

  test('moves a prompted session to the front of the list', () => {
    const store = new PiSessionStore();
    const internal = store as unknown as {
      state: ReturnType<PiSessionStore['getState']>;
      touchSessionList: (sessionId: string) => void;
    };
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
    const internal = store as unknown as {
      state: ReturnType<PiSessionStore['getState']>;
      promoteSession: (sessionId: string, phase: 'active' | 'settled', options?: { notifyIfSettled?: boolean }) => void;
    };
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
    expect(useSessionOrderingStore.getState().rankById.has('background')).toBe(true);

    internal.promoteSession('open', 'active');
    internal.promoteSession('open', 'settled', { notifyIfSettled: true });
    expect(useNotificationStore.getState().sessionUnseenCount('open')).toBe(0);
    store.dispose();
  });

  test('does not settle from a skipped stale session.error', () => {
    const store = new PiSessionStore();
    const internal = store as unknown as {
      state: ReturnType<PiSessionStore['getState']>;
      activityPhaseById: Map<string, 'active' | 'settled'>;
      commitEvents: (events: readonly PiSessionEvent[]) => void;
    };
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
    expect(internal.activityPhaseById.get('s1')).toBe('active');
    store.dispose();
  });

  test('keeps a prompted session busy when a reconnect snapshot is still idle', () => {
    const store = new PiSessionStore();
    const internal = store as unknown as {
      state: ReturnType<PiSessionStore['getState']>;
      pendingPromptById: Set<string>;
      activityPhaseById: Map<string, 'active' | 'settled'>;
      commitEvents: (events: readonly PiSessionEvent[]) => void;
    };
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
    expect(internal.activityPhaseById.get('s1')).toBe('active');
    store.dispose();
  });

  test('marks a prompted session busy even before reducer state exists', async () => {
    const store = new PiSessionStore();
    const original = piClient.sendPrompt.bind(piClient);
    piClient.sendPrompt = async () => ({ accepted: true, messageId: 'msg_1' });
    const internal = store as unknown as {
      state: ReturnType<PiSessionStore['getState']>;
    };
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      sessions: [{ session: { id: 's1', directory: '/repo', createdAt: 1, updatedAt: 1 } as never, updatedAt: 1 }],
    };
    try {
      await store.prompt('s1', 'continue', 'prompt');
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('busy');
      expect(store.getState().sessions[0]?.session.id).toBe('s1');
    } finally {
      piClient.sendPrompt = original;
      store.dispose();
    }
  });

  test('rolls a failed prompt back off busy when no live turn started', async () => {
    const store = new PiSessionStore();
    const original = piClient.sendPrompt.bind(piClient);
    piClient.sendPrompt = async () => {
      throw new PiRequestError('SESSION_BUSY', 'The Pi session already has an active run.');
    };
    const internal = store as unknown as {
      state: ReturnType<PiSessionStore['getState']>;
      activityPhaseById: Map<string, 'active' | 'settled'>;
    };
    internal.state = {
      ...store.getState(),
      directory: '/repo',
      sessions: [{ session: { id: 's1', directory: '/repo', createdAt: 1, updatedAt: 1 } as never, updatedAt: 1 }],
      reducer: {
        bySession: new Map([['s1', reducerSession({ sessionId: 's1', lifecycle: 'error' })]]),
        lastSequence: new Map([['s1', 3]]),
      },
    };
    try {
      await expect(store.prompt('s1', 'retry', 'prompt')).rejects.toThrow(/SESSION_BUSY|active run/);
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('error');
      expect(internal.activityPhaseById.get('s1')).toBe('settled');
    } finally {
      piClient.sendPrompt = original;
      store.dispose();
    }
  });
});
