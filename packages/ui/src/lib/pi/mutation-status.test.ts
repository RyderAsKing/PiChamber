import { describe, expect, test } from 'bun:test';

import {
  busySettingsMessage,
  deferredSettingsMessage,
  isDeferredPiMutation,
  isSessionBusyError,
} from './mutation-status';

describe('Pi mutation status', () => {
  test('recognizes the stable busy error code and legacy message form', () => {
    expect(isSessionBusyError({ code: 'SESSION_BUSY' })).toBe(true);
    expect(isSessionBusyError(new Error('Pi request failed: SESSION_BUSY'))).toBe(true);
    expect(isSessionBusyError({ code: 'DAEMON_REQUEST_FAILED' })).toBe(false);
  });

  test('distinguishes deferred mutations from ordinary responses', () => {
    expect(isDeferredPiMutation({ deferred: true })).toBe(true);
    expect(isDeferredPiMutation({ deferred: false })).toBe(false);
    expect(isDeferredPiMutation(null)).toBe(false);
  });

  test('uses direct copy for deferred and rejected settings changes', () => {
    expect(deferredSettingsMessage('Behavior')).toBe('Behavior saved. It will apply when active sessions are idle.');
    expect(busySettingsMessage('Behavior')).toBe('Behavior could not be changed while a session is running. Try again when it finishes.');
  });
});
