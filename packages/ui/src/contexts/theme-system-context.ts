import { createContext } from 'react';

import type { Theme, ThemeMode } from '@/types/theme';

export interface ThemeContextValue {
  currentTheme: Theme;
  availableThemes: Theme[];
  setTheme: (themeId: string) => void;
  customThemesLoading: boolean;
  reloadCustomThemes: () => Promise<void>;
  isSystemPreference: boolean;
  setSystemPreference: (use: boolean) => void;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  lightThemeId: string;
  darkThemeId: string;
  setLightThemePreference: (themeId: string) => void;
  setDarkThemePreference: (themeId: string) => void;
  /** Sets the light and dark themes together (a theme family); either may be missing. */
  setThemeFamily: (lightThemeId: string | undefined, darkThemeId: string | undefined) => void;
}

export const ThemeSystemContext = createContext<ThemeContextValue | undefined>(undefined);
