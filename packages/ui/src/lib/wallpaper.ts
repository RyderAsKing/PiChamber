/**
 * The new-session screen's wallpaper: none, an ordered dither, or ASCII
 * characters, both drawn from the same static field in the theme's ink.
 *
 * Persisted server-side as the `draftWallpaper` UI setting so every client of
 * a server shows the same screen.
 */
const WALLPAPERS = ['none', 'dither', 'ascii'] as const;

export type Wallpaper = (typeof WALLPAPERS)[number];

export const DEFAULT_WALLPAPER: Wallpaper = 'none';

export const isWallpaper = (value: unknown): value is Wallpaper =>
  typeof value === 'string' && (WALLPAPERS as readonly string[]).includes(value);

/** Size of one dither dot and one ASCII character cell, in CSS pixels. */
export const DITHER_CELL_PX = 3;
export const ASCII_CELL = { width: 7, height: 13 } as const;

/** Light to dense; a space is an empty cell. */
export const ASCII_RAMP = ' .:-=+*#%@';

const BAYER_8 = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
].map((rank) => (rank + 0.5) / 64);

/** Ordered-dither threshold for a cell, in (0, 1). */
export const bayerThreshold = (col: number, row: number): number => BAYER_8[(row & 7) * 8 + (col & 7)];

const hash = (x: number, y: number): number => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};

const smooth = (t: number): number => t * t * (3 - 2 * t);

const valueNoise = (x: number, y: number): number => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = smooth(x - xi);
  const v = smooth(y - yi);
  const top = hash(xi, yi) + (hash(xi + 1, yi) - hash(xi, yi)) * u;
  const bottom = hash(xi, yi + 1) + (hash(xi + 1, yi + 1) - hash(xi, yi + 1)) * u;
  return top + (bottom - top) * v;
};

/**
 * Density in [0, 1] at a point in CSS pixels from the centre of the screen:
 * soft drifting bands, emptied around the middle where the title and
 * composer sit, so the wallpaper fades toward them. Deterministic, so the
 * same window always shows the same picture.
 */
export function wallpaperDensity(x: number, y: number, width: number, height: number): number {
  const sx = x / 260;
  const sy = y / 260;
  let noise = 0;
  let amplitude = 0.5;
  let frequency = 1;
  for (let octave = 0; octave < 4; octave += 1) {
    noise += amplitude * valueNoise(sx * frequency + octave * 17.3, sy * frequency - octave * 9.1);
    amplitude *= 0.5;
    frequency *= 2;
  }
  // Bands that run on a diagonal give the noise a direction.
  const bands = 0.5 + 0.5 * Math.sin((x * 0.6 + y) / 140 + noise * 5);
  const field = noise * 0.55 + bands * 0.45;

  // 0 at the centre, 1 at the corners of an ellipse that fits the screen.
  const rx = x / Math.max(1, width * 0.5);
  const ry = y / Math.max(1, height * 0.5);
  const edge = Math.min(1, Math.sqrt(rx * rx + ry * ry));
  const reveal = smooth(Math.min(1, Math.max(0, (edge - 0.45) / 0.55)));

  return Math.min(1, Math.max(0, (field - 0.35) * 1.5)) * reveal;
}

export type WallpaperGrid = {
  cols: number;
  rows: number;
  /** One value per cell, row-major. */
  values: Float32Array;
};

/** Samples the density at each cell centre of a `width` x `height` screen. */
export function sampleWallpaper(width: number, height: number, cellWidth: number, cellHeight: number): WallpaperGrid {
  const cols = Math.max(0, Math.ceil(width / cellWidth));
  const rows = Math.max(0, Math.ceil(height / cellHeight));
  const values = new Float32Array(cols * rows);
  const cx = width / 2;
  const cy = height / 2;
  for (let row = 0; row < rows; row += 1) {
    const y = row * cellHeight + cellHeight / 2 - cy;
    for (let col = 0; col < cols; col += 1) {
      values[row * cols + col] = wallpaperDensity(col * cellWidth + cellWidth / 2 - cx, y, width, height);
    }
  }
  return { cols, rows, values };
}

/** The ASCII character for a density. */
export const asciiFor = (density: number): string =>
  ASCII_RAMP[Math.min(ASCII_RAMP.length - 1, Math.floor(density * ASCII_RAMP.length))];
