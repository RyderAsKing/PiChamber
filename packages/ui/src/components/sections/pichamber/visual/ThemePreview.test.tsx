import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Theme } from '@/types/theme';
import flexokiLightRaw from '@/lib/theme/themes/flexoki-light.json';
import pichamberDarkRaw from '@/lib/theme/themes/pichamber-dark.json';
import { ColorModePreview, ThemePreview, ThemeSwatch } from './ThemePreview';

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

describe('ThemeSwatch', () => {
  const lightTheme = flexokiLightRaw as unknown as Theme;
  const darkTheme = pichamberDarkRaw as unknown as Theme;

  test('renders data-theme-swatch="<id>", aria-hidden, and contains surface.background, primary.base, and syntax.base.keyword colors', () => {
    const markup = renderToStaticMarkup(React.createElement(ThemeSwatch, { theme: lightTheme }));

    expect(markup).toContain(`data-theme-swatch="${lightTheme.metadata.id}"`);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain(lightTheme.colors.surface.background);
    expect(markup).toContain(lightTheme.colors.primary.base);
    expect(markup).toContain(lightTheme.colors.syntax.base.keyword);
  });

  test('two different themes produce different swatch markup', () => {
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

describe('ColorModePreview', () => {
  const lightTheme = flexokiLightRaw as unknown as Theme;
  const darkTheme = pichamberDarkRaw as unknown as Theme;

  test('mode system contains both theme ids', () => {
    const markup = renderToStaticMarkup(
      React.createElement(ColorModePreview, {
        mode: 'system',
        lightTheme,
        darkTheme,
      }),
    );

    expect(markup).toContain(`data-color-mode-preview="system"`);
    expect(markup).toContain(`data-theme-preview="${lightTheme.metadata.id}"`);
    expect(markup).toContain(`data-theme-preview="${darkTheme.metadata.id}"`);
  });

  test('mode light contains only the light theme id', () => {
    const markup = renderToStaticMarkup(
      React.createElement(ColorModePreview, {
        mode: 'light',
        lightTheme,
        darkTheme,
      }),
    );

    expect(markup).toContain(`data-color-mode-preview="light"`);
    expect(markup).toContain(`data-theme-preview="${lightTheme.metadata.id}"`);
    expect(markup).not.toContain(`data-theme-preview="${darkTheme.metadata.id}"`);
  });

  test('mode dark contains only the dark theme id', () => {
    const markup = renderToStaticMarkup(
      React.createElement(ColorModePreview, {
        mode: 'dark',
        lightTheme,
        darkTheme,
      }),
    );

    expect(markup).toContain(`data-color-mode-preview="dark"`);
    expect(markup).not.toContain(`data-theme-preview="${lightTheme.metadata.id}"`);
    expect(markup).toContain(`data-theme-preview="${darkTheme.metadata.id}"`);
  });

  test('renders without throwing when a theme is undefined', () => {
    const markupSystem = renderToStaticMarkup(
      React.createElement(ColorModePreview, {
        mode: 'system',
        lightTheme: undefined,
        darkTheme: undefined,
      }),
    );
    expect(markupSystem).toContain('data-color-mode-preview="system"');

    const markupLight = renderToStaticMarkup(
      React.createElement(ColorModePreview, {
        mode: 'light',
        lightTheme: undefined,
        darkTheme,
      }),
    );
    expect(markupLight).toContain('data-color-mode-preview="light"');

    const markupDark = renderToStaticMarkup(
      React.createElement(ColorModePreview, {
        mode: 'dark',
        lightTheme,
        darkTheme: undefined,
      }),
    );
    expect(markupDark).toContain('data-color-mode-preview="dark"');
  });
});
