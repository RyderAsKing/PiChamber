import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { THEME_BG_COLORS, THEME_COLORS } from './extension-theme.js';

/**
 * Pi's colours for extension surfaces: the colours Pi would draw with in a
 * terminal that has PiChamber's palette.
 *
 * Extensions colour through Pi's theme names (`accent`, `border`, `dim`,
 * ...); the marker theme (extension-theme.js) sends the names, and this
 * module says what they are:
 * - The `system` theme (Pi's default) is generated from the terminal's
 *   background, foreground and 16 colours, here the ones the browser draws
 *   the surface with. Tokens Pi leaves to the terminal default are omitted.
 * - A named theme (`dark`, `light`, a custom one) uses its own colours, and
 *   its export page background when it has one.
 * - A light/dark pair (`light/dark`) picks by the terminal's appearance.
 * An unknown theme falls back to `system`, as Pi does.
 *
 * Pi exports none of this from its package root, so the theme modules are
 * loaded from Pi's install by path. If they move or change shape, resolving
 * throws and surfaces keep PiChamber's own colours.
 */

const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const TOKENS = new Set([...THEME_COLORS, ...THEME_BG_COLORS]);
const HEX = /^#[0-9a-f]{6}$/i;

const loadPiThemeModules = async () => {
  const entry = fileURLToPath(import.meta.resolve(PI_PACKAGE));
  const themeDir = join(dirname(entry), 'modes', 'interactive', 'theme');
  // pi-tui is Pi's dependency, not ours: resolve it from Pi's package.
  const tuiEntry = createRequire(join(dirname(dirname(entry)), 'package.json')).resolve('@earendil-works/pi-tui');
  const [theme, system, tui] = await Promise.all([
    import(pathToFileURL(join(themeDir, 'theme.js')).href),
    import(pathToFileURL(join(themeDir, 'system-theme.js')).href),
    import(pathToFileURL(tuiEntry).href),
  ]);
  for (const name of ['resolveThemeSetting', 'getResolvedThemeColors', 'getThemeExportColors', 'getThemeByName', 'isLightTheme', 'getAvailableThemes']) {
    if (typeof theme[name] !== 'function') throw new Error(`Pi's theme module has no ${name}()`);
  }
  for (const name of ['generateSystemThemeColors', 'terminalAppearance']) {
    if (typeof system[name] !== 'function') throw new Error(`Pi's system theme module has no ${name}()`);
  }
  if (typeof system.SYSTEM_THEME_NAME !== 'string') throw new Error("Pi's system theme module has no SYSTEM_THEME_NAME");
  for (const name of ['parseColor', 'colorToHex']) {
    if (typeof tui[name] !== 'function') throw new Error(`pi-tui has no ${name}()`);
  }
  return { theme, system, toHex: (value) => tui.colorToHex(tui.parseColor(value)) };
};

const toRgb = (hex) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return { r: value >> 16, g: (value >> 8) & 255, b: value & 255 };
};

/** True for `{ background, foreground, palette }` of `#rrggbb` strings, 16 palette entries. */
export const isTerminalColors = (value) => Boolean(
  value && typeof value === 'object'
  && typeof value.background === 'string' && HEX.test(value.background)
  && typeof value.foreground === 'string' && HEX.test(value.foreground)
  && Array.isArray(value.palette) && value.palette.length === 16
  && value.palette.every((color) => typeof color === 'string' && HEX.test(color)),
);

/**
 * Known tokens with concrete `#rrggbb` colours. Pi's "" (terminal default)
 * is left out, so the surface's own foreground and background apply; for a
 * named theme `getResolvedThemeColors` fills those from Pi's process-wide
 * terminal colours or a guess, so `terminalDefaults` names them to drop.
 */
const concreteColors = (colors, terminalDefaults = new Set()) => Object.fromEntries(
  Object.entries(colors ?? {})
    .filter(([token, color]) => TOKENS.has(token) && !terminalDefaults.has(token) && typeof color === 'string' && HEX.test(color))
    .map(([token, color]) => [token, color.toLowerCase()]),
);

/** The tokens a named theme leaves to the terminal default. */
const terminalDefaultTokens = (themeObject) => new Set([
  ...(Array.isArray(themeObject?.defaultForegroundTokens) ? themeObject.defaultForegroundTokens : []),
  ...(Array.isArray(themeObject?.defaultBackgroundTokens) ? themeObject.defaultBackgroundTokens : []),
]);

/** A theme's export colour as `#rrggbb`: Pi passes `#rgb` and `oklch()` through as written. */
const exportHex = (value, toHex) => {
  if (typeof value !== 'string' || value === '') return undefined;
  try {
    const hex = toHex(value);
    return typeof hex === 'string' && HEX.test(hex) ? hex.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
};

export const createExtensionPaletteResolver = ({ loadModules = loadPiThemeModules } = {}) => {
  let modules;
  const load = () => {
    modules ??= loadModules().catch((error) => {
      modules = undefined;
      throw error;
    });
    return modules;
  };

  /**
   * @param {{ themeSetting?: string, terminal: { background: string, foreground: string, palette: string[] } }} input
   * @returns {Promise<{ theme: string, appearance: 'light' | 'dark', background?: string, colors: Record<string, string> }>}
   */
  return async ({ themeSetting, terminal }) => {
    if (!isTerminalColors(terminal)) throw new TypeError('Terminal colours must be #rrggbb values with 16 palette entries.');
    const { theme, system, toHex } = await load();
    const background = toRgb(terminal.background);
    const foreground = toRgb(terminal.foreground);
    const terminalAppearance = system.terminalAppearance(background, foreground);
    const requested = theme.resolveThemeSetting(typeof themeSetting === 'string' ? themeSetting : undefined, terminalAppearance);
    const known = requested && requested !== system.SYSTEM_THEME_NAME && theme.getAvailableThemes().includes(requested);
    if (known) {
      try {
        const colors = concreteColors(theme.getResolvedThemeColors(requested), terminalDefaultTokens(theme.getThemeByName(requested)));
        const pageBg = exportHex(theme.getThemeExportColors(requested)?.pageBg, toHex);
        return {
          theme: requested,
          appearance: theme.isLightTheme(requested) ? 'light' : 'dark',
          ...(pageBg ? { background: pageBg } : {}),
          colors,
        };
      } catch {
        // An invalid theme file: Pi falls back to the system theme too.
      }
    }
    const generated = system.generateSystemThemeColors({
      background,
      foreground,
      palette: terminal.palette.map(toRgb),
      saturation: 1,
      appearanceHint: terminalAppearance,
    });
    return {
      theme: system.SYSTEM_THEME_NAME,
      appearance: generated.appearance === 'light' ? 'light' : 'dark',
      colors: concreteColors(generated.colors),
    };
  };
};
