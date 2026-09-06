import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  confirmLinuxAppImageUpdate,
  installLinuxAppImageUpdate,
  recoverLinuxAppImageUpdate,
} from './linux-appimage-update.mjs';

const createFixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pichamber-appimage-update-test-'));
  const currentPath = path.join(root, 'PiChamber.AppImage');
  const downloadedPath = path.join(root, 'download', 'PiChamber-next.AppImage');
  const appDataDirectory = path.join(root, 'data');
  await fs.mkdir(path.dirname(downloadedPath), { recursive: true });
  await fs.writeFile(currentPath, 'old-version');
  await fs.chmod(currentPath, 0o755);
  await fs.writeFile(downloadedPath, 'new-version');
  await fs.chmod(downloadedPath, 0o755);
  return { root, currentPath, downloadedPath, appDataDirectory };
};

const validateFixtureAppImage = async ({ appImagePath }) => {
  const info = await fs.stat(appImagePath);
  assert.equal(info.isFile(), true);
};

test('installs an AppImage over the existing path and preserves a backup', async () => {
  const fixture = await createFixture();
  try {
    const result = await installLinuxAppImageUpdate({
      ...fixture,
      validate: validateFixtureAppImage,
      now: () => 123,
    });

    assert.equal(result.currentPath, fixture.currentPath);
    assert.equal(await fs.readFile(fixture.currentPath, 'utf8'), 'new-version');
    assert.equal(await fs.readFile(result.backupPath, 'utf8'), 'old-version');
    assert.equal((await fs.stat(result.transactionPath)).isFile(), true);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('confirms a successful update by removing recovery state', async () => {
  const fixture = await createFixture();
  try {
    const result = await installLinuxAppImageUpdate({
      ...fixture,
      validate: validateFixtureAppImage,
    });
    assert.equal(await confirmLinuxAppImageUpdate({
      appImagePath: fixture.currentPath,
      appDataDirectory: fixture.appDataDirectory,
    }), true);
    await assert.rejects(() => fs.stat(result.backupPath), { code: 'ENOENT' });
    await assert.rejects(() => fs.stat(result.transactionPath), { code: 'ENOENT' });
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('recovers the previous AppImage after an unsuccessful restart', async () => {
  const fixture = await createFixture();
  try {
    await installLinuxAppImageUpdate({
      ...fixture,
      validate: validateFixtureAppImage,
    });

    const firstStart = await recoverLinuxAppImageUpdate({
      appImagePath: fixture.currentPath,
      appDataDirectory: fixture.appDataDirectory,
    });
    assert.equal(firstStart.pending, true);
    assert.equal(await fs.readFile(fixture.currentPath, 'utf8'), 'new-version');

    const failedRestart = await recoverLinuxAppImageUpdate({
      appImagePath: fixture.currentPath,
      appDataDirectory: fixture.appDataDirectory,
    });
    assert.equal(failedRestart.recovered, true);
    assert.equal(await fs.readFile(fixture.currentPath, 'utf8'), 'old-version');
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
