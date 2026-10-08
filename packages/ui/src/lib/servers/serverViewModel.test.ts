import { describe, expect, test } from 'bun:test';
import {
  classifyDirectRoute,
  desktopHostToServerListItem,
  isServerStatusBlocked,
  probeStatusToServerStatus,
  resolveQuietStatus,
  sameServerRoute,
  serverDisplayAddress,
  sortServerListItems,
  type ServerListItem,
  type ServerProbeSnapshot,
} from './serverViewModel';

const redactUrl = (raw: string): string =>
  raw.replace(/([?&]t=)[^&]*/, '$1[REDACTED]');

const item = (overrides: Partial<ServerListItem>): ServerListItem => ({
  id: 'x',
  label: 'X',
  isCurrent: false,
  isDefault: false,
  isLocal: false,
  routes: [],
  activeRoute: null,
  status: 'unknown',
  latencyMs: null,
  canEdit: true,
  canRemove: true,
  canOpenInNewWindow: true,
  ...overrides,
});

describe('probeStatusToServerStatus', () => {
  test('maps every desktop probe result', () => {
    expect(probeStatusToServerStatus('ok')).toBe('connected');
    expect(probeStatusToServerStatus('auth')).toBe('sign-in-required');
    expect(probeStatusToServerStatus('update-recommended')).toBe('update-recommended');
    expect(probeStatusToServerStatus('incompatible')).toBe('incompatible');
    expect(probeStatusToServerStatus('wrong-service')).toBe('wrong-service');
    expect(probeStatusToServerStatus('unreachable')).toBe('offline');
  });

  test('maps the reserved outcomes', () => {
    expect(probeStatusToServerStatus('update-required')).toBe('update-required');
    expect(probeStatusToServerStatus('reachable')).toBe('reachable');
  });
});

describe('resolveQuietStatus', () => {
  test('quiet refresh keeps the last known status while re-probing', () => {
    const cached: ServerProbeSnapshot = { status: 'ok', latencyMs: 12.6 };
    expect(resolveQuietStatus(cached, true)).toEqual({
      status: 'connected',
      latencyMs: 13,
      refreshing: true,
    });
    expect(resolveQuietStatus(cached, false)).toEqual({
      status: 'connected',
      latencyMs: 13,
      refreshing: false,
    });
  });

  test('never flashes checking over a known failure', () => {
    const cached: ServerProbeSnapshot = { status: 'unreachable', latencyMs: 0 };
    expect(resolveQuietStatus(cached, true).status).toBe('offline');
  });

  test('unprobed hosts read checking while probing, unknown otherwise', () => {
    expect(resolveQuietStatus(null, true)).toEqual({ status: 'checking', latencyMs: null, refreshing: true });
    expect(resolveQuietStatus(undefined, false)).toEqual({ status: 'unknown', latencyMs: null, refreshing: false });
  });
});

describe('desktopHostToServerListItem routes', () => {
  const ctx = { isCurrent: false, isDefault: false, isLocal: false, probe: null as ServerProbeSnapshot | null, redactUrl };

  test('local host yields the This computer route', () => {
    const result = desktopHostToServerListItem(
      { id: 'local', label: 'Local', url: 'http://127.0.0.1:4020' },
      { ...ctx, isLocal: true, localOrigin: 'http://127.0.0.1:4020' },
    );
    expect(result.routes).toEqual([
      { kind: 'local', label: 'This computer', address: 'http://127.0.0.1:4020' },
    ]);
    expect(result.isLocal).toBe(true);
    expect(result.canEdit).toBe(false);
    expect(result.canRemove).toBe(false);
  });

  test('LAN url classifies as Local network', () => {
    const result = desktopHostToServerListItem(
      { id: 'a', label: 'Studio', url: 'http://192.168.1.74:4020', apiUrl: 'http://192.168.1.74:4020' },
      ctx,
    );
    expect(result.routes).toEqual([
      { kind: 'lan', label: 'Local network', address: 'http://192.168.1.74:4020' },
    ]);
  });

  test('tailscale ts.net url classifies as Tailscale', () => {
    const result = desktopHostToServerListItem(
      { id: 'a', label: 'Studio', url: 'https://studio.tail-scale.ts.net', apiUrl: 'https://studio.tail-scale.ts.net' },
      ctx,
    );
    expect(result.routes[0]?.kind).toBe('tailscale');
    expect(result.routes[0]?.label).toBe('Tailscale');
  });

  test('relay-only host never shows a relay:// pseudo-url', () => {
    const result = desktopHostToServerListItem(
      {
        id: 'r',
        label: 'Cabin',
        url: 'relay://server-id-abc',
        relay: { relayUrl: 'wss://relay.example', serverId: 'server-id-abc' },
      },
      ctx,
    );
    expect(result.routes).toEqual([{ kind: 'relay', label: 'PiChamber Relay', address: null }]);
    expect(serverDisplayAddress(result)).toBeNull();
    expect(JSON.stringify(result)).not.toContain('relay://');
    expect(result.canEdit).toBe(false);
    expect(result.canRemove).toBe(true);
  });

  test('mixed host lists both routes and follows the probe transport', () => {
    const host = {
      id: 'm',
      label: 'Studio',
      url: 'http://192.168.1.74:4020',
      apiUrl: 'http://192.168.1.74:4020',
      relay: { relayUrl: 'wss://relay.example', serverId: 'sid' },
    };
    const direct = desktopHostToServerListItem(host, {
      ...ctx,
      probe: { status: 'ok', latencyMs: 9 },
    });
    expect(direct.routes.map((r) => r.kind)).toEqual(['lan', 'relay']);
    expect(direct.activeRoute?.kind).toBe('lan');

    const relayed = desktopHostToServerListItem(host, {
      ...ctx,
      probe: { status: 'ok', latencyMs: 210, via: 'relay' },
    });
    expect(relayed.activeRoute?.kind).toBe('relay');

    const failed = desktopHostToServerListItem(host, {
      ...ctx,
      probe: { status: 'unreachable', latencyMs: 0 },
    });
    expect(failed.activeRoute).toBeNull();
    expect(failed.status).toBe('offline');
  });

  test('sign-in-required host keeps its address and latency is null', () => {
    const result = desktopHostToServerListItem(
      { id: 's', label: 'Office', url: 'https://office.example.com', apiUrl: 'https://office.example.com' },
      { ...ctx, probe: { status: 'auth', latencyMs: 31 } },
    );
    expect(result.status).toBe('sign-in-required');
    expect(result.activeRoute).toBeNull();
    expect(serverDisplayAddress(result)).toBe('https://office.example.com');
  });

  test('token query params are redacted in addresses', () => {
    const result = desktopHostToServerListItem(
      {
        id: 't',
        label: 'Tunnel',
        url: 'https://abc.trycloudflare.com/connect?t=secret-token',
        apiUrl: 'https://abc.trycloudflare.com/connect?t=secret-token',
      },
      ctx,
    );
    expect(result.routes[0]?.kind).toBe('tunnel');
    expect(result.routes[0]?.address).toBe('https://abc.trycloudflare.com/connect?t=[REDACTED]');
    expect(result.routes[0]?.address).not.toContain('secret-token');
  });

  test('classifyDirectRoute covers the remaining kinds', () => {
    expect(classifyDirectRoute('https://office.example.com')).toBe('direct');
    expect(classifyDirectRoute('https://a.cfargotunnel.com')).toBe('tunnel');
    expect(classifyDirectRoute('http://server.local:4020')).toBe('lan');
    expect(classifyDirectRoute('not a url')).toBe('direct');
  });
});

describe('sorting and helpers', () => {
  test('current first, then default, then by label', () => {
    const sorted = sortServerListItems([
      item({ id: 'b', label: 'Bravo' }),
      item({ id: 'd', label: 'Alfa', isDefault: true }),
      item({ id: 'c', label: 'Zulu', isCurrent: true }),
      item({ id: 'a', label: 'Alfa' }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(['c', 'd', 'a', 'b']);
  });

  test('blocked statuses gate switching affordances', () => {
    expect(isServerStatusBlocked('offline')).toBe(true);
    expect(isServerStatusBlocked('incompatible')).toBe(true);
    expect(isServerStatusBlocked('wrong-service')).toBe(true);
    expect(isServerStatusBlocked('connected')).toBe(false);
    expect(isServerStatusBlocked('sign-in-required')).toBe(false);
    expect(isServerStatusBlocked('checking')).toBe(false);
  });

  test('sameServerRoute compares kind and address', () => {
    expect(
      sameServerRoute(
        { kind: 'lan', label: 'Local network', address: 'http://a' },
        { kind: 'lan', label: 'Local network', address: 'http://a' },
      ),
    ).toBe(true);
    expect(
      sameServerRoute(
        { kind: 'lan', label: 'Local network', address: 'http://a' },
        { kind: 'relay', label: 'PiChamber Relay', address: null },
      ),
    ).toBe(false);
  });
});
