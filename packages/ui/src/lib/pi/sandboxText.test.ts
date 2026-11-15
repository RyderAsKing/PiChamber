import { describe, expect, test } from 'bun:test';
import { PiRequestError } from './client';
import { describeSandboxSendError, sandboxReasonText, sessionSandboxLabel } from './sandboxText';

describe('sandboxReasonText', () => {
  test('explains each launcher reason code', () => {
    expect(sandboxReasonText('NOT_INSTALLED')).toBe('nono is not installed on the server machine.');
    expect(sandboxReasonText('NO_LANDLOCK')).toContain('Landlock');
    expect(sandboxReasonText('UNSUPPORTED_PLATFORM')).toContain('Linux');
    expect(sandboxReasonText('PROVIDER_HOSTS_UNAVAILABLE')).toContain('model providers');
  });

  test('falls back to a sentence for unknown or missing codes', () => {
    expect(sandboxReasonText('SOMETHING_NEW')).toBe('The sandbox is unavailable on the server machine.');
    expect(sandboxReasonText(undefined)).toBe('The sandbox is unavailable on the server machine.');
    expect(sandboxReasonText('toString')).toBe('The sandbox is unavailable on the server machine.');
  });
});

describe('sessionSandboxLabel', () => {
  test('is empty for an unsandboxed session with nothing pending', () => {
    expect(sessionSandboxLabel({ sandboxed: false })).toBeNull();
  });

  test('labels a sandboxed session', () => {
    expect(sessionSandboxLabel({ sandboxed: true })).toEqual({ short: 'Sandboxed', long: 'Sandboxed' });
  });

  test('a pending switch wins over the current state, in both directions', () => {
    expect(sessionSandboxLabel({ sandboxed: false, pendingSwitch: { to: 'nono' } }))
      .toEqual({ short: 'Switching', long: 'Moves into the sandbox after this turn' });
    expect(sessionSandboxLabel({ sandboxed: true, pendingSwitch: { to: 'off' } }))
      .toEqual({ short: 'Switching', long: 'Leaves the sandbox after this turn' });
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

  test('leaves other errors to the caller', () => {
    expect(describeSandboxSendError(new PiRequestError('INVALID_SESSION', 'gone', 404))).toBeNull();
    expect(describeSandboxSendError(new Error('network'))).toBeNull();
    expect(describeSandboxSendError(null)).toBeNull();
  });
});
