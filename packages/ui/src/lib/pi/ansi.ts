/**
 * ANSI escape handling and SGR segment parsing for pi extension-authored text.
 *
 * Pi TUI extensions style status texts, widget lines, notify messages, and
 * dialog strings with ANSI SGR escapes (`ctx.ui.theme.fg(...)`, basic 16-color,
 * 256-color, or 24-bit truecolor).
 *
 * Semantic theme colors from `ctx.ui.theme.fg(color, text)` are encoded as
 * truecolor SGR sequences with a reserved marker tuple (r=1, g=1, b=index):
 *   fg: \x1b[38;2;1;1;<index>m … \x1b[39m
 *   bg: \x1b[48;2;1;1;<index>m … \x1b[49m
 *
 * IMPORTANT: THEME_COLORS and THEME_BG_COLORS must stay strictly in sync with
 * packages/web/server/lib/pi/session-daemon/extension-theme.js on the server side.
 */

import type { CSSProperties } from 'react';

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
] as const);

export type ThemeColorName = (typeof THEME_COLORS)[number];

export const THEME_BG_COLORS = Object.freeze([
  'selectedBg',
  'searchMatchBg',
  'userMessageBg',
  'customMessageBg',
  'toolPendingBg',
  'toolSuccessBg',
  'toolErrorBg',
] as const);

export type ThemeBgName = (typeof THEME_BG_COLORS)[number];

export const THEME_COLOR_VARS: Readonly<Record<number, string>> = Object.freeze({
  0: 'var(--primary)', // accent
  1: 'var(--border)', // border
  2: 'var(--primary)', // borderAccent
  3: 'var(--border)', // borderMuted
  4: 'var(--status-success)', // success
  5: 'var(--status-error)', // error
  6: 'var(--status-warning)', // warning
  7: 'var(--muted-foreground)', // muted
  8: 'var(--muted-foreground)', // dim
  9: 'var(--foreground)', // text
  10: 'var(--muted-foreground)', // thinkingText
  11: 'transparent', // scrollbarTrack
  12: 'var(--oc-scrollbar-thumb, var(--muted-foreground))', // scrollbarThumb
  13: 'var(--foreground)', // searchMatchText
  14: 'var(--foreground)', // userMessageText
  15: 'var(--foreground)', // customMessageText
  16: 'var(--muted-foreground)', // customMessageLabel
  17: 'var(--tools-title)', // toolTitle
  18: 'var(--tools-description)', // toolOutput
  19: 'var(--markdown-heading1, var(--primary))', // mdHeading
  20: 'var(--markdown-link, var(--primary))', // mdLink
  21: 'var(--muted-foreground)', // mdLinkUrl
  22: 'var(--markdown-inline-code, var(--syntax-string, var(--status-success)))', // mdCode
  23: 'var(--syntax-foreground, var(--foreground))', // mdCodeBlock
  24: 'var(--tools-border, var(--border))', // mdCodeBlockBorder
  25: 'var(--markdown-blockquote, var(--muted-foreground))', // mdQuote
  26: 'var(--markdown-blockquote-border, var(--border))', // mdQuoteBorder
  27: 'var(--markdown-hr, var(--border))', // mdHr
  28: 'var(--markdown-list-marker, var(--primary))', // mdListBullet
  29: 'var(--tools-edit-added, var(--status-success))', // toolDiffAdded
  30: 'var(--tools-edit-removed, var(--status-error))', // toolDiffRemoved
  31: 'var(--muted-foreground)', // toolDiffContext
  32: 'var(--syntax-comment, var(--muted-foreground))', // syntaxComment
  33: 'var(--syntax-keyword, var(--primary))', // syntaxKeyword
  34: 'var(--syntax-function, var(--primary))', // syntaxFunction
  35: 'var(--syntax-variable, var(--foreground))', // syntaxVariable
  36: 'var(--syntax-string, var(--status-success))', // syntaxString
  37: 'var(--syntax-number, var(--status-warning))', // syntaxNumber
  38: 'var(--syntax-type, var(--status-info))', // syntaxType
  39: 'var(--syntax-operator, var(--foreground))', // syntaxOperator
  40: 'var(--syntax-punctuation, var(--muted-foreground))', // syntaxPunctuation
  41: 'var(--muted-foreground)', // thinkingOff
  42: 'var(--muted-foreground)', // thinkingMinimal
  43: 'var(--muted-foreground)', // thinkingLow
  44: 'var(--muted-foreground)', // thinkingMedium
  45: 'var(--muted-foreground)', // thinkingHigh
  46: 'var(--muted-foreground)', // thinkingXhigh
  47: 'var(--muted-foreground)', // thinkingMax
  48: 'var(--primary)', // bashMode
});

export const THEME_BG_VARS: Readonly<Record<number, string>> = Object.freeze({
  0: 'var(--interactive-selection)', // selectedBg
  1: 'var(--interactive-selection)', // searchMatchBg
  2: 'var(--surface-elevated, var(--card))', // userMessageBg
  3: 'var(--surface-muted)', // customMessageBg
  4: 'var(--status-warning-background, color-mix(in srgb, var(--status-warning) 15%, transparent))', // toolPendingBg
  5: 'var(--status-success-background, color-mix(in srgb, var(--status-success) 15%, transparent))', // toolSuccessBg
  6: 'var(--status-error-background, color-mix(in srgb, var(--status-error) 15%, transparent))', // toolErrorBg
});

const BASIC_FG_COLORS: Readonly<Record<number, string>> = Object.freeze({
  30: 'var(--muted-foreground)', // black
  31: 'var(--status-error)', // red
  32: 'var(--status-success)', // green
  33: 'var(--status-warning)', // yellow
  34: 'var(--status-info)', // blue
  35: 'var(--primary)', // magenta
  36: 'var(--status-info)', // cyan
  37: 'var(--foreground)', // white
  90: 'var(--muted-foreground)', // bright black
  91: 'var(--status-error)', // bright red
  92: 'var(--status-success)', // bright green
  93: 'var(--status-warning)', // bright yellow
  94: 'var(--status-info)', // bright blue
  95: 'var(--primary)', // bright magenta
  96: 'var(--status-info)', // bright cyan
  97: 'var(--foreground)', // bright white
});

const BASIC_BG_COLORS: Readonly<Record<number, string>> = Object.freeze({
  40: 'var(--muted)', // black
  41: 'var(--status-error-background, color-mix(in srgb, var(--status-error) 15%, transparent))', // red
  42: 'var(--status-success-background, color-mix(in srgb, var(--status-success) 15%, transparent))', // green
  43: 'var(--status-warning-background, color-mix(in srgb, var(--status-warning) 15%, transparent))', // yellow
  44: 'var(--status-info-background, color-mix(in srgb, var(--status-info) 15%, transparent))', // blue
  45: 'var(--surface-elevated)', // magenta
  46: 'var(--status-info-background, color-mix(in srgb, var(--status-info) 15%, transparent))', // cyan
  47: 'var(--surface-elevated)', // white
  100: 'var(--muted)',
  101: 'var(--status-error-background, color-mix(in srgb, var(--status-error) 15%, transparent))',
  102: 'var(--status-success-background, color-mix(in srgb, var(--status-success) 15%, transparent))',
  103: 'var(--status-warning-background, color-mix(in srgb, var(--status-warning) 15%, transparent))',
  104: 'var(--status-info-background, color-mix(in srgb, var(--status-info) 15%, transparent))',
  105: 'var(--surface-elevated)',
  106: 'var(--status-info-background, color-mix(in srgb, var(--status-info) 15%, transparent))',
  107: 'var(--surface-elevated)',
});

function xterm256ToColor(code: number): string {
  if (code < 0 || code > 255) return 'var(--foreground)';
  if (code < 16) {
    return BASIC_FG_COLORS[code < 8 ? code + 30 : code - 8 + 90] ?? 'var(--foreground)';
  }
  if (code >= 232) {
    const v = 8 + (code - 232) * 10;
    return `rgb(${v}, ${v}, ${v})`;
  }
  const c = code - 16;
  const b = c % 6;
  const g = Math.floor(c / 6) % 6;
  const r = Math.floor(c / 36);
  const steps = [0, 95, 135, 175, 215, 255];
  return `rgb(${steps[r]}, ${steps[g]}, ${steps[b]})`;
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|_[^\u0007\u001b]*(?:\u0007|\u001b\\)|[PX^_][^\u001b]*\u001b\\|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex
const ANSI_TRUECOLOR_FG_PATTERN = /\u001b\[38;2;(\d+);(\d+);(\d+)m/;

/**
 * The URL to open for an OSC 8 hyperlink, or undefined when it is not an
 * http(s) URL. Programs choose these targets, so nothing else is linked.
 */
export function safeHyperlink(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Remove every ANSI escape sequence (colors, cursor moves, resets, OSC/APC). */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * Extract a leading 24-bit foreground color as a CSS `rgb()` string, or
 * `undefined` when the text carries no truecolor sequence.
 */
export function extractAnsiTruecolor(text: string): string | undefined {
  const match = text.match(ANSI_TRUECOLOR_FG_PATTERN);
  if (!match) return undefined;
  const r = parseInt(match[1]!, 10);
  const g = parseInt(match[2]!, 10);
  const b = parseInt(match[3]!, 10);
  if (r === 1 && g === 1 && b in THEME_COLOR_VARS) {
    return THEME_COLOR_VARS[b];
  }
  return `rgb(${r}, ${g}, ${b})`;
}

/** Fast containment check so clean text skips regex work entirely. */
export function containsAnsiEscape(text: string): boolean {
  return text.includes('\u001b');
}

export interface AnsiSegment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
  /** Target of an OSC 8 hyperlink around this text, as the program sent it. */
  href?: string;
}

interface StyleState {
  fg?: string;
  bg?: string;
  href?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  inverse: boolean;
}

/**
 * Parses ANSI escape sequences into styled text segments.
 * Fast-path: plain text with no ESC returns a single segment without allocation overhead.
 */
export function parseAnsiSegments(text: string): AnsiSegment[] {
  if (!text) return [];
  if (!containsAnsiEscape(text)) {
    return [{ text }];
  }

  const segments: AnsiSegment[] = [];
  const style: StyleState = {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    strikethrough: false,
    inverse: false,
  };

  // Regex to match CSI sequences: \x1b[ <params> <final-byte>
  // or other escapes like OSC (\x1b]...\x07), APC (\x1b_...\x07), etc.
  // eslint-disable-next-line no-control-regex
  const tokenRegex = /\u001b(?:\[([0-?]*)[ -/]*([@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|_[^\u0007\u001b]*(?:\u0007|\u001b\\)|[PX^_][^\u001b]*\u001b\\|[@-Z\\-_])/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const pushText = (chunk: string) => {
    if (!chunk) return;
    if (segments.length > 0) {
      const prev = segments[segments.length - 1]!;
      if (
        (prev.fg ?? undefined) === style.fg &&
        (prev.bg ?? undefined) === style.bg &&
        Boolean(prev.bold) === style.bold &&
        Boolean(prev.dim) === style.dim &&
        Boolean(prev.italic) === style.italic &&
        Boolean(prev.underline) === style.underline &&
        Boolean(prev.strikethrough) === style.strikethrough &&
        Boolean(prev.inverse) === style.inverse &&
        prev.href === style.href
      ) {
        prev.text += chunk;
        return;
      }
    }
    const seg: AnsiSegment = { text: chunk };
    if (style.fg) seg.fg = style.fg;
    if (style.bg) seg.bg = style.bg;
    if (style.bold) seg.bold = true;
    if (style.dim) seg.dim = true;
    if (style.italic) seg.italic = true;
    if (style.underline) seg.underline = true;
    if (style.strikethrough) seg.strikethrough = true;
    if (style.inverse) seg.inverse = true;
    if (style.href) seg.href = style.href;
    segments.push(seg);
  };

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      pushText(text.slice(lastIndex, match.index));
    }
    lastIndex = tokenRegex.lastIndex;

    const paramsStr = match[1];
    const finalByte = match[2];

    // OSC 8 hyperlink: ESC ] 8 ; params ; URI ST. An empty URI ends the link.
    // SGR resets leave it alone, as in a terminal.
    if (match[0].startsWith('\u001b]8;')) {
      // eslint-disable-next-line no-control-regex
      const body = match[0].slice(4).replace(/(?:\u0007|\u001b\\)$/, '');
      const uri = body.slice(body.indexOf(';') + 1);
      style.href = uri || undefined;
      continue;
    }

    // Only CSI SGR ('m') modifies style state when parameter string contains only digits and ';'. Non-SGR CSI or other escapes are stripped.
    if (finalByte === 'm' && (!paramsStr || /^[0-9;]*$/.test(paramsStr))) {
      const rawCodes = (paramsStr || '0').split(';').map((s) => (s === '' ? 0 : parseInt(s, 10)));
      let i = 0;
      while (i < rawCodes.length) {
        const code = rawCodes[i]!;
        if (Number.isNaN(code) || code === 0) {
          style.fg = undefined;
          style.bg = undefined;
          style.bold = false;
          style.dim = false;
          style.italic = false;
          style.underline = false;
          style.strikethrough = false;
          style.inverse = false;
          i += 1;
        } else if (code === 1) {
          style.bold = true;
          i += 1;
        } else if (code === 2) {
          style.dim = true;
          i += 1;
        } else if (code === 3) {
          style.italic = true;
          i += 1;
        } else if (code === 4) {
          style.underline = true;
          i += 1;
        } else if (code === 7) {
          style.inverse = true;
          i += 1;
        } else if (code === 9) {
          style.strikethrough = true;
          i += 1;
        } else if (code === 22) {
          style.bold = false;
          style.dim = false;
          i += 1;
        } else if (code === 23) {
          style.italic = false;
          i += 1;
        } else if (code === 24) {
          style.underline = false;
          i += 1;
        } else if (code === 27) {
          style.inverse = false;
          i += 1;
        } else if (code === 29) {
          style.strikethrough = false;
          i += 1;
        } else if (code >= 30 && code <= 37) {
          style.fg = BASIC_FG_COLORS[code];
          i += 1;
        } else if (code === 39) {
          style.fg = undefined;
          i += 1;
        } else if (code >= 40 && code <= 47) {
          style.bg = BASIC_BG_COLORS[code];
          i += 1;
        } else if (code === 49) {
          style.bg = undefined;
          i += 1;
        } else if (code >= 90 && code <= 97) {
          style.fg = BASIC_FG_COLORS[code];
          i += 1;
        } else if (code >= 100 && code <= 107) {
          style.bg = BASIC_BG_COLORS[code];
          i += 1;
        } else if (code === 38) {
          const next = rawCodes[i + 1];
          if (next === 5) {
            const colorCode = rawCodes[i + 2];
            if (colorCode !== undefined) {
              style.fg = xterm256ToColor(colorCode);
            }
            i += 3;
          } else if (next === 2) {
            const r = rawCodes[i + 2];
            const g = rawCodes[i + 3];
            const b = rawCodes[i + 4];
            if (r !== undefined && g !== undefined && b !== undefined) {
              if (r === 1 && g === 1 && b in THEME_COLOR_VARS) {
                style.fg = THEME_COLOR_VARS[b];
              } else {
                style.fg = `rgb(${r}, ${g}, ${b})`;
              }
            }
            i += 5;
          } else {
            i += 1;
          }
        } else if (code === 48) {
          const next = rawCodes[i + 1];
          if (next === 5) {
            const colorCode = rawCodes[i + 2];
            if (colorCode !== undefined) {
              style.bg = xterm256ToColor(colorCode);
            }
            i += 3;
          } else if (next === 2) {
            const r = rawCodes[i + 2];
            const g = rawCodes[i + 3];
            const b = rawCodes[i + 4];
            if (r !== undefined && g !== undefined && b !== undefined) {
              if (r === 1 && g === 1 && b in THEME_BG_VARS) {
                style.bg = THEME_BG_VARS[b];
              } else {
                style.bg = `rgb(${r}, ${g}, ${b})`;
              }
            }
            i += 5;
          } else {
            i += 1;
          }
        } else {
          i += 1;
        }
      }
    }
  }

  if (lastIndex < text.length) {
    pushText(text.slice(lastIndex));
  }

  return segments;
}

/** Inline style for one parsed ANSI segment; `undefined` when unstyled. */
export const renderSegmentStyle = (segment: AnsiSegment): CSSProperties | undefined => {
  const segStyle: CSSProperties = {};
  let hasStyle = false;

  let fg = segment.fg;
  let bg = segment.bg;

  if (segment.inverse) {
    // Swap foreground and background when inverse is requested
    const temp = fg;
    fg = bg ?? 'var(--surface-background, var(--background))';
    bg = temp ?? 'var(--foreground)';
    hasStyle = true;
  }

  if (fg) {
    segStyle.color = fg;
    hasStyle = true;
  }
  if (bg) {
    segStyle.backgroundColor = bg;
    hasStyle = true;
  }
  if (segment.bold) {
    segStyle.fontWeight = 600;
    hasStyle = true;
  }
  if (segment.dim) {
    segStyle.opacity = 0.65;
    hasStyle = true;
  }
  if (segment.italic) {
    segStyle.fontStyle = 'italic';
    hasStyle = true;
  }
  if (segment.underline && segment.strikethrough) {
    segStyle.textDecoration = 'underline line-through';
    hasStyle = true;
  } else if (segment.underline) {
    segStyle.textDecoration = 'underline';
    hasStyle = true;
  } else if (segment.strikethrough) {
    segStyle.textDecoration = 'line-through';
    hasStyle = true;
  }

  return hasStyle ? segStyle : undefined;
};
