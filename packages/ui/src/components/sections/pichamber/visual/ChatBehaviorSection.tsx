import React from 'react';

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
  if (!hasBehaviorSettings) return null;

  return (
    <>
      {showBehaviorMessageOptions && (
        <SettingsSection title={'Message options'} divider={behaviorSectionDivider}>
          {/* Flat 2×2 grid so row headers share a baseline (not stacked columns). */}
          <SettingsTwoColumn className="lg:gap-y-6">
            {shouldShow('diffLayout') && (
              <SettingsControlGroup title={'Diff Layout'}>
                <SettingsRadioGroup aria-label={'Diff layout'}>
                  {DIFF_LAYOUT_OPTIONS.map((option) => (
                    <SettingsRadioOption
                      key={option.id}
                      selected={diffLayoutPreference === option.id}
                      onSelect={() => setDiffLayoutPreference(option.id)}
                      label={option.label}
                      ariaLabel={`Diff layout: ${option.label}`}
                    />
                  ))}
                </SettingsRadioGroup>
              </SettingsControlGroup>
            )}

            {shouldShow('followUpBehavior') && (
              <SettingsControlGroup
                title={'Follow-up behavior'}
                settingsItem="chat.follow-up-behavior"
              >
                <SettingsRadioGroup aria-label={'Follow-up behavior'}>
                  {FOLLOW_UP_BEHAVIOR_OPTIONS.map((option) => (
                    <SettingsRadioOption
                      key={option.id}
                      selected={followUpBehavior === option.id}
                      onSelect={() => setFollowUpBehavior(option.id)}
                      label={option.label}
                      ariaLabel={`Follow-up behavior: ${option.label}`}
                    />
                  ))}
                </SettingsRadioGroup>
              </SettingsControlGroup>
            )}
          </SettingsTwoColumn>
        </SettingsSection>
      )}

      <SettingsSection
        title={'Features'}
        contentClassName={SETTINGS_OPTION_STACK_CLASS}
      >
        <SettingsCheckboxRow
          checked={draftStartersVisible}
          onChange={onDraftStartersVisibleChange}
          label={'Show Starters on New Session Screen'}
          ariaLabel={'Show starters on the new session screen'}
          settingsItem="chat.draft-starters-visible"
        />
      </SettingsSection>
    </>
  );
};
