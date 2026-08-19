import { describe, expect, test } from 'bun:test';

import {
  HISTORY_FOLD_KEEP_RECENT,
  HISTORY_FOLD_REVEAL_BATCH,
  nextRevealedOlderCount,
  revealedCountForTurn,
  shouldFoldHistoryTurn,
} from './foldHistoryTurns';

describe('shouldFoldHistoryTurn', () => {
  test('keeps the most recent two turns expanded in a long history', () => {
    expect(shouldFoldHistoryTurn(0, 10, 0)).toBe(true);
    expect(shouldFoldHistoryTurn(7, 10, 0)).toBe(true);
    expect(shouldFoldHistoryTurn(10 - HISTORY_FOLD_KEEP_RECENT, 10, 0)).toBe(false);
    expect(shouldFoldHistoryTurn(9, 10, 0)).toBe(false);
  });

  test('reveals the two turns immediately above the visible window', () => {
    expect(shouldFoldHistoryTurn(5, 10, HISTORY_FOLD_REVEAL_BATCH)).toBe(true);
    expect(shouldFoldHistoryTurn(6, 10, HISTORY_FOLD_REVEAL_BATCH)).toBe(false);
    expect(shouldFoldHistoryTurn(7, 10, HISTORY_FOLD_REVEAL_BATCH)).toBe(false);
  });

  test('does not fold short histories', () => {
    expect(shouldFoldHistoryTurn(0, HISTORY_FOLD_KEEP_RECENT, 0)).toBe(false);
    expect(shouldFoldHistoryTurn(1, HISTORY_FOLD_KEEP_RECENT, 0)).toBe(false);
  });
});

describe('revealedCountForTurn', () => {
  test('reveals enough older turns to include a folded turn', () => {
    expect(revealedCountForTurn(7, 10)).toBe(1);
    expect(revealedCountForTurn(0, 10)).toBe(8);
  });
});

describe('nextRevealedOlderCount', () => {
  test('loads a batch without passing the remaining folded turns', () => {
    expect(nextRevealedOlderCount(0, 8)).toBe(HISTORY_FOLD_REVEAL_BATCH);
    expect(nextRevealedOlderCount(6, 1)).toBe(7);
  });
});
