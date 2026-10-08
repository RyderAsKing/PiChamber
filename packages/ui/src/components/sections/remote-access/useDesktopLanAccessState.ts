import * as React from 'react';

import {
  getDesktopLanAddress,
  isDesktopLocalOriginActive,
  isDesktopShell,
  restartDesktopApp,
} from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';

/**
 * Desktop LAN access + desktop UI password (remote-access controls).
 *
 * Moved out of DesktopNetworkSettings so each control lives in exactly one
 * place: the LAN toggle renders in Remote Access → Ways to connect and the
 * password field renders in Remote Access → Security. Both share one draft
 * state (one hook instance per page) and one save-and-restart flow, matching
 * the previous General-page behavior exactly. Partial writes merge
 * server-side, so either section's Save button persisting both keys is safe.
 */
export interface DesktopLanAccessState {
  isLocalDesktop: boolean;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  draftLanEnabled: boolean;
  setDraftLanEnabled: (value: boolean) => void;
  draftPassword: string;
  handlePasswordChange: (value: string) => void;
  showPassword: boolean;
  setShowPassword: React.Dispatch<React.SetStateAction<boolean>>;
  lanAccessActive: boolean;
  lanRequiresPassword: boolean;
  lanBlockedByMissingPassword: boolean;
  lanUrl: string | null;
  isDirty: boolean;
  saveDisabled: boolean;
  saveAndRestart: () => void;
}

export const useDesktopLanAccessState = (): DesktopLanAccessState => {
  const isLocalDesktop = isDesktopShell() && isDesktopLocalOriginActive();
  const [savedValue, setSavedValue] = React.useState(false);
  const [draftValue, setDraftValue] = React.useState(false);
  const [savedPassword, setSavedPassword] = React.useState('');
  const [draftPassword, setDraftPassword] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [lanAccessActive, setLanAccessActive] = React.useState(false);
  const [lanAccessBlockedReason, setLanAccessBlockedReason] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [lanAddress, setLanAddress] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!isLocalDesktop) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const response = await runtimeFetch('/api/pi/ui-settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          throw new Error('Failed to load desktop settings');
        }

        const data = (await response.json().catch(() => null)) as null | {
          desktopLanAccessEnabled?: unknown;
          desktopUiPassword?: unknown;
          desktopLanAccessActive?: unknown;
          desktopLanAccessBlockedReason?: unknown;
        };
        if (cancelled) {
          return;
        }

        const enabled = data?.desktopLanAccessEnabled === true;
        const password = typeof data?.desktopUiPassword === 'string' ? data.desktopUiPassword : '';
        setSavedValue(enabled);
        setDraftValue(enabled);
        setSavedPassword(password);
        setDraftPassword(password);
        setLanAccessActive(data?.desktopLanAccessActive === true);
        setLanAccessBlockedReason(
          typeof data?.desktopLanAccessBlockedReason === 'string' ? data.desktopLanAccessBlockedReason : null,
        );
        setError(null);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Failed to load desktop settings');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLocalDesktop]);

  React.useEffect(() => {
    if (!isLocalDesktop || !draftValue) {
      setLanAddress(null);
      return;
    }

    let cancelled = false;

    void (async () => {
      const address = await getDesktopLanAddress();
      if (!cancelled) {
        setLanAddress(address);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [draftValue, isLocalDesktop]);

  const isDirty = draftValue !== savedValue || draftPassword !== savedPassword;
  const currentPort = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const runtimeApiBaseUrl = getRuntimeApiBaseUrl();
    const portSource = runtimeApiBaseUrl || window.location.href;
    let parsed = 0;
    try {
      parsed = Number(new URL(portSource).port);
    } catch {
      parsed = Number(window.location.port);
    }
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }, []);
  const lanUrl = draftValue && lanAccessActive && lanAddress && currentPort ? `http://${lanAddress}:${currentPort}` : null;
  const lanRequiresPassword = draftValue && !draftPassword.trim();
  const lanBlockedByMissingPassword = savedValue && !lanAccessActive && lanAccessBlockedReason === 'missing-password';
  const saveDisabled = isLoading || isSaving || !isDirty || lanRequiresPassword;

  const handlePasswordChange = React.useCallback((value: string) => {
    setDraftPassword(value);
    if (!value.trim()) {
      setDraftValue(false);
    }
  }, []);

  const saveAndRestart = React.useCallback(async () => {
    if (!isDirty) {
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const response = await runtimeFetch('/api/pi/ui-settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          desktopLanAccessEnabled: draftValue,
          desktopUiPassword: draftPassword,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to save desktop settings');
      }

      setSavedValue(draftValue);
      setSavedPassword(draftPassword);

      const restarted = await restartDesktopApp();
      if (!restarted) {
        throw new Error('Saved, but failed to restart app');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to save desktop settings');
      setIsSaving(false);
    }
  }, [draftPassword, draftValue, isDirty]);

  return {
    isLocalDesktop,
    isLoading,
    isSaving,
    error,
    draftLanEnabled: draftValue,
    setDraftLanEnabled: setDraftValue,
    draftPassword,
    handlePasswordChange,
    showPassword,
    setShowPassword,
    lanAccessActive,
    lanRequiresPassword,
    lanBlockedByMissingPassword,
    lanUrl,
    isDirty,
    saveDisabled,
    saveAndRestart: () => void saveAndRestart(),
  };
};

