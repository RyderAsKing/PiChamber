import {
  ASCII_CELL,
  ASCII_RAMP,
  CONTOUR_LEVELS,
  DITHER_CELL_PX,
  asciiIndex,
  bayerThreshold,
  createWallpaperField,
  fillWallpaper,
  fillWallpaperFlow,
  fillWallpaperHeight,
  grainAt,
  pictureDensity,
  traceContour,
  type Wallpaper,
  type WallpaperImageStyle,
} from '@/lib/wallpaper';

type Ink = { r: number; g: number; b: number };

export type WallpaperPainter = {
  /** Draws the frame at `seconds`. */
  draw: (seconds: number) => void;
  /** Time between frames when moving; heavier patterns draw less often. */
  frameMs: number;
};

export type PainterOptions = {
  canvas: HTMLCanvasElement;
  /** Size in CSS pixels. */
  width: number;
  height: number;
  ink: Ink;
  variant: 'light' | 'dark';
  wallpaper: Exclude<Wallpaper, 'none'>;
  /** The decoded picture, for `image`. */
  picture?: ImageBitmap | null;
  pictureStyle?: WallpaperImageStyle;
};

/** How much ink a lit cell takes. Dark themes need a touch more to show. */
const INK_ALPHA = {
  dither: { light: 0.11, dark: 0.13 },
  ascii: { light: 0.15, dark: 0.18 },
  contours: { light: 0.2, dark: 0.24 },
  halftone: { light: 0.13, dark: 0.16 },
  strands: { light: 0.22, dark: 0.26 },
  grain: { light: 0.09, dark: 0.11 },
  photo: { light: 0.3, dark: 0.26 },
} as const;

/** Moving patterns draw this often; the drift is slow, so more buys nothing. */
const FRAME_MS = 1000 / 12;
/** Contours trace every line each frame, so they draw a little less often. */
const CONTOUR_FRAME_MS = 1000 / 8;

const HALFTONE_CELL_PX = 8;
const HALFTONE_LEVELS = 8;
const STRAND_CELL_PX = 12;
const CONTOUR_CELL_PX = 6;

const deviceScale = (): number => Math.min(2, window.devicePixelRatio || 1);

const inkStyle = (ink: Ink, alpha: number): string => `rgb(${ink.r} ${ink.g} ${ink.b} / ${alpha})`;

/** Whether the canvas holds one pixel per cell and is scaled up crisply by CSS. */
export const isPixelatedWallpaper = (wallpaper: Wallpaper, pictureStyle: WallpaperImageStyle): boolean =>
  wallpaper === 'dither' || wallpaper === 'grain' || (wallpaper === 'image' && pictureStyle === 'dither');

/** Cells and their density over time, from the shared field or from a picture. */
type DensitySource = {
  cols: number;
  rows: number;
  /** Row-major indices of the cells that can show ink. */
  cells: Uint32Array;
  fill: (seconds: number, out: Float32Array) => void;
};

const fieldSource = (width: number, height: number, cellWidth: number, cellHeight: number): DensitySource => {
  const field = createWallpaperField(width, height, cellWidth, cellHeight);
  return { cols: field.cols, rows: field.rows, cells: field.cells, fill: (seconds, out) => fillWallpaper(field, seconds, out) };
};

/** The source rectangle of `picture` that covers a `width` x `height` screen, centred. */
const coverCrop = (picture: ImageBitmap, width: number, height: number) => {
  const target = width / height;
  if (picture.width / picture.height > target) {
    const sw = picture.height * target;
    return { sx: (picture.width - sw) / 2, sy: 0, sw, sh: picture.height };
  }
  const sh = picture.width / target;
  return { sx: 0, sy: (picture.height - sh) / 2, sw: picture.width, sh };
};

const pictureSource = (
  picture: ImageBitmap,
  width: number,
  height: number,
  cellWidth: number,
  cellHeight: number,
  inkIsLight: boolean,
): DensitySource | null => {
  const cols = Math.ceil(width / cellWidth);
  const rows = Math.ceil(height / cellHeight);
  // The browser averages the picture down to one pixel per cell.
  const sample = document.createElement('canvas');
  sample.width = cols;
  sample.height = rows;
  const context = sample.getContext('2d', { willReadFrequently: true });
  if (!context || cols === 0 || rows === 0) return null;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  const crop = coverCrop(picture, width, height);
  context.drawImage(picture, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, cols, rows);
  const data = context.getImageData(0, 0, cols, rows).data;
  const densities = new Float32Array(cols * rows);
  for (let i = 0; i < densities.length; i += 1) {
    densities[i] = pictureDensity(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3], inkIsLight);
  }
  const cells = Uint32Array.from({ length: cols * rows }, (_, i) => i);
  return { cols, rows, cells, fill: (_seconds, out) => out.set(densities) };
};

function ditherPainter(canvas: HTMLCanvasElement, source: DensitySource, ink: Ink, alpha: number): WallpaperPainter | null {
  // One canvas pixel per dot, scaled up crisply by CSS.
  canvas.width = source.cols;
  canvas.height = source.rows;
  const context = canvas.getContext('2d');
  if (!context || source.cols === 0 || source.rows === 0) return null;
  const image = context.createImageData(source.cols, source.rows);
  const pixels = new Uint32Array(image.data.buffer);
  // Packs the RGBA bytes into one word in the platform's byte order.
  const color = new Uint32Array(new Uint8ClampedArray([ink.r, ink.g, ink.b, Math.round(alpha * 255)]).buffer)[0];
  const thresholds = Float32Array.from(source.cells, (cell) => bayerThreshold(cell % source.cols, Math.floor(cell / source.cols)));
  const densities = new Float32Array(source.cells.length);
  return {
    frameMs: FRAME_MS,
    draw: (seconds) => {
      source.fill(seconds, densities);
      pixels.fill(0);
      for (let i = 0; i < densities.length; i += 1) {
        if (densities[i] > thresholds[i]) pixels[source.cells[i]] = color;
      }
      context.putImageData(image, 0, 0);
    },
  };
}

/**
 * Draws each cell from a strip of pre-drawn sprites (characters or dots), and
 * only redraws cells whose sprite changed, so a frame never lays out text or
 * fills a path.
 */
function spritePainter(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  source: DensitySource,
  cell: { width: number; height: number },
  sprites: number,
  spriteFor: (density: number) => number,
  drawSprite: (context: CanvasRenderingContext2D, index: number, x: number, y: number, w: number, h: number) => void,
): WallpaperPainter | null {
  const scale = deviceScale();
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext('2d');
  if (!context) return null;
  const cellW = Math.ceil(cell.width * scale);
  const cellH = Math.ceil(cell.height * scale);
  const atlas = document.createElement('canvas');
  atlas.width = cellW * sprites;
  atlas.height = cellH;
  const atlasContext = atlas.getContext('2d');
  if (!atlasContext) return null;
  for (let i = 1; i < sprites; i += 1) drawSprite(atlasContext, i, i * cellW, 0, cellW, cellH);

  const densities = new Float32Array(source.cells.length);
  // What each listed cell shows now; 255 makes the first frame draw them all.
  const shown = new Uint8Array(source.cells.length).fill(255);
  context.clearRect(0, 0, canvas.width, canvas.height);
  return {
    frameMs: FRAME_MS,
    draw: (seconds) => {
      source.fill(seconds, densities);
      for (let i = 0; i < densities.length; i += 1) {
        const index = spriteFor(densities[i]);
        if (index === shown[i]) continue;
        shown[i] = index;
        const at = source.cells[i];
        const x = Math.round((at % source.cols) * cell.width * scale);
        const y = Math.round(Math.floor(at / source.cols) * cell.height * scale);
        context.clearRect(x, y, cellW, cellH);
        if (index > 0) context.drawImage(atlas, index * cellW, 0, cellW, cellH, x, y, cellW, cellH);
      }
    },
  };
}

function asciiPainter(canvas: HTMLCanvasElement, width: number, height: number, source: DensitySource, ink: Ink, alpha: number) {
  const scale = deviceScale();
  const family = getComputedStyle(canvas).getPropertyValue('--font-mono').trim() || 'monospace';
  return spritePainter(canvas, width, height, source, ASCII_CELL, ASCII_RAMP.length, asciiIndex, (context, index, x, _y, w, h) => {
    context.font = `${11 * scale}px ${family}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = inkStyle(ink, alpha);
    context.fillText(ASCII_RAMP[index], x + w / 2, h / 2);
  });
}

/**
 * Halftone sizes its dots by the field's height rather than its clamped
 * density, so dot sizes keep varying where the other patterns are solid.
 */
const heightSource = (width: number, height: number, cell: number): DensitySource => {
  const field = createWallpaperField(width, height, cell, cell);
  return {
    cols: field.cols,
    rows: field.rows,
    cells: field.cells,
    fill: (seconds, out) => {
      fillWallpaperHeight(field, seconds, out);
      for (let i = 0; i < out.length; i += 1) out[i] = Math.min(1, Math.max(0, (out[i] - 0.25) / 0.55)) * field.reveal[i];
    },
  };
};

function halftonePainter(canvas: HTMLCanvasElement, width: number, height: number, ink: Ink, alpha: number) {
  const source = heightSource(width, height, HALFTONE_CELL_PX);
  const cell = { width: HALFTONE_CELL_PX, height: HALFTONE_CELL_PX };
  // Area, not radius, follows density, as in print.
  const levelFor = (density: number) => Math.min(HALFTONE_LEVELS, Math.round(density * HALFTONE_LEVELS));
  return spritePainter(canvas, width, height, source, cell, HALFTONE_LEVELS + 1, levelFor, (context, index, x, _y, w, h) => {
    const radius = Math.sqrt(index / HALFTONE_LEVELS) * (Math.min(w, h) / 2) * 0.92;
    context.fillStyle = inkStyle(ink, alpha);
    context.beginPath();
    context.arc(x + w / 2, h / 2, radius, 0, Math.PI * 2);
    context.fill();
  });
}

function strandsPainter(canvas: HTMLCanvasElement, width: number, height: number, ink: Ink, alpha: number): WallpaperPainter | null {
  const field = createWallpaperField(width, height, STRAND_CELL_PX, STRAND_CELL_PX);
  const scale = deviceScale();
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext('2d');
  if (!context) return null;
  const centres = new Float32Array(field.cells.length * 2);
  for (let i = 0; i < field.cells.length; i += 1) {
    centres[i * 2] = ((field.cells[i] % field.cols) + 0.5) * STRAND_CELL_PX * scale;
    centres[i * 2 + 1] = (Math.floor(field.cells[i] / field.cols) + 0.5) * STRAND_CELL_PX * scale;
  }
  const densities = new Float32Array(field.cells.length);
  const angles = new Float32Array(field.cells.length);
  // Three weights of ink, so a frame is three strokes rather than one per strand.
  const weights = [0.45, 0.72, 1];
  return {
    frameMs: FRAME_MS,
    draw: (seconds) => {
      fillWallpaper(field, seconds, densities);
      fillWallpaperFlow(field, seconds, angles);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.lineWidth = scale;
      context.lineCap = 'round';
      for (let w = 0; w < weights.length; w += 1) {
        const low = w / weights.length;
        const high = (w + 1) / weights.length;
        context.beginPath();
        for (let i = 0; i < densities.length; i += 1) {
          const density = densities[i];
          if (density < 0.04 || density <= low || density > high) continue;
          const half = STRAND_CELL_PX * scale * (0.2 + 0.4 * density);
          const dx = Math.cos(angles[i]) * half;
          const dy = Math.sin(angles[i]) * half;
          context.moveTo(centres[i * 2] - dx, centres[i * 2 + 1] - dy);
          context.lineTo(centres[i * 2] + dx, centres[i * 2 + 1] + dy);
        }
        context.strokeStyle = inkStyle(ink, alpha * weights[w]);
        context.stroke();
      }
    },
  };
}

/** Contour lines fade in through this many steps of the reveal. */
const CONTOUR_FADE_STEPS = 4;

function contoursPainter(canvas: HTMLCanvasElement, width: number, height: number, ink: Ink, alpha: number): WallpaperPainter | null {
  const field = createWallpaperField(width, height, CONTOUR_CELL_PX, CONTOUR_CELL_PX);
  const scale = deviceScale();
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext('2d');
  if (!context || field.cols === 0 || field.rows === 0) return null;
  // Lines fade by the same reveal as the other patterns, in a few steps: a
  // stroke per step is far cheaper than masking the whole canvas each frame.
  const fade = new Uint8Array(field.cols * field.rows);
  for (let i = 0; i < field.cells.length; i += 1) {
    fade[field.cells[i]] = Math.min(CONTOUR_FADE_STEPS, Math.ceil(field.reveal[i] * CONTOUR_FADE_STEPS));
  }
  const heights = new Float32Array(field.cells.length);
  const grid = new Float32Array(field.cols * field.rows).fill(Number.NaN);
  const step = CONTOUR_CELL_PX * scale;
  const offset = step / 2;
  let paths: Array<Path2D | null> = [];
  const segment = (x1: number, y1: number, x2: number, y2: number, square: number) => {
    const path = paths[fade[square]];
    if (!path) return;
    path.moveTo(x1 * step + offset, y1 * step + offset);
    path.lineTo(x2 * step + offset, y2 * step + offset);
  };
  return {
    frameMs: CONTOUR_FRAME_MS,
    draw: (seconds) => {
      fillWallpaperHeight(field, seconds, heights);
      for (let i = 0; i < heights.length; i += 1) grid[field.cells[i]] = heights[i];
      // Index 0 (no reveal) stays without a path, so those pieces are dropped.
      paths = [null, ...Array.from({ length: CONTOUR_FADE_STEPS }, () => new Path2D())];
      for (const level of CONTOUR_LEVELS) traceContour(grid, field.cols, field.rows, level, segment);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.lineWidth = scale;
      context.lineJoin = 'round';
      for (let f = 1; f <= CONTOUR_FADE_STEPS; f += 1) {
        context.strokeStyle = inkStyle(ink, alpha * (f / CONTOUR_FADE_STEPS));
        const path = paths[f];
        if (path) context.stroke(path);
      }
    },
  };
}

function grainPainter(canvas: HTMLCanvasElement, width: number, height: number, ink: Ink, alpha: number): WallpaperPainter | null {
  // One canvas pixel per CSS pixel; the grain is drawn once and never moves.
  canvas.width = Math.max(0, Math.round(width));
  canvas.height = Math.max(0, Math.round(height));
  const context = canvas.getContext('2d');
  if (!context || canvas.width === 0 || canvas.height === 0) return null;
  const draw = () => {
    const image = context.createImageData(canvas.width, canvas.height);
    const data = image.data;
    const halfW = canvas.width / 2;
    const halfH = canvas.height / 2;
    for (let y = 0; y < canvas.height; y += 1) {
      const ry = (y - halfH) / halfH;
      for (let x = 0; x < canvas.width; x += 1) {
        const grain = grainAt(x, y);
        if (grain < 0.55) continue;
        const rx = (x - halfW) / halfW;
        // Lighter in the middle, heavier toward the corners.
        const edge = Math.min(1, Math.sqrt(rx * rx + ry * ry));
        const at = (y * canvas.width + x) * 4;
        data[at] = ink.r;
        data[at + 1] = ink.g;
        data[at + 2] = ink.b;
        data[at + 3] = Math.round(255 * alpha * ((grain - 0.55) / 0.45) * (0.3 + 0.7 * edge * edge));
      }
    }
    context.putImageData(image, 0, 0);
  };
  return { frameMs: FRAME_MS, draw };
}

function photoPainter(canvas: HTMLCanvasElement, width: number, height: number, picture: ImageBitmap, alpha: number): WallpaperPainter | null {
  const scale = deviceScale();
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext('2d');
  if (!context) return null;
  const crop = coverCrop(picture, width, height);
  return {
    frameMs: FRAME_MS,
    draw: () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.globalAlpha = alpha;
      context.imageSmoothingQuality = 'high';
      context.drawImage(picture, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height);
      context.globalAlpha = 1;
    },
  };
}

/**
 * Builds the painter for one wallpaper at one size and theme. Everything that
 * does not change between frames is worked out here, once.
 */
export function createWallpaperPainter(options: PainterOptions): WallpaperPainter | null {
  const { canvas, width, height, ink, variant, wallpaper } = options;
  if (width <= 0 || height <= 0) return null;
  switch (wallpaper) {
    case 'dither':
      return ditherPainter(canvas, fieldSource(width, height, DITHER_CELL_PX, DITHER_CELL_PX), ink, INK_ALPHA.dither[variant]);
    case 'ascii':
      return asciiPainter(canvas, width, height, fieldSource(width, height, ASCII_CELL.width, ASCII_CELL.height), ink, INK_ALPHA.ascii[variant]);
    case 'halftone':
      return halftonePainter(canvas, width, height, ink, INK_ALPHA.halftone[variant]);
    case 'strands':
      return strandsPainter(canvas, width, height, ink, INK_ALPHA.strands[variant]);
    case 'contours':
      return contoursPainter(canvas, width, height, ink, INK_ALPHA.contours[variant]);
    case 'grain':
      return grainPainter(canvas, width, height, ink, INK_ALPHA.grain[variant]);
    case 'image': {
      const { picture, pictureStyle = 'photo' } = options;
      if (!picture) return null;
      if (pictureStyle === 'photo') return photoPainter(canvas, width, height, picture, INK_ALPHA.photo[variant]);
      const inkIsLight = variant === 'dark';
      if (pictureStyle === 'dither') {
        const source = pictureSource(picture, width, height, DITHER_CELL_PX, DITHER_CELL_PX, inkIsLight);
        return source ? ditherPainter(canvas, source, ink, INK_ALPHA.dither[variant]) : null;
      }
      const source = pictureSource(picture, width, height, ASCII_CELL.width, ASCII_CELL.height, inkIsLight);
      return source ? asciiPainter(canvas, width, height, source, ink, INK_ALPHA.ascii[variant]) : null;
    }
    default:
      return null;
  }
}
