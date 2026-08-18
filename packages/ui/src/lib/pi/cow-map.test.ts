import { describe, expect, test } from 'bun:test';

import { COW_MAP_MAX_DEPTH, CowMap } from './cow-map';

describe('CowMap', () => {
  test('forked snapshots keep historical values and isolate writes', () => {
    const root = CowMap.empty<string>();
    root.set('a', 'one');
    root.set('b', 'two');
    const next = root.fork();
    next.set('a', 'one-new');

    expect(root.get('a')).toBe('one');
    expect(root.get('b')).toBe('two');
    expect(next.get('a')).toBe('one-new');
    expect(next.get('b')).toBe('two');
    expect(next.has('b')).toBe(true);
  });

  test('fork does not copy historical entries', () => {
    const root = CowMap.empty<object>();
    const historical = { n: 1 };
    root.set('old', historical);
    const next = root.fork();
    next.set('live', { n: 2 });
    expect(next.get('old')).toBe(historical);
    expect(next.size).toBe(2);
    expect(root.size).toBe(1);
  });

  test('flattens after the depth cap so lookups stay bounded', () => {
    let map = CowMap.empty<number>();
    map.set('keep', 1);
    for (let index = 0; index <= COW_MAP_MAX_DEPTH + 2; index += 1) {
      map = map.fork();
      map.set('live', index);
    }
    expect(map.depth <= COW_MAP_MAX_DEPTH).toBe(true);
    expect(map.get('keep')).toBe(1);
    expect(map.get('live')).toBe(COW_MAP_MAX_DEPTH + 2);
  });
});
