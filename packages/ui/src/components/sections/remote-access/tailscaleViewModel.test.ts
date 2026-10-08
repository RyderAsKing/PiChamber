import { describe, expect, test } from 'bun:test';
import type { TailscaleStatus } from '@/lib/tailscale';
import {
  getTailscaleModeValue,
  getTailscalePollIntervalMs,
  isTailscaleModeAllowed,
  presentTailscaleStatus,
  requiresPublicConfirm,
  TAILSCALE_FAST_POLL_MS,
  TAILSCALE_SLOW_POLL_MS,
} from './tailscaleViewModel';

const baseStatus = (overrides: Partial<TailscaleStatus> = {}): TailscaleStatus => ({
  installed: true,
  running: true,
  loggedIn: true,
  magicDnsName: 'm.ts.net',
  httpsCertsAvailable: null,
  config: { enabled: false, mode: 'private', httpsPort: 443 },
  state: 'off',
  url: null,
  approvalUrl: null,
  errorCode: null,
  errorMessage: null,
  ...overrides,
});

describe('tailscale polling cadence', () => {
  test('polls fast while transitional, slow otherwise', () => {
    expect(getTailscalePollIntervalMs('starting')).toBe(TAILSCALE_FAST_POLL_MS);
    expect(getTailscalePollIntervalMs('needs-approval')).toBe(TAILSCALE_FAST_POLL_MS);
    expect(TAILSCALE_FAST_POLL_MS).toBe(2_000);
    for (const state of ['off', 'unavailable', 'blocked', 'active', 'conflict', 'error', null] as const) {
      expect(getTailscalePollIntervalMs(state)).toBe(TAILSCALE_SLOW_POLL_MS);
    }
    expect(TAILSCALE_SLOW_POLL_MS).toBe(15_000);
  });
});

describe('public confirmation gating', () => {
  test('requires confirmation when switching on public from off/private', () => {
    expect(requiresPublicConfirm('off', 'public')).toBe(true);
    expect(requiresPublicConfirm('private', 'public')).toBe(true);
  });

  test('never confirms on page load shape or non-public targets', () => {
    expect(requiresPublicConfirm('public', 'public')).toBe(false);
    expect(requiresPublicConfirm('public', 'private')).toBe(false);
    expect(requiresPublicConfirm('public', 'off')).toBe(false);
    expect(requiresPublicConfirm('off', 'private')).toBe(false);
    expect(requiresPublicConfirm('off', 'off')).toBe(false);
  });
});

describe('tailscale mode value', () => {
  test('derives off/private/public from config', () => {
    expect(getTailscaleModeValue(baseStatus())).toBe('off');
    expect(getTailscaleModeValue(baseStatus({ config: { enabled: true, mode: 'private', httpsPort: 443 } }))).toBe('private');
    expect(getTailscaleModeValue(baseStatus({ config: { enabled: true, mode: 'public', httpsPort: 443 } }))).toBe('public');
  });
});

describe('failed fetch is never Off', () => {
  test('no status maps to no presentation (caller renders load-failed, not Off)', () => {
    expect(presentTailscaleStatus(null)).toBeNull();
  });
});

describe('tailscale status mapping', () => {
  test('off enables the control', () => {
    const view = presentTailscaleStatus(baseStatus({ state: 'off' }));
    expect(view?.pill).toBe('Off');
    expect(view?.tone).toBe('neutral');
    expect(view?.controlDisabled).toBe(false);
    expect(view?.showUrl).toBe(false);
  });

  test('off with not-installed flags renders Not installed, never Off', () => {
    const view = presentTailscaleStatus(baseStatus({ state: 'off', installed: false }));
    expect(view?.pill).toBe('Not installed');
    expect(view?.controlDisabled).toBe(true);
    expect(view?.headline).toContain('not installed');
  });

  test('off while signed out renders Not signed in, never Off', () => {
    const stopped = presentTailscaleStatus(baseStatus({ state: 'off', running: false }));
    expect(stopped?.pill).toBe('Not signed in');
    expect(stopped?.controlDisabled).toBe(true);
    const loggedOut = presentTailscaleStatus(baseStatus({ state: 'off', loggedIn: false }));
    expect(loggedOut?.pill).toBe('Not signed in');
    expect(loggedOut?.controlDisabled).toBe(true);
  });

  test('per-mode auth gate allows separately and defaults open without a gate', () => {
    expect(isTailscaleModeAllowed(baseStatus(), 'private')).toBe(true);
    expect(isTailscaleModeAllowed(baseStatus(), 'public')).toBe(true);
    const gated = baseStatus({ authGate: { privateAllowed: true, publicAllowed: false } });
    expect(isTailscaleModeAllowed(gated, 'private')).toBe(true);
    expect(isTailscaleModeAllowed(gated, 'public')).toBe(false);
    expect(isTailscaleModeAllowed(null, 'private')).toBe(false);
  });

  test('not_installed disables the control with an installer headline', () => {
    const view = presentTailscaleStatus(baseStatus({ state: 'unavailable', errorCode: 'not_installed' }));
    expect(view?.pill).toBe('Not installed');
    expect(view?.controlDisabled).toBe(true);
    expect(view?.controlDisabledReason).toContain('Install Tailscale');
    expect(view?.headline).toContain('not installed');
  });

  test('not_running and not_logged_in disable the control with sign-in copy', () => {
    for (const errorCode of ['not_running', 'not_logged_in'] as const) {
      const view = presentTailscaleStatus(baseStatus({ state: 'unavailable', errorCode }));
      expect(view?.controlDisabled).toBe(true);
      expect(view?.controlDisabledReason).toContain('sign in');
      expect(view?.headline).toBeTruthy();
    }
  });

  test('blocked (auth_required) keeps the control enabled and shows the password callout', () => {
    const view = presentTailscaleStatus(baseStatus({
      state: 'blocked',
      errorCode: 'auth_required',
      config: { enabled: true, mode: 'private', httpsPort: 443 },
    }));
    expect(view?.pill).toBe('Blocked');
    expect(view?.tone).toBe('warning');
    expect(view?.controlDisabled).toBe(false);
    expect(view?.showAuthCallout).toBe(true);
  });

  test('starting shows setup state, with a DNS note only for public', () => {
    const privateStarting = presentTailscaleStatus(baseStatus({
      state: 'starting',
      config: { enabled: true, mode: 'private', httpsPort: 443 },
    }));
    expect(privateStarting?.pill).toContain('Setting up');
    expect(privateStarting?.tone).toBe('info');
    expect(privateStarting?.showStartingNote).toBe(false);

    const publicStarting = presentTailscaleStatus(baseStatus({
      state: 'starting',
      config: { enabled: true, mode: 'public', httpsPort: 443 },
    }));
    expect(publicStarting?.showStartingNote).toBe(true);
  });

  test('needs-approval surfaces the approval action', () => {
    const view = presentTailscaleStatus(baseStatus({
      state: 'needs-approval',
      errorCode: 'needs_approval',
      approvalUrl: 'https://login.tailscale.com/f/serve?node=1',
      config: { enabled: true, mode: 'private', httpsPort: 443 },
    }));
    expect(view?.pill).toContain('approval');
    expect(view?.tone).toBe('warning');
    expect(view?.showApproval).toBe(true);
  });

  test('active private shows the URL with a Private badge', () => {
    const view = presentTailscaleStatus(baseStatus({
      state: 'active',
      url: 'https://m.ts.net',
      config: { enabled: true, mode: 'private', httpsPort: 443 },
    }));
    expect(view?.showUrl).toBe(true);
    expect(view?.pill).toBe('On · Private');
    expect(view?.tone).toBe('success');
  });

  test('active public warns with a Public badge', () => {
    const view = presentTailscaleStatus(baseStatus({
      state: 'active',
      url: 'https://m.ts.net',
      config: { enabled: true, mode: 'public', httpsPort: 443 },
    }));
    expect(view?.showUrl).toBe(true);
    expect(view?.pill).toBe('On · Public');
    expect(view?.tone).toBe('warning');
  });

  test('conflict shows the port picker and the server message', () => {
    const view = presentTailscaleStatus(baseStatus({
      state: 'conflict',
      errorCode: 'conflict',
      errorMessage: 'Port 443 already serves another destination.',
      config: { enabled: true, mode: 'private', httpsPort: 443 },
    }));
    expect(view?.pill).toBe('Port in use');
    expect(view?.showPortPicker).toBe(true);
    expect(view?.headline).toContain('Port 443');
  });

  test('permission_denied shows the operator fix path', () => {
    const view = presentTailscaleStatus(baseStatus({
      state: 'error',
      errorCode: 'permission_denied',
      errorMessage: 'Tailscale denied the serve configuration.',
      config: { enabled: true, mode: 'private', httpsPort: 443 },
    }));
    expect(view?.showPermissionFix).toBe(true);
    expect(view?.showPortPicker).toBe(false);
  });

  test('generic error surfaces the message for Try again', () => {
    for (const errorCode of ['apply_failed', 'probe_failed', 'invalid_config', 'timeout', 'unknown'] as const) {
      const view = presentTailscaleStatus(baseStatus({
        state: 'error',
        errorCode,
        errorMessage: `boom ${errorCode}`,
        config: { enabled: true, mode: 'private', httpsPort: 443 },
      }));
      expect(view?.pill).toBe('Error');
      expect(view?.tone).toBe('error');
      expect(view?.headline).toContain(errorCode);
      expect(view?.showPermissionFix).toBe(false);
    }
  });

  test('status_query_failed maps to readable copy for Try again', () => {
    const view = presentTailscaleStatus(baseStatus({
      state: 'error',
      errorCode: 'status_query_failed',
      errorMessage: 'Could not read the current Tailscale serve status, so nothing was changed. Try again.',
      config: { enabled: true, mode: 'private', httpsPort: 443 },
    }));
    expect(view?.pill).toBe('Error');
    expect(view?.tone).toBe('error');
    expect(view?.headline).toContain('nothing was changed');
    expect(view?.showPermissionFix).toBe(false);
    expect(view?.showPortPicker).toBe(false);
    const fallback = presentTailscaleStatus(baseStatus({
      state: 'error',
      errorCode: 'status_query_failed',
      errorMessage: null,
      config: { enabled: true, mode: 'private', httpsPort: 443 },
    }));
    expect(fallback?.headline).toContain('Try again');
  });
});
