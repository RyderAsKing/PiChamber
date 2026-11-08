/**
 * Browser key events to terminal input for Pi `ctx.ui.custom()` components.
 *
 * Pi components parse what a terminal sends (pi-tui `matchesKey`), so the UI
 * sends legacy xterm sequences: printable text as itself, control letters as
 * C0 bytes, cursor keys as CSI with an xterm modifier parameter. Enter with
 * Shift or Ctrl has no legacy byte, so it goes as CSI-u (`\x1b[13;2u`), which
 * pi-tui reads without the kitty protocol. Keys this encoder does not know
 * return `null` and stay with the browser.
 */

interface TerminalKeyEventLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /** AltGr (`getModifierState('AltGraph')`); browser key events have it. */
  getModifierState?: (key: 'AltGraph') => boolean;
}

/**
 * AltGr types a character (`@`, `[`, `{`, `€` on many layouts). Windows
 * reports it as Ctrl+Alt, so a single non-letter character with both, or
 * with AltGraph set, is that character, not a control combination.
 */
const isAltGraphCharacter = (event: TerminalKeyEventLike): boolean => {
  if ([...event.key].length !== 1) return false;
  if (event.getModifierState?.('AltGraph') === true) return true;
  return event.ctrlKey && event.altKey && !/^[a-z]$/i.test(event.key);
};

const CSI_KEYS: Record<string, string> = {
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  Insert: '\x1b[2~',
  Delete: '\x1b[3~',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
};

export const encodeTerminalKey = (event: TerminalKeyEventLike): string | null => {
  const { key, ctrlKey, altKey, metaKey, shiftKey } = event;
  // Cmd shortcuts belong to the browser and the OS (copy, tabs, quit).
  if (metaKey) return null;
  if (isAltGraphCharacter(event)) return key;
  if (key === 'Enter') {
    if (!ctrlKey && !shiftKey) return altKey ? '\x1b\r' : '\r';
    return `\x1b[13;${1 + (shiftKey ? 1 : 0) + (altKey ? 2 : 0) + (ctrlKey ? 4 : 0)}u`;
  }
  if (key === 'Escape') return '\x1b';
  if (key === 'Tab') return shiftKey ? '\x1b[Z' : '\t';
  if (key === 'Backspace') return altKey ? '\x1b\x7f' : '\x7f';
  const csi = CSI_KEYS[key];
  if (csi) {
    if (!ctrlKey && !altKey && !shiftKey) return csi;
    const modifier = 1 + (shiftKey ? 1 : 0) + (altKey ? 2 : 0) + (ctrlKey ? 4 : 0);
    const final = csi.at(-1);
    return final === '~' ? csi.replace('~', `;${modifier}~`) : `\x1b[1;${modifier}${final}`;
  }
  if ([...key].length !== 1) return null;
  if (ctrlKey) {
    const code = key.toLowerCase().charCodeAt(0);
    if (code >= 97 && code <= 122) return (altKey ? '\x1b' : '') + String.fromCharCode(code - 96);
    if (key === ' ' || key === '@') return '\x00';
    if (key === '[') return '\x1b';
    if (key === '\\') return '\x1c';
    if (key === ']') return '\x1d';
    if (key === '_' || key === '-') return '\x1f';
    return null;
  }
  return altKey ? `\x1b${key}` : key;
};

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** Pasted text as one bracketed-paste item, the way a terminal sends it. */
export const bracketedPaste = (text: string): string => {
  const body = text.split(PASTE_START).join('').split(PASTE_END).join('');
  return `${PASTE_START}${body}${PASTE_END}`;
};

export type TerminalMouseAction = 'press' | 'drag' | 'release' | 'wheel-up' | 'wheel-down';

interface TerminalMouseReport {
  action: TerminalMouseAction;
  /** DOM `MouseEvent.button`: 0 left, 1 middle, 2 right. Ignored for the wheel. */
  button: number;
  /** Zero-based cell column and row inside the surface. */
  col: number;
  row: number;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
}

/**
 * A mouse report as an SGR (mode 1006) sequence, which pi-tui's alt screen
 * reads: `CSI < code ; col ; row M` for press, drag and wheel, `m` for release,
 * one-based cells. The code holds the button (0-2), Shift 4, Alt 8, Ctrl 16,
 * motion 32 and wheel 64 (up) or 65 (down).
 */
export const encodeMouseReport = (report: TerminalMouseReport): string => {
  const wheel = report.action === 'wheel-up' || report.action === 'wheel-down';
  let code = wheel ? (report.action === 'wheel-up' ? 64 : 65) : Math.min(Math.max(report.button, 0), 2);
  if (report.action === 'drag') code += 32;
  if (report.shiftKey) code += 4;
  if (report.altKey) code += 8;
  if (report.ctrlKey) code += 16;
  const col = Math.max(0, Math.floor(report.col)) + 1;
  const row = Math.max(0, Math.floor(report.row)) + 1;
  return `\x1b[<${code};${col};${row}${report.action === 'release' ? 'm' : 'M'}`;
};

/**
 * Terminal input that turns text already sent (`sent`) into `current`: one
 * Backspace (`\x7f`) per character dropped from the end of the shared start,
 * then the new text. A phone keyboard edits a word in place while composing
 * (autocorrect, suggestions); this keeps the extension's copy in step.
 * Newlines go as Enter (`\r`).
 */
export const textEditInput = (sent: string, current: string): string => {
  const before = [...sent];
  const after = [...current];
  let shared = 0;
  while (shared < before.length && shared < after.length && before[shared] === after[shared]) shared += 1;
  return '\x7f'.repeat(before.length - shared) + after.slice(shared).join('').replace(/\r?\n/g, '\r');
};
