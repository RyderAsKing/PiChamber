import { describe, expect, it } from 'vitest';

import { detectLinuxDistribution, parseLinuxDistribution } from './linux-distribution.js';

describe('Linux distribution detection', () => {
  it('reads known distribution IDs and aliases', () => {
    expect(parseLinuxDistribution('ID=ubuntu\n')).toBe('ubuntu');
    expect(parseLinuxDistribution('ID="archlinux"\n')).toBe('arch');
    expect(parseLinuxDistribution('ID=nixos\n')).toBe('nixos');
    expect(parseLinuxDistribution('ID=fedora\n')).toBe('fedora');
  });

  it('uses ID_LIKE for recognized derivatives', () => {
    expect(parseLinuxDistribution('ID=custom\nID_LIKE="debian ubuntu"\n')).toBe('debian');
  });

  it('returns null for unknown, unavailable, and non-Linux systems', () => {
    expect(parseLinuxDistribution('ID=gentoo\n')).toBeNull();
    expect(detectLinuxDistribution({ platform: 'win32' })).toBeNull();
    expect(detectLinuxDistribution({ platform: 'linux', readFile: () => { throw new Error('missing'); } })).toBeNull();
  });
});
