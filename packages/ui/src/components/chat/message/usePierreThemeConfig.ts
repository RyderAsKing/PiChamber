import React from 'react';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { ensurePierreThemeRegistered } from '@/lib/shiki/appThemeRegistry';
import { getDefaultTheme } from '@/lib/theme/themes';

export type PierreThemeConfig = {
  theme: { light: string; dark: string };
  themeType: 'light' | 'dark';
};

export const usePierreThemeConfig = (): PierreThemeConfig => {
  const themeSystem = useOptionalThemeSystem();
  const fallbackLightTheme = React.useMemo(() => getDefaultTheme(false), []);
  const fallbackDarkTheme = React.useMemo(() => getDefaultTheme(true), []);

  const availableThemes = React.useMemo(
    () => themeSystem?.availableThemes ?? [fallbackLightTheme, fallbackDarkTheme],
    [fallbackDarkTheme, fallbackLightTheme, themeSystem?.availableThemes],
  );
  const lightThemeId = themeSystem?.lightThemeId ?? fallbackLightTheme.metadata.id;
  const darkThemeId = themeSystem?.darkThemeId ?? fallbackDarkTheme.metadata.id;

  const lightTheme = React.useMemo(
    () => availableThemes.find((theme) => theme.metadata.id === lightThemeId) ?? fallbackLightTheme,
    [availableThemes, fallbackLightTheme, lightThemeId],
  );
  const darkTheme = React.useMemo(
    () => availableThemes.find((theme) => theme.metadata.id === darkThemeId) ?? fallbackDarkTheme,
    [availableThemes, darkThemeId, fallbackDarkTheme],
  );

  React.useEffect(() => {
    ensurePierreThemeRegistered(lightTheme);
    ensurePierreThemeRegistered(darkTheme);
  }, [darkTheme, lightTheme]);

  const currentVariant = themeSystem?.currentTheme.metadata.variant ?? 'light';

  return {
    theme: { light: lightTheme.metadata.id, dark: darkTheme.metadata.id },
    themeType: currentVariant === 'dark' ? 'dark' : 'light',
  };
};
