import { describe, expect, test } from 'bun:test';

import { classifyIconTone } from './projectIconTone';

const pixels = (...groups: Array<[count: number, rgba: [number, number, number, number]]>) =>
  groups.flatMap(([count, rgba]) => Array.from({ length: count }, () => rgba).flat());

describe('classifyIconTone', () => {
  test('a dark glyph on a transparent background is dark', () => {
    expect(classifyIconTone(pixels([60, [20, 20, 26, 255]], [196, [0, 0, 0, 0]]))).toBe('dark');
  });

  test('a white glyph on a transparent background is light', () => {
    expect(classifyIconTone(pixels([60, [250, 250, 250, 255]], [196, [0, 0, 0, 0]]))).toBe('light');
  });

  test('a colored tile with a white glyph is mixed', () => {
    expect(classifyIconTone(pixels([180, [229, 72, 77, 255]], [76, [255, 255, 255, 255]]))).toBe('mixed');
  });

  test('a black tile with a white glyph is mixed', () => {
    expect(classifyIconTone(pixels([200, [0, 0, 0, 255]], [56, [255, 255, 255, 255]]))).toBe('mixed');
  });

  test('a fully transparent image is mixed', () => {
    expect(classifyIconTone(pixels([256, [0, 0, 0, 0]]))).toBe('mixed');
  });
});
