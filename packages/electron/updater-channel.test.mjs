import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareReleaseVersions,
  isReleaseCandidateVersion,
  resolveDesktopUpdateChannel,
  resolveUpdaterChannel,
  resolveUpdaterChecks,
} from './updater-channel.mjs';

test('uses stable architecture channels without enabling prereleases', () => {
  assert.equal(resolveUpdaterChannel({ platform: 'win32', architecture: 'arm64' }), 'latest-arm64');
  assert.equal(resolveUpdaterChannel({ platform: 'win32', architecture: 'x64' }), 'latest');
  assert.equal(resolveUpdaterChannel({ platform: 'darwin', architecture: 'arm64' }), 'latest');
  assert.equal(resolveUpdaterChannel({ platform: 'linux', architecture: 'arm64' }), 'latest');
});

test('uses one rc channel across desktop architectures', () => {
  assert.equal(resolveUpdaterChannel({ platform: 'win32', architecture: 'arm64', releaseChannel: 'rc' }), 'rc');
  assert.equal(resolveUpdaterChannel({ platform: 'darwin', architecture: 'arm64', releaseChannel: 'rc' }), 'rc');
  assert.equal(resolveUpdaterChannel({ platform: 'linux', architecture: 'arm64', releaseChannel: 'rc' }), 'rc');
});

test('the persisted update subscription defaults invalid and missing values to stable', () => {
  assert.equal(resolveDesktopUpdateChannel('stable'), 'stable');
  assert.equal(resolveDesktopUpdateChannel('rc'), 'rc');
  assert.equal(resolveDesktopUpdateChannel('beta'), 'stable');
  assert.equal(resolveDesktopUpdateChannel(undefined), 'stable');
});

test('rc subscribers check stable before checking the rc channel', () => {
  assert.equal(isReleaseCandidateVersion('0.9.9-rc.1'), true);
  assert.equal(isReleaseCandidateVersion('0.9.9-beta.1'), false);
  assert.deepEqual(resolveUpdaterChecks({
    updateChannel: 'rc',
    platform: 'win32',
    architecture: 'arm64',
  }), [
    { channel: 'latest-arm64', allowPrerelease: false },
    { channel: 'rc', allowPrerelease: true },
  ]);
  assert.deepEqual(resolveUpdaterChecks({
    updateChannel: 'stable',
    platform: 'win32',
    architecture: 'x64',
  }), [
    { channel: 'latest', allowPrerelease: false },
  ]);
});

test('compares release candidates using semver precedence', () => {
  assert.ok(compareReleaseVersions('0.9.9-rc.2', '0.9.9-rc.1') > 0);
  assert.ok(compareReleaseVersions('0.9.9', '0.9.9-rc.2') > 0);
  assert.ok(compareReleaseVersions('0.9.9-rc.1', '0.9.8') > 0);
  assert.equal(compareReleaseVersions('v0.9.9', '0.9.9'), 0);
});
