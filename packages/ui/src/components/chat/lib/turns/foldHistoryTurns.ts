export const HISTORY_FOLD_KEEP_RECENT = 2;
export const HISTORY_FOLD_REVEAL_BATCH = 2;
export const HISTORY_GATE_ESTIMATED_SIZE = 72;

const visibleRecentTurnCount = (
  revealedOlderCount: number,
  keepRecent = HISTORY_FOLD_KEEP_RECENT,
): number => keepRecent + Math.max(0, revealedOlderCount);

export const shouldFoldHistoryTurn = (
  turnOrdinal: number,
  historyTurnCount: number,
  revealedOlderCount: number,
  keepRecent = HISTORY_FOLD_KEEP_RECENT,
): boolean => {
  const visibleFromEnd = visibleRecentTurnCount(revealedOlderCount, keepRecent);
  if (historyTurnCount <= visibleFromEnd) return false;
  return turnOrdinal < historyTurnCount - visibleFromEnd;
};

export const revealedCountForTurn = (
  turnOrdinal: number,
  historyTurnCount: number,
  keepRecent = HISTORY_FOLD_KEEP_RECENT,
): number => Math.max(0, historyTurnCount - keepRecent - turnOrdinal);

export const nextRevealedOlderCount = (
  revealedOlderCount: number,
  foldedCount: number,
  batch = HISTORY_FOLD_REVEAL_BATCH,
): number => revealedOlderCount + Math.max(0, Math.min(batch, foldedCount));
