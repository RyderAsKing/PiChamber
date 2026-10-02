import { describe, expect, it } from 'vitest';

import {
  THEME_COLORS,
  THEME_BG_COLORS,
  createExtensionTheme,
} from './extension-theme.js';

describe('extension-theme', () => {
  it('pins the canonical THEME_COLORS and THEME_BG_COLORS lists in exact order', () => {
    expect(THEME_COLORS).toEqual([
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

    expect(THEME_BG_COLORS).toEqual([
      'selectedBg',
      'searchMatchBg',
      'userMessageBg',
      'customMessageBg',
      'toolPendingBg',
      'toolSuccessBg',
      'toolErrorBg',
    ]);
  });

  it('implements all public Theme interface members with truecolor marker tuples', () => {
    const theme = createExtensionTheme();
    expect(theme.name).toBe('pichamber');
    expect(theme.getColorMode()).toBe('truecolor');

    // Foreground styling
    const successIndex = THEME_COLORS.indexOf('success');
    expect(theme.getFgAnsi('success')).toBe(`\x1b[38;2;1;1;${successIndex}m`);
    expect(theme.fg('success', 'ok')).toBe(`\x1b[38;2;1;1;${successIndex}mok\x1b[39m`);

    // Background styling
    const selectedBgIndex = THEME_BG_COLORS.indexOf('selectedBg');
    expect(theme.getBgAnsi('selectedBg')).toBe(`\x1b[48;2;1;1;${selectedBgIndex}m`);
    expect(theme.bg('selectedBg', 'item')).toBe(`\x1b[48;2;1;1;${selectedBgIndex}mitem\x1b[49m`);

    // SGR styles
    expect(theme.bold('bold text')).toBe('\x1b[1mbold text\x1b[22m');
    expect(theme.italic('italic text')).toBe('\x1b[3mitalic text\x1b[23m');
    expect(theme.underline('underlined text')).toBe('\x1b[4munderlined text\x1b[24m');
    expect(theme.inverse('inverse text')).toBe('\x1b[7minverse text\x1b[27m');
    expect(theme.strikethrough('struck text')).toBe('\x1b[9mstruck text\x1b[29m');

    // Thinking and bash mode border helpers
    const thinkingHighIndex = THEME_COLORS.indexOf('thinkingHigh');
    const thinkingBorder = theme.getThinkingBorderColor('high');
    expect(thinkingBorder('---')).toBe(`\x1b[38;2;1;1;${thinkingHighIndex}m---\x1b[39m`);

    const thinkingOffIndex = THEME_COLORS.indexOf('thinkingOff');
    const unknownThinkingBorder = theme.getThinkingBorderColor('unknownLevel');
    expect(unknownThinkingBorder('---')).toBe(`\x1b[38;2;1;1;${thinkingOffIndex}m---\x1b[39m`);

    const bashModeIndex = THEME_COLORS.indexOf('bashMode');
    const bashBorder = theme.getBashModeBorderColor();
    expect(bashBorder('$$$')).toBe(`\x1b[38;2;1;1;${bashModeIndex}m$$$\x1b[39m`);
  });

  it('implements appearance, colors, and style() for SDK 1.0.0 Theme interface', () => {
    const theme = createExtensionTheme();
    expect(theme.appearance).toBe('dark');

    // Every ThemeToken is in theme.colors with valid Color representation
    for (const color of THEME_COLORS) {
      const token = theme.colors[color];
      expect(token).toEqual({ kind: 'rgb', r: 1, g: 1, b: THEME_COLORS.indexOf(color) });
    }
    for (const bg of THEME_BG_COLORS) {
      const token = theme.colors[bg];
      expect(token).toEqual({ kind: 'rgb', r: 1, g: 1, b: THEME_BG_COLORS.indexOf(bg) });
    }

    // style() with token names
    const successIndex = THEME_COLORS.indexOf('success');
    const selectedBgIndex = THEME_BG_COLORS.indexOf('selectedBg');
    expect(theme.style('hello', { fg: 'success', bold: true })).toBe(
      `\x1b[38;2;1;1;${successIndex}m\x1b[1mhello\x1b[22m\x1b[39m`,
    );
    expect(theme.style('world', { bg: 'selectedBg', italic: true, underline: true })).toBe(
      `\x1b[48;2;1;1;${selectedBgIndex}m\x1b[3m\x1b[4mworld\x1b[24m\x1b[23m\x1b[49m`,
    );

    // style() with theme.colors[token]
    expect(theme.style('token fg', { fg: theme.colors.success })).toBe(
      `\x1b[38;2;1;1;${successIndex}mtoken fg\x1b[39m`,
    );
    expect(theme.style('token bg', { bg: theme.colors.selectedBg })).toBe(
      `\x1b[48;2;1;1;${selectedBgIndex}mtoken bg\x1b[49m`,
    );

    // style() with concrete RGB and indexed Color
    expect(theme.style('custom rgb', { fg: { kind: 'rgb', r: 255, g: 128, b: 0 } })).toBe(
      '\x1b[38;2;255;128;0mcustom rgb\x1b[39m',
    );
    expect(theme.style('indexed', { bg: { kind: 'indexed', index: 42 } })).toBe(
      '\x1b[48;5;42mindexed\x1b[49m',
    );

    // style() with all text attributes
    expect(theme.style('attrs', { dim: true, inverse: true, strikethrough: true })).toBe(
      '\x1b[2m\x1b[7m\x1b[9mattrs\x1b[29m\x1b[27m\x1b[22m',
    );
  });

  it('handles unknown color names gracefully without throwing', () => {
    const theme = createExtensionTheme();
    expect(theme.getFgAnsi('nonExistentColor')).toBe('');
    expect(theme.getBgAnsi('nonExistentBg')).toBe('');
    expect(theme.fg('nonExistentColor', 'fallback text')).toBe('fallback text');
    expect(theme.bg('nonExistentBg', 'fallback text')).toBe('fallback text');
    expect(theme.style('fallback text', { fg: 'nonExistentColor', bg: 'nonExistentBg' })).toBe('fallback text');
  });
});
