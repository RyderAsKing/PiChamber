/**
 * WCAG contrast helpers for theme colors. Themes (built-in and custom) choose
 * their own text colors; the CSS generator uses these to hold secondary text
 * to a readable floor without touching colors that already meet it.
 */

type Rgba = { r: number; g: number; b: number; a: number };

/** WCAG AA for body text. */
export const MIN_TEXT_CONTRAST = 4.5;

/** Parses `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`; anything else is `null`. */
export function parseColor(value: string | null | undefined): Rgba | null {
  if (!value) return null;
  const color = value.trim();
  if (color.startsWith('#')) {
    let hex = color.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      hex = hex.split('').map((char) => char + char).join('');
    }
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) return null;
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
    };
  }
  const match = color.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i);
  if (!match) return null;
  const alphaText = match[4];
  const alpha = alphaText === undefined
    ? 1
    : alphaText.endsWith('%') ? parseFloat(alphaText) / 100 : parseFloat(alphaText);
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: Math.min(1, Math.max(0, alpha)) };
}

function toHex({ r, g, b }: Rgba): string {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

/** Flattens a translucent color onto an opaque backdrop. */
function composite(color: Rgba, backdrop: Rgba): Rgba {
  return {
    r: color.r * color.a + backdrop.r * (1 - color.a),
    g: color.g * color.a + backdrop.g * (1 - color.a),
    b: color.b * color.a + backdrop.b * (1 - color.a),
    a: 1,
  };
}

/** Mixes in 8-bit steps, so the ratio checked is the ratio of the hex emitted. */
function mix(from: Rgba, to: Rgba, amount: number): Rgba {
  return {
    r: Math.round(from.r + (to.r - from.r) * amount),
    g: Math.round(from.g + (to.g - from.g) * amount),
    b: Math.round(from.b + (to.b - from.b) * amount),
    a: 1,
  };
}

export function relativeLuminance({ r, g, b }: Pick<Rgba, 'r' | 'g' | 'b'>): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(a: Rgba, b: Rgba): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** The lowest contrast `color` has against any of `surfaces`. */
function worstRatio(color: Rgba, surfaces: Rgba[]): number {
  return Math.min(...surfaces.map((surface) => ratio(composite(color, surface), surface)));
}

function parseSurfaces(surfaces: Array<string | null | undefined>): Rgba[] {
  return surfaces
    .map(parseColor)
    .filter((surface): surface is Rgba => surface !== null)
    .map((surface) => ({ ...surface, a: 1 }));
}

export function contrastRatio(color: string, surface: string): number | null {
  const fg = parseColor(color);
  const bg = parseSurfaces([surface])[0];
  if (!fg || !bg) return null;
  return ratio(composite(fg, bg), bg);
}

/**
 * Returns `color` unchanged when it reaches `min` against every surface;
 * otherwise moves it toward `towards` (the theme's primary text) in small
 * steps until it does. Unparseable input is returned as is.
 */
export function ensureContrast(
  color: string,
  surfaces: Array<string | null | undefined>,
  towards: string,
  min: number = MIN_TEXT_CONTRAST,
): string {
  const parsed = parseColor(color);
  const target = parseColor(towards);
  const backdrops = parseSurfaces(surfaces);
  if (!parsed || !target || backdrops.length === 0) return color;
  if (worstRatio(parsed, backdrops) >= min) return color;

  const base = composite(parsed, backdrops[0]);
  const solidTarget = composite(target, backdrops[0]);
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mix(base, solidTarget, step / 20);
    if (worstRatio(candidate, backdrops) >= min) return toHex(candidate);
  }
  return toHex(solidTarget);
}

/**
 * A quieter step below `muted` for tertiary text (timestamps, counts, hints):
 * faded toward the background as far as it can go while staying readable,
 * never fainter than `maxFade`. Equals `muted` when there is no headroom.
 */
export function deriveSubtle(
  muted: string,
  surfaces: Array<string | null | undefined>,
  background: string,
  { min = MIN_TEXT_CONTRAST, maxFade = 0.3 }: { min?: number; maxFade?: number } = {},
): string {
  const parsed = parseColor(muted);
  const backdrops = parseSurfaces(surfaces);
  const bg = parseSurfaces([background])[0];
  if (!parsed || !bg || backdrops.length === 0) return muted;

  const base = composite(parsed, bg);
  let best: Rgba | null = null;
  for (let step = 1; step <= 30; step += 1) {
    const amount = (maxFade * step) / 30;
    const candidate = mix(base, bg, amount);
    if (worstRatio(candidate, backdrops) < min) break;
    best = candidate;
  }
  return best ? toHex(best) : muted;
}
