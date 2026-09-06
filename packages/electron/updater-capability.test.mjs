import assert from 'node:assert/strict';
import test from 'node:test';

import { assertUpdaterCapability, resolveLinuxPackageType } from './updater-capability.mjs';

test('preserves updater behavior outside packaged Linux', () => {
  assert.doesNotThrow(() => assertUpdaterCapability({ platform: 'darwin', packaged: true }));
  assert.doesNotThrow(() => assertUpdaterCapability({ platform: 'win32', packaged: true }));
  assert.doesNotThrow(() => assertUpdaterCapability({ platform: 'linux', packaged: false }));
});

test('rejects packaged Linux execution without a recognized package', () => {
  assert.throws(
    () => assertUpdaterCapability({ platform: 'linux', packaged: true, appImagePath: '' }),
    /packaged Linux installation.*\.deb\/\.rpm package/,
  );
});

test('accepts package-manager installations without an AppImage path', () => {
  assert.doesNotThrow(() => assertUpdaterCapability({
    platform: 'linux',
    packaged: true,
    packageType: 'deb',
  }));
  assert.doesNotThrow(() => assertUpdaterCapability({
    platform: 'linux',
    packaged: true,
    packageType: 'rpm',
  }));
});

test('rejects missing and non-writable AppImages with actionable errors', () => {
  assert.throws(
    () => assertUpdaterCapability({
      platform: 'linux',
      packaged: true,
      appImagePath: '/opt/PiChamber.AppImage',
      stat: () => { throw new Error('missing'); },
    }),
    /cannot be found.*valid \.AppImage file/,
  );
  assert.throws(
    () => assertUpdaterCapability({
      platform: 'linux',
      packaged: true,
      appImagePath: '/opt/PiChamber.AppImage',
      stat: () => ({ isFile: () => true }),
      access: () => { throw new Error('read-only'); },
    }),
    /not writable.*grant write permission/,
  );
});

test('accepts a writable packaged AppImage', () => {
  assert.doesNotThrow(() => assertUpdaterCapability({
    platform: 'linux',
    packaged: true,
    appImagePath: '/home/user/PiChamber.AppImage',
    stat: () => ({ isFile: () => true }),
    access: () => {},
  }));
});

test('resolves AppImage and package-manager identities', () => {
  assert.equal(resolveLinuxPackageType({
    platform: 'linux',
    packaged: true,
    appImagePath: '/home/user/PiChamber.AppImage',
  }), 'AppImage');
  assert.equal(resolveLinuxPackageType({
    platform: 'linux',
    packaged: true,
    appImagePath: '',
    resourcesPath: '/resources',
    readFile: () => 'deb\n',
  }), 'deb');
  assert.equal(resolveLinuxPackageType({
    platform: 'linux',
    packaged: true,
    appImagePath: '',
    resourcesPath: '/resources',
    readFile: () => 'unknown\n',
  }), null);
  assert.equal(resolveLinuxPackageType({
    platform: 'linux',
    packaged: true,
    appImagePath: '/home/user/PiChamber.AppImage',
    resourcesPath: '/resources',
    readFile: () => 'deb\n',
  }), 'deb');
});
