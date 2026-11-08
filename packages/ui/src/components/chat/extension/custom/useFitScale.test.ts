import { describe, expect, test as it } from 'bun:test';

import { fitScale } from './useFitScale';

describe('fitScale', () => {
  it('leaves a surface that fits at full size', () => {
    expect(fitScale({ width: 300, height: 200 }, { width: 400, height: 600 })).toBe(1);
    expect(fitScale({ width: 300 }, { width: 0 })).toBe(1);
  });

  it('shrinks to the tighter of width and height', () => {
    expect(fitScale({ width: 800 }, { width: 600 })).toBe(0.75);
    expect(fitScale({ width: 400, height: 800 }, { width: 400, height: 600 })).toBe(0.75);
  });

  it('stops at half size', () => {
    expect(fitScale({ width: 2000 }, { width: 400 })).toBe(0.5);
  });
});
