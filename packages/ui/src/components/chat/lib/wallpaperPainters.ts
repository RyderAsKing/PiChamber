import {
  ASCII_CELL,
  ASCII_RAMP,
  DITHER_CELL_PX,
  asciiIndex,
  bayerThreshold,
  createWallpaperField,
  fillWallpaper,
  fillWallpaperFlow,
  fillWallpaperHeight,
  grainAt,
  pictureDensity,
  wallpaperReveal,
  type Wallpaper,
  type WallpaperImageStyle,
} from '@/lib/wallpaper';

type Ink = { r: number; g: number; b: number };

export type WallpaperPainter = {
  /** Draws the frame at `seconds`. */
  draw: (seconds: number) => void;
  /** Time between frames when moving. */
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
  halftone: { light: 0.13, dark: 0.16 },
  strands: { light: 0.22, dark: 0.26 },
  grain: { light: 0.09, dark: 0.11 },
  photo: { light: 0.3, dark: 0.26 },
  /** Under a picture's dither or ASCII, the photo itself shows this much. */
  pictureBase: { light: 0.2, dark: 0.18 },
  /** The picture's dots or characters, in its own colours. */
  pictureEffect: { light: 0.6, dark: 0.55 },
} as const;

/** Moving patterns draw this often; the drift is slow, so more buys nothing. */
const FRAME_MS = 1000 / 6;

const HALFTONE_CELL_PX = 8;
/** How much of a picture's effect is left in the cleared middle. */
const PICTURE_EFFECT_MIDDLE = 0.25;
const HALFTONE_LEVELS = 8;
const STRAND_CELL_PX = 12;

const deviceScale = (): number => Math.min(2, window.devicePixelRatio || 1);

const inkStyle = (ink: Ink, alpha: number): string => `rgb(${ink.r} ${ink.g} ${ink.b} / ${alpha})`;

/** Whether the canvas holds one pixel per cell and is scaled up crisply by CSS. */
export const isPixelatedWallpaper = (wallpaper: Wallpaper): boolean => wallpaper === 'dither' || wallpaper === 'grain';

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

/** The picture averaged down to one RGBA pixel per cell, cropped to cover the screen. */
const samplePicture = (picture: ImageBitmap, width: number, height: number, cellWidth: number, cellHeight: number) => {
  const cols = Math.ceil(width / cellWidth);
  const rows = Math.ceil(height / cellHeight);
  const sample = document.createElement('canvas');
  sample.width = cols;
  sample.height = rows;
  const context = sample.getContext('2d', { willReadFrequently: true });
  if (!context || cols === 0 || rows === 0) return null;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  const crop = coverCrop(picture, width, height);
  context.drawImage(picture, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, cols, rows);
  return { cols, rows, data: context.getImageData(0, 0, cols, rows).data };
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
 * A picture drawn as dither or ASCII that keeps its colours: the photo shows
 * faintly underneath, and each dot or character takes the colour of the part
 * of the photo it sits on. Where a cell lights up follows the same rule as
 * the patterns, so it still reads the right way round on light and dark
 * themes. Drawn once; pictures never move.
 */
function pictureEffectPainter(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  picture: ImageBitmap,
  style: 'dither' | 'ascii',
  variant: 'light' | 'dark',
): WallpaperPainter | null {
  const cell = style === 'dither' ? { width: DITHER_CELL_PX, height: DITHER_CELL_PX } : ASCII_CELL;
  const sample = samplePicture(picture, width, height, cell.width, cell.height);
  if (!sample) return null;
  const { cols, rows, data } = sample;
  const scale = deviceScale();
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext('2d');
  if (!context) return null;
  const inkIsLight = variant === 'dark';

  // Each cell's colour where it lights up, transparent where it does not.
  const colours = document.createElement('canvas');
  colours.width = cols;
  colours.height = rows;
  const coloursContext = colours.getContext('2d');
  if (!coloursContext) return null;
  const image = coloursContext.createImageData(cols, rows);
  const asciiLevels = new Uint8Array(cols * rows);
  for (let i = 0; i < cols * rows; i += 1) {
    const at = i * 4;
    const density = pictureDensity(data[at], data[at + 1], data[at + 2], data[at + 3], inkIsLight);
    const lit = style === 'dither'
      ? density > bayerThreshold(i % cols, Math.floor(i / cols))
      : (asciiLevels[i] = asciiIndex(density)) > 0;
    if (!lit) continue;
    // The photo itself stays whole; only its dots or characters thin out
    // around the title and composer, so they stay readable.
    const col = i % cols;
    const row = Math.floor(i / cols);
    const reveal = wallpaperReveal((col + 0.5) * cell.width - width / 2, (row + 0.5) * cell.height - height / 2, width, height);
    image.data[at] = data[at];
    image.data[at + 1] = data[at + 1];
    image.data[at + 2] = data[at + 2];
    image.data[at + 3] = Math.round(255 * (PICTURE_EFFECT_MIDDLE + (1 - PICTURE_EFFECT_MIDDLE) * reveal));
  }
  coloursContext.putImageData(image, 0, 0);

  const cellW = cell.width * scale;
  const cellH = cell.height * scale;
  let effect: HTMLCanvasElement = colours;
  if (style === 'ascii') {
    // Characters in white, then tinted by the colour grid laid over them.
    const glyphs = document.createElement('canvas');
    glyphs.width = canvas.width;
    glyphs.height = canvas.height;
    const glyphContext = glyphs.getContext('2d');
    if (!glyphContext) return null;
    const family = getComputedStyle(canvas).getPropertyValue('--font-mono').trim() || 'monospace';
    glyphContext.font = `${11 * scale}px ${family}`;
    glyphContext.textAlign = 'center';
    glyphContext.textBaseline = 'middle';
    glyphContext.fillStyle = '#fff';
    for (let i = 0; i < asciiLevels.length; i += 1) {
      if (asciiLevels[i] === 0) continue;
      glyphContext.fillText(ASCII_RAMP[asciiLevels[i]], ((i % cols) + 0.5) * cellW, (Math.floor(i / cols) + 0.5) * cellH);
    }
    glyphContext.globalCompositeOperation = 'source-in';
    glyphContext.imageSmoothingEnabled = false;
    glyphContext.drawImage(colours, 0, 0, cols * cellW, rows * cellH);
    effect = glyphs;
  }

  const crop = coverCrop(picture, width, height);
  return {
    frameMs: FRAME_MS,
    draw: () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.globalAlpha = INK_ALPHA.pictureBase[variant];
      context.drawImage(picture, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height);
      context.globalAlpha = INK_ALPHA.pictureEffect[variant];
      if (effect === colours) {
        // One canvas pixel per dot, kept square and crisp at the screen's scale.
        context.imageSmoothingEnabled = false;
        context.drawImage(colours, 0, 0, cols * cellW, rows * cellH);
      } else {
        context.drawImage(effect, 0, 0);
      }
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
    case 'grain':
      return grainPainter(canvas, width, height, ink, INK_ALPHA.grain[variant]);
    case 'image': {
      const { picture, pictureStyle = 'photo' } = options;
      if (!picture) return null;
      if (pictureStyle === 'photo') return photoPainter(canvas, width, height, picture, INK_ALPHA.photo[variant]);
      return pictureEffectPainter(canvas, width, height, picture, pictureStyle, variant);
    }
    default:
      return null;
  }
}
