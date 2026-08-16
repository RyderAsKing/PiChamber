/**
 * Assemble assistant/thinking stream chunks.
 *
 * Providers and replay paths do not always send pure incremental suffixes.
 * Some chunks are cumulative snapshots; others overlap the tail of the text
 * already assembled. Blind concatenation produces the stuttering
 * "LetLet me look me look" markdown the chat then cannot parse.
 *
 * Overlap search is bounded so a long assembled message cannot turn each
 * token into an O(n^2) scan.
 */
const OVERLAP_BOUND = 256;

export const applyAssistantTextDelta = (current: string, delta: string): string => {
  if (!delta) return current;
  if (!current) return delta;
  if (delta === current) return current;
  if (delta.startsWith(current)) return delta;
  if (current.startsWith(delta)) return current;

  const maxOverlap = Math.min(OVERLAP_BOUND, current.length, delta.length);
  for (let length = maxOverlap; length > 0; length -= 1) {
    if (current.endsWith(delta.slice(0, length))) {
      return current + delta.slice(length);
    }
  }
  return current + delta;
};
