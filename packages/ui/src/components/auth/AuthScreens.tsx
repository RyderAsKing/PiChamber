import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { DesktopHostSwitcherInline } from '@/components/desktop/DesktopHostSwitcher';
import { PiChamberLogo } from '@/components/ui/PiChamberLogo';
import { Icon } from '@/components/icon/Icon';
import type { PasskeyStatus } from '@/lib/passkeys';

export const AuthShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const titlebarDragStyle = React.useMemo<React.CSSProperties>(() => {
    return {
      height: 'var(--oc-wco-titlebar-height, 0px)',
      right: 'var(--oc-wco-right-inset, 0px)',
    };
  }, []);

  return (
    <div
      className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background text-foreground"
      style={{ fontFamily: '"Inter", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif' }}
    >
      <div className="app-region-drag fixed left-0 top-0 z-20" style={titlebarDragStyle} aria-hidden />
      <div
        className="pointer-events-none absolute inset-0 opacity-55"
        style={{
          background: 'radial-gradient(120% 140% at 50% -20%, var(--surface-overlay) 0%, transparent 68%)',
        }}
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundColor: 'var(--surface-subtle)',
          opacity: 0.22,
        }}
      />
      <div className="app-region-no-drag relative z-10 flex w-full justify-center px-4 py-12 sm:px-6">
        {children}
      </div>
    </div>
  );
};

export const LoadingScreen: React.FC = () => (
  <div className="flex h-full min-h-screen w-full items-center justify-center overflow-hidden bg-background text-foreground">
    <PiChamberLogo width={120} height={120} isAnimated />
  </div>
);

export interface ErrorScreenProps {
  onRetry: () => void;
  errorType?: 'network' | 'rate-limit';
  retryAfter?: number;
  children?: React.ReactNode;
}

export const ErrorScreen: React.FC<ErrorScreenProps> = ({ onRetry, errorType = 'network', retryAfter, children }) => {
  const { t } = useTranslation();
  const isRateLimit = errorType === 'rate-limit';
  const minutes = retryAfter ? Math.ceil(retryAfter / 60) : 1;
  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-6 text-center">
        <div className="space-y-2">
          <h1 className="typography-ui-header font-semibold text-destructive">
            {isRateLimit ? t('Too many attempts') : t('Unable to reach server')}
          </h1>
          <p className="typography-meta text-muted-foreground max-w-xs">
            {isRateLimit
              ? (minutes > 1
                ? t('Please wait {{minutes}} minutes before trying again.', { minutes })
                : t('Please wait {{minutes}} minute before trying again.', { minutes }))
              : t("We could not verify the UI session. If you're opening PiChamber from another device on your local network, make sure Desktop Network Access is enabled on the desktop app and use the LAN address shown in Settings.")}
          </p>
        </div>
        <Button type="button" onClick={onRetry} className="w-full max-w-xs">
          {t('Retry')}
        </Button>
        {children}
      </div>
    </AuthShell>
  );
};

export interface AuthLockCardProps {
  isTunnelLocked: boolean;
  password: string;
  setPassword: (password: string) => void;
  passwordInputRef: React.RefObject<HTMLInputElement | null>;
  isSubmitting: boolean;
  errorMessage: string;
  setErrorMessage: (msg: string) => void;
  trustDevice: boolean;
  setTrustDevice: (checked: boolean) => void;
  supportsPasskeys: boolean;
  passkeyStatus: PasskeyStatus;
  isPasskeyBusy: boolean;
  activePasskeyAction: 'auth' | 'register' | null;
  showHostSwitcher: boolean;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onPasskeyUnlock: () => Promise<void>;
  onPasskeySetupOnly: () => Promise<void>;
}

export const AuthLockCard: React.FC<AuthLockCardProps> = ({
  isTunnelLocked,
  password,
  setPassword,
  passwordInputRef,
  isSubmitting,
  errorMessage,
  setErrorMessage,
  trustDevice,
  setTrustDevice,
  supportsPasskeys,
  passkeyStatus,
  isPasskeyBusy,
  activePasskeyAction,
  showHostSwitcher,
  onSubmit,
  onPasskeyUnlock,
  onPasskeySetupOnly,
}) => {
  const { t } = useTranslation();
  const canUsePasskey = supportsPasskeys && passkeyStatus.hasPasskeys;
  const canOfferPasskeySetup = supportsPasskeys && !passkeyStatus.hasPasskeys;

  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-6 w-full max-w-xs">
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-xl font-semibold text-foreground">
            {isTunnelLocked ? t('Tunnel access required') : t('Unlock PiChamber')}
          </h1>
          <p className="typography-meta text-muted-foreground">
            {isTunnelLocked
              ? t('Open this tunnel using the one-time connect link from the desktop app.')
              : t('This session is password-protected.')}
          </p>
        </div>

        {!isTunnelLocked && (
          <form onSubmit={onSubmit} className="w-full space-y-2">
            {canUsePasskey && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => void onPasskeyUnlock()}
                disabled={isSubmitting || (isPasskeyBusy && activePasskeyAction !== 'auth')}
              >
                {isPasskeyBusy ? (
                  <Icon name="loader-4" className="h-4 w-4 animate-spin" />
                ) : (
                  <Icon name="lock-unlock" className="h-4 w-4" />
                )}
                <span>
                  {isPasskeyBusy && activePasskeyAction === 'auth'
                    ? t('Cancel passkey')
                    : t('Use passkey')}
                </span>
              </Button>
            )}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Icon name="lock" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60" />
                <Input
                  id="pichamber-ui-password"
                  ref={passwordInputRef}
                  type="password"
                  autoComplete="current-password"
                  placeholder={t('Enter password')}
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    if (errorMessage) {
                      setErrorMessage('');
                    }
                  }}
                  className="pl-10"
                  aria-invalid={Boolean(errorMessage) || undefined}
                  aria-describedby={errorMessage ? 'oc-ui-auth-error' : undefined}
                  disabled={isSubmitting}
                />
              </div>
              <Button
                type="submit"
                size="icon"
                disabled={!password || isSubmitting}
                aria-label={isSubmitting ? t('Unlocking') : t('Unlock')}
              >
                {isSubmitting ? (
                  <Icon name="loader-4" className="h-4 w-4 animate-spin" />
                ) : (
                  <Icon name="lock-unlock" className="h-4 w-4" />
                )}
              </Button>
            </div>
            {canOfferPasskeySetup ? (
              <div className="flex items-center justify-between pt-1">
                <label className="flex items-center gap-2 text-center typography-micro text-muted-foreground">
                  <Checkbox
                    checked={trustDevice}
                    onChange={setTrustDevice}
                    disabled={isSubmitting}
                    ariaLabel={t('Trust this device')}
                    className="size-4"
                    iconClassName="size-4"
                  />
                  <span>{t('Trust this device')}</span>
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => void onPasskeySetupOnly()}
                  disabled={isSubmitting}
                >
                  {isPasskeyBusy && activePasskeyAction === 'register'
                    ? t('Cancel passkey setup')
                    : t('Add passkey')}
                </Button>
              </div>
            ) : (
              <label className="flex items-center justify-center gap-2 pt-1 text-center typography-micro text-muted-foreground">
                <Checkbox
                  checked={trustDevice}
                  onChange={setTrustDevice}
                  disabled={isSubmitting}
                  ariaLabel={t('Trust this device')}
                  className="size-4"
                  iconClassName="size-4"
                />
                <span>{t('Trust this device')}</span>
              </label>
            )}
            {errorMessage && (
              <p id="oc-ui-auth-error" className="typography-meta text-destructive">
                {errorMessage}
              </p>
            )}
          </form>
        )}

        {showHostSwitcher && (
          <div className="w-full">
            <DesktopHostSwitcherInline />
            <p className="mt-1 text-center typography-micro text-muted-foreground">
              {t('Use Local if remote is unreachable.')}
            </p>
          </div>
        )}
      </div>
    </AuthShell>
  );
};
