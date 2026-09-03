import React from 'react';

import {
  SETTINGS_FIELDS_STACK_CLASS,
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
  return (
    <SettingsSection title={'Localization'}>
      <SettingsTwoColumn>
        {(shouldShowTimeFormat || shouldShowWeekStart) && (
          <div className={SETTINGS_FIELDS_STACK_CLASS}>
            {shouldShowTimeFormat && (
              <SettingsStackedField
                label={'Time Format'}
                settingsItem="appearance.time-format"
              >
                <Select
                  value={timeFormatPreference}
                  onValueChange={(value: 'auto' | '12h' | '24h') =>
                    onTimeFormatPreferenceChange(value)
                  }
                >
                  <SelectTrigger
                    aria-label={'Select time format'}
                    size={SETTINGS_SELECT_SIZE}
                    className={SETTINGS_SELECT_TRIGGER_CLASS}
                  >
                    <SelectValue>{selectedTimeFormatLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {TIME_FORMAT_OPTIONS.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsStackedField>
            )}

            {shouldShowWeekStart && (
              <SettingsStackedField
                label={'Week Starts On'}
                settingsItem="appearance.week-start"
              >
                <Select
                  value={weekStartPreference}
                  onValueChange={(value: 'auto' | 'monday' | 'sunday') =>
                    onWeekStartPreferenceChange(value)
                  }
                >
                  <SelectTrigger
                    aria-label={'Select week start'}
                    size={SETTINGS_SELECT_SIZE}
                    className={SETTINGS_SELECT_TRIGGER_CLASS}
                  >
                    <SelectValue>{selectedWeekStartLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {WEEK_START_OPTIONS.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsStackedField>
            )}
          </div>
        )}
      </SettingsTwoColumn>
    </SettingsSection>
  );
};
