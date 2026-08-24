/**
 * ANSI escape handling for pi extension-authored text.
 *
 * Pi TUI extensions color status texts, widget lines, notify messages, and
 * dialog strings with raw ANSI SGR escapes (`ctx.ui.theme.fg(...)`, or
 * hand-rolled 24-bit sequences like `\x1b[38;2;R;G;Bm…\x1b[39m`). The web
 * surface must never render those verbatim: browsers draw ESC as zero-width
 * and leave `[38;2;…m` visible as literal garbage.
 *
 * Only SGR (color/style) handling is intentional here. Other C0 control
 * characters in extension text are not this module's concern.
 */

// eslint-disable-next-line no-control-regex
const ANSI_SGR_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ANSI_TRUECOLOR_FG_PATTERN = /\u001b\[38;2;(\d+);(\d+);(\d+)m/;

/** Remove every ANSI CSI sequence (colors, cursor moves, resets). */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR_PATTERN, "");
}

/**
 * Extract a leading 24-bit foreground color as a CSS `rgb()` string, or
 * `undefined` when the text carries no truecolor sequence. Used to preserve
 * per-mode identity (e.g. dotfiles modes.json colors) without a full SGR
 * segment parser.
 */
export function extractAnsiTruecolor(text: string): string | undefined {
  const match = text.match(ANSI_TRUECOLOR_FG_PATTERN);
  if (!match) return undefined;
  return `rgb(${match[1]}, ${match[2]}, ${match[3]})`;
}

/** Fast containment check so clean text skips regex work entirely. */
export function containsAnsiEscape(text: string): boolean {
  return text.includes("\u001b");
}
