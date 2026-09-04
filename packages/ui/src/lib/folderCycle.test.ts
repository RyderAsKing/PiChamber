import { describe, expect, test } from 'bun:test';

import { getNextCycleId } from './folderCycle';

describe('getNextCycleId', () => {
  test('returns null when there is nothing to cycle', () => {
    expect(getNextCycleId([], 'a')).toBeNull();
    expect(getNextCycleId(['a'], 'a')).toBeNull();
    expect(getNextCycleId(['a'], null)).toBeNull();
  });

  test('advances to the next id and wraps around', () => {
    expect(getNextCycleId(['a', 'b', 'c'], 'a')).toBe('b');
    expect(getNextCycleId(['a', 'b', 'c'], 'b')).toBe('c');
    expect(getNextCycleId(['a', 'b', 'c'], 'c')).toBe('a');
  });

  test('starts from the first entry when current is missing', () => {
    expect(getNextCycleId(['a', 'b'], null)).toBe('a');
    expect(getNextCycleId(['a', 'b'], 'unknown')).toBe('a');
  });
});
