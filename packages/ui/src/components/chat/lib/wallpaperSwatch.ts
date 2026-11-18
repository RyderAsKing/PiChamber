import type { Wallpaper } from '@/lib/wallpaper';

import {
  createWallpaperPainter,
  isPixelatedWallpaper,
  paintPictureBackdrop,
  wallpaperCanvasSize,
} from './wallpaperPainters';

/** CSS size of a swatch; tiles show it with `object-fit: cover`. */
const WALLPAPER_SWATCH = { width: 320, height: 200 } as const;

type SwatchOptions = {
  wallpaper: Wallpaper;
  picture: ImageBitmap | null;
  ink: { r: number; g: number; b: number };
  variant: 'light' | 'dark';
};

/**
 * A still picture of a wallpaper for its Settings tile: the pattern at full
 * strength across the whole swatch (no cleared middle, no fade) and at its
 * real scale, so a small tile still shows what it looks like. With a picture,
 * the picture under it as on the screen.
 */
function renderSwatch({ wallpaper, picture, ink, variant }: SwatchOptions): string | null {
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const out = document.createElement('canvas');
  out.width = Math.round(WALLPAPER_SWATCH.width * scale);
  out.height = Math.round(WALLPAPER_SWATCH.height * scale);
  const context = out.getContext('2d');
  if (!context) return null;

  // Copies a layer drawn for `size` (at least the swatch) from its top left.
  const copy = (layer: HTMLCanvasElement, size: { width: number; height: number }, pixelated: boolean) => {
    if (layer.width === 0 || layer.height === 0) return;
    context.imageSmoothingEnabled = !pixelated;
    const sw = (layer.width * WALLPAPER_SWATCH.width) / size.width;
    const sh = (layer.height * WALLPAPER_SWATCH.height) / size.height;
    context.drawImage(layer, 0, 0, sw, sh, 0, 0, out.width, out.height);
  };

  if (picture) {
    const layer = document.createElement('canvas');
    paintPictureBackdrop({ canvas: layer, ...WALLPAPER_SWATCH, picture, variant, underPattern: wallpaper !== 'none' });
    copy(layer, WALLPAPER_SWATCH, false);
  }
  if (wallpaper !== 'none') {
    const size = wallpaperCanvasSize(wallpaper, WALLPAPER_SWATCH.width, WALLPAPER_SWATCH.height);
    const layer = document.createElement('canvas');
    const painter = createWallpaperPainter({ canvas: layer, ...size, ink, variant, wallpaper, picture, fade: 'full' });
    painter?.draw(0);
    // On its own a pattern is faint by design, light themes most of all; laid
    // over itself a few times, a small tile still reads. Over a picture it is
    // already drawn at the picture's strength.
    const layers = picture ? 1 : variant === 'light' ? 4 : 2;
    for (let i = 0; i < layers; i += 1) copy(layer, size, isPixelatedWallpaper(wallpaper));
  }
  return out.toDataURL('image/png');
}

/** Swatches already drawn, per picture (or none), by everything else they depend on. */
const NO_PICTURE = {};
const swatches = new WeakMap<object, Map<string, string | null>>();

const swatchKey = ({ wallpaper, ink, variant }: SwatchOptions) =>
  [wallpaper, variant, ink.r, ink.g, ink.b, Math.min(2, window.devicePixelRatio || 1)].join('|');

/** The swatch if it has been drawn: a data URL, null when it could not be, undefined when not yet. */
export function peekWallpaperSwatch(options: SwatchOptions): string | null | undefined {
  return swatches.get(options.picture ?? NO_PICTURE)?.get(swatchKey(options));
}

export function drawWallpaperSwatch(options: SwatchOptions): string | null {
  const known = peekWallpaperSwatch(options);
  if (known !== undefined) return known;
  const owner = options.picture ?? NO_PICTURE;
  let byKey = swatches.get(owner);
  if (!byKey) {
    byKey = new Map();
    swatches.set(owner, byKey);
  }
  const url = renderSwatch(options);
  byKey.set(swatchKey(options), url);
  return url;
}

/** A plain thumbnail of the picture itself, cropped to fill the swatch shape. */
export function pictureThumbnail(picture: ImageBitmap): string | null {
  const known = swatches.get(picture)?.get('thumbnail');
  if (known !== undefined) return known;
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const out = document.createElement('canvas');
  out.width = Math.round(WALLPAPER_SWATCH.width * scale);
  out.height = Math.round(WALLPAPER_SWATCH.height * scale);
  const context = out.getContext('2d');
  let url: string | null = null;
  if (context && picture.width > 0 && picture.height > 0) {
    const cover = Math.max(out.width / picture.width, out.height / picture.height);
    const sw = out.width / cover;
    const sh = out.height / cover;
    context.imageSmoothingQuality = 'high';
    context.drawImage(picture, (picture.width - sw) / 2, (picture.height - sh) / 2, sw, sh, 0, 0, out.width, out.height);
    url = out.toDataURL('image/jpeg', 0.85);
  }
  let byKey = swatches.get(picture);
  if (!byKey) {
    byKey = new Map();
    swatches.set(picture, byKey);
  }
  byKey.set('thumbnail', url);
  return url;
}
