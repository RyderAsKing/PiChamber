import { describe, expect, test } from 'bun:test';

import { CSSVariableGenerator } from './cssGenerator';
import { withInkStates } from './inkStates';
import { themes } from './themes';

const byId = (id: string) => {
  const theme = themes.find((candidate) => candidate.metadata.id === id);
  if (!theme) throw new Error(`missing theme ${id}`);
  return theme;
};

describe('withInkStates', () => {
  test('derives hover, pressed and borders from the primary text at fixed alphas', () => {
    const dark = withInkStates(byId('pichamber-dark'));
    expect(dark.colors.interactive.hover).toBe('#dcdce00f');
    expect(dark.colors.interactive.active).toBe('#dcdce01a');
    expect(dark.colors.interactive.border).toBe('#dcdce021');

    const light = withInkStates(byId('pichamber-light'));
    expect(light.colors.interactive.hover).toBe('#2d2d340a');
    expect(light.colors.interactive.border).toBe('#2d2d3426');
  });

  test('keeps a translucent selection and derives an opaque one', () => {
    const kanagawa = byId('kanagawa-dark');
    expect(withInkStates(kanagawa).colors.interactive.selection).toBe(kanagawa.colors.interactive.selection);

    const jetbrains = withInkStates(byId('jetbrains-dark'));
    expect(jetbrains.colors.interactive.selection).toBe('#dfe1e526');
  });

  test('leaves text colours alone', () => {
    const theme = byId('gruvbox-light');
    expect(withInkStates(theme).colors.surface).toEqual(theme.colors.surface);
  });

  test('every built-in theme emits valid hex for the derived states', () => {
    const generator = new CSSVariableGenerator();
    for (const theme of themes) {
      const css = generator.generate(theme);
      for (const name of ['interactive-hover', 'interactive-active', 'interactive-border', 'interactive-border-hover']) {
        const value = css.match(new RegExp(`\\s--${name}: ([^;!]+)`))?.[1]?.trim();
        expect({ theme: theme.metadata.id, name, value: /^#[0-9a-f]{8}$/i.test(value ?? '') })
          .toEqual({ theme: theme.metadata.id, name, value: true });
      }
    }
  });
});
