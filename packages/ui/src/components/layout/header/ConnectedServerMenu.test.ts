import { describe, expect, test } from 'bun:test';

import { displayServerPlatform } from './serverPlatformLabel';

describe('displayServerPlatform', () => {
  test('describes deployment and host platforms', () => {
    expect(displayServerPlatform({ deploymentKind: 'docker', serverPlatform: 'linux', serverDistribution: 'debian' })).toBe('Docker');
    expect(displayServerPlatform({ serverPlatform: 'linux', serverDistribution: 'nixos' })).toBe('NixOS');
    expect(displayServerPlatform({ serverPlatform: 'linux', serverDistribution: 'unknown' })).toBe('Linux');
    expect(displayServerPlatform({ serverPlatform: 'win32' })).toBe('Windows');
    expect(displayServerPlatform(null)).toBe('Server');
  });
});
