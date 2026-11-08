import { describe, expect, test as it } from 'bun:test';

import { blockRunStyle, hasBlocks, isBlockRun, splitBlockRuns } from './blockGlyphs';

describe('block glyphs', () => {
  it('finds runs of one block element', () => {
    expect(hasBlocks('ab')).toBe(false);
    expect(hasBlocks('a▀')).toBe(true);
    expect(isBlockRun('▀▀')).toBe(true);
    expect(isBlockRun('▀▄')).toBe(false);
    expect(isBlockRun('')).toBe(false);
    expect(splitBlockRuns('hp ██▀ ok')).toEqual([
      { text: 'hp ', block: false },
      { text: '██', block: true },
      { text: '▀', block: true },
      { text: ' ok', block: false },
    ]);
  });

  it('fills the cells with the segment colours', () => {
    const upper = blockRunStyle('▀▀', { color: 'rgb(1, 2, 3)', backgroundColor: 'rgb(4, 5, 6)', opacity: 0.65 }, 18);
    expect(upper).toMatchObject({
      display: 'inline-block',
      width: '2ch',
      height: 18,
      color: 'transparent',
      opacity: 0.65,
      backgroundColor: 'rgb(4, 5, 6)',
      backgroundImage: 'linear-gradient(rgb(1, 2, 3) 50%, rgb(4, 5, 6) 50%)',
    });
    expect(blockRunStyle('▄', { color: 'red' }, 18).backgroundImage).toBe('linear-gradient(transparent 50%, red 50%)');
    expect(blockRunStyle('█', undefined, 18)).toMatchObject({ backgroundColor: 'var(--foreground)', backgroundImage: 'none' });
  });
});
