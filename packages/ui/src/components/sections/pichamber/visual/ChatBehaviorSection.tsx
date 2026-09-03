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
  MERMAID_RENDERING_OPTIONS,
  USER_MESSAGE_RENDERING_OPTIONS,
  normalizeUserMessageRenderingMode,
  type VisibleSetting,
} from './visualSettingsConstants';

export interface ChatBehaviorSectionProps {
  hasBehaviorSettings: boolean;
  showBehaviorMessageOptions: boolean;
  behaviorSectionDivider: boolean;
  showBehaviorFeatureCheckboxes: boolean;
  shouldShow: (setting: VisibleSetting) => boolean;
  userMessageRenderingMode: unknown;
  onUserMessageRenderingModeChange: (mode: 'markdown' | 'plain') => void;
  mermaidRenderingMode: 'svg' | 'ascii';
  onMermaidRenderingModeChange: (mode: 'svg' | 'ascii') => void;
  diffLayoutPreference: 'dynamic' | 'inline' | 'side-by-side';
  setDiffLayoutPreference: (layout: 'dynamic' | 'inline' | 'side-by-side') => void;
  followUpBehavior: FollowUpBehavior;
  setFollowUpBehavior: (behavior: FollowUpBehavior) => void;
  showExpandedBashTools: boolean;
  onShowExpandedBashToolsChange: (show: boolean) => void;
  showExpandedEditTools: boolean;
  onShowExpandedEditToolsChange: (show: boolean) => void;
  draftStartersVisible: boolean;
  onDraftStartersVisibleChange: (visible: boolean) => void;
  showReasoningTraces: boolean;
  onShowReasoningTracesChange: (show: boolean) => void;
  collapsibleThinkingBlocks: boolean;
  onCollapsibleThinkingBlocksChange: (collapsible: boolean) => void;
  collapseThinkingByDefault: boolean;
  onCollapseThinkingByDefaultChange: (collapsed: boolean) => void;
  collapsibleUserMessages: boolean;
  onCollapsibleUserMessagesChange: (collapsible: boolean) => void;
  stickyUserHeader: boolean;
  onStickyUserHeaderChange: (sticky: boolean) => void;
  promptNavigatorEnabled: boolean;
  onPromptNavigatorEnabledChange: (enabled: boolean) => void;
  wideChatLayoutEnabled: boolean;
  onWideChatLayoutChange: (enabled: boolean) => void;
  showSplitAssistantMessageActions: boolean;
  onShowSplitAssistantMessageActionsChange: (show: boolean) => void;
  codeBlockLineWrap: boolean;
  setCodeBlockLineWrap: (wrap: boolean) => void;
  showToolFileIcons: boolean;
  onShowToolFileIconsChange: (show: boolean) => void;
  showTurnChangedFiles: boolean;
  onShowTurnChangedFilesChange: (show: boolean) => void;
  directoryShowHidden: boolean;
  setDirectoryShowHidden: (show: boolean) => void;
  settingsDefaultFileViewerPreview: boolean;
  onFileViewerPreviewChange: (preview: boolean) => void;
  persistChatDraft: boolean;
  setPersistChatDraft: (persist: boolean) => void;
  inputSpellcheckEnabled: boolean;
  onInputSpellcheckChange: (spellcheck: boolean) => void;
}

export const ChatBehaviorSection: React.FC<ChatBehaviorSectionProps> = ({
  hasBehaviorSettings,
  showBehaviorMessageOptions,
  behaviorSectionDivider,
  showBehaviorFeatureCheckboxes,
  shouldShow,
  userMessageRenderingMode,
  onUserMessageRenderingModeChange,
  mermaidRenderingMode,
  onMermaidRenderingModeChange,
  diffLayoutPreference,
  setDiffLayoutPreference,
  followUpBehavior,
  setFollowUpBehavior,
  showExpandedBashTools,
  onShowExpandedBashToolsChange,
  showExpandedEditTools,
  onShowExpandedEditToolsChange,
  draftStartersVisible,
  onDraftStartersVisibleChange,
  showReasoningTraces,
  onShowReasoningTracesChange,
  collapsibleThinkingBlocks,
  onCollapsibleThinkingBlocksChange,
  collapseThinkingByDefault,
  onCollapseThinkingByDefaultChange,
  collapsibleUserMessages,
  onCollapsibleUserMessagesChange,
  stickyUserHeader,
  onStickyUserHeaderChange,
  promptNavigatorEnabled,
  onPromptNavigatorEnabledChange,
  wideChatLayoutEnabled,
  onWideChatLayoutChange,
  showSplitAssistantMessageActions,
  onShowSplitAssistantMessageActionsChange,
  codeBlockLineWrap,
  setCodeBlockLineWrap,
  showToolFileIcons,
  onShowToolFileIconsChange,
  showTurnChangedFiles,
  onShowTurnChangedFilesChange,
  directoryShowHidden,
  setDirectoryShowHidden,
  settingsDefaultFileViewerPreview,
  onFileViewerPreviewChange,
  persistChatDraft,
  setPersistChatDraft,
  inputSpellcheckEnabled,
  onInputSpellcheckChange,
}) => {
  if (!hasBehaviorSettings) return null;

  return (
    <>
      {showBehaviorMessageOptions && (
        <SettingsSection title={'Message options'} divider={behaviorSectionDivider}>
          {/* Flat 2×2 grid so row headers share a baseline (not stacked columns). */}
          <SettingsTwoColumn className="lg:gap-y-6">
            {shouldShow('userMessageRendering') && (
              <SettingsControlGroup title={'User Message Rendering'}>
                <SettingsRadioGroup aria-label={'User message rendering mode'}>
                  {USER_MESSAGE_RENDERING_OPTIONS.map((option) => (
                    <SettingsRadioOption
                      key={option.id}
                      selected={
                        normalizeUserMessageRenderingMode(userMessageRenderingMode) ===
                        option.id
                      }
                      onSelect={() => onUserMessageRenderingModeChange(option.id)}
                      label={option.label}
                      ariaLabel={`User message rendering: ${option.label}`}
                    />
                  ))}
                </SettingsRadioGroup>
              </SettingsControlGroup>
            )}

            {shouldShow('mermaidRendering') && (
              <SettingsControlGroup title={'Mermaid Rendering'}>
                <SettingsRadioGroup aria-label={'Mermaid rendering mode'}>
                  {MERMAID_RENDERING_OPTIONS.map((option) => (
                    <SettingsRadioOption
                      key={option.id}
                      selected={mermaidRenderingMode === option.id}
                      onSelect={() => onMermaidRenderingModeChange(option.id)}
                      label={option.label}
                      ariaLabel={`Mermaid rendering: ${option.label}`}
                    />
                  ))}
                </SettingsRadioGroup>
              </SettingsControlGroup>
            )}

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

      {showBehaviorFeatureCheckboxes && (
        <>
          {shouldShow('expandedTools') && (
            <SettingsSection
              title={'Show tools opened by default'}
              divider={showBehaviorMessageOptions || behaviorSectionDivider}
              contentClassName={SETTINGS_OPTION_STACK_CLASS}
            >
              <SettingsCheckboxRow
                checked={showExpandedBashTools}
                onChange={onShowExpandedBashToolsChange}
                label={'Bash'}
                ariaLabel={'Show expanded bash tools'}
              />
              <SettingsCheckboxRow
                checked={showExpandedEditTools}
                onChange={onShowExpandedEditToolsChange}
                label={'Edit tools'}
                ariaLabel={'Show expanded edit tools'}
              />
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
          {shouldShow('reasoning') && (
            <SettingsSection
              title={'Reasoning'}
              settingsItem="chat.reasoning"
              contentClassName={SETTINGS_OPTION_STACK_CLASS}
            >
              <SettingsCheckboxRow
                checked={showReasoningTraces}
                onChange={onShowReasoningTracesChange}
                label={'Show Reasoning Traces'}
                ariaLabel={'Show reasoning traces'}
                settingsItem="chat.reasoning-traces"
              />
              {showReasoningTraces && (
                <SettingsCheckboxRow
                  checked={collapsibleThinkingBlocks}
                  onChange={onCollapsibleThinkingBlocksChange}
                  label={'Enable Collapsible Reasoning Blocks'}
                  ariaLabel={'Enable collapsible reasoning blocks'}
                  settingsItem="chat.collapsible-reasoning"
                />
              )}
              {showReasoningTraces && collapsibleThinkingBlocks && (
                <SettingsCheckboxRow
                  checked={collapseThinkingByDefault}
                  onChange={onCollapseThinkingByDefaultChange}
                  label={'Collapsed by Default'}
                  ariaLabel={'Collapse reasoning blocks by default'}
                  info={
                    'Thinking still opens while it streams, then folds when that block finishes. Turn this off to keep a one-line trace unless you expand it.'
                  }
                  settingsItem="chat.collapsed-reasoning-default"
                />
              )}
            </SettingsSection>
          )}

          {(shouldShow('collapsibleUserMessages') ||
            shouldShow('stickyUserHeader') ||
            shouldShow('promptNavigatorEnabled') ||
            shouldShow('wideChatLayout') ||
            shouldShow('splitAssistantMessageActions') ||
            shouldShow('codeBlockLineWrap')) && (
            <SettingsSection
              title={'Message Appearance'}
              settingsItem="chat.message-appearance"
              contentClassName={SETTINGS_OPTION_STACK_CLASS}
            >
              {shouldShow('collapsibleUserMessages') && (
                <SettingsCheckboxRow
                  checked={collapsibleUserMessages}
                  onChange={onCollapsibleUserMessagesChange}
                  label={'Collapse Long User Messages'}
                  ariaLabel={'Collapse long user messages'}
                  settingsItem="chat.collapsible-user-messages"
                />
              )}

              {shouldShow('stickyUserHeader') && (
                <SettingsCheckboxRow
                  checked={stickyUserHeader}
                  onChange={onStickyUserHeaderChange}
                  label={'Sticky User Header'}
                  ariaLabel={'Sticky user header'}
                  settingsItem="chat.sticky-user-header"
                />
              )}

              {shouldShow('promptNavigatorEnabled') && (
                <SettingsCheckboxRow
                  checked={promptNavigatorEnabled}
                  onChange={onPromptNavigatorEnabledChange}
                  label={'Prompt Navigator'}
                  ariaLabel={'Prompt navigator'}
                  settingsItem="chat.prompt-navigator"
                />
              )}

              {shouldShow('wideChatLayout') && (
                <SettingsCheckboxRow
                  checked={wideChatLayoutEnabled}
                  onChange={onWideChatLayoutChange}
                  label={'Wide Chat Layout'}
                  ariaLabel={'Wide chat layout'}
                  settingsItem="chat.wide-layout"
                />
              )}

              {shouldShow('splitAssistantMessageActions') && (
                <SettingsCheckboxRow
                  checked={showSplitAssistantMessageActions}
                  onChange={onShowSplitAssistantMessageActionsChange}
                  label={'Inline Assistant Actions'}
                  ariaLabel={'Inline assistant actions'}
                  settingsItem="chat.inline-assistant-actions"
                  info={
                    'Show Copy Answer, Save as image, and Read aloud on assistant text blocks that appear before later tool calls in the same response.'
                  }
                />
              )}

              {shouldShow('codeBlockLineWrap') && (
                <SettingsCheckboxRow
                  checked={codeBlockLineWrap}
                  onChange={setCodeBlockLineWrap}
                  label={'Wrap Code Block Lines'}
                  ariaLabel={'Wrap code block lines'}
                  settingsItem="chat.code-block-line-wrap"
                />
              )}
            </SettingsSection>
          )}

          {(shouldShow('showToolFileIcons') ||
            shouldShow('showTurnChangedFiles') ||
            shouldShow('dotfiles') ||
            shouldShow('fileViewerPreview')) && (
            <SettingsSection
              title={'Tools & Files'}
              settingsItem="chat.tools-and-files"
              contentClassName={SETTINGS_OPTION_STACK_CLASS}
            >
              {shouldShow('showToolFileIcons') && (
                <SettingsCheckboxRow
                  checked={showToolFileIcons}
                  onChange={onShowToolFileIconsChange}
                  label={'Show Tool File Icons'}
                  ariaLabel={'Show tool file icons'}
                  settingsItem="chat.tool-file-icons"
                />
              )}

              {shouldShow('showTurnChangedFiles') && (
                <SettingsCheckboxRow
                  checked={showTurnChangedFiles}
                  onChange={onShowTurnChangedFilesChange}
                  label={'Show Changed Files for Completed Turns'}
                  ariaLabel={'Show changed files for completed turns'}
                  settingsItem="chat.changed-files"
                />
              )}

              {shouldShow('dotfiles') && (
                <SettingsCheckboxRow
                  checked={directoryShowHidden}
                  onChange={setDirectoryShowHidden}
                  label={'Show Dotfiles'}
                  ariaLabel={'Show dotfiles'}
                  settingsItem="chat.dotfiles"
                />
              )}

              {shouldShow('fileViewerPreview') && (
                <SettingsCheckboxRow
                  checked={settingsDefaultFileViewerPreview}
                  onChange={onFileViewerPreviewChange}
                  label={'Open previewable files in preview mode'}
                  ariaLabel={'Open previewable files in preview mode'}
                />
              )}
            </SettingsSection>
          )}

          {(shouldShow('persistDraft') || shouldShow('inputSpellcheck')) && (
            <SettingsSection
              title={'Composer'}
              settingsItem="chat.composer"
              contentClassName={SETTINGS_OPTION_STACK_CLASS}
            >
              {shouldShow('persistDraft') && (
                <SettingsCheckboxRow
                  checked={persistChatDraft}
                  onChange={setPersistChatDraft}
                  label={'Persist Draft Messages'}
                  ariaLabel={'Persist draft messages'}
                  settingsItem="chat.persist-drafts"
                />
              )}

              {shouldShow('inputSpellcheck') && (
                <SettingsCheckboxRow
                  checked={inputSpellcheckEnabled}
                  onChange={onInputSpellcheckChange}
                  label={'Enable Spellcheck in Text Inputs'}
                  ariaLabel={'Enable spellcheck in text inputs'}
                  settingsItem="chat.spellcheck"
                />
              )}
            </SettingsSection>
          )}
        </>
      )}
    </>
  );
};
