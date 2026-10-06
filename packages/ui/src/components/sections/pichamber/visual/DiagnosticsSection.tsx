import React from 'react';
import { useTranslation } from 'react-i18next';

import {
  SETTINGS_OPTION_STACK_CLASS,
  SettingsCheckboxRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';

export interface DiagnosticsSectionProps {
  perfHudEnabled: boolean;
  onPerfHudEnabledChange: (enabled: boolean) => void;
  processRecordingSupported: boolean;
  processRecordingEnabled: boolean;
  processRecordingActive: boolean;
  processRecordingSaving: boolean;
  processRecordingError: string | null;
  onProcessRecordingEnabledChange: (enabled: boolean) => void;
}

export const DiagnosticsSection: React.FC<DiagnosticsSectionProps> = ({
  perfHudEnabled,
  onPerfHudEnabledChange,
  processRecordingSupported,
  processRecordingEnabled,
  processRecordingActive,
  processRecordingSaving,
  processRecordingError,
  onProcessRecordingEnabledChange,
}) => {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t('Diagnostics')} contentClassName={SETTINGS_OPTION_STACK_CLASS}>
      <SettingsCheckboxRow
        checked={perfHudEnabled}
        onChange={onPerfHudEnabledChange}
        label={t('Performance overlay')}
        info={t(
          'Shows live frame time, long tasks, and render counters. Adds overhead. Stays on this device only, and is not a substitute for profile:idle or profile:session.'
        )}
        ariaLabel={t('Performance overlay')}
        settingsItem="general.performance-overlay"
      />
      {processRecordingSupported ? (
        <SettingsCheckboxRow
          checked={processRecordingEnabled}
          onChange={onProcessRecordingEnabledChange}
          disabled={processRecordingSaving}
          label={t('Record Electron process performance')}
          info={t(
            'Samples CPU and memory for Electron processes every 10 seconds and writes a local diagnostics file. Recording continues after restart until disabled.'
          )}
          description={processRecordingError ?? (processRecordingEnabled && !processRecordingActive
            ? t('Recording could not start. Disable it and try again.')
            : undefined)}
          ariaLabel={t('Record Electron process performance')}
          settingsItem="general.process-performance-recording"
        />
      ) : null}
    </SettingsSection>
  );
};
