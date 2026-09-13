import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import {
  checkForDesktopUpdate,
  createDesktopUpdateCoordinator,
  fetchRelevantChangelogNotes,
  formatUpdaterReleaseNotes,
} from './updater-check.mjs';
import { compareReleaseVersions } from './updater-channel.mjs';

const compareVersions = (left, right) => left.localeCompare(right, undefined, { numeric: true });

test('formats full changelog release-note arrays for the update dialog', () => {
  assert.equal(
    formatUpdaterReleaseNotes([
      { version: '0.9.10-rc.1', note: 'Later candidate' },
      { version: '0.9.9-rc.2', note: '## [0.9.9-rc.2] - 2026-03-11\n\n- Second candidate' },
      { version: '0.9.9-rc.1', note: 'First candidate' },
      { version: '0.9.8', note: null },
    ], {
      fromVersion: '0.9.8',
      toVersion: '0.9.9-rc.2',
      compareVersions: compareReleaseVersions,
    }),
    '## [0.9.9-rc.2] - 2026-03-11\n\n- Second candidate\n\n## [0.9.9-rc.1]\n\nFirst candidate',
  );
});

test('fetches RC notes from the exact GitHub release', async () => {
  let requestedUrl;
  const notes = await fetchRelevantChangelogNotes({
    fromVersion: '0.9.9-rc.1',
    toVersion: '0.9.9-rc.2',
    compareVersions: compareReleaseVersions,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        json: async () => ({ body: '## [0.9.9-rc.2] - 2026-03-11\n\n- Second candidate' }),
      };
    },
  });

  assert.equal(
    requestedUrl,
    'https://api.github.com/repos/RyderAsKing/PiChamber/releases/tags/v0.9.9-rc.2',
  );
  assert.match(notes, /Second candidate/);
});

test('falls back to the target tag changelog when the GitHub release has no notes', async () => {
  const requestedUrls = [];
  const notes = await fetchRelevantChangelogNotes({
    fromVersion: '0.9.9-rc.1',
    toVersion: '0.9.9-rc.2',
    compareVersions: compareReleaseVersions,
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      if (url.includes('api.github.com')) {
        return { ok: true, json: async () => ({ body: '' }) };
      }
      return {
        ok: true,
        text: async () => [
          '## [0.9.9-rc.2] - 2026-03-11',
          '',
          '- Second candidate',
          '',
          '## [0.9.9-rc.1] - 2026-03-10',
          '',
          '- First candidate',
        ].join('\n'),
      };
    },
  });

  assert.deepEqual(requestedUrls, [
    'https://api.github.com/repos/RyderAsKing/PiChamber/releases/tags/v0.9.9-rc.2',
    'https://raw.githubusercontent.com/RyderAsKing/PiChamber/v0.9.9-rc.2/CHANGELOG.md',
  ]);
  assert.match(notes, /Second candidate/);
  assert.doesNotMatch(notes, /First candidate/);
});

test('signals failed checks', async () => {
  await assert.rejects(
    checkForDesktopUpdate({
      autoUpdater: { checkForUpdates: async () => { throw new Error('feed unavailable'); } },
      currentVersion: '1.0.0',
      compareVersions,
    }),
    /Unable to check for updates: feed unavailable.*network connection/,
  );
});

test('does not treat an rc feed failure as an authoritative stable result', async () => {
  const autoUpdater = {
    set channel(value) { this._channel = value; },
    get channel() { return this._channel; },
    async checkForUpdates() {
      if (this.channel === 'rc') throw new Error('rc feed unavailable');
      return { updateInfo: { version: '0.9.8' } };
    },
  };

  await assert.rejects(
    checkForDesktopUpdate({
      autoUpdater,
      currentVersion: '0.9.7',
      compareVersions: compareReleaseVersions,
      updateChecks: [
        { channel: 'latest', allowPrerelease: false },
        { channel: 'rc', allowPrerelease: true },
      ],
    }),
    /Unable to check for updates: rc feed unavailable/,
  );
});

test('treats missing update feed (404) as no update available', async () => {
  const result = await checkForDesktopUpdate({
    autoUpdater: {
      checkForUpdates: async () => {
        throw new Error('HttpError: 404 Not Found "https://github.com/.../latest-linux.yml"');
      },
    },
    currentVersion: '1.15.0',
    pendingUpdate: { version: '1.16.0' },
    compareVersions,
  });
  assert.equal(result.available, false);
  assert.equal(result.pendingUpdate, null);
  assert.equal(result.nextVersion, '1.15.0');
});

test('authoritative no-update result clears pending update', async () => {
  const result = await checkForDesktopUpdate({
    autoUpdater: { checkForUpdates: async () => ({ updateInfo: { version: '1.0.0' } }) },
    currentVersion: '1.0.0',
    pendingUpdate: { version: '2.0.0' },
    compareVersions,
  });
  assert.equal(result.available, false);
  assert.equal(result.pendingUpdate, null);
});

test('selects the highest version across stable and rc and disables downgrade after each assignment', async () => {
  const configured = [];
  const autoUpdater = {
    allowPrerelease: false,
    allowDowngrade: false,
    activeVersion: null,
    _channel: null,
    set channel(value) {
      this._channel = value;
      this.allowDowngrade = true;
    },
    get channel() {
      return this._channel;
    },
    async checkForUpdates() {
      configured.push({
        channel: this.channel,
        allowPrerelease: this.allowPrerelease,
        allowDowngrade: this.allowDowngrade,
      });
      this.activeVersion = this.channel === 'rc' ? '0.9.9-rc.2' : '0.9.8';
      return { updateInfo: { version: this.activeVersion } };
    },
  };

  const result = await checkForDesktopUpdate({
    autoUpdater,
    currentVersion: '0.9.7',
    pendingUpdate: null,
    compareVersions: compareReleaseVersions,
    updateChecks: [
      { channel: 'latest', allowPrerelease: false },
      { channel: 'rc', allowPrerelease: true },
    ],
  });

  assert.deepEqual(configured, [
    { channel: 'latest', allowPrerelease: false, allowDowngrade: false },
    { channel: 'rc', allowPrerelease: true, allowDowngrade: false },
  ]);
  assert.equal(result.available, true);
  assert.equal(result.nextVersion, '0.9.9-rc.2');
  assert.equal(autoUpdater.activeVersion, '0.9.9-rc.2');
});

test('ignores a higher channel head when electron-updater marks it ineligible', async () => {
  const autoUpdater = {
    activeVersion: null,
    set channel(value) { this._channel = value; },
    get channel() { return this._channel; },
    async checkForUpdates() {
      if (this.channel === 'rc') {
        return { isUpdateAvailable: false, updateInfo: { version: '0.9.9-rc.2' } };
      }
      this.activeVersion = '0.9.8';
      return { isUpdateAvailable: true, updateInfo: { version: this.activeVersion } };
    },
  };

  const result = await checkForDesktopUpdate({
    autoUpdater,
    currentVersion: '0.9.7',
    pendingUpdate: null,
    compareVersions: compareReleaseVersions,
    updateChecks: [
      { channel: 'latest', allowPrerelease: false },
      { channel: 'rc', allowPrerelease: true },
    ],
  });

  assert.equal(result.nextVersion, '0.9.8');
  assert.equal(autoUpdater.channel, 'latest');
  assert.equal(autoUpdater.activeVersion, '0.9.8');
});

test('reactivates the stable channel when its release is newer than the rc', async () => {
  const checkedChannels = [];
  const autoUpdater = {
    activeVersion: null,
    set channel(value) { this._channel = value; },
    get channel() { return this._channel; },
    async checkForUpdates() {
      checkedChannels.push(this.channel);
      this.activeVersion = this.channel === 'latest' ? '0.9.10' : '0.9.9-rc.9';
      return { updateInfo: { version: this.activeVersion } };
    },
  };

  const result = await checkForDesktopUpdate({
    autoUpdater,
    currentVersion: '0.9.7',
    pendingUpdate: null,
    compareVersions: compareReleaseVersions,
    updateChecks: [
      { channel: 'latest', allowPrerelease: false },
      { channel: 'rc', allowPrerelease: true },
    ],
  });

  assert.deepEqual(checkedChannels, ['latest', 'rc', 'latest']);
  assert.equal(result.nextVersion, '0.9.10');
  assert.equal(autoUpdater.activeVersion, '0.9.10');
});

test('rejects a selected feed that changes while Electron is being reactivated', async () => {
  let stableChecks = 0;
  const autoUpdater = {
    set channel(value) { this._channel = value; },
    get channel() { return this._channel; },
    async checkForUpdates() {
      if (this.channel === 'rc') return { updateInfo: { version: '0.9.9-rc.9' } };
      stableChecks += 1;
      return { updateInfo: { version: stableChecks === 1 ? '0.9.10' : '0.9.11' } };
    },
  };

  await assert.rejects(
    checkForDesktopUpdate({
      autoUpdater,
      currentVersion: '0.9.7',
      pendingUpdate: null,
      compareVersions: compareReleaseVersions,
      updateChecks: [
        { channel: 'latest', allowPrerelease: false },
        { channel: 'rc', allowPrerelease: true },
      ],
    }),
    /Available update changed while checking/,
  );
});

test('a final stable release takes precedence over its rc', async () => {
  const checkedChannels = [];
  const autoUpdater = {
    activeVersion: null,
    set channel(value) { this._channel = value; },
    get channel() { return this._channel; },
    async checkForUpdates() {
      checkedChannels.push(this.channel);
      const version = this.channel === 'latest' ? '0.9.9' : '0.9.9-rc.2';
      if (compareReleaseVersions(version, '0.9.9-rc.2') > 0) this.activeVersion = version;
      return { updateInfo: { version } };
    },
  };

  const result = await checkForDesktopUpdate({
    autoUpdater,
    currentVersion: '0.9.9-rc.2',
    pendingUpdate: null,
    compareVersions: compareReleaseVersions,
    updateChecks: [
      { channel: 'latest', allowPrerelease: false },
      { channel: 'rc', allowPrerelease: true },
    ],
  });

  assert.deepEqual(checkedChannels, ['latest', 'rc']);
  assert.equal(autoUpdater.channel, 'latest');
  assert.equal(autoUpdater.activeVersion, '0.9.9');
  assert.equal(result.nextVersion, '0.9.9');
});

test('uses a stable update when the rc feed has not been published', async () => {
  const checkedChannels = [];
  const autoUpdater = {
    set channel(value) { this._channel = value; },
    get channel() { return this._channel; },
    async checkForUpdates() {
      checkedChannels.push(this.channel);
      if (this.channel === 'rc') throw new Error('HttpError: 404 Not Found');
      return { updateInfo: { version: '0.9.8' } };
    },
  };

  const result = await checkForDesktopUpdate({
    autoUpdater,
    currentVersion: '0.9.7',
    pendingUpdate: null,
    compareVersions: compareReleaseVersions,
    updateChecks: [
      { channel: 'latest', allowPrerelease: false },
      { channel: 'rc', allowPrerelease: true },
    ],
  });

  assert.deepEqual(checkedChannels, ['latest', 'rc']);
  assert.equal(autoUpdater.channel, 'latest');
  assert.equal(result.nextVersion, '0.9.8');
});

const checks = [
  { channel: 'latest', allowPrerelease: false },
  { channel: 'rc', allowPrerelease: true },
];

test('accepts stable when the real GitHub provider has no RC in its Atom feed', async () => {
  const require = createRequire(import.meta.url);
  const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider.js');
  const autoUpdater = {
    channel: 'latest', currentVersion: '1.0.0', allowPrerelease: false,
    async checkForUpdates() {
      if (this.channel === 'latest') return { isUpdateAvailable: true, updateInfo: { version: '2.0.0' } };
      return { updateInfo: await provider.getLatestVersion() };
    },
  };
  const provider = new GitHubProvider({ owner: 'fixture', repo: 'fixture' }, autoUpdater, { platform: 'linux', executor: {} });
  provider.httpRequest = async () => '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>v2.0.0</title><link href="https://github.com/fixture/fixture/releases/tag/v2.0.0"/></entry></feed>';
  const result = await checkForDesktopUpdate({ autoUpdater, currentVersion: '1.0.0', compareVersions: compareReleaseVersions, updateChecks: checks });
  assert.equal(result.nextVersion, '2.0.0');
  assert.equal(autoUpdater.channel, 'latest');
});

for (const error of [
  Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' }),
  new Error('HttpError: 500 fetching latest-linux.yml'),
]) {
  test(`does not classify network failure as a missing feed: ${error.message}`, async () => {
    await assert.rejects(checkForDesktopUpdate({
      autoUpdater: { checkForUpdates: async () => { throw error; } },
      currentVersion: '1.0.0', compareVersions: compareReleaseVersions, updateChecks: checks,
    }), /Unable to check for updates/);
  });
}

test('no published stable releases remains an error', async () => {
  await assert.rejects(checkForDesktopUpdate({
    autoUpdater: { checkForUpdates: async () => { throw Object.assign(new Error('No published versions on GitHub'), { code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' }); } },
    currentVersion: '1.0.0', compareVersions: compareReleaseVersions, updateChecks: checks,
  }), /Unable to check for updates/);
});

const createCoordinatorFixture = () => {
  const autoUpdater = new EventEmitter();
  autoUpdater.activeVersion = null;
  autoUpdater.nextVersion = '2.0.0';
  autoUpdater.checkForUpdates = async () => {
    autoUpdater.activeVersion = autoUpdater.nextVersion;
    return { isUpdateAvailable: true, updateInfo: { version: autoUpdater.activeVersion } };
  };
  autoUpdater.downloadUpdate = async () => {
    autoUpdater.emit('update-downloaded', { version: autoUpdater.activeVersion });
    return ['fixture-installer'];
  };
  const state = { pendingUpdate: null };
  const coordinator = createDesktopUpdateCoordinator({ autoUpdater, state, compareVersions: compareReleaseVersions });
  const check = () => coordinator.check({ currentVersion: '1.0.0', updateChecks: checks });
  return { autoUpdater, state, coordinator, check };
};

test('failed reactivation invalidates pending metadata and blocks download until a successful check', async () => {
  const { autoUpdater, state, coordinator, check } = createCoordinatorFixture();
  await check();
  let stableChecks = 0;
  autoUpdater.checkForUpdates = async () => {
    autoUpdater.activeVersion = autoUpdater.channel === 'rc' ? '1.5.0-rc.1' : ++stableChecks === 1 ? '2.0.0' : '2.1.0';
    return { isUpdateAvailable: true, updateInfo: { version: autoUpdater.activeVersion } };
  };
  await assert.rejects(check(), /Available update changed/);
  assert.equal(state.pendingUpdate, null);
  await assert.rejects(coordinator.download(), /No pending update/);
  await check();
  await coordinator.download();
  assert.equal(state.pendingUpdate.version, '2.1.0');
  assert.equal(state.pendingUpdate.downloaded, true);
});

test('serializes checks and queues downloads behind the entire multi-feed check', async () => {
  const { autoUpdater, state, coordinator, check } = createCoordinatorFixture();
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  autoUpdater.checkForUpdates = async () => {
    calls.push(autoUpdater.channel);
    if (calls.length === 1) { entered(); await gate; }
    autoUpdater.activeVersion = autoUpdater.channel === 'rc' ? '2.1.0-rc.1' : '2.0.0';
    return { isUpdateAvailable: true, updateInfo: { version: autoUpdater.activeVersion } };
  };
  const first = check();
  await started;
  const second = check();
  const download = coordinator.download();
  assert.deepEqual(calls, ['latest']);
  release();
  await Promise.all([first, second, download]);
  assert.deepEqual(calls, ['latest', 'rc', 'latest', 'rc']);
  assert.equal(state.pendingUpdate.version, '2.1.0-rc.1');
  assert.equal(state.pendingUpdate.downloaded, true);
});

test('does not let a check retarget a download in flight', async () => {
  const { autoUpdater, state, coordinator, check } = createCoordinatorFixture();
  await check();
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  autoUpdater.downloadUpdate = async () => {
    entered();
    await gate;
    assert.equal(autoUpdater.activeVersion, '2.0.0');
    autoUpdater.emit('update-downloaded', { version: '2.0.0' });
    return ['fixture-installer'];
  };
  const download = coordinator.download();
  await started;
  autoUpdater.nextVersion = '3.0.0';
  const nextCheck = check();
  release();
  await Promise.all([download, nextCheck]);
  assert.equal(state.pendingUpdate.version, '3.0.0');
  assert.notEqual(state.pendingUpdate.downloaded, true);
  assert.equal(autoUpdater.listenerCount('update-downloaded'), 0);
});

test('a mismatched downloaded version cannot become installable', async () => {
  const { autoUpdater, state, coordinator, check } = createCoordinatorFixture();
  await check();
  autoUpdater.downloadUpdate = async () => { autoUpdater.emit('update-downloaded', { version: '1.5.0' }); };
  await assert.rejects(coordinator.download(), /does not match/);
  assert.equal(state.pendingUpdate, null);
  assert.equal(autoUpdater.listenerCount('update-downloaded'), 0);
});

test('download rejection releases the queue and removes its event listener', async () => {
  const { autoUpdater, state, coordinator, check } = createCoordinatorFixture();
  await check();
  autoUpdater.downloadUpdate = async () => { throw new Error('download failed'); };
  await assert.rejects(coordinator.download(), /download failed/);
  assert.notEqual(state.pendingUpdate.downloaded, true);
  assert.equal(autoUpdater.listenerCount('update-downloaded'), 0);
  await check();
});
