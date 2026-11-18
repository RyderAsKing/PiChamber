/**
 * The new-session screen's wallpaper: none, or a pattern drawn from one shared
 * field (dither, ASCII, halftone, strands, grain). With the server's uploaded
 * picture turned on, the picture shows faintly behind and the pattern takes
 * its colours (and, for dither, ASCII and halftone, its light and dark);
 * without it, the pattern is drawn in the theme's ink.
 *
 * Persisted server-side as the `draftWallpaper*` UI settings so every client
 * of a server shows the same screen.
 */
const WALLPAPERS = ['none', 'dither', 'ascii', 'halftone', 'strands', 'grain'] as const;

export type Wallpaper = (typeof WALLPAPERS)[number];

export const DEFAULT_WALLPAPER: Wallpaper = 'none';

export const isWallpaper = (value: unknown): value is Wallpaper =>
  typeof value === 'string' && (WALLPAPERS as readonly string[]).includes(value);

/** Whether a wallpaper can drift, with or without a picture. Grain always holds still. */
export const wallpaperCanMove = (wallpaper: Wallpaper): boolean => wallpaper !== 'none' && wallpaper !== 'grain';

/** Whether dither, ASCII or halftone follow a picture's light and dark, not the field's noise. */
export const followsPictureShape = (wallpaper: Wallpaper): boolean =>
  wallpaper === 'dither' || wallpaper === 'ascii' || wallpaper === 'halftone';

/** The server names each picture by a 16-hex-digit hash of its bytes. */
export const isWallpaperImageVersion = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);

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

/** The bands drift one full cycle a minute when the wallpaper moves. */
const DRIFT_RADIANS_PER_SECOND = (2 * Math.PI) / 60;

/**
 * How a wallpaper fades out toward the bottom. `bottom` is for the phone
 * layout, whose composer is a bar along the bottom; `session` keeps it to the
 * top of an open session, well clear of the messages and composer.
 */
export type WallpaperFade = 'none' | 'bottom' | 'session';

/** Where each fade starts and ends, as shares of the height from the top. */
export const WALLPAPER_FADE_STOPS: Record<Exclude<WallpaperFade, 'none'>, readonly [number, number]> = {
  bottom: [0.45, 0.78],
  session: [0.12, 0.55],
};

/**
 * How much shows at `y` CSS pixels from the top of a `height` box with the
 * given fade: 1 above its first stop, 0 below its second, linear between.
 */
export function wallpaperFade(y: number, height: number, fade: WallpaperFade): number {
  if (fade === 'none') return 1;
  const [from, to] = WALLPAPER_FADE_STOPS[fade];
  const t = (y / Math.max(1, height) - from) / (to - from);
  return t <= 0 ? 1 : t >= 1 ? 0 : 1 - t;
}

/**
 * How much a pattern may show at a point in CSS pixels from the centre of the
 * screen: 0 in the middle, where the title and composer sit, rising to 1 at
 * the corners of an ellipse that fits the screen.
 */
function wallpaperReveal(x: number, y: number, width: number, height: number): number {
  const rx = x / Math.max(1, width * 0.5);
  const ry = y / Math.max(1, height * 0.5);
  const edge = Math.min(1, Math.sqrt(rx * rx + ry * ry));
  return smooth(Math.min(1, Math.max(0, (edge - 0.45) / 0.55)));
}

/** The parts of a point's density that never change: its noise, band phase and reveal. */
function staticTerms(x: number, y: number, width: number, height: number) {
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
  const reveal = wallpaperReveal(x, y, width, height);
  // Bands that run on a diagonal give the noise a direction.
  return { noise, phase: (x * 0.6 + y) / 140 + noise * 5, reveal };
}

const combine = (noise: number, phase: number, reveal: number, shift: number): number => {
  const bands = 0.5 + 0.5 * Math.sin(phase - shift);
  return Math.min(1, Math.max(0, (noise * 0.55 + bands * 0.45 - 0.35) * 1.5)) * reveal;
};

/**
 * Density in [0, 1] at a point in CSS pixels from the centre of the screen:
 * soft bands over noise, emptied around the middle where the title and
 * composer sit. Deterministic; `seconds` moves the bands along.
 */
export function wallpaperDensity(x: number, y: number, width: number, height: number, seconds = 0): number {
  const { noise, phase, reveal } = staticTerms(x, y, width, height);
  return combine(noise, phase, reveal, seconds * DRIFT_RADIANS_PER_SECOND);
}

/**
 * A screen's cells with everything that does not move worked out once, so a
 * frame costs one sine per cell that can ever show ink. Cells in the cleared
 * middle are left out entirely.
 */
export type WallpaperField = {
  cols: number;
  rows: number;
  /** Row-major indices of cells whose reveal is above zero. */
  cells: Uint32Array;
  /** Per listed cell, in the same order. */
  noise: Float32Array;
  phase: Float32Array;
  reveal: Float32Array;
};

export function createWallpaperField(
  width: number,
  height: number,
  cellWidth: number,
  cellHeight: number,
  /** Fade toward the bottom (see `wallpaperFade`); cells it empties are left out. */
  fade: WallpaperFade = 'none',
): WallpaperField {
  const cols = Math.max(0, Math.ceil(width / cellWidth));
  const rows = Math.max(0, Math.ceil(height / cellHeight));
  const cx = width / 2;
  const cy = height / 2;
  const cells: number[] = [];
  const noise: number[] = [];
  const phase: number[] = [];
  const reveal: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    const y = row * cellHeight + cellHeight / 2 - cy;
    for (let col = 0; col < cols; col += 1) {
      const terms = staticTerms(col * cellWidth + cellWidth / 2 - cx, y, width, height);
      // An open session has no title or composer in the middle to keep clear,
      // only messages below, so its fade alone decides what shows.
      if (fade === 'session') terms.reveal = wallpaperFade(y + cy, height, fade);
      else if (fade !== 'none') terms.reveal *= wallpaperFade(y + cy, height, fade);
      if (terms.reveal <= 0) continue;
      cells.push(row * cols + col);
      noise.push(terms.noise);
      phase.push(terms.phase);
      reveal.push(terms.reveal);
    }
  }
  return {
    cols,
    rows,
    cells: Uint32Array.from(cells),
    noise: Float32Array.from(noise),
    phase: Float32Array.from(phase),
    reveal: Float32Array.from(reveal),
  };
}

const SINE_STEPS = 4096;
const SINE_SCALE = SINE_STEPS / (2 * Math.PI);
/** 0.5 + 0.5 * sin over one turn; a frame looks bands up here instead of calling Math.sin. */
const BAND_TABLE = Float32Array.from({ length: SINE_STEPS }, (_, i) => 0.5 + 0.5 * Math.sin(i / SINE_SCALE));

const bandAt = (angle: number): number => {
  const turn = Math.floor(angle * SINE_SCALE);
  return BAND_TABLE[((turn % SINE_STEPS) + SINE_STEPS) % SINE_STEPS];
};

/** Writes each listed cell's density at `seconds` into `out` (one value per listed cell). */
export function fillWallpaper(field: WallpaperField, seconds: number, out: Float32Array): void {
  const shift = seconds * DRIFT_RADIANS_PER_SECOND;
  const { noise, phase, reveal } = field;
  for (let i = 0; i < field.cells.length; i += 1) {
    const value = (noise[i] * 0.55 + bandAt(phase[i] - shift) * 0.45 - 0.35) * 1.5;
    out[i] = value <= 0 ? 0 : value >= 1 ? reveal[i] : value * reveal[i];
  }
}

/**
 * Writes each listed cell's field height at `seconds`, before clamping and
 * without the cleared middle. Roughly in [0.1, 0.9].
 */
export function fillWallpaperHeight(field: WallpaperField, seconds: number, out: Float32Array): void {
  const shift = seconds * DRIFT_RADIANS_PER_SECOND;
  const { noise, phase } = field;
  for (let i = 0; i < field.cells.length; i += 1) out[i] = noise[i] * 0.55 + bandAt(phase[i] - shift) * 0.45;
}

/**
 * Writes the direction, in radians, a strand at each listed cell points:
 * set by the noise, and swaying with the bands as they drift.
 */
export function fillWallpaperFlow(field: WallpaperField, seconds: number, out: Float32Array): void {
  const shift = seconds * DRIFT_RADIANS_PER_SECOND;
  const { noise, phase } = field;
  for (let i = 0; i < field.cells.length; i += 1) out[i] = noise[i] * 4 * Math.PI + (bandAt(phase[i] - shift) - 0.5) * 1.2;
}

/** A fixed random value in [0, 1] for a pixel, for grain. */
export const grainAt = (x: number, y: number): number => hash(x, y);

/**
 * How lit a picture's pixel is in the theme's ink. Light ink (dark themes)
 * draws the picture's bright parts, dark ink its dark parts, so the picture
 * reads the right way round in both. Transparent pixels stay empty.
 */
export const pictureDensity = (r: number, g: number, b: number, a: number, inkIsLight: boolean): number => {
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const tone = inkIsLight ? luminance : 1 - luminance;
  return Math.min(1, Math.max(0, (tone - 0.08) / 0.84)) * (a / 255);
};

/** How far the drifting bands push a picture's tone up or down. */
const PICTURE_DRIFT = 0.4;

/**
 * Writes each listed cell's density at `seconds` for a pattern that follows a
 * picture: the picture's tone at that cell (from `pictureDensity`), with the
 * field's bands drifting through it, emptied in the middle like the patterns.
 */
export function fillPictureWallpaper(field: WallpaperField, tones: Float32Array, seconds: number, out: Float32Array): void {
  const shift = seconds * DRIFT_RADIANS_PER_SECOND;
  const { phase, reveal } = field;
  for (let i = 0; i < field.cells.length; i += 1) {
    const value = tones[i] + (bandAt(phase[i] - shift) - 0.5) * PICTURE_DRIFT;
    out[i] = value <= 0 ? 0 : value >= 1 ? reveal[i] : value * reveal[i];
  }
}

export type WallpaperGrid = {
  cols: number;
  rows: number;
  /** One value per cell, row-major. */
  values: Float32Array;
};

/** Samples the density at each cell centre of a `width` x `height` screen. */
export function sampleWallpaper(width: number, height: number, cellWidth: number, cellHeight: number, seconds = 0): WallpaperGrid {
  const field = createWallpaperField(width, height, cellWidth, cellHeight);
  const densities = new Float32Array(field.cells.length);
  fillWallpaper(field, seconds, densities);
  const values = new Float32Array(field.cols * field.rows);
  for (let i = 0; i < field.cells.length; i += 1) values[field.cells[i]] = densities[i];
  return { cols: field.cols, rows: field.rows, values };
}

/** Index into `ASCII_RAMP` for a density; 0 is an empty cell. */
export const asciiIndex = (density: number): number =>
  Math.min(ASCII_RAMP.length - 1, Math.floor(density * ASCII_RAMP.length));

/** The ASCII character for a density. */
export const asciiFor = (density: number): string => ASCII_RAMP[asciiIndex(density)];
