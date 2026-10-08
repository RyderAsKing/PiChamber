import React from 'react';
import { useTranslation } from 'react-i18next';

import {
  SETTINGS_OPTION_STACK_CLASS,
  SettingsCheckboxRow,
  SettingsControlGroup,
  SettingsRadioGroup,
  SettingsRadioOption,
  SettingsSection,
  SettingsTwoColumn,
} from '@/components/sections/shared/SettingsSection';
import type { FollowUpBehavior } from '@/stores/messageQueueStore';
import {
  DIFF_LAYOUT_OPTIONS,
  FOLLOW_UP_BEHAVIOR_OPTIONS,
  type VisibleSetting,
} from './visualSettingsConstants';

export interface ChatBehaviorSectionProps {
  hasBehaviorSettings: boolean;
  showBehaviorMessageOptions: boolean;
  behaviorSectionDivider: boolean;
  shouldShow: (setting: VisibleSetting) => boolean;
  diffLayoutPreference: 'dynamic' | 'inline' | 'side-by-side';
  setDiffLayoutPreference: (layout: 'dynamic' | 'inline' | 'side-by-side') => void;
  followUpBehavior: FollowUpBehavior;
  setFollowUpBehavior: (behavior: FollowUpBehavior) => void;
  draftStartersVisible: boolean;
  onDraftStartersVisibleChange: (visible: boolean) => void;
}

export const ChatBehaviorSection: React.FC<ChatBehaviorSectionProps> = ({
  hasBehaviorSettings,
  showBehaviorMessageOptions,
  behaviorSectionDivider,
  shouldShow,
  diffLayoutPreference,
  setDiffLayoutPreference,
  followUpBehavior,
  setFollowUpBehavior,
  draftStartersVisible,
  onDraftStartersVisibleChange,
}) => {
  const { t } = useTranslation();
  if (!hasBehaviorSettings) return null;

  return (
    <>
      {showBehaviorMessageOptions && (
        <SettingsSection title={t('Message options')} divider={behaviorSectionDivider}>
          {/* Flat 2×2 grid so row headers share a baseline (not stacked columns). */}
          <SettingsTwoColumn className="lg:gap-y-6">
            {shouldShow('diffLayout') && (
              <SettingsControlGroup title={t('Diff Layout')}>
                <SettingsRadioGroup aria-label={t('Diff layout')}>
                  {DIFF_LAYOUT_OPTIONS.map((option) => (
                    <SettingsRadioOption
                      key={option.id}
                      selected={diffLayoutPreference === option.id}
                      onSelect={() => setDiffLayoutPreference(option.id)}
                      label={t(option.label)}
                      ariaLabel={t('Diff layout: {{label}}', { label: option.label })}
                    />
                  ))}
                </SettingsRadioGroup>
              </SettingsControlGroup>
            )}

            {shouldShow('followUpBehavior') && (
              <SettingsControlGroup
                title={t('Follow-up behavior')}
                info={t('Follow-up waits until the agent finishes, then sends. Steering is delivered at the next supported tool or turn boundary. Follow-ups stay on this device.')}
                settingsItem="chat.follow-up-behavior"
              >
                <SettingsRadioGroup aria-label={t('Follow-up behavior')}>
                  {FOLLOW_UP_BEHAVIOR_OPTIONS.map((option) => (
                    <SettingsRadioOption
                      key={option.id}
                      selected={followUpBehavior === option.id}
                      onSelect={() => setFollowUpBehavior(option.id)}
                      label={t(option.label)}
                      ariaLabel={t('Follow-up behavior: {{label}}', { label: option.label })}
                    />
                  ))}
                </SettingsRadioGroup>
              </SettingsControlGroup>
            )}
          </SettingsTwoColumn>
        </SettingsSection>
      )}

      <SettingsSection
        title={t('Features')}
        contentClassName={SETTINGS_OPTION_STACK_CLASS}
      >
        <SettingsCheckboxRow
          checked={draftStartersVisible}
          onChange={onDraftStartersVisibleChange}
          label={t('Show Starters on New Session Screen')}
          ariaLabel={t('Show starters on the new session screen')}
          settingsItem="chat.draft-starters-visible"
        />
      </SettingsSection>
    </>
  );
};
