import assert from 'node:assert/strict';
import test from 'node:test';

import { checkForDesktopUpdate } from './updater-check.mjs';
import { compareReleaseVersions } from './updater-channel.mjs';

const compareVersions = (left, right) => left.localeCompare(right, undefined, { numeric: true });

test('signals failed checks without replacing an existing pending update', async () => {
  const pendingUpdate = { version: '2.0.0', electronUpdate: { id: 'existing' } };
  await assert.rejects(
    checkForDesktopUpdate({
      autoUpdater: { checkForUpdates: async () => { throw new Error('feed unavailable'); } },
      currentVersion: '1.0.0',
      pendingUpdate,
      compareVersions,
    }),
    /Unable to check for updates: feed unavailable.*network connection/,
  );
  assert.deepEqual(pendingUpdate, { version: '2.0.0', electronUpdate: { id: 'existing' } });
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

test('checks stable before rc and disables downgrade after each channel assignment', async () => {
  const configured = [];
  const autoUpdater = {
    allowPrerelease: false,
    allowDowngrade: false,
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
      return { updateInfo: { version: this.channel === 'rc' ? '0.9.9-rc.2' : '0.9.8' } };
    },
  };

  const result = await checkForDesktopUpdate({
    autoUpdater,
    currentVersion: '0.9.9-rc.1',
    pendingUpdate: null,
    compareVersions,
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
});

test('a final stable release takes precedence over another rc update', async () => {
  const checkedChannels = [];
  const autoUpdater = {
    set channel(value) { this._channel = value; },
    get channel() { return this._channel; },
    async checkForUpdates() {
      checkedChannels.push(this.channel);
      return { updateInfo: { version: '0.9.9' } };
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

  assert.deepEqual(checkedChannels, ['latest']);
  assert.equal(result.nextVersion, '0.9.9');
});
