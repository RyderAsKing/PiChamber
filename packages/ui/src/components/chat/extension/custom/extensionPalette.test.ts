import { describe, expect, test } from 'bun:test';

import { themes } from '@/lib/theme/themes';
import { paletteStyle, terminalColorsOf, textPaletteStyle } from './extensionPalette';

const isHex = (value: string): boolean => /^#[0-9a-f]{6}$/.test(value);

const light = themes.find((theme) => theme.metadata.id === 'pichamber-light')!;

describe('terminalColorsOf', () => {
  test("gives the Terminal panel's colours as #rrggbb", () => {
    const colors = terminalColorsOf(light)!;
    expect(isHex(colors.background)).toBe(true);
    expect(isHex(colors.foreground)).toBe(true);
    expect(colors.palette).toHaveLength(16);
    expect(colors.palette.every(isHex)).toBe(true);
  });
});

describe('paletteStyle', () => {
  const screen = { background: '#ffffff', foreground: '#111111', palette: Array.from({ length: 16 }, (_, i) => `#0000${i.toString(16).padStart(2, '0')}`) };

  test('sets the screen alone before Pi answers', () => {
    const style = paletteStyle(screen, null) as Record<string, string>;
    expect(style['--term-background']).toBe('#ffffff');
    expect(style['--term-foreground']).toBe('#111111');
    expect(style['--term-ansi-0']).toBe('#000000');
    expect(style['--term-ansi-15']).toBe('#00000f');
    expect(style['--term-accent']).toBeUndefined();
  });

  test("puts Pi's colours, text and page background over the screen", () => {
    const style = paletteStyle(screen, {
      theme: 'dark', appearance: 'dark', background: '#21252c', colors: { accent: '#a798d7', text: '#dee0e1' },
    }) as Record<string, string>;
    expect(style['--term-background']).toBe('#21252c');
    expect(style['--term-foreground']).toBe('#dee0e1');
    expect(style['--term-accent']).toBe('#a798d7');
    expect(style['--term-ansi-1']).toBe('#000001');
  });
});

describe('textPaletteStyle', () => {
  const terminal = { background: '#ffffff', foreground: '#111111', palette: Array.from({ length: 16 }, () => '#123456') };
  const dark = { theme: 'dark', appearance: 'dark' as const, background: '#21252c', colors: { accent: '#a798d7' } };

  test("gives Pi's colours made for the app's appearance, with no screen", () => {
    const style = textPaletteStyle(terminal, dark, 'dark') as Record<string, string>;
    expect(style['--term-accent']).toBe('#a798d7');
    expect(style['--term-ansi-3']).toBe('#123456');
    expect(style['--term-background']).toBeUndefined();
    expect(style['--term-foreground']).toBeUndefined();
  });

  test('keeps PiChamber tokens for a theme made for the other appearance', () => {
    const style = textPaletteStyle(terminal, dark, 'light') as Record<string, string>;
    expect(style['--term-accent']).toBeUndefined();
    expect(style['--term-ansi-0']).toBe('#123456');
  });
});
