import { describe, expect, test } from 'bun:test';
import { getPiSessionStore } from '@/apps/pi-session-store';
import * as sessionActions from './session-actions';

describe('session-actions Pi shims', () => {
  test('permission and question dismissals are no-ops so send can continue', async () => {
    expect(await sessionActions.dismissOpenPermissionsForSession('s1')).toBe(false);
    expect(await sessionActions.dismissOpenQuestionsForSession('s1')).toBe(false);
  });

  test('waitForConnectionOrThrow succeeds when the Pi store is ready', async () => {
    getPiSessionStore().clear();
    await sessionActions.waitForConnectionOrThrow();
  });
});
