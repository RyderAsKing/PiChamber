import { describe, expect, mock, test } from 'bun:test';

const abort = mock(() => undefined);

mock.module('@/apps/pi-session-store', () => ({
  getPiSessionStore: () => ({
    getState: () => ({ connection: 'ready', error: null, selectedSessionId: null, sessions: [] }),
    abort,
    create: mock(async () => undefined),
    remove: mock(async () => undefined),
    archive: mock(async () => undefined),
    rename: mock(async () => undefined),
    fork: mock(async () => undefined),
    navigate: mock(async () => undefined),
  }),
}));
mock.module('@/lib/chat/pi-to-renderable', () => ({
  piSessionToUiSession: (session: unknown) => session,
}));

const sessionActions = await import('./session-actions');

describe('session-actions Pi shims', () => {
  test('permission and question dismissals are no-ops so send can continue', async () => {
    expect(await sessionActions.dismissOpenPermissionsForSession('s1')).toBe(false);
    expect(await sessionActions.dismissOpenQuestionsForSession('s1')).toBe(false);
  });

  test('waitForConnectionOrThrow succeeds when the Pi store is ready', async () => {
    await sessionActions.waitForConnectionOrThrow();
  });
});
