import { createContext } from 'react';

import type { Theme } from '@/types/theme';

export interface ThemeContextValue {
  currentTheme: Theme;
  availableThemes: Theme[];
  setTheme: (themeId: string) => void;
  customThemesLoading: boolean;
  reloadCustomThemes: () => Promise<void>;
  /** The last light and dark theme picked; diffs use the other one for contrast. */
  lightThemeId: string;
  darkThemeId: string;
}

export const ThemeSystemContext = createContext<ThemeContextValue | undefined>(undefined);
