import { describe, expect, it } from 'vitest';

import { isServerNetworkHost } from './server-network-host.js';

describe('isServerNetworkHost', () => {
  it('treats local and special-use addresses as the server network, up to their edges', () => {
    for (const host of [
      'localhost', 'localhost.', 'app.localhost.', 'printer.local.',
      '0.0.0.0', '127.0.0.1', '10.0.0.1', '100.64.0.0', '100.127.255.255', '169.254.169.254',
      '172.16.0.0', '172.31.255.255', '192.168.1.1', '192.0.0.0', '192.0.0.255',
      '198.18.0.0', '198.19.255.255', '224.0.0.1', '240.0.0.1', '255.255.255.255',
      '::', '::1', '[::1]', 'fe80::1', 'febf::1', 'fe80::1%eth0', 'fc00::1', 'fdff::1', 'ff02::1',
      '::ffff:8.8.8.8', '0:0:0:0:0:ffff:7f00:1', '::7f00:1', '::10.0.0.1',
      '::ffff:0:127.0.0.1', '::ffff:0:a00:1',
      '64:ff9b::a00:1', '64:ff9b::192.168.0.1', '2002:7f00:1::', '2002:c0a8:101::1',
      'a:b',
    ]) {
      expect(isServerNetworkHost(host), host).toBe(true);
    }
  });

  it('lets public addresses and names through', () => {
    for (const host of [
      'example.com', 'example.com.', 'localhost.example.com',
      '1.1.1.1', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0',
      '192.0.1.0', '198.17.255.255', '198.20.0.0', '223.255.255.255',
      'fec0::1', '2001:4860:4860::8888', '::808:808', '::ffff:0:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1',
    ]) {
      expect(isServerNetworkHost(host), host).toBe(false);
    }
  });
});
