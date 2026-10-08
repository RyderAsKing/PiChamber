import { describe, expect, test } from 'bun:test';

import {
  mobileConnectionToServerListItem,
  type MobileServerConnectionInput,
} from './mobileServerViewModel';
import { sortServerListItems } from './serverViewModel';

const lanDirect = { kind: 'direct' as const, url: 'http://192.168.1.74:2606' };
const tailscaleDirect = { kind: 'direct' as const, url: 'https://studio.tailabcd.ts.net' };
const tunnelDirect = { kind: 'direct' as const, url: 'https://relay.trycloudflare.com' };
const relayOnly = { kind: 'relay' as const };

const lanConnection: MobileServerConnectionInput = {
  id: 'lan',
  label: 'Studio LAN',
  candidates: [lanDirect],
};

const mixedConnection: MobileServerConnectionInput = {
  id: 'mixed',
  label: 'Studio',
  candidates: [lanDirect, tailscaleDirect, tunnelDirect, relayOnly],
};

const relayConnection: MobileServerConnectionInput = {
  id: 'relay',
  label: 'Cabin',
  candidates: [relayOnly],
};

describe('mobileConnectionToServerListItem routes', () => {
  test('direct candidates classify to LAN / Tailscale / Tunnel routes', () => {
    const item = mobileConnectionToServerListItem(mixedConnection, {
      isCurrent: false,
      status: { kind: 'unknown' },
    });
    expect(item.routes.map((route) => route.kind)).toEqual([
      'lan',
      'tailscale',
      'tunnel',
      'relay',
    ]);
    expect(item.routes.map((route) => route.label)).toEqual([
      'Local network',
      'Tailscale',
      'Tunnel',
      'PiChamber Relay',
    ]);
    expect(item.routes[0]?.address).toBe('http://192.168.1.74:2606');
    expect(item.routes[3]?.address).toBeNull();
  });

  test('relay-only connection yields one relay route with no pseudo-URL', () => {
    const item = mobileConnectionToServerListItem(relayConnection, {
      isCurrent: false,
      status: { kind: 'unknown' },
    });
    expect(item.routes).toHaveLength(1);
    expect(item.routes[0]?.kind).toBe('relay');
    expect(item.routes[0]?.label).toBe('PiChamber Relay');
    expect(item.routes[0]?.address).toBeNull();
    expect(JSON.stringify(item)).not.toContain('relay://');
  });

  test('active route follows the live transport', () => {
    const viaRelay = mobileConnectionToServerListItem(mixedConnection, {
      isCurrent: true,
      status: { kind: 'connected', transport: 'relay' },
    });
    expect(viaRelay.activeRoute?.kind).toBe('relay');

    const viaDirect = mobileConnectionToServerListItem(mixedConnection, {
      isCurrent: true,
      status: { kind: 'connected', transport: 'direct' },
    });
    expect(viaDirect.activeRoute?.kind).toBe('lan');
    expect(viaDirect.activeRoute?.address).toBe('http://192.168.1.74:2606');
  });

  test('non-current rows have no active route even when connected state is passed', () => {
    const item = mobileConnectionToServerListItem(lanConnection, {
      isCurrent: false,
      status: { kind: 'connected', transport: 'direct' },
    });
    expect(item.activeRoute).toBeNull();
  });
});

describe('mobileConnectionToServerListItem statuses', () => {
  test('each live state maps to the shared vocabulary', () => {
    const statusOf = (status: Parameters<typeof mobileConnectionToServerListItem>[1]['status']) =>
      mobileConnectionToServerListItem(lanConnection, { isCurrent: true, status }).status;

    expect(statusOf({ kind: 'connected', transport: 'direct' })).toBe('connected');
    expect(statusOf({ kind: 'connected', transport: 'relay' })).toBe('connected');
    expect(statusOf({ kind: 'needs-login' })).toBe('sign-in-required');
    expect(statusOf({ kind: 'unreachable' })).toBe('offline');
    expect(statusOf({ kind: 'connecting' })).toBe('unknown');
    expect(statusOf({ kind: 'unknown' })).toBe('unknown');
  });

  test('connecting under probe reads as checking', () => {
    const item = mobileConnectionToServerListItem(lanConnection, {
      isCurrent: false,
      status: { kind: 'connecting' },
      probing: true,
    });
    expect(item.status).toBe('checking');
  });

  test('quiet refresh keeps the last known status while probing', () => {
    const item = mobileConnectionToServerListItem(mixedConnection, {
      isCurrent: true,
      status: { kind: 'connected', transport: 'relay' },
      probing: true,
    });
    expect(item.status).toBe('connected');
    expect(item.activeRoute?.kind).toBe('relay');
  });

  test('connected rows never render a bogus latency', () => {
    const item = mobileConnectionToServerListItem(lanConnection, {
      isCurrent: true,
      status: { kind: 'connected', transport: 'direct' },
    });
    expect(item.latencyMs).toBeNull();
  });
});

describe('mobileConnectionToServerListItem capabilities', () => {
  test('canEdit follows the direct-only rule', () => {
    expect(
      mobileConnectionToServerListItem(lanConnection, {
        isCurrent: false,
        status: { kind: 'unknown' },
      }).canEdit,
    ).toBe(true);
    expect(
      mobileConnectionToServerListItem(relayConnection, {
        isCurrent: false,
        status: { kind: 'unknown' },
      }).canEdit,
    ).toBe(false);
  });

  test('mobile rows never offer a default or a new window', () => {
    const item = mobileConnectionToServerListItem(mixedConnection, {
      isCurrent: true,
      status: { kind: 'connected', transport: 'direct' },
    });
    expect(item.isDefault).toBe(false);
    expect(item.isLocal).toBe(false);
    expect(item.canOpenInNewWindow).toBe(false);
    expect(item.canRemove).toBe(true);
  });
});

describe('mobile server sorting', () => {
  test('current server sorts first via the shared sorter', () => {
    const items = sortServerListItems([
      mobileConnectionToServerListItem({ id: 'b', label: 'Beta', candidates: [lanDirect] }, {
        isCurrent: false,
        status: { kind: 'unknown' },
      }),
      mobileConnectionToServerListItem({ id: 'a', label: 'Alpha', candidates: [relayOnly] }, {
        isCurrent: true,
        status: { kind: 'connected', transport: 'relay' },
      }),
    ]);
    expect(items.map((item) => item.id)).toEqual(['a', 'b']);
  });
});
