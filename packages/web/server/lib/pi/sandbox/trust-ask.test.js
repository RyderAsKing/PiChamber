import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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

  it('treats an unreadable list as every folder for the daemon, and a write replaces it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'pichamber-trust-ask-bad-'));
    await mkdir(join(dataDir, 'pi'), { recursive: true });
    await writeFile(trustAskFile(dataDir), 'not json');
    expect(createTrustAskReader({ dataDir })('/anything')).toBe(true);
    const store = createTrustAskStore({ dataDir });
    await store.add(['/work/c']);
    expect(await store.list()).toEqual(['/work/c']);
    expect(createTrustAskReader({ dataDir })('/anything')).toBe(false);
  });
});
