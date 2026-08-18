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
    });
    expect(resolvers.getDirectCandidateUrls()).toEqual(['http://192.168.1.20:2606']);
  });
});
