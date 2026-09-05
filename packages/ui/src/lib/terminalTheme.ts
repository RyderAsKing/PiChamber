import type { Theme } from '@/types/theme';

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground?: string;
  selectionInactiveBackground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export function convertThemeToXterm(theme: Theme): TerminalTheme {
  const { colors } = theme;
  const syntax = colors.syntax.base;

  return {

    background: colors.surface.background,
    foreground: syntax.foreground,
    cursor: colors.interactive.cursor,
    cursorAccent: colors.surface.background,

    selectionBackground: colors.interactive.selection,
    selectionForeground: colors.interactive.selectionForeground,
    selectionInactiveBackground: colors.interactive.selection + '50',

    black: colors.surface.muted,
    red: colors.status.error,
    green: colors.status.success,
    yellow: colors.status.warning,
    blue: syntax.function,
    magenta: syntax.keyword,
    cyan: syntax.type,
    white: syntax.foreground,

    brightBlack: syntax.comment,
    brightRed: colors.status.error,
    brightGreen: colors.status.success,
    brightYellow: colors.status.warning,
    brightBlue: syntax.function,
    brightMagenta: syntax.keyword,
    brightCyan: syntax.type,
    brightWhite: colors.surface.elevatedForeground,
  };
}

/**
 * Get terminal options for the xterm.js renderer.
 */
export function getXtermTerminalOptions(
  fontFamily: string,
  fontSize: number,
  theme: TerminalTheme,
) {
  const powerlineFallbacks =
    '"JetBrainsMonoNL Nerd Font", "FiraCode Nerd Font", "Cascadia Code PL", "Fira Code", "JetBrains Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", "Courier New", monospace';
  const augmentedFontFamily = `${fontFamily}, ${powerlineFallbacks}`;

  return {
    // TerminalViewport enables blinking only while its input owns focus.
    cursorBlink: false,
    cursorStyle: 'bar' as const,
    cursorInactiveStyle: 'none' as const,
    fontSize,
    fontFamily: augmentedFontFamily,
    allowTransparency: false,
    convertEol: true,
    scrollback: 10_000,
    theme: {
      background: theme.background,
      foreground: theme.foreground,
      cursor: theme.cursor,
      cursorAccent: theme.cursorAccent,
      selectionBackground: theme.selectionBackground,
      selectionForeground: theme.selectionForeground,
      selectionInactiveBackground: theme.selectionInactiveBackground,
      black: theme.black,
      red: theme.red,
      green: theme.green,
      yellow: theme.yellow,
      blue: theme.blue,
      magenta: theme.magenta,
      cyan: theme.cyan,
      white: theme.white,
      brightBlack: theme.brightBlack,
      brightRed: theme.brightRed,
      brightGreen: theme.brightGreen,
      brightYellow: theme.brightYellow,
      brightBlue: theme.brightBlue,
      brightMagenta: theme.brightMagenta,
      brightCyan: theme.brightCyan,
      brightWhite: theme.brightWhite,
    },
  };
}
