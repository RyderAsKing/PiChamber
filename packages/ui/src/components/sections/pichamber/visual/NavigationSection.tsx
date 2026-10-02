import React from 'react';

import {
  SETTINGS_OPTION_STACK_CLASS,
  SETTINGS_SELECT_SIZE,
  SETTINGS_SELECT_TRIGGER_CLASS,
  SettingsCheckboxRow,
  SettingsControlGroup,
  SettingsPreviewOption,
  SettingsRadioGroup,
  SettingsRadioOption,
  SettingsSection,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { TerminalShell, TerminalShellOption } from '@/lib/api/types';
import { isTerminalShell } from '@/lib/terminalShell';
import type { SidebarViewMode } from '@/lib/sidebarViewMode';
import { SidebarViewPreview } from './SidebarViewPreview';
import {
  SIDEBAR_VIEW_MODE_OPTIONS,
  type VisibleSetting,
} from './visualSettingsConstants';

export interface NavigationSectionProps {
  shouldShow: (setting: VisibleSetting) => boolean;
  sidebarViewMode: SidebarViewMode;
  onSidebarViewModeChange: (mode: SidebarViewMode) => void;
  fileEditorKeymap: 'default' | 'vim';
  setFileEditorKeymap: (keymap: 'default' | 'vim') => void;
  autoSaveEnabled: boolean;
  setAutoSaveEnabled: (enabled: boolean) => void;
  expandedEditorToolbar: boolean;
  onExpandedEditorToolbarChange: (expanded: boolean) => void;
  showTerminalQuickKeysOnDesktop: boolean;
  setShowTerminalQuickKeysOnDesktop: (show: boolean) => void;
  showTerminalShellSetting: boolean;
  terminalShell: string;
  setTerminalShell: (shell: TerminalShell) => void;
  terminalShellOptions: TerminalShellOption[];
  terminalShellSupportsLogin: boolean;
  terminalLoginShellEnabled: boolean;
  setTerminalLoginShellEnabled: (enabled: boolean) => void;
}

export const NavigationSection: React.FC<NavigationSectionProps> = ({
  shouldShow,
  sidebarViewMode,
  onSidebarViewModeChange,
  fileEditorKeymap,
  setFileEditorKeymap,
  autoSaveEnabled,
  setAutoSaveEnabled,
  expandedEditorToolbar,
  onExpandedEditorToolbarChange,
  showTerminalQuickKeysOnDesktop,
  setShowTerminalQuickKeysOnDesktop,
  showTerminalShellSetting,
  terminalShell,
  setTerminalShell,
  terminalShellOptions,
  terminalShellSupportsLogin,
  terminalLoginShellEnabled,
  setTerminalLoginShellEnabled,
}) => {
  return (
    <SettingsSection title={'Navigation'} contentClassName="space-y-4">
      {shouldShow('sidebarViewMode') && (
        <SettingsControlGroup
          title={'Sidebar view'}
          info={'Workspace opens one folder at a time. By folder lists every folder with its sessions underneath. Timeline groups sessions from every folder by when they were last active. Applies to every device connected to this server.'}
          settingsItem="appearance.sidebar-view"
        >
          <SettingsRadioGroup aria-label={'Sidebar view'} className="grid max-w-[30rem] grid-cols-3 gap-2 space-y-0 @xl:gap-3">
            {SIDEBAR_VIEW_MODE_OPTIONS.map((option) => (
              <SettingsPreviewOption
                key={option.id}
                selected={sidebarViewMode === option.id}
                onSelect={() => onSidebarViewModeChange(option.id)}
                label={option.label}
                ariaLabel={option.label}
                preview={<SidebarViewPreview mode={option.id} />}
              />
            ))}
          </SettingsRadioGroup>
        </SettingsControlGroup>
      )}
      {shouldShow('fileEditorKeymap') && (
        <SettingsControlGroup
          title={'File editor keymap'}
          settingsItem="appearance.file-editor-keymap"
        >
          <SettingsRadioGroup aria-label={'File editor keymap'}>
            {(['default', 'vim'] as const).map((keymap) => (
              <SettingsRadioOption
                key={keymap}
                selected={fileEditorKeymap === keymap}
                onSelect={() => setFileEditorKeymap(keymap)}
                label={keymap === 'default' ? 'Default' : 'Vim'}
                ariaLabel={keymap === 'default' ? 'Default' : 'Vim'}
              />
            ))}
          </SettingsRadioGroup>
        </SettingsControlGroup>
      )}
      <div className={SETTINGS_OPTION_STACK_CLASS}>
        {shouldShow('autoSaveEnabled') && (
          <SettingsCheckboxRow
            checked={autoSaveEnabled}
            onChange={setAutoSaveEnabled}
            label={'Auto-save files'}
            ariaLabel={'Auto-save files'}
            info={
              'Automatically save file edits after you stop typing. Disable to require manual save.'
            }
            settingsItem="appearance.auto-save-enabled"
          />
        )}
        {shouldShow('expandedEditorToolbar') && (
          <SettingsCheckboxRow
            checked={expandedEditorToolbar}
            onChange={onExpandedEditorToolbarChange}
            label={'Always show editor toolbar (docked under the file tabs)'}
            ariaLabel={'Always show editor toolbar'}
            settingsItem="appearance.expanded-editor-toolbar"
          />
        )}
        {shouldShow('terminalQuickKeys') && (
          <SettingsCheckboxRow
            checked={showTerminalQuickKeysOnDesktop}
            onChange={setShowTerminalQuickKeysOnDesktop}
            label={'Terminal Quick Keys'}
            ariaLabel={'Terminal quick keys'}
            settingsItem="appearance.terminal-quick-keys"
            info={'Show Esc, Ctrl, Arrows in terminal view'}
          />
        )}
        {showTerminalShellSetting && (
          <SettingsStackedField
            label={'Terminal Shell'}
            info={'Restart the terminal to apply this change to the current session.'}
            settingsItem="appearance.terminal-shell"
            className="pt-2"
          >
            <Select
              value={terminalShell}
              onValueChange={(value) => {
                if (isTerminalShell(value)) setTerminalShell(value);
              }}
            >
              <SelectTrigger
                aria-label={'Select terminal shell'}
                size={SETTINGS_SELECT_SIZE}
                className={SETTINGS_SELECT_TRIGGER_CLASS}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{'Auto'}</SelectItem>
                {terminalShellOptions.map((shell) => (
                  <SelectItem key={shell.id} value={shell.id}>
                    {shell.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsStackedField>
        )}
        {showTerminalShellSetting && terminalShellSupportsLogin && (
          <SettingsCheckboxRow
            checked={terminalLoginShellEnabled}
            onChange={setTerminalLoginShellEnabled}
            label={'Start as login shell'}
            ariaLabel={'Start as login shell'}
            settingsItem="appearance.terminal-login-shell"
          />
        )}
      </div>
    </SettingsSection>
  );
};
