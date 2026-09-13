import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process so package-manager-detection does not hit real binaries.
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '/usr/local/bin', stderr: '' })),
}));

const {
  checkForUpdates,
  detectPackageManager,
  detectSystemdServiceContext,
  executeUpdate,
  getCurrentVersion,
  getInstalledVersion,
  getUpdateCapability,
  launchUpdateCommand,
  isInsidePiChamberSystemdService,
  resolveTrustedUpdatePackageManager,
} = await import('./package-manager.js');

function officialRegistryPackage(latest, rc) {
  return {
    'dist-tags': { latest, ...(rc ? { rc } : {}) },
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
        .when('api.github.com/repos/RyderAsKing/PiChamber/releases/tags/v1.10.0', {
          ok: true,
          json: async () => ({ body: '## [1.10.0] - 2026-05-01\n\n- New!' }),
        });

      const result = await checkForUpdates({ currentVersion: '1.9.10' });
      expect(result.available).toBe(true);
      expect(result.version).toBe('1.10.0');
      expect(result.body).toContain('New!');
      expect(result.releaseUrl).toBe('https://github.com/RyderAsKing/PiChamber/releases/tag/v1.10.0');
      expect(fetchMock.calls.map((c) => c.url)).toContain(
        'https://api.github.com/repos/RyderAsKing/PiChamber/releases/tags/v1.10.0',
      );
      // No requests to api.pichamber.dev when the override is absent.
      expect(fetchMock.calls.map((c) => c.url).some((u) => u.includes('api.pichamber.dev'))).toBe(false);
    });
  });

  it('selects a newer RC and returns its GitHub release notes', async () => {
    await withNoHostedApi(async () => {
      fetchMock
        .when('registry.npmjs.org', {
          ok: true,
          json: async () => officialRegistryPackage('1.9.10', '2.0.0-rc.2'),
        })
        .when('api.github.com/repos/RyderAsKing/PiChamber/releases/tags/v2.0.0-rc.2', {
          ok: true,
          json: async () => ({
            body: '## [2.0.0-rc.2] - 2026-05-02\n\n- Second candidate',
          }),
        });
      const result = await checkForUpdates({ currentVersion: '2.0.0-rc.1', channel: 'rc' });
      expect(result).toMatchObject({
        available: true,
        version: '2.0.0-rc.2',
        channel: 'rc',
        body: expect.stringContaining('Second candidate'),
      });
      expect(result.body).not.toContain('First candidate');
    });
  });

  it('selects an RC when it is newer than the latest stable release', async () => {
    await withNoHostedApi(async () => {
      fetchMock
        .when('registry.npmjs.org', {
          ok: true,
          json: async () => officialRegistryPackage('2.0.0', '2.1.0-rc.1'),
        })
        .when('raw.githubusercontent.com', { ok: true, text: async () => '' });
      const result = await checkForUpdates({ currentVersion: '1.9.10', channel: 'rc' });
      expect(result).toMatchObject({ available: true, version: '2.1.0-rc.1', channel: 'rc' });
    });
  });

  it('selects a final stable release over its prerelease', async () => {
    await withNoHostedApi(async () => {
      fetchMock
        .when('registry.npmjs.org', {
          ok: true,
          json: async () => officialRegistryPackage('2.1.0', '2.1.0-rc.2'),
        })
        .when('raw.githubusercontent.com', { ok: true, text: async () => '' });
      const result = await checkForUpdates({ currentVersion: '1.9.10', channel: 'rc' });
      expect(result).toMatchObject({ available: true, version: '2.1.0', channel: 'rc' });
    });
  });

  it('selects stable when the RC dist-tag is older', async () => {
    await withNoHostedApi(async () => {
      fetchMock
        .when('registry.npmjs.org', {
          ok: true,
          json: async () => officialRegistryPackage('2.0.0', '1.9.0-rc.5'),
        })
        .when('raw.githubusercontent.com', { ok: true, text: async () => '' });
      const result = await checkForUpdates({ currentVersion: '1.9.10', channel: 'rc' });
      expect(result).toMatchObject({ available: true, version: '2.0.0', channel: 'rc' });
    });
  });

  it('compares numbered release candidates using semver precedence', async () => {
    await withNoHostedApi(async () => {
      fetchMock
        .when('registry.npmjs.org', {
          ok: true,
          json: async () => officialRegistryPackage('1.9.10', '2.0.0-rc.10'),
        })
        .when('raw.githubusercontent.com', { ok: true, text: async () => '' });
      const result = await checkForUpdates({ currentVersion: '2.0.0-rc.2', channel: 'rc' });
      expect(result).toMatchObject({ available: true, version: '2.0.0-rc.10' });
    });
  });

  it('keeps stable subscribers on the latest stable release', async () => {
    await withNoHostedApi(async () => {
      fetchMock.when('registry.npmjs.org', {
        ok: true,
        json: async () => officialRegistryPackage('1.9.10', '2.0.0-rc.1'),
      });
      const result = await checkForUpdates({ currentVersion: '1.9.10', channel: 'stable' });
      expect(result).toMatchObject({ available: false, version: '1.9.10', channel: 'stable' });
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
      const hostedCall = fetchMock.calls.find((call) => call.url.includes('updates.example.test'));
      expect(JSON.parse(hostedCall.options.body)).toMatchObject({ channel: 'stable' });
      expect(urls.some((u) => u.includes('api.pichamber.dev'))).toBe(false);
    } finally {
      if (typeof previous === 'string') {
        process.env.PICHAMBER_UPDATE_API_URL = previous;
      } else {
        delete process.env.PICHAMBER_UPDATE_API_URL;
      }
    }
  });

  it('requests hosted notes for the higher RC target', async () => {
    const previous = process.env.PICHAMBER_UPDATE_API_URL;
    process.env.PICHAMBER_UPDATE_API_URL = 'https://updates.example.test/api/check';
    try {
      fetchMock
        .when('updates.example.test', {
          ok: true,
          json: async () => ({
            latestVersion: '2.1.0-rc.1',
            updateAvailable: true,
          }),
        })
        .when('registry.npmjs.org', {
          ok: true,
          json: async () => officialRegistryPackage('2.0.0', '2.1.0-rc.1'),
        });

      const result = await checkForUpdates({ currentVersion: '1.9.10', channel: 'rc' });
      expect(result).toMatchObject({ available: true, version: '2.1.0-rc.1', channel: 'rc' });
      const hostedCall = fetchMock.calls.find((call) => call.url.includes('updates.example.test'));
      expect(JSON.parse(hostedCall.options.body)).toMatchObject({ channel: 'rc' });
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
    expect(typeof getInstalledVersion).toBe('function');
    expect(getCurrentVersion()).toMatch(/^\d+\.\d+\.\d+|unknown$/);
  });
});

describe('update capability reporting', () => {
  const trustedDetails = {
    packageManager: 'npm',
    reason: 'install-path-owner',
    packagePath: '/home/test/node_modules/@pi-chamber/web',
    globalNodeModulesRoot: '/home/test/node_modules',
  };

  it('gives deployment-specific instructions for containers and source checkouts', () => {
    expect(getUpdateCapability({ isContainer: true })).toMatchObject({
      supported: false,
      code: 'DOCKER_DEPLOYMENT',
    });
    expect(getUpdateCapability({
      isContainer: false,
      packagePath: '/work/PiChamber/packages/web',
      existsSync: (candidate) => ['/work/PiChamber/package.json', '/work/PiChamber/packages/ui'].includes(candidate),
      systemdContext: null,
    })).toMatchObject({
      supported: false,
      code: 'SOURCE_CHECKOUT',
    });
  });

  it('reports the exact custom user unit and restart command for servers and browser terminals', () => {
    const contextOptions = {
      platform: 'linux',
      env: {},
      readFileSync: () => '0::/user.slice/user-1000.slice/user@1000.service/app.slice/my-pichamber.service',
    };
    expect(detectSystemdServiceContext(contextOptions)).toEqual({
      unit: 'my-pichamber.service',
      scope: 'user',
      managed: false,
    });
    const capability = getUpdateCapability({
      ...contextOptions,
      isContainer: false,
      serverProcess: true,
      packagePath: trustedDetails.packagePath,
      details: trustedDetails,
      installWritable: true,
    });
    expect(capability).toMatchObject({ supported: false, code: 'CUSTOM_SYSTEMD_UNIT' });
    expect(capability.error).toContain('systemctl --user restart my-pichamber.service');
  });

  it('ignores ancestor user-manager services when the process belongs to a session scope', () => {
    expect(detectSystemdServiceContext({
      platform: 'linux',
      env: {},
      readFileSync: () => '0::/user.slice/user-1000.slice/user@1000.service/session.slice/session-2.scope',
    })).toBeNull();
  });

  it('does not mistake an ordinary SSH service for a custom PiChamber deployment', () => {
    expect(getUpdateCapability({
      isContainer: false,
      serverProcess: false,
      platform: 'linux',
      env: { INVOCATION_ID: 'ssh-invocation' },
      readFileSync: () => '0::/system.slice/ssh.service',
      packagePath: trustedDetails.packagePath,
      details: trustedDetails,
      installWritable: true,
    })).toEqual({ supported: true, code: 'SUPPORTED', packageManager: 'npm' });
  });

  it('distinguishes ownership failures from unsupported installs', () => {
    expect(getUpdateCapability({
      isContainer: false,
      systemdContext: null,
      packagePath: trustedDetails.packagePath,
      details: trustedDetails,
      installWritable: false,
    })).toMatchObject({ supported: false, code: 'INSTALL_OWNERSHIP_MISMATCH' });
    expect(getUpdateCapability({
      isContainer: false,
      systemdContext: null,
      packagePath: '/temporary/pichamber',
      existsSync: () => false,
      details: { packageManager: 'npm', reason: 'default-fallback' },
    })).toMatchObject({ supported: false, code: 'UNSUPPORTED_INSTALL' });
  });
});

describe('launchUpdateCommand', () => {
  const job = { id: '10000000-0000-4000-8000-000000000001', state: 'queued' };
  const jobOptions = () => ({
    claimUpdateJob: vi.fn(async () => ({ job, created: true })),
    updateUpdateJob: vi.fn(async () => job),
  });

  it('starts the CLI updater detached so the live server can respond before shutdown', async () => {
    const unref = vi.fn();
    const once = vi.fn();
    const spawnProcess = vi.fn(() => ({ once, unref }));

    await expect(launchUpdateCommand({
      isContainer: false,
      isSystemd: false,
      spawnProcess,
      ...jobOptions(),
    })).resolves.toMatchObject({ success: true, jobId: job.id, state: 'queued' });
    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/bin[\\/]cli\.js$/), 'update', '--yes', '--quiet', '--update-worker', '--update-job-id', job.id],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    expect(once).toHaveBeenCalledWith('error', expect.any(Function));
    expect(unref).toHaveBeenCalledOnce();
  });

  it('pins the selected channel and target in the worker job', async () => {
    const options = jobOptions();
    await launchUpdateCommand({
      isContainer: false,
      isSystemd: false,
      targetVersion: '2.0.0-rc.3',
      channel: 'rc',
      spawnProcess: () => ({ once: vi.fn(), unref: vi.fn() }),
      ...options,
    });
    expect(options.claimUpdateJob).toHaveBeenCalledWith(expect.objectContaining({
      targetVersion: '2.0.0-rc.3',
      channel: 'rc',
    }));
  });

  it('starts a transient worker outside the PiChamber systemd unit', async () => {
    const runProcess = vi.fn(() => ({ status: 0 }));

    await expect(launchUpdateCommand({
      isContainer: false,
      isSystemd: true,
      isRoot: false,
      runProcess,
      env: {
        HOME: '/home/test',
        PATH: '/test/bin',
        PICHAMBER_DATA_DIR: '/home/test/.config/pichamber',
        PICHAMBER_PACKAGE_MANAGER: 'npm',
        PICHAMBER_UI_PASSWORD: 'must-not-be-forwarded',
      },
      ...jobOptions(),
    })).resolves.toMatchObject({ success: true, jobId: job.id });

    expect(runProcess).toHaveBeenCalledWith(
      'systemd-run',
      expect.arrayContaining([
        '--user',
        expect.stringMatching(/^--unit=pichamber-update-/),
        '--collect',
        '--setenv=PICHAMBER_PACKAGE_MANAGER=npm',
        '--',
        process.execPath,
        expect.stringMatching(/bin[\\/]cli\.js$/),
        'update',
        '--update-worker',
        '--update-job-id',
        job.id,
      ]),
      expect.objectContaining({ stdio: 'pipe' }),
    );
    expect(runProcess.mock.calls[0][1].join(' ')).not.toContain('must-not-be-forwarded');
  });

  it('records a failed job when systemd cannot start the worker', async () => {
    const updateUpdateJob = vi.fn(async () => job);
    const result = await launchUpdateCommand({
      isContainer: false,
      isSystemd: true,
      runProcess: () => ({ status: 1 }),
      ...jobOptions(),
      updateUpdateJob,
    });

    expect(result).toMatchObject({ success: false, jobId: job.id });
    expect(updateUpdateJob).toHaveBeenCalledWith(job.id, expect.objectContaining({ state: 'failed' }));
  });

  it('refuses container replacement without creating a job', async () => {
    await expect(launchUpdateCommand({ isContainer: true })).resolves.toMatchObject({ success: false });
  });
});

describe('isInsidePiChamberSystemdService', () => {
  it('does not treat a generic systemd invocation such as SSH as PiChamber-owned', () => {
    expect(isInsidePiChamberSystemdService({
      platform: 'linux',
      env: { INVOCATION_ID: 'ssh-service-invocation' },
      readFileSync: () => '0::/system.slice/ssh.service',
    })).toBe(false);
  });

  it('recognizes generated units and their child terminals', () => {
    expect(isInsidePiChamberSystemdService({
      platform: 'linux',
      env: { PICHAMBER_SYSTEMD_UNIT: 'pichamber.service' },
    })).toBe(true);
    expect(isInsidePiChamberSystemdService({
      platform: 'linux',
      env: {},
      readFileSync: () => '0::/user.slice/user-1000.slice/user@1000.service/app.slice/pichamber.service',
    })).toBe(true);
  });
});

describe('CLI update exports', () => {
  it('exports package-manager helpers used by the update command', () => {
    expect(typeof detectPackageManager).toBe('function');
    expect(typeof executeUpdate).toBe('function');
    expect(typeof resolveTrustedUpdatePackageManager).toBe('function');
  });

  it('does not inherit package-manager output in silent mode', async () => {
    const { spawnSync } = await import('node:child_process');
    spawnSync.mockClear();

    expect(executeUpdate('npm', { silent: true, targetVersion: '2.0.0-rc.3' })).toEqual({ success: true, exitCode: 0 });
    expect(spawnSync).toHaveBeenLastCalledWith(
      expect.stringContaining('@pi-chamber/web@2.0.0-rc.3'),
      expect.objectContaining({ shell: true, stdio: 'ignore' }),
    );
  });

  it('rejects an unsafe package target before spawning a package manager', async () => {
    const { spawnSync } = await import('node:child_process');
    spawnSync.mockClear();
    expect(() => executeUpdate('npm', { silent: true, targetVersion: 'latest; touch /tmp/nope' }))
      .toThrow('Update target version is invalid.');
    expect(spawnSync).not.toHaveBeenCalled();
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
