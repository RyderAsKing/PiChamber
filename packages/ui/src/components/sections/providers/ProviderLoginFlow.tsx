import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  SettingsFieldRow,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
} from '@/components/sections/shared/SettingsSection';
import type { PiProviderLoginState } from '@/lib/pi/protocol';

export const ProviderLoginFlow: React.FC<{
  login: PiProviderLoginState;
  promptValue: string;
  onPromptValueChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
}> = ({ login, promptValue, onPromptValueChange, onSubmit, busy }) => {
  return (
    <div className="space-y-3 border-t border-[var(--surface-subtle)] pt-3">
      {login.authUrl ? (
        <a className="typography-meta text-[var(--primary-base)] underline" href={login.authUrl.url} target="_blank" rel="noreferrer">
          {login.authUrl.instructions || 'Open'}
        </a>
      ) : null}
      {login.deviceCode ? (
        <div className="typography-meta text-muted-foreground">
          <span className="mr-2">Device code</span>
          <code className="text-foreground">{login.deviceCode.userCode}</code>
          <a
            className="ml-2 text-[var(--primary-base)] underline"
            href={login.deviceCode.verificationUri}
            target="_blank"
            rel="noreferrer"
          >
            Open
          </a>
        </div>
      ) : null}
      {login.prompt ? (
        <SettingsFieldRow label={login.prompt.message || 'Copy the authorization code from your browser and paste it here.'}>
          {login.prompt.type === 'select' && login.prompt.options ? (
            <Select value={promptValue} onValueChange={onPromptValueChange}>
              <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {login.prompt.options.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              type={login.prompt.type === 'secret' ? 'password' : 'text'}
              value={promptValue}
              onChange={(event) => onPromptValueChange(event.target.value)}
              placeholder={login.prompt.placeholder}
              autoComplete="off"
            />
          )}
          <Button size="sm" onClick={onSubmit} disabled={busy || promptValue.length === 0}>
            Continue
          </Button>
        </SettingsFieldRow>
      ) : (
        <p className="typography-meta text-muted-foreground">Waiting for authorization…</p>
      )}
    </div>
  );
};
