import type { Theme } from '@/types/theme';
import { presetThemes } from './presets';
import { withPrColors } from './prColors';
import flexokiLightRaw from './flexoki-light.json';
import flexokiDarkRaw from './flexoki-dark.json';
import pichamberLightRaw from './pichamber-light.json';
import pichamberDarkRaw from './pichamber-dark.json';

const flexokiLightTheme = withPrColors(flexokiLightRaw as Theme);
const flexokiDarkTheme = withPrColors(flexokiDarkRaw as Theme);
const pichamberLightTheme = withPrColors(pichamberLightRaw as Theme);
const pichamberDarkTheme = withPrColors(pichamberDarkRaw as Theme);

export const DEFAULT_LIGHT_THEME_ID = 'pichamber-light' as const;
export const DEFAULT_DARK_THEME_ID = 'pichamber-dark' as const;

export const themes: Theme[] = [
  pichamberLightTheme,
  pichamberDarkTheme,
  flexokiLightTheme,
  flexokiDarkTheme,
  ...presetThemes.filter(
    (theme) =>
      theme.metadata.id !== 'pichamber-light' &&
      theme.metadata.id !== 'pichamber-dark' &&
      theme.metadata.id !== 'pichamber-light' &&
      theme.metadata.id !== 'pichamber-dark',
  ),
];

export function getThemeById(id: string): Theme | undefined {
  // Back-compat for renames.
  const resolvedId =
    id === 'app-light' || id === 'pichamber-light' ? 'pichamber-light' :
    id === 'app-dark' || id === 'pichamber-dark' ? 'pichamber-dark' :
    id;

  return themes.find(theme => theme.metadata.id === resolvedId);
}

export function getDefaultTheme(prefersDark: boolean): Theme {
  const variant: Theme['metadata']['variant'] = prefersDark ? 'dark' : 'light';

  const defaultId = prefersDark ? DEFAULT_DARK_THEME_ID : DEFAULT_LIGHT_THEME_ID;
  const defaultTheme = getThemeById(defaultId);
  if (defaultTheme && defaultTheme.metadata.variant === variant) {
    return defaultTheme;
  }

  return themes.find((theme) => theme.metadata.variant === variant) ?? themes[0] ?? flexokiLightTheme;
}
