import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { DesktopHost, DesktopHostsConfig } from './desktopHosts';

let electronShell = true;
let runtimeKey = 'host:remote-a';
let apiBaseUrl = 'https://api.remote.example';
let bearerToken = '';
let relayActive = false;
let hostsConfig: DesktopHostsConfig | null = null;
let localClientToken = '';
const switchCalls: Array<Record<string, unknown>> = [];

const remote: DesktopHost = {
  id: 'remote-a',
  label: 'Remote',
  url: 'https://remote.example',
  apiUrl: 'https://api.remote.example',
  clientToken: 'remembered-token',
};

mock.module('@/lib/desktop', () => ({
  isElectronShell: () => electronShell,
}));
mock.module('@/lib/desktopHosts', () => ({
  desktopHostsGet: async () => hostsConfig,
  desktopHostsSet: async () => undefined,
  desktopHostProbe: async () => ({ status: 'ok', latencyMs: 1 }),
  desktopLocalClientTokenGet: async () => localClientToken,
  getDesktopHostApiUrl: (host: DesktopHost) => host.apiUrl || host.url,
  normalizeHostUrl: (value: string) => value.replace(/\/+$/, ''),
  locationMatchesHost: (left: string, right: string) => {
    try {
      return new URL(left).origin === new URL(right).origin;
    } catch {
      return false;
    }
  },
  redactSensitiveUrl: (value: string) => value,
}));
mock.module('@/lib/runtime-auth', () => ({
  getRuntimeBearerTokenSync: () => bearerToken,
}));
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async () => null,
}));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => runtimeKey,
  getRuntimeApiBaseUrl: () => apiBaseUrl,
  switchRuntimeEndpoint: (options: Record<string, unknown>) => {
    switchCalls.push(options);
    if (typeof options.runtimeKey === 'string') runtimeKey = options.runtimeKey;
    if (typeof options.apiBaseUrl === 'string') apiBaseUrl = options.apiBaseUrl;
    if (typeof options.clientToken === 'string') bearerToken = options.clientToken;
  },
}));
mock.module('@/lib/relay/runtime-tunnel', () => ({
  isRelayModeActive: () => relayActive,
}));

const { restoreDesktopRelayRuntime } = await import('./desktopRelayRestore');

describe('restoreDesktopRelayRuntime', () => {
  beforeEach(() => {
    electronShell = true;
    runtimeKey = 'host:remote-a';
    apiBaseUrl = 'https://api.remote.example';
    bearerToken = '';
    relayActive = false;
    localClientToken = '';
    switchCalls.length = 0;
    hostsConfig = {
      hosts: [remote],
      defaultHostId: 'local',
      initialHostChoiceCompleted: true,
      localOrigin: 'http://127.0.0.1:3000',
    };
  });

  test('is a no-op outside Electron', async () => {
    electronShell = false;
    await restoreDesktopRelayRuntime();
    expect(switchCalls).toEqual([]);
  });

  test('reapplies the stored token when reload already hydrated the last host', async () => {
    await restoreDesktopRelayRuntime();
    expect(switchCalls).toEqual([{
      apiBaseUrl: 'https://api.remote.example',
      clientToken: 'remembered-token',
      requestHeaders: null,
      runtimeKey: 'host:remote-a',
      relay: undefined,
    }]);
  });

  test('does not switch again when the stored token is already active', async () => {
    bearerToken = 'remembered-token';
    await restoreDesktopRelayRuntime();
    expect(switchCalls).toEqual([]);
  });

  test('reapplies the local client token for a hydrated local runtime', async () => {
    runtimeKey = 'local';
    apiBaseUrl = 'http://127.0.0.1:3000';
    localClientToken = 'local-token';
    await restoreDesktopRelayRuntime();
    expect(switchCalls).toEqual([{
      apiBaseUrl: 'http://127.0.0.1:3000',
      clientToken: 'local-token',
      runtimeKey: 'local',
    }]);
  });

  test('reopens the relay tunnel when reload hydrated a relay host on the window origin', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const relayHost: DesktopHost = {
      id: 'relay-a',
      label: 'Relay',
      url: 'relay://srv_1',
      clientToken: 'relay-token',
      relay: {
        relayUrl: 'wss://relay.example/tunnel',
        serverId: 'srv_1',
        hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      },
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { origin: 'pichamber-ui://app' },
        setTimeout: (callback: () => void) => {
          callback();
          return 0;
        },
      },
    });
    try {
      runtimeKey = 'host:relay-a';
      apiBaseUrl = 'pichamber-ui://app';
      hostsConfig = {
        hosts: [relayHost],
        defaultHostId: 'local',
        initialHostChoiceCompleted: true,
        localOrigin: 'http://127.0.0.1:3000',
      };
      await restoreDesktopRelayRuntime();
      expect(switchCalls[0]).toEqual({
        apiBaseUrl: 'pichamber-ui://app',
        clientToken: 'relay-token',
        runtimeKey: 'host:relay-a',
        relay: relayHost.relay,
      });
    } finally {
      if (previousWindow) {
        Object.defineProperty(globalThis, 'window', previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, 'window');
      }
    }
  });
});
