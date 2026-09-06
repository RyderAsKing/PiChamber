import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPiUiSettingsStore } from './ui-settings-store.js';

const makeStore = async () => {
  const root = await mkdtemp(join(tmpdir(), 'pichamber-ui-settings-'));
  const file = join(root, 'settings.json');
  const runtimeFile = join(root, 'runtime-state.json');
  return { file, runtimeFile, store: createPiUiSettingsStore({ file, runtimeFile }) };
};

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

describe('Pi UI settings store', () => {
  it('distinguishes malformed persisted settings from a fresh store', async () => {
    const { file, store } = await makeStore();
    await expect(store.read()).resolves.toEqual({});
    await writeFile(file, '{broken');
    await expect(store.read()).rejects.toThrow('UI_SETTINGS_INVALID');
  });

  it('migrates a flat settings file into portable and local allowlists', async () => {
    const { file, runtimeFile, store } = await makeStore();
    await writeFile(file, JSON.stringify({
      themeId: 'nord',
      homeDirectory: '/old-home',
      projects: [{ id: 'old', path: '/old-home/project' }],
      desktopUiPassword: 'secret',
      unknownField: 'drop-me',
    }));

    await expect(store.read()).resolves.toMatchObject({
      themeId: 'nord',
      homeDirectory: '/old-home',
      projects: [{ id: 'old', path: '/old-home/project' }],
      desktopUiPassword: 'secret',
    });
    await expect(readJson(file)).resolves.toEqual({
      __pichamberSettingsScope: 'portable-v1',
      themeId: 'nord',
    });
    await expect(readJson(runtimeFile)).resolves.toEqual({
      homeDirectory: '/old-home',
      projects: [{ id: 'old', path: '/old-home/project' }],
      desktopUiPassword: 'secret',
    });
  });

  it('does not apply local fields copied in from another home', async () => {
    const source = await makeStore();
    await source.store.write({ themeId: 'nord', homeDirectory: '/mnt/data', projects: [{ id: 'one', path: '/mnt/data/project' }] });

    const target = await makeStore();
    await target.store.write({ homeDirectory: '/root', projects: [{ id: 'two', path: '/root/project' }] });
    await writeFile(target.file, await readFile(source.file));

    await expect(target.store.read()).resolves.toEqual({
      themeId: 'nord',
      homeDirectory: '/root',
      projects: [{ id: 'two', path: '/root/project' }],
    });
  });

  it('serializes scoped merge writes without dropping unrelated fields', async () => {
    const { file, runtimeFile, store } = await makeStore();
    await Promise.all([
      store.write({ themeId: 'dark' }),
      store.write({ projects: [{ id: 'one', path: '/one' }] }),
    ]);
    await expect(store.read()).resolves.toEqual({
      themeId: 'dark',
      projects: [{ id: 'one', path: '/one' }],
    });
    await expect(readJson(file)).resolves.toEqual({
      __pichamberSettingsScope: 'portable-v1',
      themeId: 'dark',
    });
    await expect(readJson(runtimeFile)).resolves.toEqual({
      projects: [{ id: 'one', path: '/one' }],
    });
  });

  it('rejects prototype-polluting keys', async () => {
    const { store } = await makeStore();
    const changes = JSON.parse('{"__proto__":{"polluted":true}}');
    await expect(store.write(changes)).rejects.toThrow('UI_SETTINGS_INVALID');
  });
});
