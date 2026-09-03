import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  SETTINGS_CLUSTER_CONTROL_CLASS,
  SETTINGS_CONTROL_CLUSTER_CLASS,
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_SELECT_SIZE,
  SettingsFieldRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { normalizeMobileKeyboardMode, type MobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import {
  DEFAULT_PWA_INSTALL_NAME,
  MOBILE_KEYBOARD_MODE_OPTIONS,
  normalizePwaOrientation,
  PWA_ORIENTATION_OPTIONS,
} from './visualSettingsConstants';

export interface AppInstallSectionProps {
  showPwaInstallNameSetting: boolean;
  pwaInstallName: string;
  setPwaInstallName: (name: string) => void;
  onApplyPwaInstallName: (name: string) => void;
  showPwaOrientationSetting: boolean;
  pwaOrientation: 'system' | 'portrait' | 'landscape';
  selectedPwaOrientationLabel?: string;
  onApplyPwaOrientation: (orientation: 'system' | 'portrait' | 'landscape') => void;
  showMobileKeyboardModeSetting: boolean;
  mobileKeyboardMode: MobileKeyboardMode;
  selectedMobileKeyboardModeLabel?: string;
  onSetMobileKeyboardMode: (mode: MobileKeyboardMode) => void;
}

export const AppInstallSection: React.FC<AppInstallSectionProps> = ({
  showPwaInstallNameSetting,
  pwaInstallName,
  setPwaInstallName,
  onApplyPwaInstallName,
  showPwaOrientationSetting,
  pwaOrientation,
  selectedPwaOrientationLabel,
  onApplyPwaOrientation,
  showMobileKeyboardModeSetting,
  mobileKeyboardMode,
  selectedMobileKeyboardModeLabel,
  onSetMobileKeyboardMode,
}) => {
  return (
    <SettingsSection title={'App install'} contentClassName={SETTINGS_FIELDS_STACK_CLASS}>
      {showPwaInstallNameSetting && (
        <SettingsFieldRow
          label={'Install App Name'}
          info={'Used by PWA installation process.'}
          settingsItem="appearance.pwa-install-name"
          alignEnd={false}
          controlClassName={SETTINGS_CONTROL_CLUSTER_CLASS}
        >
          <Input
            value={pwaInstallName}
            onChange={(event) => setPwaInstallName(event.target.value)}
            onBlur={() => {
              void onApplyPwaInstallName(pwaInstallName);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void onApplyPwaInstallName(pwaInstallName);
              }
            }}
            className="min-w-0 flex-1"
            maxLength={64}
            aria-label={'PWA install app name'}
          />
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => {
              setPwaInstallName(DEFAULT_PWA_INSTALL_NAME);
              void onApplyPwaInstallName('');
            }}
            className={SETTINGS_ICON_BUTTON_CLASS}
            aria-label={'Reset install app name'}
            title={'Reset'}
          >
            <Icon name="restart" className="h-3.5 w-3.5" />
          </Button>
        </SettingsFieldRow>
      )}

      {showPwaOrientationSetting && (
        <SettingsFieldRow
          label={'Install Orientation'}
          description={'Used by the installed web app. Reinstall the PWA after changing this.'}
          settingsItem="appearance.pwa-orientation"
          alignEnd={false}
          controlClassName={SETTINGS_CONTROL_CLUSTER_CLASS}
        >
          <Select
            value={pwaOrientation}
            onValueChange={(value) => {
              const orientation = normalizePwaOrientation(value);
              onApplyPwaOrientation(orientation);
            }}
          >
            <SelectTrigger
              aria-label={'PWA install orientation'}
              size={SETTINGS_SELECT_SIZE}
              className={SETTINGS_CLUSTER_CONTROL_CLASS}
            >
              <SelectValue placeholder={'Select orientation'}>
                {selectedPwaOrientationLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PWA_ORIENTATION_OPTIONS.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => {
              onApplyPwaOrientation('system');
            }}
            disabled={pwaOrientation === 'system'}
            className={SETTINGS_ICON_BUTTON_CLASS}
            aria-label={'Reset install orientation'}
            title={'Reset'}
          >
            <Icon name="restart" className="h-3.5 w-3.5" />
          </Button>
        </SettingsFieldRow>
      )}

      {showMobileKeyboardModeSetting && (
        <SettingsFieldRow
          label={'Mobile Keyboard Behavior'}
          info={
            'Default browser behavior is safest. Resize content asks supported browsers to shrink the app when the on-screen keyboard opens.'
          }
          settingsItem="appearance.mobile-keyboard-mode"
          alignEnd={false}
          controlClassName={SETTINGS_CONTROL_CLUSTER_CLASS}
        >
          <Select
            value={mobileKeyboardMode}
            onValueChange={(value) => {
              const mode = normalizeMobileKeyboardMode(value);
              onSetMobileKeyboardMode(mode);
            }}
          >
            <SelectTrigger
              aria-label={'Mobile keyboard behavior'}
              size={SETTINGS_SELECT_SIZE}
              className={SETTINGS_CLUSTER_CONTROL_CLASS}
            >
              <SelectValue placeholder={'Select keyboard behavior'}>
                {selectedMobileKeyboardModeLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {MOBILE_KEYBOARD_MODE_OPTIONS.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => {
              onSetMobileKeyboardMode('native');
            }}
            disabled={mobileKeyboardMode === 'native'}
            className={SETTINGS_ICON_BUTTON_CLASS}
            aria-label={'Reset mobile keyboard behavior'}
            title={'Reset'}
          >
            <Icon name="restart" className="h-3.5 w-3.5" />
          </Button>
        </SettingsFieldRow>
      )}
    </SettingsSection>
  );
};
