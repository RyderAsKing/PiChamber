/**
 * PiChamber Theme implementation for pi extensions.
 *
 * Implements the full public Theme interface from Pi SDK (@earendil-works/pi-coding-agent).
 * Encodes semantic ThemeColor (fg) and ThemeBg (bg) values as standard SGR truecolor
 * escape sequences with a reserved marker tuple (r=1, g=1, b=index):
 *   fg: \x1b[38;2;1;1;<index>m … \x1b[39m
 *   bg: \x1b[48;2;1;1;<index>m … \x1b[49m
 *
 * Width-measuring code (such as pi-tui visibleWidth) treats these as standard ANSI
 * SGR sequences, while PiChamber UI parses the marker into theme CSS variables.
 *
 * IMPORTANT: THEME_COLORS and THEME_BG_COLORS must stay strictly in sync with
 * packages/ui/src/lib/pi/ansi.ts on the client side.
 */

export const THEME_COLORS = Object.freeze([
  'accent',
  'border',
  'borderAccent',
  'borderMuted',
  'success',
  'error',
  'warning',
  'muted',
  'dim',
  'text',
  'thinkingText',
  'scrollbarTrack',
  'scrollbarThumb',
  'searchMatchText',
  'userMessageText',
  'customMessageText',
  'customMessageLabel',
  'toolTitle',
  'toolOutput',
  'mdHeading',
  'mdLink',
  'mdLinkUrl',
  'mdCode',
  'mdCodeBlock',
  'mdCodeBlockBorder',
  'mdQuote',
  'mdQuoteBorder',
  'mdHr',
  'mdListBullet',
  'toolDiffAdded',
  'toolDiffRemoved',
  'toolDiffContext',
  'syntaxComment',
  'syntaxKeyword',
  'syntaxFunction',
  'syntaxVariable',
  'syntaxString',
  'syntaxNumber',
  'syntaxType',
  'syntaxOperator',
  'syntaxPunctuation',
  'thinkingOff',
  'thinkingMinimal',
  'thinkingLow',
  'thinkingMedium',
  'thinkingHigh',
  'thinkingXhigh',
  'thinkingMax',
  'bashMode',
]);

export const THEME_BG_COLORS = Object.freeze([
  'selectedBg',
  'searchMatchBg',
  'userMessageBg',
  'customMessageBg',
  'toolPendingBg',
  'toolSuccessBg',
  'toolErrorBg',
]);

const FG_INDEX_MAP = new Map(THEME_COLORS.map((name, index) => [name, index]));
const BG_INDEX_MAP = new Map(THEME_BG_COLORS.map((name, index) => [name, index]));

const FROZEN_COLORS = Object.freeze(
  Object.fromEntries([
    ...THEME_COLORS.map((token, index) => [
      token,
      Object.freeze({ kind: 'rgb', r: 1, g: 1, b: index }),
    ]),
    ...THEME_BG_COLORS.map((token, index) => [
      token,
      Object.freeze({ kind: 'rgb', r: 1, g: 1, b: index }),
    ]),
  ]),
);

/**
 * Creates a Theme-compatible instance implementing all public Theme members.
 */
export const createExtensionTheme = () => {
  const getFgAnsi = (color) => {
    const index = FG_INDEX_MAP.get(color);
    return index !== undefined ? `\x1b[38;2;1;1;${index}m` : '';
  };

  const getBgAnsi = (color) => {
    const index = BG_INDEX_MAP.get(color);
    return index !== undefined ? `\x1b[48;2;1;1;${index}m` : '';
  };

  const resolveColorAnsi = (color, isBg) => {
    if (color === undefined || color === null) return '';
    if (typeof color === 'string') {
      return isBg ? getBgAnsi(color) : getFgAnsi(color);
    }
    if (typeof color === 'object') {
      if (color.kind === 'rgb' && Number.isFinite(color.r) && Number.isFinite(color.g) && Number.isFinite(color.b)) {
        const r = Math.round(color.r);
        const g = Math.round(color.g);
        const b = Math.round(color.b);
        return `\x1b[${isBg ? 48 : 38};2;${r};${g};${b}m`;
      }
      if (color.kind === 'indexed' && Number.isFinite(color.index)) {
        return `\x1b[${isBg ? 48 : 38};5;${Math.round(color.index)}m`;
      }
    }
    // Other Color kinds (oklch) have no SGR form here and render unstyled.
    return '';
  };

  const style = (text, options = {}) => {
    const fgAnsi = resolveColorAnsi(options.fg, false);
    const bgAnsi = resolveColorAnsi(options.bg, true);
    let prefix = '';
    let suffix = '';
    if (fgAnsi) {
      prefix += fgAnsi;
      suffix = '\x1b[39m';
    }
    if (bgAnsi) {
      prefix += bgAnsi;
      suffix = `\x1b[49m${suffix}`;
    }
    if (options.bold) prefix += '\x1b[1m';
    if (options.dim) prefix += '\x1b[2m';
    if (options.bold || options.dim) suffix = `\x1b[22m${suffix}`;
    if (options.italic) {
      prefix += '\x1b[3m';
      suffix = `\x1b[23m${suffix}`;
    }
    if (options.underline) {
      prefix += '\x1b[4m';
      suffix = `\x1b[24m${suffix}`;
    }
    if (options.inverse) {
      prefix += '\x1b[7m';
      suffix = `\x1b[27m${suffix}`;
    }
    if (options.strikethrough) {
      prefix += '\x1b[9m';
      suffix = `\x1b[29m${suffix}`;
    }
    return `${prefix}${text}${suffix}`;
  };

  const fg = (color, text) => {
    const ansi = getFgAnsi(color);
    if (!ansi) return text;
    return `${ansi}${text}\x1b[39m`;
  };

  const bg = (color, text) => {
    const ansi = getBgAnsi(color);
    if (!ansi) return text;
    return `${ansi}${text}\x1b[49m`;
  };

  const bold = (text) => `\x1b[1m${text}\x1b[22m`;
  const italic = (text) => `\x1b[3m${text}\x1b[23m`;
  const underline = (text) => `\x1b[4m${text}\x1b[24m`;
  const inverse = (text) => `\x1b[7m${text}\x1b[27m`;
  const strikethrough = (text) => `\x1b[9m${text}\x1b[29m`;

  const getColorMode = () => 'truecolor';

  const getThinkingBorderColor = (level) => {
    const cap = typeof level === 'string' && level.length > 0
      ? level.charAt(0).toUpperCase() + level.slice(1)
      : '';
    const candidate = `thinking${cap}`;
    const color = FG_INDEX_MAP.has(candidate) ? candidate : 'thinkingOff';
    return (str) => fg(color, str);
  };

  const getBashModeBorderColor = () => (str) => fg('bashMode', str);

  // The daemon serves multiple clients with different themes and has no
  // single terminal appearance. Return dark as the fixed default.
  const appearance = 'dark';

  return {
    name: 'pichamber',
    get appearance() { return appearance; },
    get colors() { return FROZEN_COLORS; },
    style,
    fg,
    bg,
    bold,
    italic,
    underline,
    inverse,
    strikethrough,
    getFgAnsi,
    getBgAnsi,
    getColorMode,
    getThinkingBorderColor,
    getBashModeBorderColor,
  };
};
