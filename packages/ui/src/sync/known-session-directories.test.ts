import { describe, expect, test } from 'bun:test';

import { buildKnownSessionDirectories, knownSessionDirectoryKey } from './known-session-directories';

describe('buildKnownSessionDirectories', () => {
  test('keeps filesystem casing for list RPC paths', () => {
    const directories = buildKnownSessionDirectories([
      { path: '/home/ryder/Development/PiChamber' },
    ]);
    expect([...directories]).toEqual(['/home/ryder/Development/PiChamber']);
  });

  test('dedupes case and trailing-slash variants, keeping the first casing', () => {
    const directories = buildKnownSessionDirectories(
      [{ path: '/home/ryder/Development/PiChamber/' }],
      new Map([
        ['pichamber', [{ path: '/home/ryder/development/pichamber' }]],
      ]),
      { includeWorktrees: true },
    );
    expect([...directories]).toEqual(['/home/ryder/Development/PiChamber']);
  });
});

describe('knownSessionDirectoryKey', () => {
  test('lowercases for membership comparison', () => {
    expect(knownSessionDirectoryKey('/home/ryder/Development/PiChamber')).toBe(
      '/home/ryder/development/pichamber',
    );
  });
});
