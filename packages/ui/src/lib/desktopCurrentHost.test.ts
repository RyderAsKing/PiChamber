import { describe, expect, test } from 'bun:test';

import { resolveDesktopHostIdentity, runtimeKeyForDesktopHost, type DesktopHostIdentity } from './desktopCurrentHost';
import type { DesktopHost } from './desktopHosts';

const remote: DesktopHost = {
  id: 'remote-a',
  label: 'Remote',
  url: 'https://remote.example',
  apiUrl: 'https://api.remote.example',
  clientToken: 'remembered-token',
};

const relay: DesktopHost = {
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

describe('resolveDesktopHostIdentity', () => {
  test('maps the local runtime key to local even when the API URL is elsewhere', () => {
    expect(resolveDesktopHostIdentity({
      runtimeKey: 'local',
      apiBaseUrl: 'https://api.remote.example',
      hosts: [remote],
      localOrigin: 'http://127.0.0.1:3000',
    })).toEqual({ kind: 'local' });
  });

  test('maps a host runtime key onto that saved host, including relay hosts', () => {
    expect(resolveDesktopHostIdentity({
      runtimeKey: runtimeKeyForDesktopHost(relay),
      apiBaseUrl: 'pichamber-ui://app',
      hosts: [remote, relay],
      localOrigin: 'http://127.0.0.1:3000',
    })).toEqual({ kind: 'host', host: relay } satisfies DesktopHostIdentity);
  });

  test('falls back to API URL matching when the runtime key is the url form', () => {
    expect(resolveDesktopHostIdentity({
      runtimeKey: 'url:https://api.remote.example',
      apiBaseUrl: 'https://api.remote.example',
      hosts: [remote, relay],
      localOrigin: 'http://127.0.0.1:3000',
    })).toEqual({ kind: 'host', host: remote });
  });

  test('maps a loopback API URL onto local when no host matches', () => {
    expect(resolveDesktopHostIdentity({
      runtimeKey: 'url:http://127.0.0.1:3000',
      apiBaseUrl: 'http://127.0.0.1:3000',
      hosts: [remote],
      localOrigin: 'http://127.0.0.1:3000',
    })).toEqual({ kind: 'local' });
  });
});
