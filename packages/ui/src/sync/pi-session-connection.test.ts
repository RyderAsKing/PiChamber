import { describe, expect, test } from 'bun:test';

import { PiSessionStore } from '@/apps/pi-session-store';

describe('PiSessionStore connection failure', () => {
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
