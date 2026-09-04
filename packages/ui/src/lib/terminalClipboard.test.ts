import { describe, expect, test } from 'bun:test';
import {
  detectTerminalClipboardPlatform,
  hasTerminalSelection,
  resolveTerminalClipboardShortcut,
} from './terminalClipboard';

const base = { code: undefined as string | undefined, altKey: false };

describe('terminal clipboard shortcuts', () => {
  test('uses native copy on macOS without stealing Ctrl+C', () => {
    expect(
      resolveTerminalClipboardShortcut(
        { ...base, key: 'c', ctrlKey: false, shiftKey: false, metaKey: true },
        'mac',
        true,
      ),
    ).toBe('copy');
    expect(
      resolveTerminalClipboardShortcut(
        { ...base, key: 'v', ctrlKey: false, shiftKey: false, metaKey: true },
        'mac',
        false,
      ),
    ).toBeNull();
    expect(
      resolveTerminalClipboardShortcut(
        { ...base, key: 'c', ctrlKey: true, shiftKey: false, metaKey: false },
        'mac',
        true,
      ),
    ).toBeNull();
  });

  test('ignores copy with no selection instead of sending PTY input', () => {
    expect(
      resolveTerminalClipboardShortcut(
        { ...base, key: 'c', ctrlKey: false, shiftKey: false, metaKey: true },
        'mac',
        false,
      ),
    ).toBe('ignore');
    expect(
      resolveTerminalClipboardShortcut(
        { ...base, key: 'C', ctrlKey: true, shiftKey: true, metaKey: false },
        'other',
        false,
      ),
    ).toBe('ignore');
  });

  test('uses Ctrl+Shift+C and Ctrl+Shift+V on Windows and Linux', () => {
    expect(
      resolveTerminalClipboardShortcut(
        { ...base, key: 'C', ctrlKey: true, shiftKey: true, metaKey: false },
        'other',
        true,
      ),
    ).toBe('copy');
    expect(
      resolveTerminalClipboardShortcut(
        { ...base, key: 'V', ctrlKey: true, shiftKey: true, metaKey: false },
        'other',
        false,
      ),
    ).toBe('paste');
    expect(
      resolveTerminalClipboardShortcut(
        { ...base, key: 'c', ctrlKey: true, shiftKey: false, metaKey: false },
        'other',
        true,
      ),
    ).toBeNull();
    expect(
      resolveTerminalClipboardShortcut(
        { ...base, key: 'v', ctrlKey: true, shiftKey: false, metaKey: false },
        'other',
        false,
      ),
    ).toBeNull();
  });

  test('supports Insert shortcuts and ignores Alt combinations', () => {
    expect(
      resolveTerminalClipboardShortcut(
        { ...base, key: 'Insert', code: 'Insert', ctrlKey: false, shiftKey: true, metaKey: false },
        'other',
        false,
      ),
    ).toBe('paste');
    expect(
      resolveTerminalClipboardShortcut(
        { ...base, key: 'c', ctrlKey: true, shiftKey: true, metaKey: false, altKey: true },
        'other',
        true,
      ),
    ).toBeNull();
  });

  test('detects platform and selection', () => {
    expect(detectTerminalClipboardPlatform('MacIntel', '')).toBe('mac');
    expect(detectTerminalClipboardPlatform('', 'Windows')).toBe('other');
    expect(hasTerminalSelection('  \n ')).toBe(false);
    expect(hasTerminalSelection('nvim')).toBe(true);
  });
});
