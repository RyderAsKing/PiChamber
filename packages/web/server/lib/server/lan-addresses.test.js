import { describe, expect, it } from 'vitest';

import { createPairingTransportResolvers, listLanIPv4Addresses } from './lan-addresses.js';

describe('LAN pairing addresses', () => {
  it('lists non-internal IPv4 addresses and skips loopback', () => {
    expect(listLanIPv4Addresses({
      lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }],
      wlan0: [{ family: 4, internal: false, address: '192.168.1.20' }],
    })).toEqual(['192.168.1.20']);
  });

  it('does not advertise a LAN URL while the server is loopback-only', () => {
    const resolvers = createPairingTransportResolvers({
      getPort: () => 2606,
      bindHost: '127.0.0.1',
    });
    expect(resolvers.getPairingTransports()).toEqual({
      local: 'http://127.0.0.1:2606',
      lan: null,
      relayAvailable: false,
      tailscale: { available: false, url: null, mode: 'private' },
    });
    expect(resolvers.getDirectCandidateUrls()).toEqual([]);
  });

  it('advertises LAN URLs from the current bind port when the server is network-exposed', () => {
    const resolvers = createPairingTransportResolvers({
      getPort: () => 2606,
      bindHost: '0.0.0.0',
      networkInterfaces: {
        wlan0: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }],
      },
    });
    expect(resolvers.getPairingTransports()).toEqual({
      local: 'http://127.0.0.1:2606',
      lan: 'http://192.168.1.20:2606',
      relayAvailable: false,
      tailscale: { available: false, url: null, mode: 'private' },
    });
    expect(resolvers.getDirectCandidateUrls()).toEqual(['http://192.168.1.20:2606']);
  });

  it('reports the live Tailscale mapping in transports', () => {
    const resolvers = createPairingTransportResolvers({
      getPort: () => 2606,
      bindHost: '127.0.0.1',
      getTailscaleCandidate: () => ({ type: 'tailscale', url: 'https://m.ts.net', mode: 'private', priority: 20 }),
    });
    expect(resolvers.getPairingTransports().tailscale).toEqual({
      available: true,
      url: 'https://m.ts.net',
      mode: 'private',
    });
  });

  it('stays silent when the Tailscale lookup throws', () => {
    const resolvers = createPairingTransportResolvers({
      getPort: () => 2606,
      bindHost: '127.0.0.1',
      getTailscaleCandidate: () => { throw new Error('boom'); },
    });
    expect(resolvers.getPairingTransports().tailscale).toEqual({
      available: false,
      url: null,
      mode: 'private',
    });
  });
});
