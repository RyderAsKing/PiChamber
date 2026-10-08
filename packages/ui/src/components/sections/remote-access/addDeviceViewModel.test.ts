import { describe, expect, test } from 'bun:test';
import {
  buildAddDeviceSessionInput,
  formatPairingCountdown,
  getAddDevicePhase,
  getIncludedRouteChips,
  isLoopbackOnlyTransports,
  shouldAnnounceCountdown,
} from './addDeviceViewModel';

describe('add device session input (all routes, no picker)', () => {
  test('advertises LAN directly and relay only when available', () => {
    expect(buildAddDeviceSessionInput({ lan: 'http://192.168.1.74:3000', relayAvailable: true })).toEqual({
      serverUrl: 'http://192.168.1.74:3000',
      includeRelay: true,
      includeDirect: true,
    });
  });

  test('omits relay when unavailable and serverUrl when there is no LAN', () => {
    expect(buildAddDeviceSessionInput({ lan: null, relayAvailable: false })).toEqual({
      includeRelay: false,
      includeDirect: true,
    });
  });
});

describe('loopback-only callout', () => {
  const base = { local: 'http://127.0.0.1:3000', lan: null as string | null, relayAvailable: false, tailscale: null };
  test('loopback alone cannot pair', () => {
    expect(isLoopbackOnlyTransports(base)).toBe(true);
  });

  test('any reachable route clears the callout', () => {
    expect(isLoopbackOnlyTransports({ ...base, lan: 'http://192.168.1.74:3000' })).toBe(false);
    expect(isLoopbackOnlyTransports({ ...base, relayAvailable: true })).toBe(false);
    expect(isLoopbackOnlyTransports({
      ...base,
      tailscale: { available: true, url: 'https://m.ts.net', mode: 'private' as const },
    })).toBe(false);
  });

  test('an inactive tailscale entry does not clear the callout', () => {
    expect(isLoopbackOnlyTransports({
      ...base,
      tailscale: { available: false, url: null, mode: 'private' as const },
    })).toBe(true);
  });
});

describe('included route chips', () => {
  test('lists LAN, Tailscale mode, and relay', () => {
    expect(getIncludedRouteChips({
      lanUrl: 'http://192.168.1.74:3000',
      candidates: [
        { type: 'lan', url: 'http://192.168.1.74:3000', priority: 10 },
        { type: 'tailscale', url: 'https://m.ts.net', mode: 'private', priority: 20 },
        {
          type: 'relay',
          relayUrl: 'wss://relay.example/ws',
          serverId: 's1',
          hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
          priority: 30,
        },
      ],
    })).toEqual([
      { key: 'lan', label: 'Local network · 192.168.1.74' },
      { key: 'tailscale', label: 'Tailscale · Private' },
      { key: 'relay', label: 'Relay · works away from home' },
    ]);
  });

  test('labels public tailscale and falls back to the LAN url host', () => {
    expect(getIncludedRouteChips({
      lanUrl: 'http://192.168.1.9:3000',
      candidates: [{ type: 'tailscale', url: 'https://m.ts.net:8443', mode: 'public', priority: 20 }],
    })).toEqual([
      { key: 'lan', label: 'Local network · 192.168.1.9' },
      { key: 'tailscale', label: 'Tailscale · Public' },
    ]);
  });

  test('no candidates means no chips', () => {
    expect(getIncludedRouteChips({ lanUrl: null, candidates: [] })).toEqual([]);
  });
});

describe('expiry countdown', () => {
  test('formats minutes and seconds', () => {
    expect(formatPairingCountdown(582_000)).toBe('Expires in 9:42');
    expect(formatPairingCountdown(60_000)).toBe('Expires in 1:00');
    expect(formatPairingCountdown(9_500)).toBe('Expires in 0:09');
  });

  test('returns null once expired or invalid', () => {
    expect(formatPairingCountdown(0)).toBeNull();
    expect(formatPairingCountdown(-1)).toBeNull();
    expect(formatPairingCountdown(Number.NaN)).toBeNull();
  });

  test('announces at minute boundaries and the final seconds, not every tick', () => {
    expect(shouldAnnounceCountdown(599_000, 601_000)).toBe(true);
    expect(shouldAnnounceCountdown(590_000, 591_000)).toBe(false);
    expect(shouldAnnounceCountdown(9_500, 10_500)).toBe(true);
    expect(shouldAnnounceCountdown(9_400, 9_900)).toBe(false);
  });
});

describe('add device phases', () => {
  const future = new Date(Date.now() + 500_000).toISOString();
  const past = new Date(Date.now() - 1_000).toISOString();

  test('creating without a payload, ready with a live one', () => {
    expect(getAddDevicePhase({ expiresAt: null, nowMs: Date.now(), hasPayload: false, succeeded: false })).toBe('creating');
    expect(getAddDevicePhase({ expiresAt: future, nowMs: Date.now(), hasPayload: true, succeeded: false })).toBe('ready');
  });

  test('expired codes and success close', () => {
    expect(getAddDevicePhase({ expiresAt: past, nowMs: Date.now(), hasPayload: true, succeeded: false })).toBe('expired');
    expect(getAddDevicePhase({ expiresAt: past, nowMs: Date.now(), hasPayload: true, succeeded: true })).toBe('succeeded');
  });
});
