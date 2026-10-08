import React from 'react';
import { toast } from '@/components/ui';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  cancelPasskeyCeremony,
  defaultPasskeyStatus,
  fetchPasskeyStatus,
  fetchStoredPasskeys,
  getPasskeySupportState,
  isPasskeyCeremonyAbort,
  registerCurrentDevicePasskey,
  resetAllAuth,
  revokeStoredPasskey,
  type PasskeyStatus,
  type StoredPasskey,
} from '@/lib/passkeys';
import { SettingsSection, SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { useUIStore, type TimeFormatPreference } from '@/stores/useUIStore';

const formatTimestamp = (timestamp: number | null, neverUsedText: string, timeFormatPreference: TimeFormatPreference) => {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return neverUsedText;
  }

  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: timeFormatPreference === 'auto' ? undefined : timeFormatPreference === '12h',
  }).format(timestamp);
};

export const PasskeySettings: React.FC = () => {
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const { t } = useTranslation();
  const [supportsPasskeys, setSupportsPasskeys] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isRegistering, setIsRegistering] = React.useState(false);
  const [revokingId, setRevokingId] = React.useState<string | null>(null);
  const [isResetting, setIsResetting] = React.useState(false);
  const [passkeys, setPasskeys] = React.useState<StoredPasskey[]>([]);
  const [status, setStatus] = React.useState<PasskeyStatus>(defaultPasskeyStatus);
  const [errorMessage, setErrorMessage] = React.useState('');
  const supportState = React.useMemo(() => getPasskeySupportState(), []);

  const loadPasskeys = React.useCallback(async () => {
    setIsLoading(true);
    setErrorMessage('');

    try {
      const nextPasskeys = await fetchStoredPasskeys();
      setPasskeys(nextPasskeys);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('Could not load passkeys.');
      setErrorMessage(message);
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        if (!supportState.supported) {
          if (!cancelled) {
            setSupportsPasskeys(false);
            setIsLoading(false);
          }
          return;
        }
        if (!cancelled) {
          setSupportsPasskeys(true);
        }
      } catch {
        if (!cancelled) {
          setSupportsPasskeys(false);
        }
      }

      if (!cancelled) {
        const nextStatus = await fetchPasskeyStatus();
        setStatus(nextStatus);
        if (!nextStatus.enabled) {
          setPasskeys([]);
          setIsLoading(false);
          return;
        }
        await loadPasskeys();
      }
    })();

    return () => {
      cancelled = true;
      cancelPasskeyCeremony();
    };
  }, [loadPasskeys, supportState.supported]);

  const handleRegisterPasskey = React.useCallback(async () => {
    if (!status.enabled) {
      const message = t('Enable the UI password lock before adding passkeys.');
      setErrorMessage(message);
      toast.message(message);
      return;
    }

    if (!supportsPasskeys) {
      setErrorMessage(supportState.reason);
      toast.message(supportState.reason);
      return;
    }

    if (isRegistering) {
      cancelPasskeyCeremony();
      setIsRegistering(false);
      return;
    }

    setErrorMessage('');
    setIsRegistering(true);

    try {
      await registerCurrentDevicePasskey();
      setStatus(await fetchPasskeyStatus());
      await loadPasskeys();
      toast.success(t('Passkey added'));
    } catch (error) {
      if (isPasskeyCeremonyAbort(error)) {
        toast.message(t('Passkey setup canceled'));
        return;
      }

      const message = error instanceof Error ? error.message : t('Could not add passkey.');
      setErrorMessage(message);
      toast.error(message);
    } finally {
      setIsRegistering(false);
    }
  }, [isRegistering, loadPasskeys, status.enabled, supportState.reason, supportsPasskeys, t]);

  const handleRevokePasskey = React.useCallback(async (id: string) => {
    setRevokingId(id);
    setErrorMessage('');

    try {
      await revokeStoredPasskey(id);
      setStatus(await fetchPasskeyStatus());
      await loadPasskeys();
      toast.success(t('Passkey removed'));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('Could not remove passkey.');
      setErrorMessage(message);
      toast.error(message);
    } finally {
      setRevokingId(null);
    }
  }, [loadPasskeys, t]);

  const handleResetAllAuth = React.useCallback(async () => {
    setIsResetting(true);
    setErrorMessage('');

    try {
      await resetAllAuth();
      window.location.reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : t('Could not clear saved authentication.');
      setErrorMessage(message);
      toast.error(message);
      setIsResetting(false);
    }
  }, [t]);

  return (
    <SettingsSection title={t('Passkeys')}>
      <div className="space-y-2">
        <SettingsFieldRow label={t('Current device')}>
          <Button
            type="button"
            variant={isRegistering ? 'secondary' : 'outline'}
            size="xs"
            onClick={() => void handleRegisterPasskey()}
            disabled={isLoading || isResetting}
            className="!font-normal"
          >
            {isRegistering ? t('Cancel passkey setup') : t('Add passkey')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void handleResetAllAuth()}
            disabled={isLoading || isRegistering || isResetting}
            className="!font-normal text-muted-foreground hover:text-foreground"
          >
            {isResetting ? t('Signing out…') : t('Sign out everywhere')}
          </Button>
        </SettingsFieldRow>

        {!status.enabled && (
          <p className="typography-meta text-muted-foreground">
            {t('Passkeys are available only when the UI password lock is enabled.')}
          </p>
        )}

        {status.enabled && !supportsPasskeys && (
          <p className="typography-meta text-muted-foreground">
            {supportState.reason}
          </p>
        )}

        {isLoading ? (
          <p className="typography-meta text-muted-foreground">{t('Loading passkeys…')}</p>
        ) : passkeys.length === 0 ? (
          <p className="typography-meta text-muted-foreground">{t('No passkeys saved for this host yet.')}</p>
        ) : (
          <div className="space-y-1 pt-1">
            {passkeys.map((passkey) => (
              <SettingsFieldRow
                key={passkey.id}
                label={<span className="truncate">{passkey.label}</span>}
                alignEnd={false}
                controlClassName="justify-between sm:flex-1"
              >
                <span className="typography-meta text-muted-foreground truncate">
                  {passkey.lastUsedAt
                    ? t('Last used {{time}}', { time: formatTimestamp(passkey.lastUsedAt, t('Never used'), timeFormatPreference) })
                    : t('Added {{time}}', { time: formatTimestamp(passkey.createdAt, t('Never used'), timeFormatPreference) })}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => void handleRevokePasskey(passkey.id)}
                  disabled={revokingId === passkey.id}
                  className="!font-normal text-muted-foreground hover:text-foreground"
                >
                  {revokingId === passkey.id ? t('Removing…') : t('Delete')}
                </Button>
              </SettingsFieldRow>
            ))}
          </div>
        )}
      </div>

      {errorMessage && (
        <div className="mt-1 py-1.5">
          <p className="typography-meta text-[var(--status-error)]">{errorMessage}</p>
        </div>
      )}
    </SettingsSection>
  );
};
