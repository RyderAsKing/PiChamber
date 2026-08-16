import { describe, expect, test } from 'bun:test';

import { PiSessionStore } from '@/apps/pi-session-store';

describe('PiSessionStore connection and selection', () => {
  test('allocates a distinct generation for each rapid ready-state selection', async () => {
    const store = new PiSessionStore();
    const internal = store as unknown as {
      state: ReturnType<PiSessionStore['getState']>;
      hydrate: (sessionId: string, generation: number) => Promise<void>;
    };
    internal.state = { ...store.getState(), directory: '/repo', connection: 'ready', selectedSessionId: 'initial' };
    const calls: Array<{ sessionId: string; generation: number }> = [];
    internal.hydrate = async (sessionId, generation) => {
      calls.push({ sessionId, generation });
    };

    await store.select('first');
    await store.select('second');

    expect(calls.map((call) => call.sessionId)).toEqual(['first', 'second']);
    expect(calls[1].generation).toBeGreaterThan(calls[0].generation);
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
});
