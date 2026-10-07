import { afterEach, describe, expect, it } from 'vitest';
import fsPromises, { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import fsSync from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeFileAtomic, writeFileAtomicSync } from './atomic-write.js';

const directories = [];

const makeRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'pichamber-atomic-write-'));
  directories.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const variants = [
  ['writeFileAtomic', (file, data, options) => writeFileAtomic(file, data, options), fsPromises],
  ['writeFileAtomicSync', async (file, data, options) => writeFileAtomicSync(file, data, options), fsSync],
];

describe.each(variants)('%s', (_name, write, defaultFs) => {
  it('replaces a regular file with mode 0600', async () => {
    const root = await makeRoot();
    const file = join(root, 'settings.json');
    await writeFile(file, 'old', { mode: 0o644 });

    await expect(write(file, 'new')).resolves.toBe(file);

    expect(await readFile(file, 'utf8')).toBe('new');
    expect((await lstat(file)).isFile()).toBe(true);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(['settings.json']);
  });

  it('writes through an absolute symlink and keeps the link', async () => {
    const root = await makeRoot();
    const dotfiles = join(root, 'dotfiles');
    const config = join(root, 'config');
    await mkdir(dotfiles);
    await mkdir(config);
    const target = join(dotfiles, 'settings.json');
    const link = join(config, 'settings.json');
    await writeFile(target, 'old');
    await symlink(target, link);

    await expect(write(link, 'new')).resolves.toBe(await fsPromises.realpath(target));

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe(target);
    expect(await readFile(target, 'utf8')).toBe('new');
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readdir(config)).toEqual(['settings.json']);
    expect(await readdir(dotfiles)).toEqual(['settings.json']);
  });

  it('writes through a relative symlink and keeps the link', async () => {
    const root = await makeRoot();
    await mkdir(join(root, 'dotfiles', 'pi'), { recursive: true });
    await mkdir(join(root, 'config', 'pi'), { recursive: true });
    const target = join(root, 'dotfiles', 'pi', 'snippets.json');
    const link = join(root, 'config', 'pi', 'snippets.json');
    await writeFile(target, 'old');
    await symlink('../../dotfiles/pi/snippets.json', link);

    await write(link, 'new');

    expect(await readlink(link)).toBe('../../dotfiles/pi/snippets.json');
    expect(await readFile(target, 'utf8')).toBe('new');
  });

  it('writes to the target of a dangling symlink instead of replacing the link', async () => {
    const root = await makeRoot();
    await mkdir(join(root, 'config'));
    const link = join(root, 'config', 'config.json');
    const target = join(root, 'dotfiles', 'stt', 'config.json');
    await symlink('../dotfiles/stt/config.json', link);

    await expect(write(link, 'new')).resolves.toBe(target);

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('new');
    expect(await readFile(link, 'utf8')).toBe('new');
  });

  it('creates a missing file and its parent directory', async () => {
    const root = await makeRoot();
    const file = join(root, 'nested', 'settings.json');

    await expect(write(file, 'new')).resolves.toBe(file);

    expect(await readFile(file, 'utf8')).toBe('new');
    expect((await lstat(file)).isFile()).toBe(true);
  });

  it('removes the temporary file and keeps the previous content when rename fails', async () => {
    const root = await makeRoot();
    const file = join(root, 'settings.json');
    await writeFile(file, 'old');
    const renameFailure = Object.assign(new Error('rename failed'), { code: 'EXDEV' });
    const failingFs = {
      ...defaultFs,
      rename: async () => { throw renameFailure; },
      renameSync: () => { throw renameFailure; },
    };

    await expect(write(file, 'new', { fs: failingFs })).rejects.toBe(renameFailure);

    expect(await readFile(file, 'utf8')).toBe('old');
    expect(await readdir(root)).toEqual(['settings.json']);
  });
});
