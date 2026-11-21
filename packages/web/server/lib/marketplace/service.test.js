import { describe, expect, it, vi } from 'vitest';

import { MarketplaceError } from './npm-registry.js';
import { createMarketplaceService, normalizeQuery } from './service.js';

const pkg = (name, overrides = {}) => ({
  name,
  version: '1.0.0',
  description: `The ${name} package`,
  keywords: ['pi-package'],
  ...overrides,
});

const hit = (name, overrides = {}, downloads) => ({
  package: pkg(name, overrides),
  ...(downloads === undefined ? {} : { downloads: { weekly: downloads } }),
});

const setup = ({ objects = [], total = 0, featured = { updated: '2026-01-01', featured: [], hidden: [] }, bundled = [] } = {}) => {
  const registry = {
    searchRaw: vi.fn(async () => ({ total, objects })),
    latest: vi.fn(async (name) => ({ name, version: '1.0.0', keywords: ['pi-package'] })),
    weeklyDownloads: vi.fn(async () => undefined),
  };
  const featuredSource = { get: vi.fn(async () => ({ ...featured, source: 'builtin' })) };
  const service = createMarketplaceService({
    registry,
    featuredSource,
    bundledPackageNames: async () => bundled,
  });
  return { registry, featuredSource, service };
};

describe('normalizeQuery', () => {
  it('strips keyword qualifiers and control chars and caps at 100 chars', () => {
    expect(normalizeQuery('keywords:pi-package lens')).toBe('lens');
    expect(normalizeQuery('foo:bar hello')).toBe('hello');
    expect(normalizeQuery('a\x00b')).toBe('a b');
    expect(normalizeQuery('x'.repeat(200)).length).toBe(100);
    expect(normalizeQuery(undefined)).toBe('');
  });
});

describe('search', () => {
  it('drops results without the pi-package keyword', async () => {
    const { service } = setup({ objects: [hit('pi-good'), hit('plain', { keywords: ['other'] })], total: 2 });
    const result = await service.search({ query: '', from: 0 });
    expect(result.packages.map((entry) => entry.name)).toEqual(['pi-good']);
  });

  it('drops hidden and bundled names', async () => {
    const { service } = setup({
      objects: [hit('pi-good'), hit('evil-pkg'), hit('bundled-pkg')],
      total: 3,
      featured: { updated: '2026-01-01', featured: [], hidden: ['evil-pkg'] },
      bundled: ['bundled-pkg'],
    });
    const result = await service.search({ query: '', from: 0 });
    expect(result.packages.map((entry) => entry.name)).toEqual(['pi-good']);
  });

  it('filters unrelated padding and clears nextFrom when any appears', async () => {
    const objects = Array.from({ length: 20 }, (_, index) => (
      index === 19
        ? hit('unrelated-zzz', { description: 'zzz qqq www' })
        : hit(`pi-lens-${index}`, { description: 'lens helper' })
    ));
    const { service } = setup({ objects, total: 100 });
    const result = await service.search({ query: 'lens', from: 0 });
    expect(result.packages).toHaveLength(19);
    expect(result.nextFrom).toBeNull();
    expect(result).not.toHaveProperty('total');
  });

  it('reports total only without a query and nextFrom for a full relevant page', async () => {
    const objects = Array.from({ length: 20 }, (_, index) => hit(`pi-pkg-${index}`));
    const { service } = setup({ objects, total: 100 });
    const result = await service.search({ query: '', from: 0 });
    expect(result.total).toBe(100);
    expect(result.nextFrom).toBe(20);
  });

  it('asks npm for pichamber only and requires both keywords', async () => {
    const { registry, service } = setup({
      objects: [
        hit('pi-both', { keywords: ['pi-package', 'pichamber'] }),
        hit('pi-narrow', { keywords: ['pichamber'] }),
      ],
      total: 2,
    });
    const result = await service.search({ query: '', from: 0, pichamberOnly: true });
    expect(registry.searchRaw).toHaveBeenCalledWith(
      expect.objectContaining({ keywords: ['pichamber'] }),
    );
    expect(result.packages.map((entry) => entry.name)).toEqual(['pi-both']);
  });

  it('caches results but never caches a failure', async () => {
    const { registry, service } = setup({ objects: [hit('pi-good')], total: 1 });
    await service.search({ query: '', from: 0 });
    await service.search({ query: '', from: 0 });
    expect(registry.searchRaw).toHaveBeenCalledTimes(1);

    registry.searchRaw.mockRejectedValueOnce(new MarketplaceError('MARKETPLACE_UNAVAILABLE'));
    await expect(service.search({ query: 'retry', from: 0 })).rejects.toMatchObject({ code: 'MARKETPLACE_UNAVAILABLE' });
    const calls = registry.searchRaw.mock.calls.length;
    await service.search({ query: 'retry', from: 0 });
    expect(registry.searchRaw.mock.calls.length).toBe(calls + 1);
  });
});

describe('featured', () => {
  it('keeps listed order and marks failures unavailable with their note', async () => {
    const registry = {
      searchRaw: vi.fn(),
      latest: vi.fn(async (name) => {
        if (name === 'missing-pkg') throw new MarketplaceError('MARKETPLACE_PACKAGE_NOT_FOUND');
        return { name, version: '2.0.0', keywords: ['pi-package'], pi: { extensions: ['./e.js'] } };
      }),
      weeklyDownloads: vi.fn(async () => undefined),
    };
    const featuredSource = {
      get: async () => ({
        updated: '2026-01-01',
        featured: [{ name: 'pi-first', note: 'First' }, { name: 'missing-pkg', note: 'Gone' }],
        hidden: [],
        source: 'builtin',
      }),
    };
    const service = createMarketplaceService({ registry, featuredSource, bundledPackageNames: async () => [] });
    const result = await service.featured();
    expect(result.packages.map((entry) => entry.name)).toEqual(['pi-first', 'missing-pkg']);
    expect(result.packages[0]).toMatchObject({ version: '2.0.0', note: 'First' });
    expect(result.packages[0]).not.toHaveProperty('unavailable');
    expect(result.packages[1]).toMatchObject({ note: 'Gone', unavailable: true });
  });
});

describe('packageDetail', () => {
  it('answers not found for hidden and bundled names', async () => {
    const { service } = setup({
      featured: { updated: '2026-01-01', featured: [], hidden: ['evil-pkg'] },
      bundled: ['bundled-pkg'],
    });
    await expect(service.packageDetail('evil-pkg')).rejects.toMatchObject({ code: 'MARKETPLACE_PACKAGE_NOT_FOUND' });
    await expect(service.packageDetail('bundled-pkg')).rejects.toMatchObject({ code: 'MARKETPLACE_PACKAGE_NOT_FOUND' });
  });
});

describe('versions', () => {
  it('rejects more than 50 names or invalid names', async () => {
    const { service } = setup();
    await expect(service.versions(Array.from({ length: 51 }, (_, index) => `pi-pkg-${index}`)))
      .rejects.toMatchObject({ code: 'INVALID_MARKETPLACE_REQUEST' });
    await expect(service.versions(['Bad Name'])).rejects.toMatchObject({ code: 'INVALID_MARKETPLACE_REQUEST' });
  });

  it('leaves out names npm cannot answer for', async () => {
    const registry = {
      searchRaw: vi.fn(),
      latest: vi.fn(async (name) => {
        if (name === 'pi-gone') throw new MarketplaceError('MARKETPLACE_PACKAGE_NOT_FOUND');
        return { name, version: '3.1.0', keywords: ['pi-package'] };
      }),
      weeklyDownloads: vi.fn(),
    };
    const service = createMarketplaceService({
      registry,
      featuredSource: { get: async () => ({ updated: null, featured: [], hidden: [], source: 'builtin' }) },
      bundledPackageNames: async () => [],
    });
    await expect(service.versions(['pi-ok', 'pi-gone'])).resolves.toEqual({ versions: { 'pi-ok': '3.1.0' } });
  });
});
