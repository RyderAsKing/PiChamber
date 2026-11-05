import { describe, expect, test } from 'bun:test';

import { resolveViewportBottomStrip, type StandaloneViewportSample } from './standaloneViewportInsets';

// iPhone 16 Pro, portrait. Values from WebKit bug 313800 and the #203 screenshots.
const iphone16Pro: StandaloneViewportSample = {
  innerWidth: 402,
  innerHeight: 874,
  screenWidth: 402,
  screenHeight: 874,
  safeAreaTop: 62,
};

describe('resolveViewportBottomStrip', () => {
  test('a full-height standalone web view has no strip', () => {
    expect(resolveViewportBottomStrip(iphone16Pro)).toBe(0);
  });

  test('a web view short by exactly the top inset reports that strip', () => {
    expect(resolveViewportBottomStrip({ ...iphone16Pro, innerHeight: 812 })).toBe(62);
    // iPhone 16 Pro Max on the iOS 27 beta (bug 313800 comment 3).
    expect(resolveViewportBottomStrip({
      innerWidth: 440, innerHeight: 894, screenWidth: 440, screenHeight: 956, safeAreaTop: 62,
    })).toBe(62);
  });

  test('no top inset means the web view is not under the status bar', () => {
    // iOS 26.1 letterboxing (bug 301994): the missing height is above the page.
    expect(resolveViewportBottomStrip({ ...iphone16Pro, innerHeight: 812, safeAreaTop: 0 })).toBe(0);
  });

  test('other shortfalls are inconclusive so the last value is kept', () => {
    // Keyboard-sized resize.
    expect(resolveViewportBottomStrip({ ...iphone16Pro, innerHeight: 520 })).toBeNull();
  });

  test('landscape compares against the swapped screen size', () => {
    expect(resolveViewportBottomStrip({
      innerWidth: 874, innerHeight: 402, screenWidth: 402, screenHeight: 874, safeAreaTop: 0,
    })).toBe(0);
    expect(resolveViewportBottomStrip({
      innerWidth: 874, innerHeight: 382, screenWidth: 402, screenHeight: 874, safeAreaTop: 20,
    })).toBe(20);
  });

  test('windowed or split-view apps are left alone', () => {
    expect(resolveViewportBottomStrip({
      innerWidth: 694, innerHeight: 1000, screenWidth: 1032, screenHeight: 1376, safeAreaTop: 24,
    })).toBe(0);
  });

  test('invalid measurements are inconclusive', () => {
    expect(resolveViewportBottomStrip({ ...iphone16Pro, innerHeight: 0 })).toBeNull();
    expect(resolveViewportBottomStrip({ ...iphone16Pro, safeAreaTop: Number.NaN })).toBeNull();
  });
});
