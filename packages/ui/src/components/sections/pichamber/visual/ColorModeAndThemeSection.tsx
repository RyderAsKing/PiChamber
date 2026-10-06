import React from 'react';
import { useTranslation } from 'react-i18next';

import { Icon } from '@/components/icon/Icon';
import {
  SETTINGS_SELECT_SIZE,
  SETTINGS_SELECT_TRIGGER_CLASS,
  SettingsCheckboxRow,
  SettingsChipGroup,
  SettingsControlGroup,
  SettingsInset,
  SettingsPreviewOption,
  SettingsRadioGroup,
  SettingsSection,
  SettingsStackedField,
  SettingsTwoColumn,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { MobileLayoutPreference } from '@/lib/mobileLayoutPreference';
import type { Theme, ThemeMode } from '@/types/theme';
import { MOBILE_LAYOUT_OPTIONS, THEME_MODE_OPTIONS } from './visualSettingsConstants';
import { ColorModePreview, ThemeSwatch } from './ThemePreview';

export interface ColorModeAndThemeSectionProps {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  showMobileLayoutSetting: boolean;
  mobileLayoutPreference: MobileLayoutPreference;
  onMobileLayoutPreferenceChange: (pref: MobileLayoutPreference) => void;
  selectedLightTheme: Theme | null | undefined;
  setLightThemePreference: (id: string) => void;
  lightThemes: Theme[];
  selectedDarkTheme: Theme | null | undefined;
  setDarkThemePreference: (id: string) => void;
  darkThemes: Theme[];
  formatThemeLabel: (name: string, mode: 'light' | 'dark') => string;
  customThemesLoading: boolean;
  themesReloading: boolean;
  setThemesReloading: (reloading: boolean) => void;
  reloadCustomThemes: () => Promise<void>;
  dockBadgeSupported: boolean;
  dockBadgeEnabled: boolean;
  setDockBadgeEnabled: (enabled: boolean) => void;
}

export const ColorModeAndThemeSection: React.FC<ColorModeAndThemeSectionProps> = ({
  themeMode,
  setThemeMode,
  showMobileLayoutSetting,
  mobileLayoutPreference,
  onMobileLayoutPreferenceChange,
  selectedLightTheme,
  setLightThemePreference,
  lightThemes,
  selectedDarkTheme,
  setDarkThemePreference,
  darkThemes,
  formatThemeLabel,
  customThemesLoading,
  themesReloading,
  setThemesReloading,
  reloadCustomThemes,
  dockBadgeSupported,
  dockBadgeEnabled,
  setDockBadgeEnabled,
}) => {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t('Color mode & Theme')} divider={false} contentClassName="space-y-4">
      <SettingsControlGroup title={t('Color mode')}>
        <SettingsRadioGroup aria-label={t('Color Mode')} className="grid max-w-[30rem] grid-cols-3 gap-2 space-y-0 @xl:gap-3">
          {THEME_MODE_OPTIONS.map((option) => (
            <SettingsPreviewOption
              key={option.value}
              selected={themeMode === option.value}
              onSelect={() => setThemeMode(option.value)}
              label={t(option.label)}
              ariaLabel={t(option.label)}
              preview={
                <ColorModePreview
                  mode={option.value}
                  lightTheme={selectedLightTheme}
                  darkTheme={selectedDarkTheme}
                />
              }
            />
          ))}
        </SettingsRadioGroup>
      </SettingsControlGroup>

      {showMobileLayoutSetting && (
        <SettingsStackedField label={t('Mobile Layout')}>
          <SettingsChipGroup
            value={mobileLayoutPreference}
            options={MOBILE_LAYOUT_OPTIONS.map((option) => ({
              value: option.value,
              label: t(option.label),
            }))}
            onChange={onMobileLayoutPreferenceChange}
            aria-label={t('Mobile Layout')}
          />
        </SettingsStackedField>
      )}

      <SettingsTwoColumn className="gap-4 @md:grid-cols-2 @md:gap-8 @3xl:gap-10">
        <SettingsStackedField
          label={t('Light Theme')}
          settingsItem="appearance.light-theme"
        >
          <Select
            value={selectedLightTheme?.metadata.id ?? ''}
            onValueChange={setLightThemePreference}
          >
            <SelectTrigger
              aria-label={t('Select light theme')}
              size={SETTINGS_SELECT_SIZE}
              className={SETTINGS_SELECT_TRIGGER_CLASS}
            >
              <SelectValue placeholder={t('Select theme')}>
                {selectedLightTheme ? (
                  <span className="flex min-w-0 items-center gap-2">
                    <ThemeSwatch theme={selectedLightTheme} />
                    <span className="truncate">
                      {formatThemeLabel(selectedLightTheme.metadata.name, 'light')}
                    </span>
                  </span>
                ) : undefined}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {lightThemes.map((theme) => (
                <SelectItem key={theme.metadata.id} value={theme.metadata.id}>
                  <span className="flex min-w-0 items-center gap-2">
                    <ThemeSwatch theme={theme} />
                    <span className="truncate">
                      {formatThemeLabel(theme.metadata.name, 'light')}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsStackedField>

        <SettingsStackedField
          label={t('Dark Theme')}
          settingsItem="appearance.dark-theme"
        >
          <Select
            value={selectedDarkTheme?.metadata.id ?? ''}
            onValueChange={setDarkThemePreference}
          >
            <SelectTrigger
              aria-label={t('Select dark theme')}
              size={SETTINGS_SELECT_SIZE}
              className={SETTINGS_SELECT_TRIGGER_CLASS}
            >
              <SelectValue placeholder={t('Select theme')}>
                {selectedDarkTheme ? (
                  <span className="flex min-w-0 items-center gap-2">
                    <ThemeSwatch theme={selectedDarkTheme} />
                    <span className="truncate">
                      {formatThemeLabel(selectedDarkTheme.metadata.name, 'dark')}
                    </span>
                  </span>
                ) : undefined}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {darkThemes.map((theme) => (
                <SelectItem key={theme.metadata.id} value={theme.metadata.id}>
                  <span className="flex min-w-0 items-center gap-2">
                    <ThemeSwatch theme={theme} />
                    <span className="truncate">
                      {formatThemeLabel(theme.metadata.name, 'dark')}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsStackedField>
      </SettingsTwoColumn>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          disabled={customThemesLoading || themesReloading}
          onClick={() => {
            const startedAt = Date.now();
            setThemesReloading(true);
            void reloadCustomThemes().finally(() => {
              const elapsed = Date.now() - startedAt;
              if (elapsed < 500) {
                window.setTimeout(() => {
                  setThemesReloading(false);
                }, 500 - elapsed);
                return;
              }
              setThemesReloading(false);
            });
          }}
          className="typography-settings-link inline-flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
        >
          <Icon
            name="restart"
            className={cn('h-3.5 w-3.5', themesReloading && 'animate-spin')}
          />
          {themesReloading ? t('Reloading themes...') : t('Reload themes')}
        </button>
        <SettingsInfoHint>
          {t('Import custom themes from ~/.config/pichamber/themes/')}
        </SettingsInfoHint>
      </div>

      {dockBadgeSupported && (
        <SettingsInset settingsItem="appearance.dock-badge">
          <SettingsCheckboxRow
            checked={dockBadgeEnabled}
            onChange={setDockBadgeEnabled}
            label={t('Dock badge')}
            info={t('Show a count of chats with unseen activity on the macOS dock icon.')}
            ariaLabel={t('Dock badge')}
          />
        </SettingsInset>
      )}
    </SettingsSection>
  );
};

