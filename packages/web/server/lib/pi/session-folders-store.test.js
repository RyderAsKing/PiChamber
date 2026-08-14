import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createPiSessionFoldersStore } from './session-folders-store.js';

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const snapshot = {
  version: 1,
  foldersMap: {
    '/workspace': [{ id: 'folder-1', name: 'Current', sessionIds: ['session-1'], createdAt: 1, parentId: null }],
  },
  collapsedFolderIds: ['folder-1'],
  updatedAt: 2,
};

describe('Pi session folders store', () => {
  it('distinguishes a missing snapshot and atomically round-trips a valid snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pichamber-session-folders-'));
    directories.push(directory);
    const file = join(directory, 'pi', 'session-folders.json');
    const store = createPiSessionFoldersStore({ file });

    await expect(store.read()).resolves.toEqual({ exists: false });
    await expect(store.write(snapshot)).resolves.toEqual({ exists: true, ...snapshot });
    await expect(store.read()).resolves.toEqual({ exists: true, ...snapshot });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(snapshot);
  });

  it('rejects malformed snapshots without replacing valid data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pichamber-session-folders-'));
    directories.push(directory);
    const store = createPiSessionFoldersStore({ file: join(directory, 'session-folders.json') });
    await store.write(snapshot);

    await expect(store.write({ ...snapshot, foldersMap: { '/workspace': [{ id: '', name: 'bad', sessionIds: [], createdAt: 1 }] } })).rejects.toThrow('SESSION_FOLDERS_INVALID');
    await expect(store.read()).resolves.toEqual({ exists: true, ...snapshot });
  });
});
