import React from 'react';
import { useTranslation } from 'react-i18next';

import { Icon } from '@/components/icon/Icon';
import {
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_NUMBER_STEPPER_ROW_CLASS,
  SETTINGS_NUMBER_UNIT_CLASS,
  SETTINGS_SELECT_SIZE,
  SETTINGS_SELECT_TRIGGER_CLASS,
  SettingsSection,
  SettingsStackedField,
  SettingsTwoColumn,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  CODE_FONT_OPTIONS,
  DEFAULT_MONO_FONT,
  DEFAULT_UI_FONT,
  UI_FONT_OPTIONS,
  type MonoFontOption,
  type UiFontOption,
} from '@/lib/fontOptions';
import type { VisibleSetting } from './visualSettingsConstants';

export interface DensityAndTypeSectionProps {
  shouldShow: (setting: VisibleSetting) => boolean;
  uiFont: UiFontOption;
  setUiFont: (font: UiFontOption) => void;
  monoFont: MonoFontOption;
  setMonoFont: (font: MonoFontOption) => void;
  fontSize: number;
  setFontSize: (size: number) => void;
  terminalFontSize: number;
  setTerminalFontSize: (size: number) => void;
  editorFontSize: number;
  setEditorFontSize: (size: number) => void;
  padding: number;
  setPadding: (pad: number) => void;
  inputBarOffset: number;
  setInputBarOffset: (offset: number) => void;
  isMobile: boolean;
}

export const DensityAndTypeSection: React.FC<DensityAndTypeSectionProps> = ({
  shouldShow,
  uiFont,
  setUiFont,
  monoFont,
  setMonoFont,
  fontSize,
  setFontSize,
  terminalFontSize,
  setTerminalFontSize,
  editorFontSize,
  setEditorFontSize,
  padding,
  setPadding,
  inputBarOffset,
  setInputBarOffset,
  isMobile,
}) => {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t('Density & type')} contentClassName={SETTINGS_FIELDS_STACK_CLASS}>
      {shouldShow('fontSize') || shouldShow('terminalFontSize') ? (
        <SettingsTwoColumn>
          {shouldShow('fontSize') && (
            <SettingsStackedField
              label={t('Interface Font')}
              settingsItem="appearance.interface-font-size"
              controlClassName="w-full"
            >
              <Select
                value={uiFont}
                onValueChange={(value) => setUiFont(value as UiFontOption)}
              >
                <SelectTrigger
                  aria-label={t('Select interface font')}
                  size={SETTINGS_SELECT_SIZE}
                  className={SETTINGS_SELECT_TRIGGER_CLASS}
                >
                  <SelectValue>
                    {UI_FONT_OPTIONS.find((option) => option.id === uiFont)?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {UI_FONT_OPTIONS.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      <span style={{ fontFamily: option.stack }}>{option.label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => setUiFont(DEFAULT_UI_FONT)}
                disabled={uiFont === DEFAULT_UI_FONT}
                className={SETTINGS_ICON_BUTTON_CLASS}
                aria-label={t('Reset interface font')}
                title={t('Reset')}
              >
                <Icon name="restart" className="h-3.5 w-3.5" />
              </Button>
            </SettingsStackedField>
          )}
          {shouldShow('terminalFontSize') && (
            <SettingsStackedField label={t('Code Font')} controlClassName="w-full">
              <Select
                value={monoFont}
                onValueChange={(value) => setMonoFont(value as MonoFontOption)}
              >
                <SelectTrigger
                  aria-label={t('Select code font')}
                  size={SETTINGS_SELECT_SIZE}
                  className={SETTINGS_SELECT_TRIGGER_CLASS}
                >
                  <SelectValue>
                    {CODE_FONT_OPTIONS.find((option) => option.id === monoFont)?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {CODE_FONT_OPTIONS.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      <span style={{ fontFamily: option.stack }}>{option.label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => setMonoFont(DEFAULT_MONO_FONT)}
                disabled={monoFont === DEFAULT_MONO_FONT}
                className={SETTINGS_ICON_BUTTON_CLASS}
                aria-label={t('Reset code font')}
                title={t('Reset')}
              >
                <Icon name="restart" className="h-3.5 w-3.5" />
              </Button>
            </SettingsStackedField>
          )}
        </SettingsTwoColumn>
      ) : null}

      {shouldShow('fontSize') ||
      shouldShow('terminalFontSize') ||
      shouldShow('editorFontSize') ? (
        <SettingsTwoColumn>
          {shouldShow('fontSize') && (
            <SettingsStackedField
              label={t('Interface Font Size')}
              settingsItem="appearance.interface-font-size"
              controlClassName="w-full"
            >
              <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
                <NumberInput
                  value={fontSize}
                  onValueChange={setFontSize}
                  min={50}
                  max={200}
                  step={5}
                  aria-label={t('Font size percentage')}
                />
                <span className={SETTINGS_NUMBER_UNIT_CLASS}>%</span>
                <Button
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => setFontSize(100)}
                  disabled={fontSize === 100}
                  className={SETTINGS_ICON_BUTTON_CLASS}
                  aria-label={t('Reset font size')}
                  title={t('Reset')}
                >
                  <Icon name="restart" className="h-3.5 w-3.5" />
                </Button>
              </div>
            </SettingsStackedField>
          )}
          {shouldShow('terminalFontSize') && (
            <SettingsStackedField
              label={t('Terminal Font Size')}
              settingsItem="appearance.terminal-font-size"
              controlClassName="w-full"
            >
              <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
                <NumberInput
                  value={terminalFontSize}
                  onValueChange={setTerminalFontSize}
                  min={9}
                  max={52}
                  step={1}
                />
                <span className={SETTINGS_NUMBER_UNIT_CLASS}>px</span>
                <Button
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => setTerminalFontSize(13)}
                  disabled={terminalFontSize === 13}
                  className={SETTINGS_ICON_BUTTON_CLASS}
                  aria-label={t('Reset terminal font size')}
                  title={t('Reset')}
                >
                  <Icon name="restart" className="h-3.5 w-3.5" />
                </Button>
              </div>
            </SettingsStackedField>
          )}
          {shouldShow('editorFontSize') && (
            <SettingsStackedField
              label={t('Editor Font Size')}
              settingsItem="appearance.editor-font-size"
              controlClassName="w-full"
            >
              <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
                <NumberInput
                  value={editorFontSize}
                  onValueChange={setEditorFontSize}
                  min={9}
                  max={32}
                  step={1}
                />
                <span className={SETTINGS_NUMBER_UNIT_CLASS}>px</span>
                <Button
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => setEditorFontSize(13)}
                  disabled={editorFontSize === 13}
                  className={SETTINGS_ICON_BUTTON_CLASS}
                  aria-label={t('Reset editor font size')}
                  title={t('Reset')}
                >
                  <Icon name="restart" className="h-3.5 w-3.5" />
                </Button>
              </div>
            </SettingsStackedField>
          )}
        </SettingsTwoColumn>
      ) : null}

      {shouldShow('spacing') || (shouldShow('inputBarOffset') && isMobile) ? (
        <SettingsTwoColumn>
          {shouldShow('spacing') && (
            <SettingsStackedField
              label={t('Spacing Density')}
              settingsItem="appearance.spacing-density"
              controlClassName="w-full"
            >
              <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
                <NumberInput
                  value={padding}
                  onValueChange={setPadding}
                  min={50}
                  max={200}
                  step={5}
                />
                <span className={SETTINGS_NUMBER_UNIT_CLASS}>%</span>
                <Button
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => setPadding(100)}
                  disabled={padding === 100}
                  className={SETTINGS_ICON_BUTTON_CLASS}
                  aria-label={t('Reset spacing')}
                  title={t('Reset')}
                >
                  <Icon name="restart" className="h-3.5 w-3.5" />
                </Button>
              </div>
            </SettingsStackedField>
          )}
          {shouldShow('inputBarOffset') && isMobile && (
            <SettingsStackedField
              label={t('Input Bar Offset')}
              info={t('Raise input bar to avoid OS-level screen obstructions like home bars.')}
              settingsItem="appearance.input-bar-offset"
              controlClassName="w-full"
            >
              <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
                <NumberInput
                  value={inputBarOffset}
                  onValueChange={setInputBarOffset}
                  min={0}
                  max={100}
                  step={5}
                />
                <span className={SETTINGS_NUMBER_UNIT_CLASS}>px</span>
                <Button
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => setInputBarOffset(0)}
                  disabled={inputBarOffset === 0}
                  className={SETTINGS_ICON_BUTTON_CLASS}
                  aria-label={t('Reset input bar offset')}
                  title={t('Reset')}
                >
                  <Icon name="restart" className="h-3.5 w-3.5" />
                </Button>
              </div>
            </SettingsStackedField>
          )}
        </SettingsTwoColumn>
      ) : null}
    </SettingsSection>
  );
};
