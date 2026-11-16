import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createWorktreeIdStore, worktreeIdsFile } from './worktree-ids.js';

const setup = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pichamber-worktree-ids-'));
  return { dataDir, file: worktreeIdsFile(dataDir), store: createWorktreeIdStore({ dataDir }) };
};

const A = 'a'.repeat(40);
const B = 'b'.repeat(64);

describe('remembered worktree ids', () => {
  it('keeps the first id seen for a project, whatever is offered later', async () => {
    const { store, file } = await setup();
    expect(await store.remember('/code/app', A)).toBe(A);
    expect(await store.remember('/code/app', B)).toBe(A);
    expect(await store.remember('/code/app/', null)).toBe(A);
    expect(await store.remember('/code/other', B)).toBe(B);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, projects: { '/code/app': A, '/code/other': B } });
  });

  it('remembers nothing for a missing id or one that is not a git object id', async () => {
    const { store } = await setup();
    for (const id of [null, '', '../../etc', 'A'.repeat(40), 'a'.repeat(39)]) {
      expect(await store.remember('/code/app', id)).toBeNull();
    }
    expect(await store.read()).toEqual(new Map());
  });

  it('keeps concurrent first sights apart', async () => {
    const { store } = await setup();
    expect(await Promise.all([store.remember('/code/app', A), store.remember('/code/app', B)])).toEqual([A, A]);
  });

  it('throws on a record it cannot parse instead of forgetting the ids', async () => {
    const { store, file } = await setup();
    await mkdir(dirname(file), { recursive: true });
    for (const raw of ['{', '[]', JSON.stringify({ projects: { 'code/app': A } }), JSON.stringify({ projects: { '/code/app': '../x' } })]) {
      await writeFile(file, raw);
      await expect(store.read()).rejects.toMatchObject({ code: 'SANDBOX_WORKTREE_IDS_UNREADABLE' });
      await expect(store.remember('/code/app', A)).rejects.toMatchObject({ code: 'SANDBOX_WORKTREE_IDS_UNREADABLE' });
    }
  });

  it('takes no new project when the record is full, and forgets none', async () => {
    const { store, file } = await setup();
    await mkdir(dirname(file), { recursive: true });
    const projects = Object.fromEntries(Array.from({ length: 4096 }, (_, index) => [`/code/p${index}`, A]));
    await writeFile(file, JSON.stringify({ version: 1, projects }));
    await expect(store.remember('/code/new', B)).rejects.toMatchObject({ code: 'SANDBOX_WORKTREE_IDS_FULL' });
    const saved = JSON.parse(await readFile(file, 'utf8')).projects;
    expect(Object.keys(saved)).toHaveLength(4096);
    expect(saved['/code/p0']).toBe(A);
    // A project already in it is still answered.
    expect(await store.remember('/code/p0', B)).toBe(A);
  });
});
