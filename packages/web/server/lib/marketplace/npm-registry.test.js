import { describe, expect, it, vi } from 'vitest';

import {
  createNpmRegistry,
  isValidNpmName,
  safeLink,
  summarizeManifest,
  summarizePackage,
} from './npm-registry.js';

const jsonResponse = (body, { status = 200, contentLength } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: {
    get: (name) => (String(name).toLowerCase() === 'content-length' && contentLength !== undefined
      ? String(contentLength)
      : null),
  },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const errorResponse = (status) => ({
  status,
  ok: false,
  headers: { get: () => null },
  text: async () => '{}',
});

const streamResponse = (chunks) => ({
  status: 200,
  ok: true,
  headers: { get: () => null },
  body: {
    getReader: () => {
      let index = 0;
      return {
        read: async () => (index < chunks.length
          ? { done: false, value: chunks[index++] }
          : { done: true, value: undefined }),
        cancel: async () => {},
      };
    },
  },
});

describe('isValidNpmName', () => {
  it('accepts plain and scoped names', () => {
    expect(isValidNpmName('pi-lens')).toBe(true);
    expect(isValidNpmName('@scope/x')).toBe(true);
    expect(isValidNpmName('a'.repeat(214))).toBe(true);
  });

  it('rejects names npm would not take for a new package', () => {
    expect(isValidNpmName('Uppercase')).toBe(false);
    expect(isValidNpmName('../x')).toBe(false);
    expect(isValidNpmName('foo@1.0.0')).toBe(false);
    expect(isValidNpmName('npm:foo')).toBe(false);
    expect(isValidNpmName('')).toBe(false);
    expect(isValidNpmName('a'.repeat(215))).toBe(false);
    expect(isValidNpmName(undefined)).toBe(false);
  });
});

describe('safeLink', () => {
  it('normalizes git urls and strips .git for github', () => {
    const link = safeLink('git+https://github.com/user/repo.git');
    expect(link).toContain('https://github.com/user/repo');
    expect(link).not.toContain('.git');
  });

  it('expands the github: shorthand', () => {
    expect(safeLink('github:user/repo')).toContain('https://github.com/user/repo');
  });

  it('strips credentials', () => {
    const link = safeLink('https://user:pass@example.com/x');
    expect(link).toContain('https://example.com/x');
    expect(link).not.toContain('user');
    expect(link).not.toContain('pass');
  });

  it('rejects dangerous and non-http schemes', () => {
    expect(safeLink('javascript:alert(1)')).toBeUndefined();
    expect(safeLink('file:///etc/passwd')).toBeUndefined();
    expect(safeLink('not a url')).toBeUndefined();
    expect(safeLink('')).toBeUndefined();
    expect(safeLink(undefined)).toBeUndefined();
  });
});

describe('summarizePackage', () => {
  const valid = {
    name: 'pi-lens',
    version: '1.2.3',
    description: 'A lens for pi.',
    keywords: ['pi-package', 'pichamber-plugin'],
    maintainers: [{ username: 'alice' }],
    publisher: { username: 'GitHub Actions' },
  };

  it('summarizes a well-formed entry', () => {
    const summary = summarizePackage(valid, { weeklyDownloads: 42 });
    expect(summary).toMatchObject({
      name: 'pi-lens',
      version: '1.2.3',
      publisher: 'alice',
      weeklyDownloads: 42,
      pichamberKeyword: true,
    });
    expect(summary.links.npm).toContain('pi-lens');
  });

  it('drops entries without a usable name', () => {
    expect(summarizePackage({ ...valid, name: 'Bad Name' })).toBeUndefined();
    expect(summarizePackage({ ...valid, name: '' })).toBeUndefined();
    expect(summarizePackage(null)).toBeUndefined();
  });

  it('strips control characters and caps the description', () => {
    const summary = summarizePackage({ ...valid, description: 'a\x00\x01b' });
    expect(summary.description).toBe('a b');
    const long = summarizePackage({ ...valid, description: 'x'.repeat(500) });
    expect(long.description.length).toBeLessThanOrEqual(300);
    expect(long.description).toContain('…');
  });

  it('prefers maintainers[0] over a publisher named GitHub Actions', () => {
    expect(summarizePackage(valid).publisher).toBe('alice');
    expect(summarizePackage({ ...valid, maintainers: undefined }).publisher).toBeUndefined();
  });

  it('reads pichamberKeyword from keywords and floors downloads', () => {
    expect(summarizePackage({ ...valid, keywords: ['pi-package'] }).pichamberKeyword).toBe(false);
    expect(summarizePackage(valid, { weeklyDownloads: 42.9 }).weeklyDownloads).toBe(42);
    expect(summarizePackage(valid).weeklyDownloads).toBeUndefined();
  });
});

describe('summarizeManifest', () => {
  it('reads contains from the pi block', () => {
    const summary = summarizeManifest({
      name: 'pi-lens',
      version: '1.0.0',
      keywords: ['pi-package'],
      license: 'MIT',
      pi: { extensions: ['./extension.js'], skills: [] },
      pichamber: { apiVersion: 1 },
    });
    expect(summary.contains).toEqual(['extensions']);
    expect(summary.pichamber).toBe(true);
    expect(summary.license).toBe('MIT');
    expect(summary.isPiPackage).toBe(true);
  });

  it('requires an object pichamber block with a numeric apiVersion', () => {
    const base = { name: 'pi-lens', keywords: ['pi-package'] };
    expect(summarizeManifest({ ...base, pichamber: { apiVersion: 1 } }).pichamber).toBe(true);
    expect(summarizeManifest({ ...base, pichamber: { apiVersion: '1' } }).pichamber).toBe(false);
    expect(summarizeManifest({ ...base, pichamber: true }).pichamber).toBe(false);
    expect(summarizeManifest(base).pichamber).toBe(false);
  });

  it('drops licenses outside the pattern', () => {
    const summary = summarizeManifest({ name: 'pi-lens', keywords: [], license: 'MIT; rm -rf' });
    expect(summary.license).toBeUndefined();
  });
});

describe('createNpmRegistry', () => {
  it('sends search params with the keyword qualifier, size, and from', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ total: 0, objects: [] }));
    const registry = createNpmRegistry({ fetchImpl });
    await registry.searchRaw({ text: 'lens', keywords: ['pi-package'], from: 5, size: 20 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/-/v1/search');
    expect(parsed.searchParams.get('text')).toContain('keywords:pi-package');
    expect(parsed.searchParams.get('text')).toContain('lens');
    expect(parsed.searchParams.get('size')).toBe('20');
    expect(parsed.searchParams.get('from')).toBe('5');
    expect(init.headers['user-agent']).toBe('PiChamber');
  });

  it('answers 404 on latest as not found', async () => {
    const registry = createNpmRegistry({ fetchImpl: async () => errorResponse(404) });
    await expect(registry.latest('pi-lens')).rejects.toMatchObject({ code: 'MARKETPLACE_PACKAGE_NOT_FOUND' });
  });

  it('maps network throws and bad statuses to unavailable', async () => {
    const throwing = createNpmRegistry({ fetchImpl: async () => { throw new Error('down'); } });
    await expect(throwing.latest('pi-lens')).rejects.toMatchObject({ code: 'MARKETPLACE_UNAVAILABLE' });
    const fiveHundred = createNpmRegistry({ fetchImpl: async () => errorResponse(500) });
    await expect(fiveHundred.latest('pi-lens')).rejects.toMatchObject({ code: 'MARKETPLACE_UNAVAILABLE' });
  });

  it('maps malformed JSON to unavailable', async () => {
    const registry = createNpmRegistry({ fetchImpl: async () => jsonResponse('{oops') });
    await expect(registry.latest('pi-lens')).rejects.toMatchObject({ code: 'MARKETPLACE_UNAVAILABLE' });
  });

  it('rejects an oversized body by content-length', async () => {
    const registry = createNpmRegistry({
      fetchImpl: async () => jsonResponse({ total: 0, objects: [] }, { contentLength: 5 * 1024 * 1024 }),
    });
    await expect(registry.searchRaw({ text: '', keywords: [] })).rejects.toMatchObject({ code: 'MARKETPLACE_UNAVAILABLE' });
  });

  it('rejects a streamed body over the cap', async () => {
    const registry = createNpmRegistry({
      fetchImpl: async () => streamResponse([new Uint8Array(300 * 1024), new Uint8Array(300 * 1024)]),
    });
    await expect(registry.latest('pi-lens')).rejects.toMatchObject({ code: 'MARKETPLACE_UNAVAILABLE' });
  });

  it('rejects a latest body whose name differs', async () => {
    const registry = createNpmRegistry({ fetchImpl: async () => jsonResponse({ name: 'other' }) });
    await expect(registry.latest('pi-lens')).rejects.toMatchObject({ code: 'MARKETPLACE_UNAVAILABLE' });
  });

  it('URL-encodes the slash of a scoped name', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ name: '@scope/x' }));
    const registry = createNpmRegistry({ fetchImpl });
    await registry.latest('@scope/x');
    expect(String(fetchImpl.mock.calls[0][0])).toContain('@scope%2Fx/latest');
  });
});
