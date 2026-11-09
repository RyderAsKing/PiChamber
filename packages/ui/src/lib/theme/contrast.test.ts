import { describe, expect, test } from 'bun:test';

import { contrastRatio, deriveSubtle, ensureContrast, MIN_TEXT_CONTRAST, parseColor } from './contrast';
import { CSSVariableGenerator } from './cssGenerator';
import { themes } from './themes';

const ratioOn = (color: string, surfaces: string[]) =>
  Math.min(...surfaces.map((surface) => contrastRatio(color, surface) ?? 0));

describe('parseColor', () => {
  test('reads hex with and without alpha, and rgb()', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#00000080')?.a).toBe(128 / 255);
    expect(parseColor('rgba(10, 20, 30, 0.5)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor('oklch(0.5 0.1 40)')).toBeNull();
  });
});

describe('ensureContrast', () => {
  test('keeps a color that already reaches the floor exactly as written', () => {
    expect(ensureContrast('#9e9ea8', ['#0f0f12', '#18181d'], '#e2e2e6')).toBe('#9e9ea8');
  });

  test('moves a dim color toward the text color until every surface reaches the floor', () => {
    const surfaces = ['#002b36', '#073642'];
    const raised = ensureContrast('#6f7475', surfaces, '#93a1a1');
    expect(raised).not.toBe('#6f7475');
    expect(ratioOn(raised, surfaces)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });

  test('accounts for a translucent color drawn over the surface', () => {
    const raised = ensureContrast('#ffffff40', ['#101010'], '#ffffff');
    expect(ratioOn(raised, ['#101010'])).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });

  test('passes through colors it cannot read', () => {
    expect(ensureContrast('var(--x)', ['#000'], '#fff')).toBe('var(--x)');
  });
});

describe('deriveSubtle', () => {
  test('fades toward the background but stays readable', () => {
    const surfaces = ['#0f0f12', '#0b0b0e', '#18181d'];
    const subtle = deriveSubtle('#9e9ea8', surfaces, '#0f0f12');
    expect(subtle).not.toBe('#9e9ea8');
    expect(ratioOn(subtle, surfaces)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(ratioOn(subtle, surfaces)).toBeLessThan(ratioOn('#9e9ea8', surfaces));
  });

  test('equals muted when muted has no headroom', () => {
    expect(deriveSubtle('#7a7a85', ['#0f0f12'], '#0f0f12')).toBe('#7a7a85');
  });
});

describe('generated theme variables', () => {
  const generator = new CSSVariableGenerator();
  const read = (css: string, name: string) => css.match(new RegExp(`\\s--${name}: ([^;!]+)`))?.[1]?.trim();

  test('every built-in theme gets readable secondary and tertiary text on its surfaces', () => {
    for (const theme of themes) {
      const css = generator.generate(theme);
      const { background, muted, elevated } = theme.colors.surface;
      const surfaces = [background, muted, elevated];
      for (const name of ['muted-foreground', 'subtle-foreground']) {
        const value = read(css, name);
        // Named on failure so the offending theme and token are obvious.
        expect({ theme: theme.metadata.id, name, readable: value !== undefined && ratioOn(value, surfaces) >= MIN_TEXT_CONTRAST })
          .toEqual({ theme: theme.metadata.id, name, readable: true });
      }
    }
  });
});
