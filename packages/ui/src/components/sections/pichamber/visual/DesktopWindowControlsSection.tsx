import React from 'react';

import {
  SettingsChipGroup,
  SettingsSection,
  SettingsStackedField,
  SettingsTwoColumn,
} from '@/components/sections/shared/SettingsSection';
import type { DesktopWindowControlsPosition, DesktopWindowControlsStyle } from '@/lib/desktop';
import {
  WINDOW_CONTROLS_POSITION_OPTIONS,
  WINDOW_CONTROLS_STYLE_OPTIONS,
} from './visualSettingsConstants';

export interface DesktopWindowControlsSectionProps {
  desktopWindowControlsPosition: DesktopWindowControlsPosition;
  desktopWindowControlsStyle: DesktopWindowControlsStyle;
  hasThemeSettings: boolean;
  onWindowControlsPositionChange: (pos: DesktopWindowControlsPosition) => void;
  onWindowControlsStyleChange: (style: DesktopWindowControlsStyle) => void;
}

export const DesktopWindowControlsSection: React.FC<DesktopWindowControlsSectionProps> = ({
  desktopWindowControlsPosition,
  desktopWindowControlsStyle,
  hasThemeSettings,
  onWindowControlsPositionChange,
  onWindowControlsStyleChange,
}) => {
  return (
    <SettingsSection
      title={'Window controls'}
      info={'Choose where minimize, maximize, and close buttons appear. Defaults to the right.'}
      divider={hasThemeSettings}
    >
      <SettingsTwoColumn>
        <SettingsStackedField
          label={'Window controls position'}
          settingsItem="sessions.desktop-window-controls-position"
        >
          <SettingsChipGroup
            value={desktopWindowControlsPosition}
            options={WINDOW_CONTROLS_POSITION_OPTIONS.map((option) => ({
              value: option.id,
              label: option.label,
            }))}
            onChange={onWindowControlsPositionChange}
            aria-label={'Window controls position'}
          />
        </SettingsStackedField>
        <SettingsStackedField
          label={'Style'}
          settingsItem="sessions.desktop-window-controls-style"
        >
          <SettingsChipGroup
            value={desktopWindowControlsStyle}
            options={WINDOW_CONTROLS_STYLE_OPTIONS.map((option) => ({
              value: option.id,
              label: option.label,
            }))}
            onChange={onWindowControlsStyleChange}
            aria-label={'Window controls style'}
          />
        </SettingsStackedField>
      </SettingsTwoColumn>
    </SettingsSection>
  );
};
