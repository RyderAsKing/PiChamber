import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Theme } from '@/types/theme';
import flexokiLightRaw from '@/lib/theme/themes/flexoki-light.json';
import pichamberDarkRaw from '@/lib/theme/themes/pichamber-dark.json';
import { ThemeSwatch } from './ThemeSwatch';

describe('ThemeSwatch', () => {
  const lightTheme = flexokiLightRaw as unknown as Theme;
  const darkTheme = pichamberDarkRaw as unknown as Theme;

  test('renders data-theme-swatch="<id>" with the theme background, text and accent colours', () => {
    const markup = renderToStaticMarkup(React.createElement(ThemeSwatch, { theme: lightTheme }));

    expect(markup).toContain(`data-theme-swatch="${lightTheme.metadata.id}"`);
    expect(markup).toContain(lightTheme.colors.surface.background);
    expect(markup).toContain(lightTheme.colors.surface.foreground);
    expect(markup).toContain(lightTheme.colors.primary.base);
  });

  test('two different themes produce different markup', () => {
    const lightMarkup = renderToStaticMarkup(React.createElement(ThemeSwatch, { theme: lightTheme }));
    const darkMarkup = renderToStaticMarkup(React.createElement(ThemeSwatch, { theme: darkTheme }));

    expect(lightMarkup).not.toBe(darkMarkup);
  });

  test('the markup contains no scaled spacing utility', () => {
    const scaledSpacingPattern = /\b(?:p|px|py|pl|pr|m|mx|my|ml|mr|gap|h|w)-\d/;
    for (const theme of [lightTheme, darkTheme]) {
      const markup = renderToStaticMarkup(React.createElement(ThemeSwatch, { theme }));
      expect(scaledSpacingPattern.test(markup)).toBe(false);
    }
  });
});
