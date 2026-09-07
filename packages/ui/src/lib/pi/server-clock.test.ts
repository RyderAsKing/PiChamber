import { describe, expect, test } from 'bun:test';

import { toClientTimestamp } from './server-clock';

describe('toClientTimestamp', () => {
  test('normalizes server time for a client clock offset', () => {
    expect(toClientTimestamp(90_000, 100_000, 105_000)).toBe(95_000);
  });

  test('preserves timestamps from runtimes without a server clock sample', () => {
    expect(toClientTimestamp(90_000, undefined, 105_000)).toBe(90_000);
  });

  test('rejects non-finite timestamps', () => {
    expect(toClientTimestamp(Number.NaN, 100_000, 105_000)).toBe(undefined);
  });
});
