import { describe, expect, it } from 'bun:test';

import { getTunnelDependencyInstallInfo } from './install-help.js';
import {
  TUNNEL_PROVIDER_CLOUDFLARE,
} from './types.js';

describe('getTunnelDependencyInstallInfo', () => {
  it('returns Windows cloudflared winget guidance', () => {
    const info = getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_CLOUDFLARE, 'win32');

    expect(info.dependency).toBe('cloudflared');
    expect(info.installCommand).toBe('winget install --id Cloudflare.cloudflared');
    expect(info.message).toContain('Cloudflare.cloudflared');
  });

  it('keeps macOS Homebrew guidance', () => {
    const info = getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_CLOUDFLARE, 'darwin');

    expect(info.installCommand).toBe('brew install cloudflared');
  });
});
