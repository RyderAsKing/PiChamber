import { describe, expect, test } from 'bun:test';

import {
  ASCII_RAMP,
  asciiFor,
  bayerThreshold,
  isWallpaper,
  sampleWallpaper,
  wallpaperDensity,
} from './wallpaper';

describe('wallpaper', () => {
  test('accepts only the three styles', () => {
    expect(['none', 'dither', 'ascii'].every(isWallpaper)).toBe(true);
    expect(isWallpaper('stars')).toBe(false);
    expect(isWallpaper(undefined)).toBe(false);
  });

  test('the Bayer thresholds cover (0, 1) once each per 8x8 tile', () => {
    const values = new Set<number>();
    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) values.add(bayerThreshold(col, row));
    }
    expect(values.size).toBe(64);
    expect(Math.min(...values)).toBeGreaterThan(0);
    expect(Math.max(...values)).toBeLessThan(1);
    expect(bayerThreshold(9, 17)).toBe(bayerThreshold(1, 1));
  });

  test('is empty in the middle, where the title and composer sit', () => {
    expect(wallpaperDensity(0, 0, 1200, 800)).toBe(0);
    expect(wallpaperDensity(100, -60, 1200, 800)).toBe(0);
  });

  test('stays in range and draws something toward the edges', () => {
    const grid = sampleWallpaper(1200, 800, 8, 8);
    expect(grid.cols).toBe(150);
    expect(grid.rows).toBe(100);
    let lit = 0;
    for (const value of grid.values) {
      expect(value >= 0 && value <= 1).toBe(true);
      if (value > 0.2) lit += 1;
    }
    expect(lit).toBeGreaterThan(grid.values.length * 0.05);
  });

  test('draws the same picture every time', () => {
    expect(sampleWallpaper(300, 200, 7, 13).values).toEqual(sampleWallpaper(300, 200, 7, 13).values);
  });

  test('maps density onto the character ramp', () => {
    expect(asciiFor(0)).toBe(' ');
    expect(asciiFor(1)).toBe(ASCII_RAMP[ASCII_RAMP.length - 1]);
  });
});
