import { relativeLuminance } from '@/lib/theme/contrast';

/**
 * Whether a project icon is almost entirely dark or almost entirely light.
 * A dark logo on a transparent background disappears on a dark theme (and a
 * white one on a light theme), so `ProjectIcon` sets such icons on a plate.
 * `mixed` icons have enough of both to read on either.
 */
export type ProjectIconTone = 'dark' | 'light' | 'mixed';

const SAMPLE_SIZE = 16;
/** Pixels at least this opaque count toward the icon's tone. */
const MIN_ALPHA = 96;
/** Below or above these luminances a pixel reads as dark or light. */
const DARK_LUMINANCE = 0.12;
const LIGHT_LUMINANCE = 0.6;
/** Share of opaque pixels that may be of the other kind before an icon is mixed. */
const TOLERANCE = 0.1;

/** Classifies RGBA pixel data, as read from a canvas. */
export function classifyIconTone(pixels: ArrayLike<number>): ProjectIconTone {
  let opaque = 0;
  let notDark = 0;
  let notLight = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    if (pixels[index + 3] < MIN_ALPHA) continue;
    opaque += 1;
    const luminance = relativeLuminance({ r: pixels[index], g: pixels[index + 1], b: pixels[index + 2] });
    if (luminance > DARK_LUMINANCE) notDark += 1;
    if (luminance < LIGHT_LUMINANCE) notLight += 1;
  }
  if (opaque === 0) return 'mixed';
  if (notDark / opaque <= TOLERANCE) return 'dark';
  if (notLight / opaque <= TOLERANCE) return 'light';
  return 'mixed';
}

// Keyed by object URL; bounded because refreshed icons get new URLs.
const TONE_CACHE_CAPACITY = 400;
const tones = new Map<string, ProjectIconTone>();

export function getCachedIconTone(url: string): ProjectIconTone | undefined {
  return tones.get(url);
}

/**
 * Measures a loaded icon once per URL. Icons are same-origin object URLs, so
 * the canvas is never tainted; if reading still fails the icon counts as mixed
 * and renders as before.
 */
export function measureIconTone(image: HTMLImageElement, url: string): ProjectIconTone {
  const cached = tones.get(url);
  if (cached) return cached;
  let tone: ProjectIconTone = 'mixed';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context) {
      context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      tone = classifyIconTone(context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
    }
  } catch {
    tone = 'mixed';
  }
  tones.set(url, tone);
  if (tones.size > TONE_CACHE_CAPACITY) {
    const oldest = tones.keys().next().value;
    if (oldest !== undefined) tones.delete(oldest);
  }
  return tone;
}
