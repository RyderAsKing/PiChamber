import { describe, expect, test } from 'bun:test';

import {
  ASCII_RAMP,
  asciiFor,
  bayerThreshold,
  createWallpaperField,
  fillWallpaper,
  fillPictureWallpaper,
  fillWallpaperHeight,
  followsPictureShape,
  isWallpaper,
  isWallpaperImageVersion,
  pictureDensity,
  wallpaperFade,
  wallpaperCanMove,
  sampleWallpaper,
  wallpaperDensity,
} from './wallpaper';

describe('wallpaper', () => {
  test('accepts only the known wallpapers, picture styles and versions', () => {
    expect(['none', 'dither', 'ascii', 'halftone', 'strands', 'grain'].every(isWallpaper)).toBe(true);
    // The picture is a layer under any pattern now, not a wallpaper of its own.
    expect(isWallpaper('image')).toBe(false);
    expect(isWallpaper('stars')).toBe(false);
    // Contours was tried and removed; a saved value falls back to the default.
    expect(isWallpaper('contours')).toBe(false);
    expect(isWallpaper(undefined)).toBe(false);
    expect(isWallpaperImageVersion('0123456789abcdef')).toBe(true);
    expect(isWallpaperImageVersion('0123456789ABCDEF')).toBe(false);
    expect(isWallpaperImageVersion('../etc/passwd')).toBe(false);
    expect(isWallpaperImageVersion(null)).toBe(false);
  });

  test('only patterns move; grain holds still', () => {
    expect(['dither', 'ascii', 'halftone', 'strands'].every((w) => wallpaperCanMove(w as never))).toBe(true);
    expect(wallpaperCanMove('none')).toBe(false);
    expect(wallpaperCanMove('grain')).toBe(false);
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

  test('drifts over time but keeps the middle empty', () => {
    const still = sampleWallpaper(1200, 800, 8, 8, 0);
    const later = sampleWallpaper(1200, 800, 8, 8, 5);
    expect(later.values).not.toEqual(still.values);
    const middle = 50 * 150 + 75;
    expect(later.values[middle]).toBe(0);
    // A full cycle comes back to the start.
    const cycled = sampleWallpaper(1200, 800, 8, 8, 60);
    let drift = 0;
    for (let i = 0; i < still.values.length; i += 1) drift = Math.max(drift, Math.abs(cycled.values[i] - still.values[i]));
    expect(drift < 0.01).toBe(true);
  });

  test('a field lists only cells that can show ink', () => {
    const field = createWallpaperField(1200, 800, 8, 8);
    expect(field.cells.length).toBeGreaterThan(0);
    expect(field.cells.length).toBeLessThan(field.cols * field.rows);
    const out = new Float32Array(field.cells.length);
    fillWallpaper(field, 0, out);
    for (let i = 0; i < out.length; i += 1) {
      expect(Math.abs(out[i] - wallpaperDensity(
        (field.cells[i] % field.cols) * 8 + 4 - 600,
        Math.floor(field.cells[i] / field.cols) * 8 + 4 - 400,
        1200,
        800,
      )) < 0.01).toBe(true);
    }
  });

  test('the field height keeps varying where the clamped density is solid', () => {
    // Halftone sizes its dots by height, so it needs a spread, not a plateau.
    const field = createWallpaperField(1600, 1000, 8, 8);
    const heights = new Float32Array(field.cells.length);
    fillWallpaperHeight(field, 0, heights);
    expect(Math.max(...heights) - Math.min(...heights) > 0.4).toBe(true);
  });

  test('a faded field empties the bottom and keeps the top', () => {
    expect(wallpaperFade(0, 1000)).toBe(1);
    expect(wallpaperFade(450, 1000)).toBe(1);
    expect(Math.abs(wallpaperFade(615, 1000) - 0.5) < 1e-9).toBe(true);
    expect(wallpaperFade(780, 1000)).toBe(0);
    const plain = createWallpaperField(1600, 1000, 8, 8);
    const faded = createWallpaperField(1600, 1000, 8, 8, true);
    const lastRow = (field: typeof plain) => Math.floor(field.cells[field.cells.length - 1] / field.cols);
    expect(lastRow(plain)).toBe(plain.rows - 1);
    expect(lastRow(faded) * 8 < 780).toBe(true);
    // Above the fade the two agree.
    expect(faded.reveal[0]).toBe(plain.reveal[0]);
  });

  test('dither, ASCII and halftone follow a picture, drifting through it', () => {
    expect(['dither', 'ascii', 'halftone'].every((w) => followsPictureShape(w as never))).toBe(true);
    expect(followsPictureShape('strands')).toBe(false);
    expect(followsPictureShape('grain')).toBe(false);
    const field = createWallpaperField(1200, 800, 8, 8);
    const dark = new Float32Array(field.cells.length).fill(0);
    const bright = new Float32Array(field.cells.length).fill(1);
    const out = new Float32Array(field.cells.length);
    // The picture's tone sets the level; the bands only push it by a little.
    fillPictureWallpaper(field, dark, 0, out);
    expect(Math.max(...out) <= 0.2 + 1e-6).toBe(true);
    fillPictureWallpaper(field, bright, 0, out);
    let corner = 0;
    for (let i = 0; i < out.length; i += 1) if (field.reveal[i] === 1) corner = Math.max(corner, out[i]);
    expect(corner).toBe(1);
    const later = new Float32Array(field.cells.length);
    const mid = new Float32Array(field.cells.length).fill(0.5);
    fillPictureWallpaper(field, mid, 0, out);
    fillPictureWallpaper(field, mid, 5, later);
    expect(later).not.toEqual(out);
  });

  test('draws a picture the right way round for the ink', () => {
    // Light ink (dark themes) lights bright pixels; dark ink lights dark ones.
    expect(pictureDensity(255, 255, 255, 255, true)).toBe(1);
    expect(pictureDensity(0, 0, 0, 255, true)).toBe(0);
    expect(pictureDensity(0, 0, 0, 255, false)).toBe(1);
    expect(pictureDensity(255, 255, 255, 255, false)).toBe(0);
    expect(pictureDensity(255, 255, 255, 0, true)).toBe(0);
  });

  test('maps density onto the character ramp', () => {
    expect(asciiFor(0)).toBe(' ');
    expect(asciiFor(1)).toBe(ASCII_RAMP[ASCII_RAMP.length - 1]);
  });
});
