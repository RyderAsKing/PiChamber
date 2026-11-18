import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFeaturedSource, parseFeaturedList } from './featured.js';

const tempDir = () => mkdtemp(join(tmpdir(), 'pichamber-featured-'));

const writeBuiltin = async (dir, list) => {
  const path = join(dir, 'featured.json');
  await writeFile(path, JSON.stringify(list));
  return path;
};

const builtinList = (overrides = {}) => ({
  version: 1,
  updated: '2026-01-01',
  featured: [{ name: 'pi-lens', note: 'Local pick' }],
  hidden: [],
  ...overrides,
});

const remoteResponse = (list) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(list),
});

describe('parseFeaturedList', () => {
  it('requires version 1 and a parseable date', () => {
    expect(parseFeaturedList({ version: 2, updated: '2026-01-01', featured: [] })).toBeUndefined();
    expect(parseFeaturedList({ version: 1, updated: 'not-a-date', featured: [] })).toBeUndefined();
    expect(parseFeaturedList({ version: 1, updated: '2026/01/01', featured: [] })).toBeUndefined();
    expect(parseFeaturedList(null)).toBeUndefined();
    expect(parseFeaturedList(builtinList())).toMatchObject({ updated: '2026-01-01' });
  });

  it('skips bad names and drops duplicates', () => {
    const list = parseFeaturedList(builtinList({
      featured: [{ name: 'pi-lens' }, { name: 'Bad Name' }, { name: 'pi-lens' }, { name: '../x' }],
    }));
    expect(list.featured).toEqual([{ name: 'pi-lens' }]);
  });

  it('removes hidden names from featured', () => {
    const list = parseFeaturedList(builtinList({
      featured: [{ name: 'pi-lens' }, { name: 'evil-pkg' }],
      hidden: ['evil-pkg'],
    }));
    expect(list.featured).toEqual([{ name: 'pi-lens' }]);
    expect(list.hidden).toEqual(['evil-pkg']);
  });

  it('caps notes at 120 chars', () => {
    const list = parseFeaturedList(builtinList({
      featured: [{ name: 'pi-lens', note: 'x'.repeat(121) }, { name: 'pi-other', note: 'kept' }],
    }));
    expect(list.featured).toEqual([{ name: 'pi-lens' }, { name: 'pi-other', note: 'kept' }]);
  });

  it('caps featured at 24 entries', () => {
    const featured = Array.from({ length: 30 }, (_, index) => ({ name: `pi-pkg-${index}` }));
    const list = parseFeaturedList(builtinList({ featured }));
    expect(list.featured).toHaveLength(24);
  });
});

describe('createFeaturedSource', () => {
  it('answers built-in when there is no cache and does not await the network', async () => {
    const dir = await tempDir();
    const builtinPath = await writeBuiltin(dir, builtinList());
    const fetchImpl = vi.fn(() => new Promise(() => {}));
    const source = createFeaturedSource({
      builtinPath,
      cachePath: join(dir, 'cache', 'featured.json'),
      remoteUrl: 'https://example.com/featured.json',
      fetchImpl,
      logger: { warn: vi.fn() },
    });
    const result = await source.get();
    expect(result).toMatchObject({ updated: '2026-01-01', source: 'builtin' });
    expect(result.featured).toEqual([{ name: 'pi-lens', note: 'Local pick' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('writes the cache on refresh and later returns the remote list', async () => {
    const dir = await tempDir();
    const builtinPath = await writeBuiltin(dir, builtinList());
    const cachePath = join(dir, 'cache', 'featured.json');
    const remote = builtinList({ updated: '2026-02-01', featured: [{ name: 'pi-new', note: 'Fresh' }] });
    const fetchImpl = vi.fn(async () => remoteResponse(remote));
    let time = 1_000_000;
    const source = createFeaturedSource({
      builtinPath, cachePath, remoteUrl: 'https://example.com/featured.json', fetchImpl, now: () => time, logger: { warn: vi.fn() },
    });
    expect(await source.refresh()).toBe(true);
    const stored = JSON.parse(await readFile(cachePath, 'utf8'));
    expect(stored.list.featured).toEqual([{ name: 'pi-new', note: 'Fresh' }]);
    time += 1000;
    const result = await source.get();
    expect(result).toMatchObject({ updated: '2026-02-01', source: 'remote' });
    expect(result.featured).toEqual([{ name: 'pi-new', note: 'Fresh' }]);
  });

  it('prefers the remote copy on the same date but keeps a newer built-in', async () => {
    const dir = await tempDir();
    const sameDayRemote = builtinList({ updated: '2026-01-01', featured: [{ name: 'pi-remote' }] });
    const source = createFeaturedSource({
      builtinPath: await writeBuiltin(dir, builtinList()),
      cachePath: join(dir, 'cache.json'),
      remoteUrl: 'https://example.com/featured.json',
      fetchImpl: async () => remoteResponse(sameDayRemote),
      logger: { warn: vi.fn() },
    });
    expect(await source.refresh()).toBe(true);
    expect((await source.get()).featured).toEqual([{ name: 'pi-remote' }]);

    const dir2 = await tempDir();
    const olderRemote = builtinList({ updated: '2025-01-01', featured: [{ name: 'pi-old' }] });
    const newer = createFeaturedSource({
      builtinPath: await writeBuiltin(dir2, builtinList({ updated: '2026-03-01' })),
      cachePath: join(dir2, 'cache.json'),
      remoteUrl: 'https://example.com/featured.json',
      fetchImpl: async () => remoteResponse(olderRemote),
      logger: { warn: vi.fn() },
    });
    expect(await newer.refresh()).toBe(true);
    const result = await newer.get();
    expect(result).toMatchObject({ updated: '2026-03-01', source: 'builtin' });
  });

  it('logs a failed refresh and does not retry within 10 minutes', async () => {
    const dir = await tempDir();
    const logger = { warn: vi.fn() };
    const fetchImpl = vi.fn(async () => { throw new Error('down'); });
    let time = 100_000_000_000;
    const source = createFeaturedSource({
      builtinPath: await writeBuiltin(dir, builtinList()),
      cachePath: join(dir, 'cache.json'),
      remoteUrl: 'https://example.com/featured.json',
      fetchImpl,
      now: () => time,
      logger,
    });
    expect(await source.refresh()).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
    const calls = fetchImpl.mock.calls.length;
    const result = await source.get();
    expect(result.source).toBe('builtin');
    expect(fetchImpl.mock.calls.length).toBe(calls);
    time += 11 * 60 * 1000;
    await source.get();
    expect(fetchImpl.mock.calls.length).toBe(calls + 1);
  });

  it('never fetches when remoteUrl is null', async () => {
    const dir = await tempDir();
    const fetchImpl = vi.fn(async () => remoteResponse(builtinList()));
    const source = createFeaturedSource({
      builtinPath: await writeBuiltin(dir, builtinList()),
      cachePath: join(dir, 'cache.json'),
      remoteUrl: null,
      fetchImpl,
      logger: { warn: vi.fn() },
    });
    expect(await source.refresh()).toBe(false);
    expect((await source.get()).source).toBe('builtin');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ignores a malformed cache file', async () => {
    const dir = await tempDir();
    const cachePath = join(dir, 'cache.json');
    await writeFile(cachePath, '{broken');
    const source = createFeaturedSource({
      builtinPath: await writeBuiltin(dir, builtinList()),
      cachePath,
      remoteUrl: null,
      logger: { warn: vi.fn() },
    });
    const result = await source.get();
    expect(result).toMatchObject({ updated: '2026-01-01', source: 'builtin' });
  });

  it('shares one fetch across concurrent refresh calls', async () => {
    const dir = await tempDir();
    const remote = builtinList({ updated: '2026-02-01' });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fetchImpl = vi.fn(() => gate.then(() => remoteResponse(remote)));
    const source = createFeaturedSource({
      builtinPath: await writeBuiltin(dir, builtinList()),
      cachePath: join(dir, 'cache.json'),
      remoteUrl: 'https://example.com/featured.json',
      fetchImpl,
      logger: { warn: vi.fn() },
    });
    const first = source.refresh();
    const second = source.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
