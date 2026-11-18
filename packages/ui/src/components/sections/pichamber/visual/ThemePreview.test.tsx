import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Theme } from '@/types/theme';
import flexokiLightRaw from '@/lib/theme/themes/flexoki-light.json';
import pichamberDarkRaw from '@/lib/theme/themes/pichamber-dark.json';
import { ThemePreview } from './ThemePreview';

describe('ThemePreview', () => {
  const lightTheme = flexokiLightRaw as unknown as Theme;
  const darkTheme = pichamberDarkRaw as unknown as Theme;

  test('renders data-theme-preview="<id>" and contains theme surface.background, primary.base, and interactive.selection colors', () => {
    const markup = renderToStaticMarkup(React.createElement(ThemePreview, { theme: lightTheme }));

    expect(markup).toContain(`data-theme-preview="${lightTheme.metadata.id}"`);
    expect(markup).toContain(lightTheme.colors.surface.background);
    expect(markup).toContain(lightTheme.colors.primary.base);
    expect(markup).toContain(lightTheme.colors.interactive.selection);
  });

  test('two different themes produce different markup', () => {
    const lightMarkup = renderToStaticMarkup(React.createElement(ThemePreview, { theme: lightTheme }));
    const darkMarkup = renderToStaticMarkup(React.createElement(ThemePreview, { theme: darkTheme }));

    expect(lightMarkup).not.toBe(darkMarkup);
  });

  test('the markup contains no scaled spacing utility', () => {
    const scaledSpacingPattern = /\b(?:p|px|py|pl|pr|m|mx|my|ml|mr|gap|h|w)-\d/;
    for (const theme of [lightTheme, darkTheme]) {
      const markup = renderToStaticMarkup(React.createElement(ThemePreview, { theme }));
      expect(scaledSpacingPattern.test(markup)).toBe(false);
    }
  });
});
