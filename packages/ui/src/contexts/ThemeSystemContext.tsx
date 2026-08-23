import React, {
  useEffect,
  useMemo,
  useCallback,
  useRef,
  useState,
} from 'react';
import type { Theme, ThemeMode } from '@/types/theme';
import type { DesktopSettings } from '@/lib/desktop';
import { isDesktopLocalOriginActive, isDesktopShell as detectDesktopShell } from '@/lib/desktop';
import { setDesktopWindowTheme } from '@/lib/desktopNative';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import { updateDesktopSettings } from '@/lib/persistence';
import {
  themes,
  getThemeById,
  getDefaultTheme,
  DEFAULT_LIGHT_THEME_ID,
  DEFAULT_DARK_THEME_ID,
} from '@/lib/theme/themes';
import { withPrColors } from '@/lib/theme/themes/prColors';
import { ThemeSystemContext, type ThemeContextValue } from './theme-system-context';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isValidTheme } from './theme-validation';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

type ThemePreferences = {
  themeMode: ThemeMode;
  lightThemeId: string;
  darkThemeId: string;
};

const DEFAULT_LIGHT_ID = DEFAULT_LIGHT_THEME_ID;
const DEFAULT_DARK_ID = DEFAULT_DARK_THEME_ID;

const fallbackThemeForVariant = (variant: 'light' | 'dark'): Theme =>
  getDefaultTheme(variant === 'dark');

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

const suppressTransitionsForThemeSwitch = () => {
  if (typeof document === 'undefined') {
    return;
  }

  const root = document.documentElement;
  root.classList.add('oc-theme-switching');

  const frame = window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      root.classList.remove('oc-theme-switching');
    });
  });

  return () => {
    window.cancelAnimationFrame(frame);
    root.classList.remove('oc-theme-switching');
  };
};

const buildInitialPreferences = (defaultThemeId?: string): ThemePreferences => {
  let lightThemeId: string = DEFAULT_LIGHT_ID;
  let darkThemeId: string = DEFAULT_DARK_ID;
  let themeMode: ThemeMode = 'system';

  if (typeof window !== 'undefined') {
    const storedMode = localStorage.getItem('themeMode');
    const storedLightId = localStorage.getItem('lightThemeId');
    const storedDarkId = localStorage.getItem('darkThemeId');
    const legacyUseSystem = localStorage.getItem('useSystemTheme');
    const legacyThemeId = localStorage.getItem('selectedThemeId');
    const legacyVariant = localStorage.getItem('selectedThemeVariant');

    if (storedMode === 'light' || storedMode === 'dark' || storedMode === 'system') {
      themeMode = storedMode;
    } else if (legacyUseSystem !== null) {
      const useSystem = legacyUseSystem === 'true';
      if (useSystem) {
        themeMode = 'system';
      } else if (legacyThemeId) {
        const legacyTheme = getThemeById(legacyThemeId);
        if (legacyTheme) {
          themeMode = legacyTheme.metadata.variant === 'dark' ? 'dark' : 'light';
          if (legacyTheme.metadata.variant === 'dark') {
            darkThemeId = legacyTheme.metadata.id;
          } else {
            lightThemeId = legacyTheme.metadata.id;
          }
        }
      }
    } else if (legacyVariant === 'light' || legacyVariant === 'dark') {
      themeMode = legacyVariant;
    }

    if (typeof storedLightId === 'string' && storedLightId.trim().length > 0) {
      lightThemeId = storedLightId.trim();
    }

    if (typeof storedDarkId === 'string' && storedDarkId.trim().length > 0) {
      darkThemeId = storedDarkId.trim();
    }
  }

  if (defaultThemeId) {
    const defaultTheme = getThemeById(defaultThemeId);
    if (defaultTheme) {
      if (defaultTheme.metadata.variant === 'light') {
        lightThemeId = defaultTheme.metadata.id;
      } else {
        darkThemeId = defaultTheme.metadata.id;
      }
    }
  }

  return {
    themeMode,
    lightThemeId,
    darkThemeId,
  };
};

interface ThemeSystemProviderProps {
  children: React.ReactNode;
  defaultThemeId?: string;
}

export function ThemeSystemProvider({ children, defaultThemeId }: ThemeSystemProviderProps) {
  const cssGenerator = useMemo(() => new CSSVariableGenerator(), []);
  const [preferences, setPreferences] = useState<ThemePreferences>(() => buildInitialPreferences(defaultThemeId));
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() => (
    typeof window === 'undefined' ? true : window.matchMedia('(prefers-color-scheme: dark)').matches
  ));
  const [customThemes, setCustomThemes] = useState<Theme[]>([]);
  const [developmentThemes, setDevelopmentThemes] = useState<Theme[]>([]);
  const [customThemesLoading, setCustomThemesLoading] = useState(false);
  const isDesktopShell = useMemo(() => detectDesktopShell(), []);
  const customThemesRequestRef = useRef(0);
  const availableThemes = useMemo(() => {
    const merged: Theme[] = [];
    const seen = new Set<string>();

    const add = (theme: Theme) => {
      const id = theme.metadata.id;
      if (seen.has(id)) return;
      seen.add(id);
      merged.push(theme);
    };

    // Custom themes first so they can override built-ins with the same id.
    customThemes.forEach(add);
    // Vite publishes valid built-in JSON edits through this development-only
    // runtime channel, avoiding a full page reload for theme work.
    developmentThemes.forEach(add);
    themes.forEach(add);

    return merged;
  }, [customThemes, developmentThemes]);

  useEffect(() => {
    const handleThemeHmr = (event: Event) => {
      const theme = (event as CustomEvent<unknown>).detail;
      if (!isValidTheme(theme)) return;

      const nextTheme = withPrColors(theme);
      setDevelopmentThemes((previous) => {
        const index = previous.findIndex((candidate) => candidate.metadata.id === nextTheme.metadata.id);
        if (index < 0) return [...previous, nextTheme];
        const next = [...previous];
        next[index] = nextTheme;
        return next;
      });
    };

    window.addEventListener('pichamber:theme-hmr', handleThemeHmr);
    return () => window.removeEventListener('pichamber:theme-hmr', handleThemeHmr);
  }, []);

  const getThemeByIdFromAvailable = useCallback(
    (themeId: string): Theme | undefined => availableThemes.find((theme) => theme.metadata.id === themeId),
    [availableThemes],
  );

  const ensureThemeById = useCallback(
    (themeId: string, variant: 'light' | 'dark'): Theme => {
      const theme = getThemeByIdFromAvailable(themeId);
      if (theme && theme.metadata.variant === variant) {
        return theme;
      }

      const fallback = availableThemes.find((candidate) => candidate.metadata.variant === variant);
      return fallback ?? fallbackThemeForVariant(variant);
    },
    [availableThemes, getThemeByIdFromAvailable],
  );

  const currentTheme = useMemo(() => {
    if (preferences.themeMode === 'light') {
      return ensureThemeById(preferences.lightThemeId, 'light');
    }
    if (preferences.themeMode === 'dark') {
      return ensureThemeById(preferences.darkThemeId, 'dark');
    }
    return systemPrefersDark
      ? ensureThemeById(preferences.darkThemeId, 'dark')
      : ensureThemeById(preferences.lightThemeId, 'light');
  }, [ensureThemeById, preferences, systemPrefersDark]);

  const reloadCustomThemes = useCallback(async () => {
    if (typeof window === 'undefined') {
      return;
    }

    const runtimeKey = getRuntimeKey();
    const request = ++customThemesRequestRef.current;
    setCustomThemesLoading(true);
    try {
      const res = await runtimeFetch('/api/pi/themes', {
        method: 'GET',
        credentials: isDesktopLocalOriginActive() ? 'omit' : 'include',
        headers: {
          Accept: 'application/json',
        },
      });

      if (res.status === 401) {
        // UI auth gate will handle prompting; avoid noisy retries here.
        return;
      }

      if (!res.ok) {
        return;
      }

      const payload = await res.json();
      if (request !== customThemesRequestRef.current || runtimeKey !== getRuntimeKey()) return;
      const incoming = Array.isArray(payload?.themes) ? payload.themes : [];
      const normalized = incoming.filter(isValidTheme);
      setCustomThemes(normalized);
    } catch {
      // ignore
    } finally {
      if (request === customThemesRequestRef.current && runtimeKey === getRuntimeKey()) {
        setCustomThemesLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void reloadCustomThemes();
  }, [reloadCustomThemes]);

  useEffect(() => subscribeRuntimeEndpointChanged((detail) => {
    if (detail.runtimeKey === detail.previousRuntimeKey) return;
    customThemesRequestRef.current += 1;
    setCustomThemes([]);
    setCustomThemesLoading(false);
    void reloadCustomThemes();
  }), [reloadCustomThemes]);

  const updateBrowserChrome = useCallback((theme: Theme) => {
    if (typeof document === 'undefined') {
      return;
    }
    const chromeColor = theme.colors.surface.background;

    document.body.style.backgroundColor = chromeColor;

    let metaThemeColor = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement;
    if (!metaThemeColor) {
      metaThemeColor = document.createElement('meta');
      metaThemeColor.setAttribute('name', 'theme-color');
      document.head.appendChild(metaThemeColor);
    }
    metaThemeColor.setAttribute('content', chromeColor);

    const mediaQuery =
      theme.metadata.variant === 'dark'
        ? '(prefers-color-scheme: dark)'
        : '(prefers-color-scheme: light)';
    let metaThemeColorMedia = document.querySelector(
      `meta[name="theme-color"][media="${mediaQuery}"]`,
    ) as HTMLMetaElement;
    if (!metaThemeColorMedia) {
      metaThemeColorMedia = document.createElement('meta');
      metaThemeColorMedia.setAttribute('name', 'theme-color');
      metaThemeColorMedia.setAttribute('media', mediaQuery);
      document.head.appendChild(metaThemeColorMedia);
    }
    metaThemeColorMedia.setAttribute('content', chromeColor);
  }, []);

  useIsomorphicLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const restoreTransitions = suppressTransitionsForThemeSwitch();
    cssGenerator.apply(currentTheme);
    updateBrowserChrome(currentTheme);

    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(currentTheme.metadata.variant);

    return restoreTransitions;
  }, [cssGenerator, currentTheme, updateBrowserChrome]);

  useEffect(() => {
    if (preferences.themeMode !== 'system' || typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };

    setSystemPrefersDark(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [preferences.themeMode]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    localStorage.setItem('themeMode', preferences.themeMode);
    localStorage.setItem('lightThemeId', preferences.lightThemeId);
    localStorage.setItem('darkThemeId', preferences.darkThemeId);
    localStorage.setItem('useSystemTheme', String(preferences.themeMode === 'system'));
    localStorage.setItem('selectedThemeId', currentTheme.metadata.id);
    localStorage.setItem(
      'selectedThemeVariant',
      currentTheme.metadata.variant === 'light' ? 'light' : 'dark',
    );

    // Splash screen (packages/web/index.html) runs before the theme CSS vars load.
    // Persist just enough to theme it on next boot.
    const lightTheme = ensureThemeById(preferences.lightThemeId, 'light');
    const darkTheme = ensureThemeById(preferences.darkThemeId, 'dark');

    localStorage.setItem('splashBgLight', lightTheme.colors.surface.background);
    localStorage.setItem('splashFgLight', lightTheme.colors.surface.foreground);
    localStorage.setItem('splashBgDark', darkTheme.colors.surface.background);
    localStorage.setItem('splashFgDark', darkTheme.colors.surface.foreground);
  }, [preferences, currentTheme, ensureThemeById]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) {
        return;
      }

      if (event.key !== 'themeMode' && event.key !== 'lightThemeId' && event.key !== 'darkThemeId') {
        return;
      }

      setPreferences((prev) => {
        const nextModeRaw = localStorage.getItem('themeMode');
        const nextMode: ThemeMode =
          nextModeRaw === 'light' || nextModeRaw === 'dark' || nextModeRaw === 'system'
            ? nextModeRaw
            : prev.themeMode;

        const nextLightRaw = localStorage.getItem('lightThemeId');
        const nextLight = typeof nextLightRaw === 'string' && nextLightRaw.trim().length > 0
          ? nextLightRaw.trim()
          : prev.lightThemeId;

        const nextDarkRaw = localStorage.getItem('darkThemeId');
        const nextDark = typeof nextDarkRaw === 'string' && nextDarkRaw.trim().length > 0
          ? nextDarkRaw.trim()
          : prev.darkThemeId;

        if (nextMode === prev.themeMode && nextLight === prev.lightThemeId && nextDark === prev.darkThemeId) {
          return prev;
        }

        return {
          themeMode: nextMode,
          lightThemeId: nextLight,
          darkThemeId: nextDark,
        };
      });
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  useEffect(() => {
    const lightTheme = ensureThemeById(preferences.lightThemeId, 'light');
    const darkTheme = ensureThemeById(preferences.darkThemeId, 'dark');

    void updateDesktopSettings({
      themeId: currentTheme.metadata.id,
      themeVariant: currentTheme.metadata.variant === 'light' ? 'light' : 'dark',
      useSystemTheme: preferences.themeMode === 'system',
      lightThemeId: preferences.lightThemeId,
      darkThemeId: preferences.darkThemeId,
      splashBgLight: lightTheme.colors.surface.background,
      splashFgLight: lightTheme.colors.surface.foreground,
      splashBgDark: darkTheme.colors.surface.background,
      splashFgDark: darkTheme.colors.surface.foreground,
    });
  }, [currentTheme.metadata.id, currentTheme.metadata.variant, ensureThemeById, preferences.themeMode, preferences.lightThemeId, preferences.darkThemeId]);

  useEffect(() => {
    if (!isDesktopShell) {
      return;
    }

    void (async () => {
      await setDesktopWindowTheme(preferences.themeMode, currentTheme.metadata.variant);
    })();
  }, [currentTheme.metadata.variant, isDesktopShell, preferences.themeMode]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const handleSettingsSynced = (event: Event) => {
      const detail = (event as CustomEvent<DesktopSettings>).detail;
      if (!detail) {
        return;
      }

      setPreferences((prev) => {
        let nextMode = prev.themeMode;
        if (detail.useSystemTheme === true) {
          nextMode = 'system';
        } else if (detail.useSystemTheme === false) {
          if (detail.themeVariant === 'dark' || detail.themeVariant === 'light') {
            nextMode = detail.themeVariant;
          }
        }

        let nextLight = prev.lightThemeId;
        if (typeof detail.lightThemeId === 'string' && detail.lightThemeId.length > 0) {
          nextLight = detail.lightThemeId.trim();
        }

        let nextDark = prev.darkThemeId;
        if (typeof detail.darkThemeId === 'string' && detail.darkThemeId.length > 0) {
          nextDark = detail.darkThemeId.trim();
        }

        const same =
          nextMode === prev.themeMode &&
          nextLight === prev.lightThemeId &&
          nextDark === prev.darkThemeId;

        if (same) {
          return prev;
        }

        return {
          themeMode: nextMode,
          lightThemeId: nextLight,
          darkThemeId: nextDark,
        };
      });
    };

    window.addEventListener('pichamber:settings-synced', handleSettingsSynced);
    return () => window.removeEventListener('pichamber:settings-synced', handleSettingsSynced);
  }, []);

  const setTheme = useCallback(
    (themeId: string) => {
      const theme = availableThemes.find((candidate) => candidate.metadata.id === themeId);
      if (!theme) {
        return;
      }

      setPreferences((prev) => {
        if (theme.metadata.variant === 'dark') {
          if (prev.darkThemeId === theme.metadata.id && prev.themeMode === 'dark') {
            return prev;
          }
          return {
            ...prev,
            darkThemeId: theme.metadata.id,
            themeMode: 'dark',
          };
        }

        if (prev.lightThemeId === theme.metadata.id && prev.themeMode === 'light') {
          return prev;
        }

        return {
          ...prev,
          lightThemeId: theme.metadata.id,
          themeMode: 'light',
        };
      });
    },
    [availableThemes],
  );

  const setThemeModeHandler = useCallback((mode: ThemeMode) => {
    if (preferences.themeMode === mode) {
      return;
    }

    setPreferences((prev) => ({
      ...prev,
      themeMode: mode,
    }));

    void updateDesktopSettings({
      themeVariant: mode === 'system' ? currentTheme.metadata.variant : mode,
      useSystemTheme: mode === 'system',
    });
  }, [currentTheme.metadata.variant, preferences.themeMode]);

  const setSystemPreferenceHandler = useCallback(
    (use: boolean) => {
      if (use) {
        setPreferences((prev) => {
          if (prev.themeMode === 'system') {
            return prev;
          }
          return {
            ...prev,
            themeMode: 'system',
          };
        });
        return;
      }

      const fallbackMode: ThemeMode =
        currentTheme.metadata.variant === 'dark' ? 'dark' : 'light';
      setPreferences((prev) => {
        if (prev.themeMode === fallbackMode) {
          return prev;
        }
        return {
          ...prev,
          themeMode: fallbackMode,
        };
      });
    },
    [currentTheme.metadata.variant],
  );

  const setLightThemePreference = useCallback(
    (themeId: string) => {
      const theme = availableThemes.find(
        (candidate) =>
          candidate.metadata.id === themeId && candidate.metadata.variant === 'light',
      );
      if (!theme) {
        return;
      }

      setPreferences((prev) => {
        if (prev.lightThemeId === theme.metadata.id) {
          return prev;
        }
        return {
          ...prev,
          lightThemeId: theme.metadata.id,
        };
      });
    },
    [availableThemes],
  );

  const setDarkThemePreference = useCallback(
    (themeId: string) => {
      const theme = availableThemes.find(
        (candidate) =>
          candidate.metadata.id === themeId && candidate.metadata.variant === 'dark',
      );
      if (!theme) {
        return;
      }

      setPreferences((prev) => {
        if (prev.darkThemeId === theme.metadata.id) {
          return prev;
        }
        return {
          ...prev,
          darkThemeId: theme.metadata.id,
        };
      });
    },
    [availableThemes],
  );

  const value: ThemeContextValue = {
    currentTheme,
    availableThemes,
    setTheme,
    customThemesLoading,
    reloadCustomThemes,
    isSystemPreference: preferences.themeMode === 'system',
    setSystemPreference: setSystemPreferenceHandler,
    themeMode: preferences.themeMode,
    setThemeMode: setThemeModeHandler,
    lightThemeId: preferences.lightThemeId,
    darkThemeId: preferences.darkThemeId,
    setLightThemePreference,
    setDarkThemePreference,
  };

  return (
    <ThemeSystemContext.Provider value={value}>
      {children}
    </ThemeSystemContext.Provider>
  );
}
