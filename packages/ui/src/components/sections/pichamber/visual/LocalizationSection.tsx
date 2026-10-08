import React from 'react';
import { useTranslation } from 'react-i18next';

import {
  SETTINGS_SELECT_SIZE,
  SETTINGS_SELECT_TRIGGER_CLASS,
  SettingsSection,
  SettingsStackedField,
  SettingsTwoColumn,
} from '@/components/sections/shared/SettingsSection';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  SUPPORTED_LANGUAGES,
  getLanguagePreference,
  setLanguagePreference,
  type LanguagePreference,
} from '@/i18n';
import { TIME_FORMAT_OPTIONS, WEEK_START_OPTIONS } from './visualSettingsConstants';

export interface LocalizationSectionProps {
  shouldShowTimeFormat: boolean;
  shouldShowWeekStart: boolean;
  timeFormatPreference: 'auto' | '12h' | '24h';
  selectedTimeFormatLabel: string;
  onTimeFormatPreferenceChange: (value: 'auto' | '12h' | '24h') => void;
  weekStartPreference: 'auto' | 'monday' | 'sunday';
  selectedWeekStartLabel: string;
  onWeekStartPreferenceChange: (value: 'auto' | 'monday' | 'sunday') => void;
}

export const LocalizationSection: React.FC<LocalizationSectionProps> = ({
  shouldShowTimeFormat,
  shouldShowWeekStart,
  timeFormatPreference,
  selectedTimeFormatLabel,
  onTimeFormatPreferenceChange,
  weekStartPreference,
  selectedWeekStartLabel,
  onWeekStartPreferenceChange,
}) => {
  const { t } = useTranslation();
  const [languagePreference, setLanguagePreferenceState] = React.useState<LanguagePreference>(
    () => getLanguagePreference(),
  );

  const handleLanguageChange = React.useCallback((value: LanguagePreference) => {
    setLanguagePreferenceState(value);
    setLanguagePreference(value);
  }, []);

  return (
    <SettingsSection title={t('Localization')}>
      <SettingsTwoColumn className="gap-4 @md:grid-cols-2 @md:gap-8 @3xl:gap-10">
        <SettingsStackedField
          label={t('Language')}
          settingsItem="appearance.language"
        >
          <Select
            value={languagePreference}
            onValueChange={(value: LanguagePreference) => handleLanguageChange(value)}
          >
            <SelectTrigger
              aria-label={t('Select language')}
              size={SETTINGS_SELECT_SIZE}
              className={SETTINGS_SELECT_TRIGGER_CLASS}
            >
              <SelectValue>
                {SUPPORTED_LANGUAGES.find((option) => option.value === languagePreference)?.label ??
                  languagePreference}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {SUPPORTED_LANGUAGES.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {t(option.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsStackedField>

        {shouldShowTimeFormat && (
          <SettingsStackedField
            label={t('Time Format')}
            settingsItem="appearance.time-format"
          >
            <Select
              value={timeFormatPreference}
              onValueChange={(value: 'auto' | '12h' | '24h') =>
                onTimeFormatPreferenceChange(value)
              }
            >
              <SelectTrigger
                aria-label={t('Select time format')}
                size={SETTINGS_SELECT_SIZE}
                className={SETTINGS_SELECT_TRIGGER_CLASS}
              >
                <SelectValue>{selectedTimeFormatLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {TIME_FORMAT_OPTIONS.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {t(option.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsStackedField>
        )}

        {shouldShowWeekStart && (
          <SettingsStackedField
            label={t('Week Starts On')}
            settingsItem="appearance.week-start"
          >
            <Select
              value={weekStartPreference}
              onValueChange={(value: 'auto' | 'monday' | 'sunday') =>
                onWeekStartPreferenceChange(value)
              }
            >
              <SelectTrigger
                aria-label={t('Select week start')}
                size={SETTINGS_SELECT_SIZE}
                className={SETTINGS_SELECT_TRIGGER_CLASS}
              >
                <SelectValue>{selectedWeekStartLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {WEEK_START_OPTIONS.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {t(option.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsStackedField>
        )}
      </SettingsTwoColumn>
    </SettingsSection>
  );
};
