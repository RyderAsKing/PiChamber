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
  const [theme, system] = await Promise.all([
    import(pathToFileURL(join(themeDir, 'theme.js')).href),
    import(pathToFileURL(join(themeDir, 'system-theme.js')).href),
  ]);
  for (const name of ['resolveThemeSetting', 'getResolvedThemeColors', 'getThemeExportColors', 'isLightTheme', 'getAvailableThemes']) {
    if (typeof theme[name] !== 'function') throw new Error(`Pi's theme module has no ${name}()`);
  }
  for (const name of ['generateSystemThemeColors', 'terminalAppearance']) {
    if (typeof system[name] !== 'function') throw new Error(`Pi's system theme module has no ${name}()`);
  }
  if (typeof system.SYSTEM_THEME_NAME !== 'string') throw new Error("Pi's system theme module has no SYSTEM_THEME_NAME");
  return { theme, system };
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

/** Known tokens with concrete `#rrggbb` colours; Pi's "" (terminal default) is left out. */
const concreteColors = (colors) => Object.fromEntries(
  Object.entries(colors ?? {})
    .filter(([token, color]) => TOKENS.has(token) && typeof color === 'string' && HEX.test(color))
    .map(([token, color]) => [token, color.toLowerCase()]),
);

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
    const { theme, system } = await load();
    const background = toRgb(terminal.background);
    const foreground = toRgb(terminal.foreground);
    const terminalAppearance = system.terminalAppearance(background, foreground);
    const requested = theme.resolveThemeSetting(typeof themeSetting === 'string' ? themeSetting : undefined, terminalAppearance);
    const known = requested && requested !== system.SYSTEM_THEME_NAME && theme.getAvailableThemes().includes(requested);
    if (known) {
      try {
        const colors = concreteColors(theme.getResolvedThemeColors(requested));
        const pageBg = theme.getThemeExportColors(requested)?.pageBg;
        return {
          theme: requested,
          appearance: theme.isLightTheme(requested) ? 'light' : 'dark',
          ...(typeof pageBg === 'string' && HEX.test(pageBg) ? { background: pageBg.toLowerCase() } : {}),
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
