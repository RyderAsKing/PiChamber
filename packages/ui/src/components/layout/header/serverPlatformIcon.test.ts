import { describe, expect, test } from 'bun:test';

import { serverPlatformIcon } from './serverPlatformIcon';

describe('serverPlatformIcon', () => {
  test('uses colored Docker branding ahead of the container distribution', () => {
    expect(serverPlatformIcon({
      deploymentKind: 'docker',
      serverPlatform: 'linux',
      serverDistribution: 'debian',
    })).toEqual({ name: 'docker', color: '#2496ED' });
  });

  test('maps known Linux distributions to colored logos', () => {
    expect(serverPlatformIcon({ serverPlatform: 'linux', serverDistribution: 'ubuntu' })).toEqual({ name: 'ubuntu-fill', color: '#E95420' });
    expect(serverPlatformIcon({ serverPlatform: 'linux', serverDistribution: 'arch' }).name).toBe('arch-linux');
    expect(serverPlatformIcon({ serverPlatform: 'linux', serverDistribution: 'nixos' }).name).toBe('nixos');
    expect(serverPlatformIcon({ serverPlatform: 'linux', serverDistribution: 'fedora' }).name).toBe('fedora');
  });

  test('uses a terminal for unknown Linux distributions', () => {
    expect(serverPlatformIcon({ serverPlatform: 'linux', serverDistribution: 'gentoo' })).toEqual({ name: 'terminal-box' });
  });

  test('maps other host operating systems and keeps a server fallback', () => {
    expect(serverPlatformIcon({ serverPlatform: 'win32' })).toEqual({ name: 'windows', color: '#0078D4' });
    expect(serverPlatformIcon({ serverPlatform: 'darwin' })).toEqual({ name: 'apple' });
    expect(serverPlatformIcon(null)).toEqual({ name: 'server' });
  });
});
