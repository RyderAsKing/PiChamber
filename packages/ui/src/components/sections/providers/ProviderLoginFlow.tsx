import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import {
  SettingsFieldRow,
  SettingsStackedField,
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
} from '@/components/sections/shared/SettingsSection';
import { copyTextToClipboard } from '@/lib/clipboard';
import type { PiProviderLoginState } from '@/lib/pi/protocol';

type ProviderLoginFlowProps = {
  login: PiProviderLoginState;
  promptValue: string;
  onPromptValueChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
};

const parseHttpUrl = (value: string | undefined): URL | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
};

// Browser OAuth: Pi listens for the redirect on the PiChamber host's loopback
// address and also accepts the pasted redirect URL (or code), which is the only
// way to finish when the browser runs on another device.
const ProviderBrowserSignIn: React.FC<ProviderLoginFlowProps & { authUrl: string }> = ({
  login,
  authUrl,
  promptValue,
  onPromptValueChange,
  onSubmit,
  busy,
}) => {
  const [copied, setCopied] = React.useState(false);
  const redirectUri = login.prompt?.placeholder;
  const expectsRedirectUrl = parseHttpUrl(redirectUri) !== null;
  const trimmed = promptValue.trim();
  const wrongUrl = expectsRedirectUrl && redirectUri && /^https?:\/\//i.test(trimmed) && !trimmed.startsWith(redirectUri);

  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyLink = async () => {
    const result = await copyTextToClipboard(authUrl);
    if (result.ok) setCopied(true);
    else toast.error('Could not copy the sign-in link');
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || trimmed.length === 0 || wrongUrl) return;
    onSubmit();
  };

  return (
    <div className="space-y-5 border-t border-[var(--surface-subtle)] pt-4">
      <SettingsStackedField label="1. Sign in" description="Open the sign-in page and finish signing in.">
        <Button asChild size="sm">
          <a href={authUrl} target="_blank" rel="noreferrer">
            <Icon name="external-link" className="size-4" />
            Open sign-in page
          </a>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={SETTINGS_ICON_BUTTON_CLASS}
          onClick={() => void copyLink()}
          aria-label={copied ? 'Sign-in link copied' : 'Copy sign-in link'}
          title={copied ? 'Copied' : 'Copy sign-in link'}
        >
          <Icon name={copied ? 'check' : 'file-copy'} className="size-4" />
        </Button>
      </SettingsStackedField>

      <form onSubmit={submit}>
        <SettingsStackedField
          label={expectsRedirectUrl ? '2. Paste the redirect URL' : '2. Paste the code'}
          description={expectsRedirectUrl ? (
            <>
              After you sign in, the browser opens a page starting with{' '}
              <code className="break-all text-foreground">{redirectUri}</code>. That page may not load, which is expected.
              Copy the full address from the address bar and paste it here.
            </>
          ) : (login.prompt?.message || 'Copy the code shown after you sign in and paste it here.')}
          controlClassName="max-w-[32rem]"
        >
          <Input
            className="h-8 min-w-0 flex-1 rounded-md px-3"
            value={promptValue}
            onChange={(event) => onPromptValueChange(event.target.value)}
            placeholder={expectsRedirectUrl ? `${redirectUri}?code=…` : login.prompt?.placeholder}
            aria-label={expectsRedirectUrl ? 'Redirect URL' : 'Authorization code'}
            aria-invalid={wrongUrl ? true : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" size="sm" disabled={busy || trimmed.length === 0 || Boolean(wrongUrl)}>
            {busy ? 'Connecting...' : 'Connect'}
          </Button>
        </SettingsStackedField>
        {wrongUrl ? (
          <p className="mt-2 typography-meta text-[var(--status-error)]">
            This isn't the redirect address. Paste the URL that starts with {redirectUri}.
          </p>
        ) : null}
      </form>

      <p className="flex items-center gap-2 typography-meta text-muted-foreground">
        <Icon name="loader-4" className="size-4 shrink-0 animate-spin" />
        {expectsRedirectUrl
          ? 'Waiting for sign-in. If your browser runs on the same machine as PiChamber, this finishes on its own.'
          : 'Waiting for the code…'}
      </p>
    </div>
  );
};

export const ProviderLoginFlow: React.FC<ProviderLoginFlowProps> = (props) => {
  const { login, promptValue, onPromptValueChange, onSubmit, busy } = props;
  if (login.authUrl && login.prompt?.type === 'manual_code') {
    return <ProviderBrowserSignIn {...props} authUrl={login.authUrl.url} />;
  }
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
