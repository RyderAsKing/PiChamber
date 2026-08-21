import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPiUiSettingsStore } from './ui-settings-store.js';

const makeStore = async () => {
  const root = await mkdtemp(join(tmpdir(), 'pichamber-ui-settings-'));
  const file = join(root, 'settings.json');
  return { file, store: createPiUiSettingsStore({ file }) };
};

describe('Pi UI settings store', () => {
  it('distinguishes a missing file from malformed persisted settings', async () => {
    const { file, store } = await makeStore();
    await expect(store.read()).resolves.toEqual({});
    await writeFile(file, '{broken');
    await expect(store.read()).rejects.toThrow('UI_SETTINGS_INVALID');
  });

  it('serializes merge writes without dropping unrelated fields', async () => {
    const { file, store } = await makeStore();
    await Promise.all([
      store.write({ themeMode: 'dark' }),
      store.write({ projects: [{ id: 'one', path: '/one' }] }),
    ]);
    await expect(store.read()).resolves.toEqual({
      themeMode: 'dark',
      projects: [{ id: 'one', path: '/one' }],
    });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ themeMode: 'dark' });
  });

  it('publishes a monotonic revision after each committed write', async () => {
    const { store } = await makeStore();
    const revisions = [];
    const unsubscribe = store.subscribe((revision) => revisions.push(revision));

    await store.write({ projects: [{ id: 'one', path: '/one' }] });
    await store.write({ themeMode: 'dark' });
    unsubscribe();
    await store.write({ themeMode: 'light' });

    expect(revisions).toEqual([1, 2]);
    expect(store.getRevision()).toBe(3);
  });

  it('rejects prototype-polluting keys', async () => {
    const { store } = await makeStore();
    const changes = JSON.parse('{"__proto__":{"polluted":true}}');
    await expect(store.write(changes)).rejects.toThrow('UI_SETTINGS_INVALID');
  });
});
