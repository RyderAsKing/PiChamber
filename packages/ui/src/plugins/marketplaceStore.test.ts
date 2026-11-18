import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type {
  PiMarketplaceFeaturedResponse,
  PiMarketplacePackage,
  PiMarketplaceSearchResponse,
} from '@/lib/pi/protocol';

type SearchInput = { query: string; from: number; pichamberOnly: boolean };

let searchImpl: (input: SearchInput) => Promise<PiMarketplaceSearchResponse> = async () => {
  throw new Error('unset');
};
let featuredImpl: () => Promise<PiMarketplaceFeaturedResponse> = async () => {
  throw new Error('unset');
};
let versionsImpl: (names: string[]) => Promise<{ versions: Record<string, string> }> = async () => {
  throw new Error('unset');
};
let runtimeKey = 'runtime-1';

mock.module('@/lib/pi/client', () => ({
  piClient: {
    searchMarketplace: (input: SearchInput) => searchImpl(input),
    getMarketplaceFeatured: () => featuredImpl(),
    getMarketplacePackage: async () => {
      throw new Error('unset');
    },
    getMarketplaceVersions: (names: string[]) => versionsImpl(names),
  },
}));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => runtimeKey }));

const { searchKey, useMarketplaceStore } = await import('./marketplaceStore');

const hit = (name: string, version = '1.0.0'): PiMarketplacePackage => ({
  name,
  version,
  keywords: ['pi-package'],
  pichamberKeyword: false,
  links: { npm: `https://www.npmjs.com/package/${name}` },
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const store = () => useMarketplaceStore.getState();

describe('useMarketplaceStore', () => {
  beforeEach(() => {
    runtimeKey = 'runtime-1';
    store().resetForRuntimeSwitch();
  });

  test('a search key ignores case and spacing, not the filter', () => {
    expect(searchKey('  Web  Access ', false)).toBe(searchKey('web access', false));
    expect(searchKey('web', true)).not.toBe(searchKey('web', false));
  });

  test('more pages append without repeats and keep their versions', async () => {
    const asked: SearchInput[] = [];
    searchImpl = async (input) => {
      asked.push(input);
      return input.from === 0
        ? { packages: [hit('a'), hit('b')], nextFrom: 20 }
        : { packages: [hit('b'), hit('c', '2.0.0')], nextFrom: null };
    };
    await store().search('lens', false);
    await store().search('lens', false, { more: true });
    // No further page: nothing is asked.
    await store().search('lens', false, { more: true });
    const entry = store().searches[searchKey('lens', false)];
    expect(entry?.packages.map((pkg) => pkg.name)).toEqual(['a', 'b', 'c']);
    expect(entry?.nextFrom).toBeNull();
    expect(asked.map((input) => input.from)).toEqual([0, 20]);
    expect(store().latest.c).toBe('2.0.0');
  });

  test('a failed further page keeps the pages before it', async () => {
    searchImpl = async () => ({ packages: [hit('a')], nextFrom: 20 });
    await store().search('lens', false);
    searchImpl = async () => {
      throw new Error('offline');
    };
    await store().search('lens', false, { more: true });
    const entry = store().searches[searchKey('lens', false)];
    expect(entry?.status).toBe('ready');
    expect(entry?.moreFailed).toBe(true);
    expect(entry?.packages.map((pkg) => pkg.name)).toEqual(['a']);
  });

  test('a failed first search is an error, not an empty result', async () => {
    searchImpl = async () => {
      throw new Error('offline');
    };
    await store().search('lens', false);
    expect(store().searches[searchKey('lens', false)]?.status).toBe('error');
  });

  test('a fresh answer is reused and a forced search asks again', async () => {
    let calls = 0;
    featuredImpl = async () => {
      calls += 1;
      return { packages: [hit('a')], source: 'builtin', updated: '2026-11-18' };
    };
    await store().loadFeatured();
    await store().loadFeatured();
    expect(calls).toBe(1);
    await store().loadFeatured({ force: true });
    expect(calls).toBe(2);
  });

  test('versions are asked once per name; a failure lets them be asked again', async () => {
    const asked: string[][] = [];
    versionsImpl = async (names) => {
      asked.push(names);
      throw new Error('offline');
    };
    await store().loadVersions(['a', 'b', 'a']);
    versionsImpl = async (names) => {
      asked.push(names);
      return { versions: { a: '1.1.0' } };
    };
    await store().loadVersions(['a', 'b']);
    await store().loadVersions(['a', 'b']);
    expect(asked).toEqual([['a', 'b'], ['a', 'b']]);
    expect(store().latest).toEqual({ a: '1.1.0' });
  });

  test('a runtime switch drops answers that arrive after it', async () => {
    const answer = deferred<PiMarketplaceSearchResponse>();
    searchImpl = () => answer.promise;
    const search = store().search('lens', false);
    runtimeKey = 'runtime-2';
    store().resetForRuntimeSwitch();
    answer.resolve({ packages: [hit('a')], nextFrom: null });
    await search;
    expect(store().searches).toEqual({});
    expect(store().latest).toEqual({});
  });
});
