import { describe, expect, it } from 'vitest';

import { createExtensionKeybindingHints } from './extension-keybindings.js';
import { createExtensionTheme, THEME_COLORS } from './extension-theme.js';

describe('createExtensionKeybindingHints', () => {
  it('returns no key for any keybinding id', () => {
    const { keyText } = createExtensionKeybindingHints({ theme: createExtensionTheme() });
    expect(keyText('app.tools.expand')).toBe('');
    expect(keyText('tui.select.cancel')).toBe('');
    expect(keyText('not.a.keybinding')).toBe('');
  });

  it('returns only the description, styled muted, with no leading space', () => {
    const theme = createExtensionTheme();
    const { keyHint } = createExtensionKeybindingHints({ theme });

    const hint = keyHint('app.tools.expand', 'to expand');
    expect(hint).toBe(theme.fg('muted', 'to expand'));
    expect(hint).toContain(`\x1b[38;2;1;1;${THEME_COLORS.indexOf('muted')}m`);
    expect(hint.replace(/\x1b\[[0-9;]*m/g, '')).toBe('to expand');
  });

  it('keeps a typical Pi hint readable', () => {
    const theme = createExtensionTheme();
    const { keyHint } = createExtensionKeybindingHints({ theme });
    const line = `${theme.fg('muted', '... (40 more lines,')} ${keyHint('app.tools.expand', 'to expand')}${theme.fg('muted', ')')}`;
    expect(line.replace(/\x1b\[[0-9;]*m/g, '')).toBe('... (40 more lines, to expand)');
  });

  it('returns plain text without a theme and never throws on odd input', () => {
    const { keyText, keyHint } = createExtensionKeybindingHints();
    expect(keyHint('app.tools.expand', 'to expand')).toBe('to expand');
    expect(keyHint(undefined, undefined)).toBe('');
    expect(keyText(undefined)).toBe('');
  });
});
