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
  fillPictureWallpaper,
  followsPictureShape,
  grainAt,
  pictureDensity,
  wallpaperFade,
  WALLPAPER_FADE_STOPS,
  type Wallpaper,
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
  /** The decoded picture: the pattern takes its colours, and its shape for dither, ASCII and halftone. */
  picture?: ImageBitmap | null;
  /** Fade the bottom out, drawn into the canvas (see `wallpaperFade`). */
  fade?: boolean;
};

/** How much ink a lit cell takes. Dark themes need a touch more to show. */
const INK_ALPHA = {
  dither: { light: 0.11, dark: 0.13 },
  ascii: { light: 0.15, dark: 0.18 },
  halftone: { light: 0.13, dark: 0.16 },
  strands: { light: 0.22, dark: 0.26 },
  grain: { light: 0.09, dark: 0.11 },
  /** The picture on its own, with no pattern over it. */
  photo: { light: 0.3, dark: 0.26 },
  /** The picture under a pattern. */
  pictureBase: { light: 0.2, dark: 0.18 },
  /** A pattern in the picture's colours. */
  pictureEffect: { light: 0.6, dark: 0.55 },
  pictureGrain: { light: 0.3, dark: 0.3 },
} as const;

/** Moving patterns draw this often; the drift is slow, so more buys nothing. */
const FRAME_MS = 1000 / 6;

const HALFTONE_CELL_PX = 8;
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

/** One opaque pixel per cell in the picture's colour there, row-major, as a canvas and as bytes. */
type CellColours = { canvas: HTMLCanvasElement; data: Uint8ClampedArray };

const WHITE: Ink = { r: 255, g: 255, b: 255 };

const fieldSource = (width: number, height: number, cellWidth: number, cellHeight: number, fade: boolean): DensitySource => {
  const field = createWallpaperField(width, height, cellWidth, cellHeight, fade);
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

/** The picture averaged down to one opaque pixel per cell, cropped to cover the screen. */
const sampleColours = (picture: ImageBitmap, width: number, height: number, cellWidth: number, cellHeight: number): CellColours | null => {
  const cols = Math.ceil(width / cellWidth);
  const rows = Math.ceil(height / cellHeight);
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context || cols === 0 || rows === 0) return null;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  const crop = coverCrop(picture, width, height);
  context.drawImage(picture, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, cols, rows);
  const image = context.getImageData(0, 0, cols, rows);
  const data = image.data;
  // Opaque, so tinting keeps each dot's own alpha; how lit a cell is still reads the real alpha.
  const alpha = Uint8ClampedArray.from({ length: cols * rows }, (_, i) => data[i * 4 + 3]);
  for (let i = 0; i < cols * rows; i += 1) data[i * 4 + 3] = 255;
  context.putImageData(image, 0, 0);
  for (let i = 0; i < cols * rows; i += 1) data[i * 4 + 3] = alpha[i];
  return { canvas, data };
};

/**
 * A pattern's cells following a picture: each cell's tone from the picture,
 * with the field's bands drifting through, plus the picture's colours.
 */
const pictureSource = (
  width: number,
  height: number,
  cellWidth: number,
  cellHeight: number,
  fade: boolean,
  picture: ImageBitmap,
  inkIsLight: boolean,
): (DensitySource & { colours: CellColours }) | null => {
  const colours = sampleColours(picture, width, height, cellWidth, cellHeight);
  if (!colours) return null;
  const field = createWallpaperField(width, height, cellWidth, cellHeight, fade);
  const { data } = colours;
  const tones = Float32Array.from(field.cells, (cell) => {
    const at = cell * 4;
    return pictureDensity(data[at], data[at + 1], data[at + 2], data[at + 3], inkIsLight);
  });
  return {
    cols: field.cols,
    rows: field.rows,
    cells: field.cells,
    colours,
    fill: (seconds, out) => fillPictureWallpaper(field, tones, seconds, out),
  };
};

function ditherPainter(
  canvas: HTMLCanvasElement,
  source: DensitySource,
  ink: Ink,
  alpha: number,
  colours?: CellColours,
): WallpaperPainter | null {
  // One canvas pixel per dot, scaled up crisply by CSS.
  canvas.width = source.cols;
  canvas.height = source.rows;
  const context = canvas.getContext('2d');
  if (!context || source.cols === 0 || source.rows === 0) return null;
  const image = context.createImageData(source.cols, source.rows);
  const pixels = new Uint32Array(image.data.buffer);
  // Packs RGBA bytes into one word in the platform's byte order.
  const pack = (r: number, g: number, b: number) => new Uint32Array(new Uint8ClampedArray([r, g, b, Math.round(alpha * 255)]).buffer)[0];
  const inkColor = pack(ink.r, ink.g, ink.b);
  const colorOf = colours
    ? Uint32Array.from(source.cells, (cell) => pack(colours.data[cell * 4], colours.data[cell * 4 + 1], colours.data[cell * 4 + 2]))
    : null;
  const thresholds = Float32Array.from(source.cells, (cell) => bayerThreshold(cell % source.cols, Math.floor(cell / source.cols)));
  const densities = new Float32Array(source.cells.length);
  return {
    frameMs: FRAME_MS,
    draw: (seconds) => {
      source.fill(seconds, densities);
      pixels.fill(0);
      for (let i = 0; i < densities.length; i += 1) {
        if (densities[i] > thresholds[i]) pixels[source.cells[i]] = colorOf ? colorOf[i] : inkColor;
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
  /** Sprites drawn in white are recoloured per cell from these. */
  colours?: CellColours,
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
  const drawn = new Uint32Array(source.cells.length);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = false;
  return {
    frameMs: FRAME_MS,
    draw: (seconds) => {
      source.fill(seconds, densities);
      let count = 0;
      for (let i = 0; i < densities.length; i += 1) {
        const index = spriteFor(densities[i]);
        if (index === shown[i]) continue;
        shown[i] = index;
        const at = source.cells[i];
        const x = Math.round((at % source.cols) * cell.width * scale);
        const y = Math.round(Math.floor(at / source.cols) * cell.height * scale);
        context.clearRect(x, y, cellW, cellH);
        if (index === 0) continue;
        context.drawImage(atlas, index * cellW, 0, cellW, cellH, x, y, cellW, cellH);
        drawn[count] = i;
        count += 1;
      }
      if (!colours || count === 0) return;
      // Paints each new sprite in its cell's colour, keeping the sprite's shape and alpha.
      context.globalCompositeOperation = 'source-atop';
      for (let k = 0; k < count; k += 1) {
        const at = source.cells[drawn[k]];
        const col = at % source.cols;
        const row = Math.floor(at / source.cols);
        context.drawImage(colours.canvas, col, row, 1, 1, Math.round(col * cell.width * scale), Math.round(row * cell.height * scale), cellW, cellH);
      }
      context.globalCompositeOperation = 'source-over';
    },
  };
}

function asciiPainter(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  source: DensitySource,
  ink: Ink,
  alpha: number,
  colours?: CellColours,
) {
  const scale = deviceScale();
  const family = getComputedStyle(canvas).getPropertyValue('--font-mono').trim() || 'monospace';
  return spritePainter(canvas, width, height, source, ASCII_CELL, ASCII_RAMP.length, asciiIndex, (context, index, x, _y, w, h) => {
    context.font = `${11 * scale}px ${family}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = inkStyle(ink, alpha);
    context.fillText(ASCII_RAMP[index], x + w / 2, h / 2);
  }, colours);
}

/**
 * Halftone sizes its dots by the field's height rather than its clamped
 * density, so dot sizes keep varying where the other patterns are solid.
 */
const heightSource = (width: number, height: number, cell: number, fade: boolean): DensitySource => {
  const field = createWallpaperField(width, height, cell, cell, fade);
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

function halftonePainter(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  ink: Ink,
  alpha: number,
  fade: boolean,
  picture?: (DensitySource & { colours: CellColours }) | null,
) {
  const source = picture ?? heightSource(width, height, HALFTONE_CELL_PX, fade);
  const cell = { width: HALFTONE_CELL_PX, height: HALFTONE_CELL_PX };
  // Area, not radius, follows density, as in print.
  const levelFor = (density: number) => Math.min(HALFTONE_LEVELS, Math.round(density * HALFTONE_LEVELS));
  return spritePainter(canvas, width, height, source, cell, HALFTONE_LEVELS + 1, levelFor, (context, index, x, _y, w, h) => {
    const radius = Math.sqrt(index / HALFTONE_LEVELS) * (Math.min(w, h) / 2) * 0.92;
    context.fillStyle = inkStyle(ink, alpha);
    context.beginPath();
    context.arc(x + w / 2, h / 2, radius, 0, Math.PI * 2);
    context.fill();
  }, picture?.colours);
}

function strandsPainter(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  ink: Ink,
  alpha: number,
  fade: boolean,
  colours?: CellColours | null,
): WallpaperPainter | null {
  const field = createWallpaperField(width, height, STRAND_CELL_PX, STRAND_CELL_PX, fade);
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
  // With a picture, strands are grouped once by their cell's colour, rounded
  // to a few levels a channel, so a frame is three strokes per colour in use.
  const groups = colours ? groupByColour(field.cells, colours.data) : [{ ink, members: Uint32Array.from(field.cells, (_, i) => i) }];
  return {
    frameMs: FRAME_MS,
    draw: (seconds) => {
      fillWallpaper(field, seconds, densities);
      fillWallpaperFlow(field, seconds, angles);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.lineWidth = scale;
      context.lineCap = 'round';
      for (const group of groups) {
        for (let w = 0; w < weights.length; w += 1) {
          const low = w / weights.length;
          const high = (w + 1) / weights.length;
          let any = false;
          context.beginPath();
          for (let k = 0; k < group.members.length; k += 1) {
            const i = group.members[k];
            const density = densities[i];
            if (density < 0.04 || density <= low || density > high) continue;
            const half = STRAND_CELL_PX * scale * (0.2 + 0.4 * density);
            const dx = Math.cos(angles[i]) * half;
            const dy = Math.sin(angles[i]) * half;
            context.moveTo(centres[i * 2] - dx, centres[i * 2 + 1] - dy);
            context.lineTo(centres[i * 2] + dx, centres[i * 2 + 1] + dy);
            any = true;
          }
          if (!any) continue;
          context.strokeStyle = inkStyle(group.ink, alpha * weights[w]);
          context.stroke();
        }
      }
    },
  };
}

/** Levels per channel when grouping strands by colour: 6 gives at most 216 groups, far fewer in practice. */
const STRAND_COLOUR_LEVELS = 6;

/** The listed cells (by position in `cells`) grouped by their colour, rounded to a few levels a channel. */
const groupByColour = (cells: Uint32Array, data: Uint8ClampedArray): Array<{ ink: Ink; members: Uint32Array }> => {
  const step = 255 / (STRAND_COLOUR_LEVELS - 1);
  const level = (value: number) => Math.round(value / step);
  const byKey = new Map<number, number[]>();
  for (let i = 0; i < cells.length; i += 1) {
    const at = cells[i] * 4;
    const key = (level(data[at]) * STRAND_COLOUR_LEVELS + level(data[at + 1])) * STRAND_COLOUR_LEVELS + level(data[at + 2]);
    const members = byKey.get(key);
    if (members) members.push(i);
    else byKey.set(key, [i]);
  }
  return [...byKey].map(([key, members]) => {
    const b = key % STRAND_COLOUR_LEVELS;
    const g = Math.floor(key / STRAND_COLOUR_LEVELS) % STRAND_COLOUR_LEVELS;
    const r = Math.floor(key / (STRAND_COLOUR_LEVELS * STRAND_COLOUR_LEVELS));
    return { ink: { r: Math.round(r * step), g: Math.round(g * step), b: Math.round(b * step) }, members: Uint32Array.from(members) };
  });
};

function grainPainter(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  ink: Ink,
  alpha: number,
  fade: boolean,
  picture?: ImageBitmap | null,
): WallpaperPainter | null {
  // One canvas pixel per CSS pixel; the grain is drawn once and never moves.
  canvas.width = Math.max(0, Math.round(width));
  canvas.height = Math.max(0, Math.round(height));
  const context = canvas.getContext('2d');
  if (!context || canvas.width === 0 || canvas.height === 0) return null;
  // With a picture, each speck takes the colour of the pixel under it.
  const colours = picture ? sampleColours(picture, canvas.width, canvas.height, 1, 1)?.data ?? null : null;
  const draw = () => {
    const image = context.createImageData(canvas.width, canvas.height);
    const data = image.data;
    const halfW = canvas.width / 2;
    const halfH = canvas.height / 2;
    for (let y = 0; y < canvas.height; y += 1) {
      const fadeAt = fade ? wallpaperFade(y, canvas.height) : 1;
      if (fadeAt <= 0) break;
      const ry = (y - halfH) / halfH;
      for (let x = 0; x < canvas.width; x += 1) {
        const grain = grainAt(x, y);
        if (grain < 0.55) continue;
        const rx = (x - halfW) / halfW;
        // Lighter in the middle, heavier toward the corners.
        const edge = Math.min(1, Math.sqrt(rx * rx + ry * ry));
        const at = (y * canvas.width + x) * 4;
        data[at] = colours ? colours[at] : ink.r;
        data[at + 1] = colours ? colours[at + 1] : ink.g;
        data[at + 2] = colours ? colours[at + 2] : ink.b;
        data[at + 3] = Math.round(255 * alpha * ((grain - 0.55) / 0.45) * (0.3 + 0.7 * edge * edge) * fadeAt);
      }
    }
    context.putImageData(image, 0, 0);
  };
  return { frameMs: FRAME_MS, draw };
}

/** Fades the bottom of a finished, still frame out, matching `wallpaperFade`. */
const fadeBottom = (context: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => {
  const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(WALLPAPER_FADE_STOPS[0], '#000');
  gradient.addColorStop(WALLPAPER_FADE_STOPS[1], 'transparent');
  context.globalCompositeOperation = 'destination-in';
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = 'source-over';
};

/**
 * Draws the picture itself, cropped to cover the box: on its own when there
 * is no pattern, or fainter under one. It sits on its own canvas under the
 * pattern's and is drawn once, so a moving pattern never redraws it.
 */
export function paintPictureBackdrop(options: {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  picture: ImageBitmap;
  variant: 'light' | 'dark';
  underPattern: boolean;
  fade?: boolean;
}): void {
  const { canvas, width, height, picture, variant, underPattern, fade = false } = options;
  if (width <= 0 || height <= 0) return;
  const scale = deviceScale();
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext('2d');
  if (!context) return;
  const crop = coverCrop(picture, width, height);
  context.globalAlpha = (underPattern ? INK_ALPHA.pictureBase : INK_ALPHA.photo)[variant];
  context.imageSmoothingQuality = 'high';
  context.drawImage(picture, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height);
  context.globalAlpha = 1;
  if (fade) fadeBottom(context, canvas);
}

/**
 * Builds the painter for one wallpaper at one size and theme. Everything that
 * does not change between frames is worked out here, once.
 */
export function createWallpaperPainter(options: PainterOptions): WallpaperPainter | null {
  const { canvas, width, height, variant, wallpaper, fade = false, picture = null } = options;
  if (width <= 0 || height <= 0) return null;
  // With a picture, patterns are drawn in white at the picture's strength and coloured from it.
  const ink = picture ? WHITE : options.ink;
  const alphaOf = (pattern: keyof typeof INK_ALPHA) => (picture ? INK_ALPHA.pictureEffect : INK_ALPHA[pattern])[variant];
  const inkIsLight = variant === 'dark';
  const shaped = (cellWidth: number, cellHeight: number) =>
    picture && followsPictureShape(wallpaper) ? pictureSource(width, height, cellWidth, cellHeight, fade, picture, inkIsLight) : null;
  switch (wallpaper) {
    case 'dither': {
      const source = shaped(DITHER_CELL_PX, DITHER_CELL_PX);
      return ditherPainter(canvas, source ?? fieldSource(width, height, DITHER_CELL_PX, DITHER_CELL_PX, fade), ink, alphaOf('dither'), source?.colours);
    }
    case 'ascii': {
      const source = shaped(ASCII_CELL.width, ASCII_CELL.height);
      return asciiPainter(canvas, width, height, source ?? fieldSource(width, height, ASCII_CELL.width, ASCII_CELL.height, fade), ink, alphaOf('ascii'), source?.colours);
    }
    case 'halftone':
      return halftonePainter(canvas, width, height, ink, alphaOf('halftone'), fade, shaped(HALFTONE_CELL_PX, HALFTONE_CELL_PX));
    case 'strands': {
      const colours = picture ? sampleColours(picture, width, height, STRAND_CELL_PX, STRAND_CELL_PX) : null;
      // Strands are thin, so in a picture's colours they need its full strength.
      return strandsPainter(canvas, width, height, options.ink, picture ? 1 : alphaOf('strands'), fade, colours);
    }
    case 'grain':
      // Grain covers the middle too, so over a picture it stays lighter than the other patterns.
      return grainPainter(canvas, width, height, ink, picture ? INK_ALPHA.pictureGrain[variant] : alphaOf('grain'), fade, picture);
    default:
      return null;
  }
}
