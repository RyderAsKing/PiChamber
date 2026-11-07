import type { CSSProperties } from 'react';

// Block elements Pi extensions draw pictures with (pi-doom's half blocks).
// A terminal fills the whole cell for them; a font glyph leaves gaps above
// and below on a line taller than the font, so they are drawn as fills.
const UPPER = '▀';
const LOWER = '▄';
const FULL = '█';
const HAS_BLOCK = /[▀▄█]/;
const BLOCK_RUN = /^([▀▄█])\1*$/;
const RUNS = /([▀▄█])\1*|[^▀▄█]+/g;

export const hasBlocks = (text: string): boolean => HAS_BLOCK.test(text);

/** Whether `text` is one block element repeated. */
export const isBlockRun = (text: string): boolean => BLOCK_RUN.test(text);

/** `text` split into runs of one block element and runs of anything else. */
export const splitBlockRuns = (text: string): Array<{ text: string; block: boolean }> => (
  (text.match(RUNS) ?? []).map((run) => ({ text: run, block: isBlockRun(run) }))
);

/**
 * Style for a run of one block element that fills its cells top to bottom,
 * in the colours of `style` (the segment's SGR style). The characters stay
 * as transparent text so a selection still copies them.
 */
export const blockRunStyle = (text: string, style: CSSProperties | undefined, lineHeight: number): CSSProperties => {
  const { color, backgroundColor, ...rest } = style ?? {};
  const fg = String(color ?? 'var(--foreground)');
  const bg = String(backgroundColor ?? 'transparent');
  const char = text[0];
  return {
    ...rest,
    display: 'inline-block',
    width: `${text.length}ch`,
    height: lineHeight,
    verticalAlign: 'top',
    color: 'transparent',
    backgroundColor: char === FULL ? fg : bg,
    backgroundImage: char === UPPER
      ? `linear-gradient(${fg} 50%, ${bg} 50%)`
      : char === LOWER ? `linear-gradient(${bg} 50%, ${fg} 50%)` : 'none',
  };
};
