import { describe, expect, test } from 'bun:test';

import { HISTORY_FOLD_KEEP_RECENT, shouldFoldHistoryTurn } from './foldHistoryTurns';

describe('shouldFoldHistoryTurn', () => {
  test('keeps the most recent two turns expanded in a long history', () => {
    const expanded = new Set<string>();
    expect(shouldFoldHistoryTurn(0, 10, 't0', expanded)).toBe(true);
    expect(shouldFoldHistoryTurn(7, 10, 't7', expanded)).toBe(true);
    expect(shouldFoldHistoryTurn(10 - HISTORY_FOLD_KEEP_RECENT, 10, 't8', expanded)).toBe(false);
    expect(shouldFoldHistoryTurn(9, 10, 't9', expanded)).toBe(false);
  });

  test('does not fold when the user has expanded that turn', () => {
    expect(shouldFoldHistoryTurn(0, 10, 't0', new Set(['t0']))).toBe(false);
  });

  test('does not fold short histories', () => {
    expect(shouldFoldHistoryTurn(0, HISTORY_FOLD_KEEP_RECENT, 't0', new Set())).toBe(false);
    expect(shouldFoldHistoryTurn(1, HISTORY_FOLD_KEEP_RECENT, 't1', new Set())).toBe(false);
  });
});
