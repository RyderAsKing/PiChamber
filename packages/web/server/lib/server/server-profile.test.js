import { describe, expect, it } from 'vitest';

import { isValidProfileKey, resolveServerProfile } from './server-profile.js';

describe('server profile', () => {
  it('separates installed and development web servers on the same port', () => {
    const installed = resolveServerProfile({ env: {}, port: 3000, runtime: 'web', version: '0.9.0' });
    const dev = resolveServerProfile({
      env: { PICHAMBER_SERVER_PROFILE_KIND: 'dev' },
      port: 3000,
      runtime: 'web',
      version: '0.9.0',
    });
    expect(installed.profileKey).toBe('web-p3000');
    expect(dev.profileKey).toBe('web-dev-p3000');
    expect(installed.profileKey).not.toBe(dev.profileKey);
    expect(installed.serverInstanceId).not.toBe(dev.serverInstanceId);
  });

  it('separates web servers on different ports', () => {
    const a = resolveServerProfile({ env: {}, port: 3000 });
    const b = resolveServerProfile({ env: {}, port: 3902 });
    expect(a.profileKey).not.toBe(b.profileKey);
  });

  it('uses stable desktop profiles without ports', () => {
    const installed = resolveServerProfile({ env: { PICHAMBER_RUNTIME: 'desktop' } });
    const dev = resolveServerProfile({ env: { PICHAMBER_RUNTIME: 'desktop', PICHAMBER_ELECTRON_DEV: '1' } });
    expect(installed.profileKey).toBe('desktop');
    expect(dev.profileKey).toBe('desktop-dev');
  });

  it('hashes explicit profile overrides instead of using them as paths', () => {
    const profile = resolveServerProfile({ env: { PICHAMBER_SERVER_PROFILE: '../../evil' }, port: 3000 });
    expect(isValidProfileKey(profile.profileKey)).toBe(true);
    expect(profile.profileKey).toMatch(/^custom-[0-9a-f]{16}$/);
    expect(profile.profileKey).not.toContain('.');
  });

  it('preserves development replacement behavior for explicit profiles', () => {
    const profile = resolveServerProfile({
      env: {
        PICHAMBER_SERVER_PROFILE: 'isolated-dev',
        PICHAMBER_SERVER_PROFILE_KIND: 'dev',
      },
      port: 3000,
    });
    expect(profile.source).toBe('custom');
    expect(profile.development).toBe(true);
  });

  it('keeps the profile key stable for one logical server across launches', () => {
    const first = resolveServerProfile({ env: {}, port: 3000 });
    const second = resolveServerProfile({ env: {}, port: 3000 });
    expect(first.profileKey).toBe(second.profileKey);
    expect(first.serverInstanceId).not.toBe(second.serverInstanceId);
  });
});
