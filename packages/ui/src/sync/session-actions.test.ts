import { describe, test } from 'bun:test';
import { getPiSessionStore } from '@/apps/pi-session-store';
import * as sessionActions from './session-actions';

describe('session-actions Pi shims', () => {
  test('waitForConnectionOrThrow succeeds when the Pi store is ready', async () => {
    getPiSessionStore().clear();
    await sessionActions.waitForConnectionOrThrow();
  });
});
