import { describe, expect, it } from 'vitest';
import {
  isLoopbackBindHost,
  isNetworkExposedBindHost,
  isUnsafeUnauthenticatedLanAllowed,
} from './bind-host.js';

describe('bind host exposure classification', () => {
  it('allows only proven loopback bind hosts without authentication', () => {
    for (const host of ['localhost', '127.0.0.1', '127.25.1.2', '::1', '[::1]', '::ffff:127.0.0.1']) {
      expect(isLoopbackBindHost(host), host).toBe(true);
      expect(isNetworkExposedBindHost(host), host).toBe(false);
    }
  });

  it('treats wildcard, LAN, IPv6 local, and unknown hosts as exposed', () => {
    for (const host of [
      '0.0.0.0',
      '0',
      '0x0',
      '::',
      '[::]',
      '192.168.1.10',
      '10.0.0.5',
      '172.16.0.2',
      '::ffff:192.168.1.10',
      'fe80::1',
      'fc00::1',
      'pichamber.local',
      'example.com',
      '',
    ]) {
      expect(isLoopbackBindHost(host), host).toBe(false);
      expect(isNetworkExposedBindHost(host), host).toBe(true);
    }
  });
});

describe('unsafe unauthenticated LAN flag parsing (F10)', () => {
  it("accepts 'true' and '1' case-insensitively with surrounding whitespace", () => {
    for (const value of ['true', 'TRUE', ' True ', '1', ' 1 ']) {
      expect(isUnsafeUnauthenticatedLanAllowed({ PICHAMBER_ALLOW_UNAUTHENTICATED_LAN: value }), value).toBe(true);
    }
  });

  it('rejects anything else, including the old duplicated-operand gap', () => {
    for (const value of ['false', '0', 'yes', '', '2', 'trueish']) {
      expect(isUnsafeUnauthenticatedLanAllowed({ PICHAMBER_ALLOW_UNAUTHENTICATED_LAN: value }), value).toBe(false);
    }
    expect(isUnsafeUnauthenticatedLanAllowed({})).toBe(false);
    expect(isUnsafeUnauthenticatedLanAllowed(undefined)).toBe(false);
  });
});
