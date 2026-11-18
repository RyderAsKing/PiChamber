import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSandboxedFoldersReader, createSandboxedFoldersStore, sandboxedFoldersFile } from './sandboxed-folders.js';

describe('sandboxed folder record', () => {
  it('lists nothing before the first write, then the folders and everything inside them', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'pichamber-sandboxed-folders-'));
    const file = sandboxedFoldersFile(dataDir);
    const isSandboxed = createSandboxedFoldersReader({ file });
    expect(isSandboxed('/work/a')).toBe(false);

    const store = createSandboxedFoldersStore({ dataDir });
    await store.set(['/work/b', '/work/a', '/work/a']);
    expect(JSON.parse(await readFile(file, 'utf8')).directories).toEqual(['/work/a', '/work/b']);
    expect(isSandboxed('/work/a')).toBe(true);
    expect(isSandboxed('/work/a/src')).toBe(true);
    expect(isSandboxed('/work/ab')).toBe(false);

    await store.set(['/work/b']);
    expect(isSandboxed('/work/a')).toBe(false);
    await store.set([]);
    expect(isSandboxed('/work/b')).toBe(false);
  });

  it('puts the list back when its file was deleted or changed', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'pichamber-sandboxed-folders-'));
    const file = sandboxedFoldersFile(dataDir);
    const store = createSandboxedFoldersStore({ dataDir });
    await store.set(['/work/a']);
    await rm(file);
    await store.set(['/work/a']);
    expect(JSON.parse(await readFile(file, 'utf8')).directories).toEqual(['/work/a']);
    await writeFile(file, JSON.stringify({ version: 1, directories: [] }));
    await store.set(['/work/a']);
    expect(createSandboxedFoldersReader({ file })('/work/a')).toBe(true);
  });

  it('matches a folder that reaches a sandboxed one through a symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-sandboxed-folders-link-'));
    const project = join(root, 'project');
    await mkdir(join(project, 'src'), { recursive: true });
    await symlink(project, join(root, 'alias'));
    await createSandboxedFoldersStore({ dataDir: root }).set([project]);
    const isSandboxed = createSandboxedFoldersReader({ file: sandboxedFoldersFile(root) });
    expect(isSandboxed(join(root, 'alias'))).toBe(true);
    expect(isSandboxed(join(root, 'alias', 'src'))).toBe(true);
    expect(isSandboxed(join(root, 'elsewhere'))).toBe(false);
  });

  it('treats an unreadable record as every folder, and refuses a list too long to record', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'pichamber-sandboxed-folders-bad-'));
    await mkdir(join(dataDir, 'pi'), { recursive: true });
    await writeFile(sandboxedFoldersFile(dataDir), 'not json');
    expect(createSandboxedFoldersReader({ file: sandboxedFoldersFile(dataDir) })('/anything')).toBe(true);

    const store = createSandboxedFoldersStore({ dataDir });
    await expect(store.set(Array.from({ length: 4097 }, (_, index) => `/work/${index}`))).rejects.toMatchObject({ code: 'SANDBOXED_FOLDERS_FULL' });
    // The refused list wrote nothing; the next one replaces the bad file.
    await store.set(['/work/c']);
    expect(createSandboxedFoldersReader({ file: sandboxedFoldersFile(dataDir) })('/anything')).toBe(false);
  });
});
