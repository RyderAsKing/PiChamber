import React from 'react';

import {
  SettingsCheckboxRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';

export interface DiagnosticsSectionProps {
  perfHudEnabled: boolean;
  onPerfHudEnabledChange: (enabled: boolean) => void;
}

export const DiagnosticsSection: React.FC<DiagnosticsSectionProps> = ({
  perfHudEnabled,
  onPerfHudEnabledChange,
}) => {
  return (
    <SettingsSection title={'Diagnostics'}>
      <SettingsCheckboxRow
        checked={perfHudEnabled}
        onChange={onPerfHudEnabledChange}
        label={'Performance overlay'}
        info={
          'Shows live frame time, long tasks, and render counters. Adds overhead. Stays on this device only, and is not a substitute for profile:idle or profile:session.'
        }
        ariaLabel={'Performance overlay'}
        settingsItem="general.performance-overlay"
      />
    </SettingsSection>
  );
};
