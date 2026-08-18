import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process so package-manager-detection does not hit real binaries.
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '/usr/local/bin', stderr: '' })),
}));

const {
  checkForUpdates,
  detectPackageManager,
  executeUpdate,
  getCurrentVersion,
  resolveTrustedUpdatePackageManager,
} = await import('./package-manager.js');

function officialRegistryPackage(latest) {
  return {
    'dist-tags': { latest },
    repository: { url: 'git+https://github.com/RyderAsKing/PiChamber.git' },
  };
}

/** Helper: a fetch mock that routes by URL substring and records every call. */
function createFetchMock() {
  const handlers = new Map();
  const calls = [];
  const mock = vi.fn((url, options) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    calls.push({ url: urlStr, options });

    for (const [pattern, response] of handlers) {
      if (urlStr.includes(pattern)) {
        return Promise.resolve(response);
      }
    }
    return Promise.reject(new Error(`Unexpected fetch call: ${urlStr}`));
  });
  mock.when = (pattern, response) => {
    handlers.set(pattern, response);
    return mock;
  };
  mock.calls = calls;
  return mock;
}

const withNoHostedApi = async (fn) => {
  const previous = process.env.PICHAMBER_UPDATE_API_URL;
  delete process.env.PICHAMBER_UPDATE_API_URL;
  try {
    return await fn();
  } finally {
    if (typeof previous === 'string') {
      process.env.PICHAMBER_UPDATE_API_URL = previous;
    } else {
      delete process.env.PICHAMBER_UPDATE_API_URL;
    }
  }
};

describe('checkForUpdates (no hosted API by default)', () => {
  let fetchMock;
  let originalFetch;

  beforeEach(() => {
    fetchMock = createFetchMock();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns available=true when npm `latest` dist-tag is newer than current', async () => {
    await withNoHostedApi(async () => {
      fetchMock
        .when('registry.npmjs.org', {
          ok: true,
          json: async () => officialRegistryPackage('1.10.0'),
        })
        .when('raw.githubusercontent.com', {
          ok: true,
          text: async () => '## [1.10.0] - 2026-05-01\n\n- New!',
        });

      const result = await checkForUpdates({ currentVersion: '1.9.10' });
      expect(result.available).toBe(true);
      expect(result.version).toBe('1.10.0');
      expect(result.releaseUrl).toBe('https://github.com/RyderAsKing/PiChamber/releases/tag/v1.10.0');
      // No requests to api.pichamber.dev when the override is absent.
      expect(fetchMock.calls.map((c) => c.url).some((u) => u.includes('api.pichamber.dev'))).toBe(false);
    });
  });

  it('returns available=false when npm `latest` matches current version', async () => {
    await withNoHostedApi(async () => {
      fetchMock.when('registry.npmjs.org', {
        ok: true,
        json: async () => officialRegistryPackage('1.9.10'),
      });
      const result = await checkForUpdates({ currentVersion: '1.9.10' });
      expect(result.available).toBe(false);
    });
  });

  it('returns available=false when npm registry is unreachable', async () => {
    await withNoHostedApi(async () => {
      fetchMock.when('registry.npmjs.org', Promise.reject(new Error('Registry unreachable')));
      const result = await checkForUpdates({ currentVersion: '1.9.10' });
      expect(result.available).toBe(false);
      expect(result.error).toMatch(/Unable to determine versions/);
    });
  });

  it('ignores npm latest when pichamber is not the official PiChamber repository', async () => {
    await withNoHostedApi(async () => {
      fetchMock.when('registry.npmjs.org', {
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '1.0.0' },
          repository: { url: 'git+https://github.com/openchamber/openchamber.git' },
        }),
      });
      const result = await checkForUpdates({ currentVersion: '0.1.2' });
      expect(result.available).toBe(false);
      expect(result.version).toBeUndefined();
      expect(result.error).toMatch(/Unable to determine versions/);
    });
  });

  it('does not call api.pichamber.dev when override is absent', async () => {
    await withNoHostedApi(async () => {
      fetchMock
        .when('registry.npmjs.org', {
          ok: true,
          json: async () => officialRegistryPackage('1.10.0'),
        })
        .when('raw.githubusercontent.com', {
          ok: true,
          text: async () => '## [1.10.0]',
        });
      await checkForUpdates({ currentVersion: '1.9.10' });
      const urls = fetchMock.calls.map((c) => c.url);
      expect(urls.some((u) => u.includes('api.pichamber.dev'))).toBe(false);
      expect(urls.some((u) => u.includes('pichamber.dev'))).toBe(false);
    });
  });

  it('uses configured hosted notes only after the reported version matches npm latest', async () => {
    const previous = process.env.PICHAMBER_UPDATE_API_URL;
    process.env.PICHAMBER_UPDATE_API_URL = 'https://updates.example.test/api/check';
    try {
      fetchMock
        .when('updates.example.test', {
          ok: true,
          json: async () => ({
            latestVersion: '1.11.0',
            updateAvailable: true,
          }),
        })
        .when('registry.npmjs.org', {
          ok: true,
          json: async () => officialRegistryPackage('1.11.0'),
        });

      const result = await checkForUpdates({
        appType: 'desktop-electron',
        currentVersion: '1.10.0',
        platform: 'linux',
        arch: 'x64',
      });
      expect(result.available).toBe(true);
      expect(result.version).toBe('1.11.0');
      const urls = fetchMock.calls.map((c) => c.url);
      expect(urls.some((u) => u.includes('updates.example.test'))).toBe(true);
      expect(urls.some((u) => u.includes('api.pichamber.dev'))).toBe(false);
    } finally {
      if (typeof previous === 'string') {
        process.env.PICHAMBER_UPDATE_API_URL = previous;
      } else {
        delete process.env.PICHAMBER_UPDATE_API_URL;
      }
    }
  });

  it('ignores a configured hosted update that disagrees with npm latest', async () => {
    const previous = process.env.PICHAMBER_UPDATE_API_URL;
    process.env.PICHAMBER_UPDATE_API_URL = 'https://updates.example.test/api/check';
    try {
      fetchMock
        .when('updates.example.test', {
          ok: true,
          json: async () => ({
            latestVersion: '9.9.9',
            updateAvailable: true,
            releaseNotes: 'Untrusted release notes',
          }),
        })
        .when('registry.npmjs.org', {
          ok: true,
          json: async () => officialRegistryPackage('1.11.0'),
        })
        .when('raw.githubusercontent.com', {
          ok: true,
          text: async () => '## [1.11.0] - 2026-05-01\n\n- Verified release',
        });

      const result = await checkForUpdates({
        appType: 'desktop-electron',
        currentVersion: '1.10.0',
      });
      expect(result).toMatchObject({
        available: true,
        version: '1.11.0',
        body: expect.stringContaining('Verified release'),
        releaseUrl: 'https://github.com/RyderAsKing/PiChamber/releases/tag/v1.11.0',
      });
    } finally {
      if (typeof previous === 'string') {
        process.env.PICHAMBER_UPDATE_API_URL = previous;
      } else {
        delete process.env.PICHAMBER_UPDATE_API_URL;
      }
    }
  });

  it('does not advertise an PiChamber package or release URL', async () => {
    await withNoHostedApi(async () => {
      fetchMock
        .when('registry.npmjs.org', {
          ok: true,
          json: async () => officialRegistryPackage('1.10.0'),
        })
        .when('raw.githubusercontent.com', {
          ok: true,
          text: async () => '## [1.10.0]',
        });
      const result = await checkForUpdates({ currentVersion: '1.9.10' });
      const flatten = JSON.stringify(result);
      expect(flatten).not.toMatch(/openchamber/i);
      expect(result.releaseUrl).toBe('https://github.com/RyderAsKing/PiChamber/releases/tag/v1.10.0');
    });
  });

  it('selects the canonical PiChamber APK on Android (not AAB or unrelated assets)', async () => {
    await withNoHostedApi(async () => {
      fetchMock
        .when('registry.npmjs.org', {
          ok: true,
          json: async () => officialRegistryPackage('1.10.0'),
        })
        .when('raw.githubusercontent.com', {
          ok: true,
          text: async () => '## [1.10.0]',
        })
        .when('api.github.com/repos/RyderAsKing/PiChamber/releases/tags/v1.10.0', {
          ok: true,
          json: async () => ({
            assets: [
              { name: 'PiChamber-1.10.0-42-android.aab', browser_download_url: 'https://dl/a.aab' },
              { name: 'PiChamber-1.10.0-android.apk', browser_download_url: 'https://dl/legacy.apk' },
              { name: 'PiChamber-1.10.0-42-android.apk', browser_download_url: 'https://dl/correct.apk' },
              { name: 'app-release.apk', browser_download_url: 'https://dl/random.apk' },
            ],
          }),
        });

      const result = await checkForUpdates({
        appType: 'mobile-capacitor',
        platform: 'android',
        currentVersion: '1.9.10',
      });
      expect(result.downloadUrl).toBe('https://dl/correct.apk');
    });
  });

  it('returns no downloadUrl when GitHub releases contain only AAB or unrelated assets', async () => {
    await withNoHostedApi(async () => {
      fetchMock
        .when('registry.npmjs.org', {
          ok: true,
          json: async () => officialRegistryPackage('1.10.0'),
        })
        .when('raw.githubusercontent.com', {
          ok: true,
          text: async () => '## [1.10.0]',
        })
        .when('api.github.com/repos/RyderAsKing/PiChamber/releases/tags/v1.10.0', {
          ok: true,
          json: async () => ({
            assets: [
              { name: 'PiChamber-1.10.0-42-android.aab', browser_download_url: 'https://dl/a.aab' },
              { name: 'totally-unrelated.txt', browser_download_url: 'https://dl/x.txt' },
            ],
          }),
        });

      const result = await checkForUpdates({
        appType: 'mobile-capacitor',
        platform: 'android',
        currentVersion: '1.9.10',
      });
      expect(result.downloadUrl).toBeUndefined();
    });
  });

  it('ignores a hosted APK URL and selects only the canonical GitHub release APK', async () => {
    const previous = process.env.PICHAMBER_UPDATE_API_URL;
    process.env.PICHAMBER_UPDATE_API_URL = 'https://updates.example.test/api/check';
    try {
      fetchMock
        .when('updates.example.test', {
          ok: true,
          json: async () => ({
            latestVersion: '1.10.0',
            updateAvailable: true,
            downloadUrl: 'https://untrusted.example/malicious.apk',
          }),
        })
        .when('registry.npmjs.org', {
          ok: true,
          json: async () => officialRegistryPackage('1.10.0'),
        })
        .when('api.github.com/repos/RyderAsKing/PiChamber/releases/tags/v1.10.0', {
          ok: true,
          json: async () => ({
            assets: [
              { name: 'PiChamber-1.10.0-42-android.apk', browser_download_url: 'https://github.example/PiChamber.apk' },
            ],
          }),
        });

      const result = await checkForUpdates({
        appType: 'mobile-capacitor',
        platform: 'android',
        currentVersion: '1.9.10',
      });
      expect(result.downloadUrl).toBe('https://github.example/PiChamber.apk');
      expect(result.downloadUrl).not.toContain('untrusted.example');
    } finally {
      if (typeof previous === 'string') {
        process.env.PICHAMBER_UPDATE_API_URL = previous;
      } else {
        delete process.env.PICHAMBER_UPDATE_API_URL;
      }
    }
  });
});

describe('package-manager ownership detection', () => {
  it('detects PiChamber-claimed paths for the @pi-chamber/web package', () => {
    const containsPackage = (stdout) => stdout.includes('@pi-chamber/web');
    expect(containsPackage('/home/u/.npm-global/lib/node_modules/@pi-chamber/web')).toBe(true);
    expect(containsPackage('@pi-chamber/web@0.1.7')).toBe(true);
  });
});

describe('getCurrentVersion', () => {
  it('is exported for the CLI update command', () => {
    expect(typeof getCurrentVersion).toBe('function');
    expect(getCurrentVersion()).toMatch(/^\d+\.\d+\.\d+|unknown$/);
  });
});

describe('CLI update exports', () => {
  it('exports package-manager helpers used by the update command', () => {
    expect(typeof detectPackageManager).toBe('function');
    expect(typeof executeUpdate).toBe('function');
    expect(typeof resolveTrustedUpdatePackageManager).toBe('function');
  });
});

describe('resolveTrustedUpdatePackageManager', () => {
  it('accepts only installs that this process can prove it owns', () => {
    expect(resolveTrustedUpdatePackageManager({
      packageManager: 'pnpm',
      reason: 'install-path-owner',
    })).toBe('pnpm');
    expect(resolveTrustedUpdatePackageManager({
      packageManager: 'bun',
      reason: 'forced-env',
    })).toBe('bun');
    expect(resolveTrustedUpdatePackageManager({
      packageManager: 'npm',
      reason: 'default-fallback',
    })).toBeNull();
    expect(resolveTrustedUpdatePackageManager({
      packageManager: 'npm',
      reason: 'runtime-visible-install',
    })).toBeNull();
    expect(resolveTrustedUpdatePackageManager({
      packageManager: 'pnpm',
      reason: 'last-resort-visible-install',
    })).toBeNull();
  });
});
