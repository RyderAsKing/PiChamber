import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  SettingsCheckboxRow,
  SettingsChipGroup,
  SettingsControlGroup,
  SettingsInset,
  SettingsPreviewOption,
  SettingsRadioGroup,
  SettingsSection,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { cn } from '@/lib/utils';
import type { MobileLayoutPreference } from '@/lib/mobileLayoutPreference';
import type { Theme } from '@/types/theme';
import { COLLAPSED_THEME_COUNT, MOBILE_LAYOUT_OPTIONS, collapsedThemes, themeLabel } from './visualSettingsConstants';
import { WallpaperSettings } from './WallpaperSettings';
import { ThemePreview } from './ThemePreview';

export interface ThemeSectionProps {
  themes: Theme[];
  currentThemeId: string;
  onSelectTheme: (id: string) => void;
  showMobileLayoutSetting: boolean;
  mobileLayoutPreference: MobileLayoutPreference;
  onMobileLayoutPreferenceChange: (pref: MobileLayoutPreference) => void;
  customThemesLoading: boolean;
  themesReloading: boolean;
  setThemesReloading: (reloading: boolean) => void;
  reloadCustomThemes: () => Promise<void>;
  dockBadgeSupported: boolean;
  dockBadgeEnabled: boolean;
  setDockBadgeEnabled: (enabled: boolean) => void;
}

/** Settings → Appearance: the theme, picked from tiles, then the wallpaper. */
export const ThemeSection: React.FC<ThemeSectionProps> = ({
  themes,
  currentThemeId,
  onSelectTheme,
  showMobileLayoutSetting,
  mobileLayoutPreference,
  onMobileLayoutPreferenceChange,
  customThemesLoading,
  themesReloading,
  setThemesReloading,
  reloadCustomThemes,
  dockBadgeSupported,
  dockBadgeEnabled,
  setDockBadgeEnabled,
}) => {
  const [showAll, setShowAll] = React.useState(false);
  const shown = showAll ? themes : collapsedThemes(themes, currentThemeId);

  const reload = () => {
    const startedAt = Date.now();
    setThemesReloading(true);
    void reloadCustomThemes().finally(() => {
      // Long enough to see that something happened.
      const wait = Math.max(0, 500 - (Date.now() - startedAt));
      window.setTimeout(() => setThemesReloading(false), wait);
    });
  };

  return (
    <SettingsSection title={'Theme & wallpaper'} divider={false} contentClassName="space-y-6">
      <SettingsControlGroup title={'Theme'} settingsItem="appearance.theme">
        <SettingsRadioGroup
          aria-label={'Theme'}
          className="grid max-w-[48rem] grid-cols-2 gap-2 space-y-0 @xl:grid-cols-3 @xl:gap-3 @3xl:grid-cols-5"
        >
          {shown.map((theme) => (
            <SettingsPreviewOption
              key={theme.metadata.id}
              selected={theme.metadata.id === currentThemeId}
              onSelect={() => onSelectTheme(theme.metadata.id)}
              label={themeLabel(theme)}
              ariaLabel={themeLabel(theme)}
              previewClassName="aspect-[16/10]"
              preview={<ThemePreview theme={theme} />}
            />
          ))}
        </SettingsRadioGroup>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
          {themes.length > COLLAPSED_THEME_COUNT ? (
            <button
              type="button"
              aria-expanded={showAll}
              onClick={() => setShowAll((value) => !value)}
              className="typography-settings-link"
            >
              {showAll ? 'Show fewer' : `Show all ${themes.length} themes`}
            </button>
          ) : null}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={customThemesLoading || themesReloading}
              onClick={reload}
              className="typography-settings-link inline-flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
            >
              <Icon name="restart" className={cn('h-3.5 w-3.5', themesReloading && 'animate-spin')} />
              {themesReloading ? 'Reloading themes...' : 'Reload themes'}
            </button>
            <SettingsInfoHint>{'Import custom themes from ~/.config/pichamber/themes/'}</SettingsInfoHint>
          </div>
        </div>
      </SettingsControlGroup>

      {showMobileLayoutSetting && (
        <SettingsStackedField label={'Mobile layout'}>
          <SettingsChipGroup
            value={mobileLayoutPreference}
            options={MOBILE_LAYOUT_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
            onChange={onMobileLayoutPreferenceChange}
            aria-label={'Mobile layout'}
          />
        </SettingsStackedField>
      )}

      <WallpaperSettings />

      {dockBadgeSupported && (
        <SettingsInset settingsItem="appearance.dock-badge">
          <SettingsCheckboxRow
            checked={dockBadgeEnabled}
            onChange={setDockBadgeEnabled}
            label={'Dock badge'}
            info={'Show a count of chats with unseen activity on the macOS dock icon.'}
            ariaLabel={'Dock badge'}
          />
        </SettingsInset>
      )}
    </SettingsSection>
  );
};
