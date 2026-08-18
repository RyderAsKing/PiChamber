import { describe, expect, test } from 'bun:test';

import { isMeasurableScrollElement } from './readyScrollElement';

describe('isMeasurableScrollElement', () => {
  test('rejects missing and zero-height nodes', () => {
    expect(isMeasurableScrollElement(null)).toBe(false);
    expect(isMeasurableScrollElement(undefined)).toBe(false);
    expect(isMeasurableScrollElement({ clientHeight: 0 } as HTMLElement)).toBe(false);
  });

  test('accepts a scroller that already has a layout rectangle', () => {
    expect(isMeasurableScrollElement({ clientHeight: 480 } as HTMLElement)).toBe(true);
  });
});
