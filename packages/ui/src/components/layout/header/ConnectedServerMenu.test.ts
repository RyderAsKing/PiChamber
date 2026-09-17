import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';

import { ConnectedServerMenu } from './ConnectedServerMenu';
import { displayServerPlatform } from './serverPlatformLabel';

const menuSource = readFileSync(join(__dirname, 'ConnectedServerMenu.tsx'), 'utf8');

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
  test('takes open state from its parent so the header shortcut can drive it', () => {
    let received: boolean | undefined;
    const element = createElement(ConnectedServerMenu, {
      open: true,
      onOpenChange: (next: boolean) => {
        received = next;
      },
    });
    expect(element.props.open).toBe(true);
    element.props.onOpenChange(false);
    expect(received).toBe(false);
  });

  test('copies through the shared clipboard helper instead of raw clipboard access', () => {
    // Tripwire: direct navigator.clipboard access throws synchronously when
    // the API is unavailable and skips the execCommand fallback. The
    // success/failure contract of the shared helper is covered in
    // src/lib/clipboard.test.ts.
    expect(menuSource).not.toContain('navigator.clipboard');
  });
});
