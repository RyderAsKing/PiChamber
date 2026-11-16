import { describe, expect, test } from 'bun:test';
import { PiRequestError } from './client';
import { describeSandboxSendError, isSessionSwitchingError, sandboxLimitText, sandboxReasonText, sessionSandboxLabel } from './sandboxText';

describe('sandboxReasonText', () => {
  test('explains each launcher reason code', () => {
    expect(sandboxReasonText('NOT_INSTALLED')).toBe('nono is not installed on the server machine.');
    expect(sandboxReasonText('NO_LANDLOCK')).toContain('Landlock');
    expect(sandboxReasonText('UNSUPPORTED_PLATFORM')).toContain('Linux');
    expect(sandboxReasonText('PROVIDER_HOSTS_UNAVAILABLE')).toContain('model providers');
    expect(sandboxReasonText('UNSUPPORTED_PLATFORM')).toContain('macOS');
    expect(sandboxReasonText('WSL_KERNEL_TOO_OLD')).toContain('wsl --update');
    expect(sandboxReasonText('SANDBOX_LIMITS_NOT_ACCEPTED')).toContain('Settings, Projects, Sandboxing');
  });

  test('falls back to a sentence for unknown or missing codes', () => {
    expect(sandboxReasonText('SOMETHING_NEW')).toBe('The sandbox is unavailable on the server machine.');
    expect(sandboxReasonText(undefined)).toBe('The sandbox is unavailable on the server machine.');
    expect(sandboxReasonText('toString')).toBe('The sandbox is unavailable on the server machine.');
  });
});

describe('sandboxLimitText', () => {
  test('names and explains each host limit, and falls back for unknown codes', () => {
    expect(sandboxLimitText('UNIX_SOCKETS').title).toBe('Unix sockets are not blocked');
    expect(sandboxLimitText('PROXY_PORT').text).toContain('any server');
    const fallback = { title: 'Part of the policy is not enforced', text: 'The sandbox on this server cannot enforce part of its policy.' };
    expect(sandboxLimitText('SOMETHING_NEW')).toEqual(fallback);
    expect(sandboxLimitText('toString')).toEqual(fallback);
  });
});

describe('sessionSandboxLabel', () => {
  test('is empty for an unsandboxed session with nothing pending', () => {
    expect(sessionSandboxLabel({ sandboxed: false })).toBeNull();
  });

  test('labels a sandboxed session', () => {
    expect(sessionSandboxLabel({ sandboxed: true })).toEqual({ icon: 'lock', text: 'Sandboxed' });
  });

  test('a pending switch wins over the current state, in both directions', () => {
    expect(sessionSandboxLabel({ sandboxed: false, pendingSwitch: { to: 'nono' } }))
      .toEqual({ icon: 'lock-unlock', text: 'Moves into the sandbox after this turn' });
    expect(sessionSandboxLabel({ sandboxed: true, pendingSwitch: { to: 'off' } }))
      .toEqual({ icon: 'lock-unlock', text: 'Leaves the sandbox after this turn' });
  });
});

describe('describeSandboxSendError', () => {
  test('explains an unavailable sandbox with its reason', () => {
    const error = new PiRequestError('SANDBOX_UNAVAILABLE', 'Sandbox unavailable', 503, 'NO_LANDLOCK');
    expect(describeSandboxSendError(error)).toBe(
      `This project is sandboxed, but its sandbox cannot start. ${sandboxReasonText('NO_LANDLOCK')}`,
    );
  });

  test('explains SESSION_IN_USE only while the session has a pending switch', () => {
    const error = new PiRequestError('SESSION_IN_USE', 'busy', 409);
    expect(describeSandboxSendError(error, { sandboxed: true, pendingSwitch: { to: 'off' } }))
      .toContain('finishing its turn');
    // Without a pending switch it means another PiChamber instance holds it.
    expect(describeSandboxSendError(error, { sandboxed: true })).toBeNull();
    expect(describeSandboxSendError(error)).toBeNull();
  });

  test('explains a switching refusal from its reason, whatever the session state says', () => {
    const error = new PiRequestError('SESSION_IN_USE', 'busy', 409, 'SESSION_SWITCHING');
    expect(isSessionSwitchingError(error)).toBe(true);
    expect(describeSandboxSendError(error)).toContain('finishing its turn');
    expect(isSessionSwitchingError(new PiRequestError('SESSION_IN_USE', 'busy', 409))).toBe(false);
    expect(isSessionSwitchingError(new Error('network'))).toBe(false);
  });

  test('has text for every reason the server reports', () => {
    for (const reason of [
      'SANDBOX_SETTING_CHANGED',
      'SANDBOX_SETTINGS_UNREADABLE',
      'SANDBOX_PORT_REFUSED',
      'SANDBOX_INVALID_NETWORK',
      'SANDBOX_SHADOW_CONFLICT',
      'DAEMON_START_TIMEOUT',
    ]) {
      expect(sandboxReasonText(reason)).not.toBe(sandboxReasonText('SOMETHING_UNKNOWN'));
    }
  });

  test('leaves other errors to the caller', () => {
    expect(describeSandboxSendError(new PiRequestError('INVALID_SESSION', 'gone', 404))).toBeNull();
    expect(describeSandboxSendError(new Error('network'))).toBeNull();
    expect(describeSandboxSendError(null)).toBeNull();
  });
});
