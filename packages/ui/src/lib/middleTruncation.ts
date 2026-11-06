// Tail kept whole after the ellipsis; a short last path segment ("feature/x")
// is kept entirely so the distinctive part of a branch name stays readable.
const DEFAULT_TAIL_LENGTH = 10;
const MAX_SEGMENT_TAIL_LENGTH = 16;
const MIN_WORD_TAIL_LENGTH = 4;
const WORD_SEPARATOR = /[-_./]/;

/**
 * Splits `value` into a head that may be cut and a tail that is always shown,
 * or returns null when the value is too short to be worth splitting.
 */
export function splitMiddleTruncation(value: string): { head: string; tail: string } | null {
  // Work on code points so a cut never lands inside a surrogate pair.
  const chars = Array.from(value);
  let tailLength = DEFAULT_TAIL_LENGTH;
  const lastSlash = chars.lastIndexOf('/');
  if (lastSlash > 0 && lastSlash < chars.length - 1) {
    const segmentLength = chars.length - lastSlash - 1;
    if (segmentLength >= MIN_WORD_TAIL_LENGTH && segmentLength <= MAX_SEGMENT_TAIL_LENGTH) tailLength = segmentLength;
  }
  if (chars.length <= tailLength + 4) return null;

  let cut = chars.length - tailLength;
  const startsWord = (index: number) => WORD_SEPARATOR.test(chars[index - 1] ?? '');
  if (!startsWord(cut)) {
    // Prefer a shorter tail that starts on a word ("machine", not "er-machine"),
    // then a longer one; keep the fixed cut when no separator is close.
    let snapped = -1;
    for (let index = cut + 1; index <= chars.length - MIN_WORD_TAIL_LENGTH; index += 1) {
      if (startsWord(index)) {
        snapped = index;
        break;
      }
    }
    for (let index = cut - 1; snapped < 0 && index >= chars.length - MAX_SEGMENT_TAIL_LENGTH && index > 4; index -= 1) {
      if (startsWord(index)) snapped = index;
    }
    if (snapped > 0) cut = snapped;
  }
  return { head: chars.slice(0, cut).join(''), tail: chars.slice(cut).join('') };
}
