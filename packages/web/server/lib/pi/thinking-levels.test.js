import { describe, expect, it } from 'vitest';

import { clampThinkingLevel, getSupportedThinkingLevels, isPiThinkingLevel } from './thinking-levels.js';

describe('Pi thinking levels', () => {
  it('accepts the full Pi vocabulary', () => {
    expect(isPiThinkingLevel('minimal')).toBe(true);
    expect(isPiThinkingLevel('max')).toBe(true);
    expect(isPiThinkingLevel('bad')).toBe(false);
  });

  it('returns off when the model does not reason', () => {
    expect(getSupportedThinkingLevels({ reasoning: false })).toEqual(['off']);
    expect(getSupportedThinkingLevels({})).toEqual(['off']);
  });

  it('includes standard levels when reasoning is on and the map omits them', () => {
    expect(getSupportedThinkingLevels({ reasoning: true })).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
  });

  it('hides null map entries and keeps xhigh/max opt-in', () => {
    expect(getSupportedThinkingLevels({
      reasoning: true,
      thinkingLevelMap: { low: 1, high: null, xhigh: 2 },
    })).toEqual(['off', 'minimal', 'low', 'medium', 'xhigh']);
  });

  it('clamps a missing level up, then down, the ordered list', () => {
    expect(clampThinkingLevel(['off', 'minimal', 'low', 'medium'], 'high')).toBe('medium');
    expect(clampThinkingLevel(['off', 'high', 'xhigh'], 'low')).toBe('high');
    expect(clampThinkingLevel(['off', 'minimal'], 'bogus')).toBe('off');
    expect(clampThinkingLevel(['low', 'medium'], 'low')).toBe('low');
  });
});
