import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveElectronUpdaterVersion } from './app-version.mjs';

test('keeps packaged PiChamber versions for electron-updater', () => {
  assert.equal(resolveElectronUpdaterVersion('0.1.1'), '0.1.1');
  assert.equal(resolveElectronUpdaterVersion('v1.2.3'), '1.2.3');
  assert.equal(resolveElectronUpdaterVersion('1.2.3-beta.1'), '1.2.3-beta.1');
});

test('replaces unpackaged Electron host versions that are not semver', () => {
  assert.equal(resolveElectronUpdaterVersion('0.0'), '0.0.0-dev');
  assert.equal(resolveElectronUpdaterVersion(''), '0.0.0-dev');
  assert.equal(resolveElectronUpdaterVersion(undefined), '0.0.0-dev');
});
