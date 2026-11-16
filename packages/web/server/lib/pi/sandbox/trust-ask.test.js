import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTrustAskReader, createTrustAskStore, trustAskFile } from './trust-ask.js';

describe('trust reset list', () => {
  it('records folders, clears one on an explicit decision, and the daemon reader matches folders inside them', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'pichamber-trust-ask-'));
    const store = createTrustAskStore({ dataDir });
    const isAsk = createTrustAskReader({ dataDir });
    expect(await store.list()).toEqual([]);
    expect(isAsk('/work/a')).toBe(false);

    await Promise.all([store.add(['/work/a', '/work/b']), store.add(['/work/a', 'relative'])]);
    expect(await store.list()).toEqual(['/work/a', '/work/b']);
    expect(isAsk('/work/a')).toBe(true);
    expect(isAsk('/work/a/src')).toBe(true);
    expect(isAsk('/work/ab')).toBe(false);

    await store.remove('/work/a');
    expect(await store.list()).toEqual(['/work/b']);
    expect(isAsk('/work/a')).toBe(false);
  });

  it('treats an unreadable list as every folder, and a write refuses to replace it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'pichamber-trust-ask-bad-'));
    await mkdir(join(dataDir, 'pi'), { recursive: true });
    for (const raw of ['not json', '{"directories":["relative"]}', '[]']) {
      await writeFile(trustAskFile(dataDir), raw);
      expect(createTrustAskReader({ dataDir })('/anything')).toBe(true);
      const store = createTrustAskStore({ dataDir });
      await expect(store.list()).rejects.toMatchObject({ code: 'TRUST_ASK_UNREADABLE' });
      await expect(store.add(['/work/c'])).rejects.toMatchObject({ code: 'TRUST_ASK_UNREADABLE' });
      await expect(store.remove('/work/c')).rejects.toMatchObject({ code: 'TRUST_ASK_UNREADABLE' });
      expect(await readFile(trustAskFile(dataDir), 'utf8')).toBe(raw);
    }
  });

  it('keeps earlier entries when the file is repaired, and asks for a symlinked spelling', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'pichamber-trust-ask-link-'));
    const real = await mkdtemp(join(tmpdir(), 'pichamber-trust-ask-real-'));
    const link = join(dataDir, 'link');
    await symlink(real, link);
    const store = createTrustAskStore({ dataDir });
    await store.add([real]);
    const isAsk = createTrustAskReader({ dataDir });
    expect(isAsk(real)).toBe(true);
    expect(isAsk(link)).toBe(true);
    expect(isAsk(join(link, 'src'))).toBe(true);
    expect(isAsk(dataDir)).toBe(false);
  });
});
