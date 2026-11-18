import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  SettingsCheckboxRow,
  SettingsChipGroup,
  SettingsControlGroup,
  SettingsInset,
  SettingsRadioGroup,
  SettingsSection,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { cn } from '@/lib/utils';
import type { MobileLayoutPreference } from '@/lib/mobileLayoutPreference';
import type { Theme, ThemeMode } from '@/types/theme';
import {
  COLLAPSED_THEME_COUNT,
  MOBILE_LAYOUT_OPTIONS,
  THEME_MODE_OPTIONS,
  type ThemeFamily,
  collapsedFamilies,
  familyOf,
  themeFamilies,
} from './visualSettingsConstants';
import { WallpaperSettings } from './WallpaperSettings';
import { ThemeSwatch } from './ThemeSwatch';

export interface ThemeSectionProps {
  themes: Theme[];
  /** The theme on screen, which picks the selected family and the half each tile shows. */
  currentTheme: Theme;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  onSelectFamily: (family: ThemeFamily) => void;
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

/** One theme family as a radio pill: its swatch, in the half the mode shows, and its name. */
const ThemePill: React.FC<{
  family: ThemeFamily;
  variant: 'light' | 'dark';
  selected: boolean;
  onSelect: () => void;
}> = ({ family, variant, selected, onSelect }) => {
  const swatch = family[variant] ?? family.light ?? family.dark;
  const only = !family.light ? 'Dark only' : !family.dark ? 'Light only' : undefined;
  return (
    <div
      role="radio"
      tabIndex={0}
      aria-checked={selected}
      aria-label={only ? `${family.name}, ${only.toLowerCase()}` : family.name}
      title={family.name}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'flex min-w-0 max-w-full cursor-pointer items-center gap-2.5 rounded-lg border py-1.5 pl-1.5 pr-3 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-base)]',
        // Border and ring share one colour and neither changes the box, so selecting never shifts the pill.
        selected
          ? 'border-[var(--primary-base)] ring-1 ring-[var(--primary-base)]'
          : 'border-[var(--interactive-border)] hover:border-foreground/30',
      )}
    >
      {swatch ? <ThemeSwatch theme={swatch} /> : null}
      <span className="flex min-w-0 flex-col">
        <span className="truncate typography-settings-field-label font-normal text-foreground">{family.name}</span>
        {only ? <span className="truncate typography-meta text-muted-foreground">{only}</span> : null}
      </span>
    </div>
  );
};

/**
 * Settings → Appearance: System, Light or Dark, then the theme, picked from
 * one pill per family (PiChamber covers PiChamber Light and Dark), then the
 * wallpaper. Each pill shows the half the current mode uses.
 */
export const ThemeSection: React.FC<ThemeSectionProps> = ({
  themes,
  currentTheme,
  themeMode,
  onThemeModeChange,
  onSelectFamily,
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
  const families = React.useMemo(() => themeFamilies(themes), [themes]);
  const currentFamily = familyOf(families, currentTheme.metadata.id);
  const shown = showAll ? families : collapsedFamilies(families, currentFamily?.key);
  const variant = currentTheme.metadata.variant;

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
      <SettingsStackedField label={'Mode'} settingsItem="appearance.color-mode">
        <SettingsChipGroup
          value={themeMode}
          options={THEME_MODE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
          onChange={onThemeModeChange}
          aria-label={'Mode'}
        />
      </SettingsStackedField>

      <SettingsControlGroup title={'Theme'} settingsItem="appearance.theme">
        <SettingsRadioGroup
          aria-label={'Theme'}
          className="flex max-w-[48rem] flex-wrap gap-2 space-y-0"
        >
          {shown.map((family) => (
            <ThemePill
              key={family.key}
              family={family}
              variant={variant}
              selected={family.key === currentFamily?.key}
              onSelect={() => onSelectFamily(family)}
            />
          ))}
        </SettingsRadioGroup>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-3">
          {families.length > COLLAPSED_THEME_COUNT ? (
            <button
              type="button"
              aria-expanded={showAll}
              onClick={() => setShowAll((value) => !value)}
              className="typography-settings-link"
            >
              {showAll ? 'Show fewer' : `Show all ${families.length} themes`}
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
