import * as React from 'react';

import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { piClient } from '@/lib/pi/client';
import type { PiExtensionPalette, PiTerminalColors } from '@/lib/pi/protocol';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { convertThemeToXterm, type TerminalTheme } from '@/lib/terminalTheme';
import type { Theme } from '@/types/theme';

/**
 * The colours an extension surface draws with, as `--term-*` variables that
 * `lib/pi/ansi.ts` reads before PiChamber's own tokens:
 * - the screen: the Terminal panel's background, foreground and 16 colours
 *   for the app theme (`convertThemeToXterm`), so raw SGR colours look as
 *   they do there;
 * - Pi's theme colours (`accent`, `border`, `selectedBg`, ...), from the
 *   daemon: Pi's system theme generated from that palette, or the user's own
 *   Pi theme (`extension-palette.js`).
 * The screen applies at once; Pi's colours follow when the daemon answers,
 * cached per runtime and palette. Until then, or if it fails, Pi's names
 * keep PiChamber's tokens. Pi-drawn lines elsewhere (tool and message
 * renders, widgets, statuses) get the colours without the screen
 * (`useExtensionTextClass`); dialogs and notices are PiChamber's own and
 * keep its tokens.
 */

const toHex = (value: string): string | null => {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!match) return null;
  const digits = match[1]!;
  const six = digits.length === 3 ? digits.split('').map((digit) => digit + digit).join('') : digits.slice(0, 6);
  return `#${six.toLowerCase()}`;
};

const ansiColors = (terminal: TerminalTheme): string[] => [
  terminal.black, terminal.red, terminal.green, terminal.yellow,
  terminal.blue, terminal.magenta, terminal.cyan, terminal.white,
  terminal.brightBlack, terminal.brightRed, terminal.brightGreen, terminal.brightYellow,
  terminal.brightBlue, terminal.brightMagenta, terminal.brightCyan, terminal.brightWhite,
];

/** The Terminal panel's colours for a theme, or null when one is not a hex colour. */
export const terminalColorsOf = (theme: Theme): PiTerminalColors | null => {
  const terminal = convertThemeToXterm(theme);
  const background = toHex(terminal.background);
  const foreground = toHex(terminal.foreground);
  const palette = ansiColors(terminal).map(toHex);
  if (!background || !foreground || palette.some((color) => color === null)) return null;
  return { background, foreground, palette: palette as string[] };
};

type Screen = { terminal: PiTerminalColors; key: string };

// Per theme object, so every row of a long transcript shares one result.
const screens = new WeakMap<Theme, Screen | null>();
const screenOf = (theme: Theme): Screen | null => {
  let screen = screens.get(theme);
  if (screen === undefined) {
    const terminal = terminalColorsOf(theme);
    screen = terminal ? { terminal, key: `${terminal.background}${terminal.foreground}${terminal.palette.join('')}` } : null;
    screens.set(theme, screen);
  }
  return screen;
};

/** The `--term-*` variables for a screen and, when known, Pi's colours. */
export const paletteStyle = (screen: PiTerminalColors, palette: PiExtensionPalette | null): React.CSSProperties => {
  const vars: Record<string, string> = {
    '--term-background': palette?.background ?? screen.background,
    '--term-foreground': palette?.colors.text ?? screen.foreground,
  };
  screen.palette.forEach((color, index) => {
    vars[`--term-ansi-${index}`] = color;
  });
  for (const [token, color] of Object.entries(palette?.colors ?? {})) vars[`--term-${token}`] = color;
  return vars as React.CSSProperties;
};

/**
 * The variables for Pi-drawn lines on PiChamber's own background (tool and
 * message renders, widgets, statuses): the 16 colours, and Pi's colours
 * only when made for the app's appearance. A pinned theme for the other one
 * would put light text on a light card, so its names keep PiChamber's tokens.
 */
export const textPaletteStyle = (
  terminal: PiTerminalColors,
  palette: PiExtensionPalette | null,
  appearance: 'light' | 'dark',
): React.CSSProperties => {
  const vars: Record<string, string> = {};
  terminal.palette.forEach((color, index) => {
    vars[`--term-ansi-${index}`] = color;
  });
  if (palette && palette.appearance === appearance) {
    for (const [token, color] of Object.entries(palette.colors)) vars[`--term-${token}`] = color;
  }
  return vars as React.CSSProperties;
};

type Entry = { palette: PiExtensionPalette | null; at: number };
const entries = new Map<string, Entry>();
const inFlight = new Set<string>();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const samePalette = (a: PiExtensionPalette | null, b: PiExtensionPalette | null): boolean =>
  a === b || (a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b));

/**
 * Asks the daemon unless an answer (or failure) for `key` is younger than
 * `maxAge`. One request per key at a time; a failure keeps the last colours,
 * and an unchanged answer keeps the same object, so nothing re-renders.
 */
const refresh = (key: string, terminal: PiTerminalColors, runtimeKey: string, maxAge: number): void => {
  const entry = entries.get(key);
  if (inFlight.has(key) || (entry && Date.now() - entry.at < maxAge)) return;
  inFlight.add(key);
  const settle = (next: PiExtensionPalette | null) => {
    inFlight.delete(key);
    const previous = entries.get(key)?.palette ?? null;
    const palette = samePalette(previous, next) ? previous : next;
    entries.set(key, { palette, at: Date.now() });
    if (palette !== previous) listeners.forEach((listener) => listener());
  };
  piClient.getExtensionPalette(terminal, { runtimeKey }).then(settle, () => settle(entry?.palette ?? null));
};

/** A surface asks again on opening, so a changed Pi theme shows on the next one. */
const SURFACE_MAX_AGE = 0;
/** Lines in the transcript are many; they reuse an answer for a minute. */
const TEXT_MAX_AGE = 60_000;

/** `enabled: false` asks nothing, for a component with no Pi lines showing. */
const usePalette = (maxAge: number, enabled: boolean) => {
  const themes = useOptionalThemeSystem();
  const current = themes?.currentTheme;
  const screen = current ? screenOf(current) : null;
  const runtimeKey = getRuntimeKey();
  const key = enabled && screen ? `${runtimeKey}\n${screen.key}` : null;
  const palette = React.useSyncExternalStore(
    subscribe,
    () => (key ? entries.get(key)?.palette ?? null : null),
    () => null,
  );
  React.useEffect(() => {
    if (key && screen) refresh(key, screen.terminal, runtimeKey, maxAge);
  }, [key, screen, runtimeKey, maxAge]);
  return { themes, current, terminal: key ? screen?.terminal ?? null : null, palette };
};

/** The style for a surface's screen, or undefined without a theme (tests). */
export const useExtensionPaletteStyle = (): React.CSSProperties | undefined => {
  const { themes, current, terminal, palette } = usePalette(SURFACE_MAX_AGE, true);
  return React.useMemo(() => {
    if (!themes || !current || !terminal) return undefined;
    // A named Pi theme made for the other appearance (Pi's dark theme in a
    // light app) gets the other app theme's screen, so raw colours suit it.
    let screen = terminal;
    if (palette && palette.appearance !== current.metadata.variant) {
      const otherId = palette.appearance === 'dark' ? themes.darkThemeId : themes.lightThemeId;
      const other = themes.availableThemes.find((theme) => theme.metadata.id === otherId);
      screen = (other && screenOf(other)?.terminal) ?? terminal;
    }
    return paletteStyle(screen, palette);
  }, [themes, current, terminal, palette]);
};

// One style object per screen, palette and appearance, shared by every row.
const textStyles = new WeakMap<PiTerminalColors, Map<PiExtensionPalette | null, Map<string, React.CSSProperties>>>();
const sharedTextStyle = (terminal: PiTerminalColors, palette: PiExtensionPalette | null, appearance: 'light' | 'dark') => {
  let byPalette = textStyles.get(terminal);
  if (!byPalette) textStyles.set(terminal, byPalette = new Map());
  let byAppearance = byPalette.get(palette);
  if (!byAppearance) {
    // Only the latest palette is kept.
    byPalette.clear();
    byPalette.set(palette, byAppearance = new Map());
  }
  let style = byAppearance.get(appearance);
  if (!style) byAppearance.set(appearance, style = textPaletteStyle(terminal, palette, appearance));
  return style;
};

// Lines outside a surface are many (a transcript can mount dozens), so they
// share one stylesheet rule per palette instead of each carrying ~70 inline
// custom properties. Values are #rrggbb from the route's whitelist and names
// come from fixed lists, so the rule text is safe to build.
const ruleClasses = new WeakMap<React.CSSProperties, string>();
let ruleSheet: HTMLStyleElement | null = null;
let ruleCount = 0;
const classFor = (style: React.CSSProperties): string => {
  let className = ruleClasses.get(style);
  if (!className) {
    className = `pi-term-colors-${ruleCount += 1}`;
    ruleClasses.set(style, className);
    if (typeof document !== 'undefined') {
      const body = Object.entries(style as Record<string, string>).map(([name, value]) => `${name}:${value}`).join(';');
      ruleSheet ??= document.head.appendChild(document.createElement('style'));
      ruleSheet.appendChild(document.createTextNode(`.${className}{${body}}`));
    }
  }
  return className;
};

/**
 * The class for Pi-drawn lines outside a surface, or undefined without a
 * theme. Pass `enabled: false` while the component shows no such lines.
 */
export const useExtensionTextClass = (enabled = true): string | undefined => {
  const { current, terminal, palette } = usePalette(TEXT_MAX_AGE, enabled);
  return current && terminal ? classFor(sharedTextStyle(terminal, palette, current.metadata.variant)) : undefined;
};

/** Classes for the area a surface's lines sit on. */
export const SCREEN_CLASS = 'bg-[var(--term-background)] text-[color:var(--term-foreground)]';
