import { copyTextToClipboard } from '@/lib/clipboard';

export type TerminalClipboardPlatform = 'mac' | 'other';
export type TerminalClipboardShortcut = 'copy' | 'paste' | 'ignore' | null;

type ShortcutEvent = {
  key: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  altKey: boolean;
};

export const detectTerminalClipboardPlatform = (
  platform?: string,
  userAgent?: string,
): TerminalClipboardPlatform => {
  const target = `${platform ?? ''} ${userAgent ?? ''}`;
  return /mac|iphone|ipad|darwin/i.test(target) ? 'mac' : 'other';
};

const normalizeKey = (event: ShortcutEvent): string => {
  if (event.key.length === 1) return event.key.toLowerCase();
  if (event.code === 'KeyC') return 'c';
  if (event.code === 'KeyV') return 'v';
  if (event.code === 'Insert') return 'insert';
  return event.key.toLowerCase();
};

/**
 * Decide whether a key event is a terminal clipboard shortcut.
 * Returns `copy`/`paste` when the terminal should handle it, `ignore` when the
 * event must be consumed without PTY input (for example copy with no
 * selection), and `null` when the event belongs to the terminal.
 * Ctrl+C is never a copy shortcut so SIGINT keeps working.
 */
export const resolveTerminalClipboardShortcut = (
  event: ShortcutEvent,
  platform: TerminalClipboardPlatform,
  hasSelection: boolean,
): TerminalClipboardShortcut => {
  if (event.altKey) return null;
  const key = normalizeKey(event);

  if (platform === 'mac') {
    if (!event.metaKey || event.ctrlKey) return null;
    if (key === 'c' && !event.shiftKey) return hasSelection ? 'copy' : 'ignore';
    // Cmd+V relies on the native paste event so xterm.js can apply
    // bracketed paste and IME handling without a second manual paste.
    return null;
  }

  if (event.metaKey) return null;
  if (event.shiftKey && !event.ctrlKey && key === 'insert') return 'paste';
  if (event.ctrlKey && !event.shiftKey && key === 'insert') {
    return hasSelection ? 'copy' : 'ignore';
  }
  if (!event.ctrlKey || !event.shiftKey) return null;
  if (key === 'c') return hasSelection ? 'copy' : 'ignore';
  if (key === 'v') return 'paste';
  return null;
};

export const hasTerminalSelection = (text: string | null | undefined): boolean =>
  typeof text === 'string' && text.trim().length > 0;

export async function copyTerminalSelection(text: string): Promise<boolean> {
  if (!hasTerminalSelection(text)) return false;
  const result = await copyTextToClipboard(text);
  return result.ok;
}

export async function readClipboardText(): Promise<string | null> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return null;
  try {
    const text = await navigator.clipboard.readText();
    return text || null;
  } catch {
    return null;
  }
}
