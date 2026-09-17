import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { displayServerPlatform } from './serverPlatformLabel';

const menuSource = readFileSync(join(__dirname, 'ConnectedServerMenu.tsx'), 'utf8');
const headerSource = readFileSync(join(__dirname, '..', 'Header.tsx'), 'utf8');

describe('displayServerPlatform', () => {
  test('describes deployment and host platforms', () => {
    expect(displayServerPlatform({ deploymentKind: 'docker', serverPlatform: 'linux', serverDistribution: 'debian' })).toBe('Docker');
    expect(displayServerPlatform({ serverPlatform: 'linux', serverDistribution: 'nixos' })).toBe('NixOS');
    expect(displayServerPlatform({ serverPlatform: 'linux', serverDistribution: 'unknown' })).toBe('Linux');
    expect(displayServerPlatform({ serverPlatform: 'win32' })).toBe('Windows');
    expect(displayServerPlatform(null)).toBe('Server');
  });
});

describe('ConnectedServerMenu wiring', () => {
  test('shares the header shortcut state with the browser menu', () => {
    expect(menuSource).toContain('open={open}');
    expect(menuSource).toContain('onOpenChange(nextOpen)');
    expect(headerSource).toContain('open={isDesktopServicesOpen}');
    expect(headerSource).toContain('onOpenChange={setIsDesktopServicesOpen}');
  });

  test('uses the shared clipboard fallback', () => {
    expect(menuSource).toContain('copyTextToClipboard(address)');
    expect(menuSource).not.toContain('navigator.clipboard');
  });
});
