export const HISTORY_FOLD_KEEP_RECENT = 2;
export const FOLDED_TURN_ESTIMATED_SIZE = 56;

export const shouldFoldHistoryTurn = (
  turnOrdinal: number,
  historyTurnCount: number,
  turnId: string,
  expandedTurnIds: ReadonlySet<string>,
  keepRecent = HISTORY_FOLD_KEEP_RECENT,
): boolean => {
  if (expandedTurnIds.has(turnId)) return false;
  if (historyTurnCount <= keepRecent) return false;
  return turnOrdinal < historyTurnCount - keepRecent;
};
