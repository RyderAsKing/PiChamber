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
});
