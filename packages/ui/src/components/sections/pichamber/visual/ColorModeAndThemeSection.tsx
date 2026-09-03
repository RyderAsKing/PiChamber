import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_SELECT_SIZE,
  SETTINGS_SELECT_TRIGGER_CLASS,
  SettingsCheckboxRow,
  SettingsChipGroup,
  SettingsInset,
  SettingsRadioGroup,
  SettingsRadioOption,
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
import type { ThemeMode } from '@/types/theme';
import { MOBILE_LAYOUT_OPTIONS, THEME_MODE_OPTIONS } from './visualSettingsConstants';

export interface ThemeOptionItem {
  metadata: {
    id: string;
    name: string;
  };
}

export interface ColorModeAndThemeSectionProps {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  showMobileLayoutSetting: boolean;
  mobileLayoutPreference: MobileLayoutPreference;
  onMobileLayoutPreferenceChange: (pref: MobileLayoutPreference) => void;
  selectedLightTheme: ThemeOptionItem | null | undefined;
  setLightThemePreference: (id: string) => void;
  lightThemes: ThemeOptionItem[];
  selectedDarkTheme: ThemeOptionItem | null | undefined;
  setDarkThemePreference: (id: string) => void;
  darkThemes: ThemeOptionItem[];
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
  return (
    <SettingsSection title={'Color mode & Theme'} divider={false}>
      <SettingsTwoColumn>
        <div className={SETTINGS_FIELDS_STACK_CLASS}>
          <SettingsRadioGroup aria-label={'Color Mode'}>
            {THEME_MODE_OPTIONS.map((option) => (
              <SettingsRadioOption
                key={option.value}
                selected={themeMode === option.value}
                onSelect={() => setThemeMode(option.value)}
                label={option.label}
                ariaLabel={option.label}
              />
            ))}
          </SettingsRadioGroup>

          {showMobileLayoutSetting && (
            <SettingsInset>
              <SettingsStackedField label={'Mobile Layout'}>
                <SettingsChipGroup
                  value={mobileLayoutPreference}
                  options={MOBILE_LAYOUT_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  onChange={onMobileLayoutPreferenceChange}
                  aria-label={'Mobile Layout'}
                />
              </SettingsStackedField>
            </SettingsInset>
          )}
        </div>

        <div className={SETTINGS_FIELDS_STACK_CLASS}>
          <SettingsStackedField
            label={'Light Theme'}
            settingsItem="appearance.light-theme"
          >
            <Select
              value={selectedLightTheme?.metadata.id ?? ''}
              onValueChange={setLightThemePreference}
            >
              <SelectTrigger
                aria-label={'Select light theme'}
                size={SETTINGS_SELECT_SIZE}
                className={SETTINGS_SELECT_TRIGGER_CLASS}
              >
                <SelectValue placeholder={'Select theme'}>
                  {selectedLightTheme
                    ? formatThemeLabel(selectedLightTheme.metadata.name, 'light')
                    : undefined}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {lightThemes.map((theme) => (
                  <SelectItem key={theme.metadata.id} value={theme.metadata.id}>
                    {formatThemeLabel(theme.metadata.name, 'light')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsStackedField>
          <SettingsStackedField
            label={'Dark Theme'}
            settingsItem="appearance.dark-theme"
          >
            <Select
              value={selectedDarkTheme?.metadata.id ?? ''}
              onValueChange={setDarkThemePreference}
            >
              <SelectTrigger
                aria-label={'Select dark theme'}
                size={SETTINGS_SELECT_SIZE}
                className={SETTINGS_SELECT_TRIGGER_CLASS}
              >
                <SelectValue placeholder={'Select theme'}>
                  {selectedDarkTheme
                    ? formatThemeLabel(selectedDarkTheme.metadata.name, 'dark')
                    : undefined}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {darkThemes.map((theme) => (
                  <SelectItem key={theme.metadata.id} value={theme.metadata.id}>
                    {formatThemeLabel(theme.metadata.name, 'dark')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsStackedField>

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
              {themesReloading ? 'Reloading themes...' : 'Reload themes'}
            </button>
            <SettingsInfoHint>
              {'Import custom themes from ~/.config/pichamber/themes/'}
            </SettingsInfoHint>
          </div>
        </div>
      </SettingsTwoColumn>

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
