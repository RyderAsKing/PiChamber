import React from 'react';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { toast } from '@/components/ui';
import { getRuntimeExtraHeadersSync } from '@/lib/runtime-auth';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { isDesktopShell } from '@/lib/desktop';
import {
  authenticateWithPasskey,
  cancelPasskeyCeremony,
  defaultPasskeyStatus,
  fetchPasskeyStatus,
  isPasskeyCeremonyAbort,
  type PasskeyStatus,
  registerCurrentDevicePasskey,
} from '@/lib/passkeys';
import {
  resolveStatusCheckFailureState,
  type GateState,
} from './sessionAuthGateState';
import {
  applyDesktopClientToken,
  captureRuntimeIdentity,
  desktopClientAuthMetadata,
  fetchSessionStatus,
  isRuntimeIdentityActive,
  issueDesktopClientToken,
  issueDesktopClientTokenViaShell,
  readStoredTrustDevice,
  shouldIssueDesktopClientToken,
  shouldUseDesktopShellPasswordLogin,
  submitPassword,
  TRANSIENT_RETRY_BASE_DELAY_MS,
  TRANSIENT_RETRY_MAX_ATTEMPTS,
  TRUST_DEVICE_STORAGE_KEY,
} from './sessionAuthHelpers';

export function useSessionAuthGateController() {
  const skipAuth = false;
  const showHostSwitcher = React.useMemo(() => isDesktopShell(), []);
  const [state, setState] = React.useState<GateState>(() => (skipAuth ? 'authenticated' : 'pending'));
  const [password, setPassword] = React.useState('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState('');
  const [retryAfter, setRetryAfter] = React.useState<number | undefined>(undefined);
  const [isTunnelLocked, setIsTunnelLocked] = React.useState(false);
  const [passkeyStatus, setPasskeyStatus] = React.useState<PasskeyStatus>(defaultPasskeyStatus);
  const [supportsPasskeys, setSupportsPasskeys] = React.useState(false);
  const [isPasskeyBusy, setIsPasskeyBusy] = React.useState(false);
  const [trustDevice, setTrustDevice] = React.useState<boolean>(() => readStoredTrustDevice());
  const [activePasskeyAction, setActivePasskeyAction] = React.useState<'auth' | 'register' | null>(null);
  const passwordInputRef = React.useRef<HTMLInputElement | null>(null);
  const hasResyncedRef = React.useRef(skipAuth);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(TRUST_DEVICE_STORAGE_KEY, trustDevice ? 'true' : 'false');
  }, [trustDevice]);

  const refreshPasskeyStatus = React.useCallback(async (runtime = captureRuntimeIdentity()) => {
    if (skipAuth) {
      return defaultPasskeyStatus;
    }

    try {
      const nextStatus = await fetchPasskeyStatus();
      if (isRuntimeIdentityActive(runtime)) {
        setPasskeyStatus(nextStatus);
      }
      return nextStatus;
    } catch {
      if (isRuntimeIdentityActive(runtime)) {
        setPasskeyStatus(defaultPasskeyStatus);
      }
      return defaultPasskeyStatus;
    }
  }, [skipAuth]);

  React.useEffect(() => {
    let cancelled = false;

    if (skipAuth) {
      return;
    }

    void (async () => {
      try {
        if (!window.isSecureContext || !browserSupportsWebAuthn()) {
          if (!cancelled) {
            setSupportsPasskeys(false);
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
    })();

    return () => {
      cancelled = true;
    };
  }, [skipAuth]);

  const transientRetryAttemptRef = React.useRef(0);
  const transientRetryTimerRef = React.useRef<number | null>(null);
  const checkStatusRef = React.useRef<(() => Promise<void>) | null>(null);

  const clearTransientRetry = React.useCallback(() => {
    if (transientRetryTimerRef.current !== null) {
      window.clearTimeout(transientRetryTimerRef.current);
      transientRetryTimerRef.current = null;
    }
  }, []);

  const resetTransientRetry = React.useCallback(() => {
    transientRetryAttemptRef.current = 0;
    clearTransientRetry();
  }, [clearTransientRetry]);

  const scheduleTransientRetry = React.useCallback((): boolean => {
    if (transientRetryAttemptRef.current >= TRANSIENT_RETRY_MAX_ATTEMPTS) return false;
    transientRetryAttemptRef.current += 1;
    clearTransientRetry();
    transientRetryTimerRef.current = window.setTimeout(() => {
      transientRetryTimerRef.current = null;
      void checkStatusRef.current?.();
    }, TRANSIENT_RETRY_BASE_DELAY_MS * transientRetryAttemptRef.current);
    return true;
  }, [clearTransientRetry]);

  React.useEffect(() => clearTransientRetry, [clearTransientRetry]);

  const checkStatus = React.useCallback(async () => {
    if (skipAuth) {
      setState('authenticated');
      return;
    }

    const runtime = captureRuntimeIdentity();
    setState((prev) => (prev === 'authenticated' ? prev : 'pending'));
    try {
      const [response, latestPasskeyStatus] = await Promise.all([
        fetchSessionStatus(),
        refreshPasskeyStatus(runtime),
      ]);
      const responseText = await response.text();

      if (!isRuntimeIdentityActive(runtime)) {
        return;
      }

      if (response.ok) {
        resetTransientRetry();
        setState('authenticated');
        setIsTunnelLocked(false);
        setErrorMessage('');
        setRetryAfter(undefined);
        return;
      }
      if (response.status === 401) {
        let data: { tunnelLocked?: boolean; debug?: { hasRefreshToken: boolean; message: string } } = {};
        try {
          data = JSON.parse(responseText);
        } catch {
          data = {};
        }
        resetTransientRetry();
        setIsTunnelLocked(data.tunnelLocked === true);
        setPasskeyStatus(latestPasskeyStatus);
        setState('locked');
        setRetryAfter(undefined);
        return;
      }
      if (response.status === 429) {
        let data: { retryAfter?: number } = {};
        try {
          data = JSON.parse(responseText);
        } catch {
          data = {};
        }
        resetTransientRetry();
        setRetryAfter(data.retryAfter);
        setIsTunnelLocked(false);
        setState('rate-limited');
        return;
      }
      if (scheduleTransientRetry()) return;
      setState('error');
      setIsTunnelLocked(false);
    } catch (error) {
      if (!isRuntimeIdentityActive(runtime)) {
        return;
      }
      console.warn('Failed to check session status:', error);
      if (
        resolveStatusCheckFailureState({
          shouldUseDesktopShellPasswordLogin: shouldUseDesktopShellPasswordLogin(),
        }) === 'locked'
      ) {
        setState('locked');
        setRetryAfter(undefined);
        setIsTunnelLocked(false);
        return;
      }
      if (scheduleTransientRetry()) return;
      setState('error');
      setIsTunnelLocked(false);
    }
  }, [refreshPasskeyStatus, resetTransientRetry, scheduleTransientRetry, skipAuth]);

  React.useEffect(() => {
    checkStatusRef.current = checkStatus;
  }, [checkStatus]);

  React.useEffect(() => {
    if (skipAuth) {
      return;
    }
    void checkStatus();
  }, [checkStatus, skipAuth]);

  React.useEffect(() => {
    if (skipAuth) {
      return;
    }

    return subscribeRuntimeEndpointChanged(() => {
      cancelPasskeyCeremony();
      setPassword('');
      setErrorMessage('');
      setRetryAfter(undefined);
      setIsTunnelLocked(false);
      setIsSubmitting(false);
      setActivePasskeyAction(null);
      setIsPasskeyBusy(false);
      resetTransientRetry();
      setState('pending');
      void checkStatus();
    });
  }, [checkStatus, resetTransientRetry, skipAuth]);

  React.useEffect(() => {
    if (!skipAuth && state === 'locked') {
      hasResyncedRef.current = false;
    }
  }, [skipAuth, state]);

  React.useEffect(() => {
    if (state === 'locked' && passwordInputRef.current) {
      passwordInputRef.current.focus();
      passwordInputRef.current.select();
    }
  }, [state]);

  React.useEffect(() => {
    if (!skipAuth && state === 'authenticated') {
      hasResyncedRef.current = true;
    }
  }, [skipAuth, state]);

  const registerPasskeyForCurrentSession = React.useCallback(async () => {
    const runtime = captureRuntimeIdentity();
    setActivePasskeyAction('register');
    setIsPasskeyBusy(true);
    try {
      await registerCurrentDevicePasskey();
    } finally {
      if (isRuntimeIdentityActive(runtime)) {
        setActivePasskeyAction(null);
        setIsPasskeyBusy(false);
      }
    }
    if (!isRuntimeIdentityActive(runtime)) return;
    await refreshPasskeyStatus(runtime);
  }, [refreshPasskeyStatus]);

  const cancelActivePasskey = React.useCallback(() => {
    cancelPasskeyCeremony();
    setActivePasskeyAction(null);
    setIsPasskeyBusy(false);
  }, []);

  const handlePasswordUnlock = React.useCallback(
    async (enrollPasskey: boolean) => {
      if (isTunnelLocked) {
        return;
      }
      if (!password || isSubmitting) {
        return;
      }

      if (isPasskeyBusy) {
        cancelActivePasskey();
      }

      const runtime = captureRuntimeIdentity();
      const requestHeaders = getRuntimeExtraHeadersSync();
      setIsSubmitting(true);
      setErrorMessage('');

      try {
        if (shouldUseDesktopShellPasswordLogin()) {
          const shellLogin = await issueDesktopClientTokenViaShell(
            password,
            trustDevice,
            runtime,
            requestHeaders
          );
          if (!isRuntimeIdentityActive(runtime)) return;
          if (shellLogin?.token) {
            setPassword('');
            setIsTunnelLocked(false);
            if (!(await applyDesktopClientToken(shellLogin.token, runtime, requestHeaders))) return;
            setState('authenticated');
            return;
          }
          if (shellLogin?.status === 401) {
            setErrorMessage('Incorrect password. Try again.');
            setIsTunnelLocked(false);
            setState('locked');
            return;
          }
          if (shellLogin?.status === 429) {
            setRetryAfter(undefined);
            setIsTunnelLocked(false);
            setState('rate-limited');
            return;
          }
        }

        const response = await submitPassword(password, trustDevice);
        if (!isRuntimeIdentityActive(runtime)) return;
        if (response.ok) {
          const payload = (await response.json().catch(() => null)) as { clientToken?: unknown } | null;
          if (!isRuntimeIdentityActive(runtime)) return;
          const shouldUseClientToken = shouldIssueDesktopClientToken();
          let clientToken = '';
          if (shouldUseClientToken) {
            clientToken =
              typeof payload?.clientToken === 'string' && payload.clientToken.trim()
                ? payload.clientToken.trim()
                : '';
            if (!clientToken) {
              const shellLogin = await issueDesktopClientTokenViaShell(
                password,
                trustDevice,
                runtime,
                requestHeaders
              );
              if (!isRuntimeIdentityActive(runtime)) return;
              clientToken = shellLogin?.token || (await issueDesktopClientToken());
              if (!isRuntimeIdentityActive(runtime)) return;
            }
          }
          setPassword('');
          setIsTunnelLocked(false);
          if (clientToken) {
            if (!(await applyDesktopClientToken(clientToken, runtime, requestHeaders))) return;
          }
          if (enrollPasskey && supportsPasskeys) {
            try {
              await registerPasskeyForCurrentSession();
              if (!isRuntimeIdentityActive(runtime)) return;
              toast.success('Passkey added');
              setState('authenticated');
              return;
            } catch (error) {
              if (isPasskeyCeremonyAbort(error)) {
                toast.message('Passkey setup canceled');
              } else {
                const message = error instanceof Error ? error.message : 'Passkey setup failed.';
                toast.error(message);
              }
              setState('authenticated');
              return;
            }
          }
          setState('authenticated');
          return;
        }

        if (response.status === 401) {
          setErrorMessage('Incorrect password. Try again.');
          setIsTunnelLocked(false);
          setState('locked');
          return;
        }

        if (response.status === 429) {
          const data = await response.json().catch(() => ({}));
          setRetryAfter(data.retryAfter);
          setIsTunnelLocked(false);
          setState('rate-limited');
          return;
        }

        setErrorMessage('Unexpected response from server.');
        setIsTunnelLocked(false);
        setState('error');
      } catch (error) {
        if (!isRuntimeIdentityActive(runtime)) return;
        console.warn('Failed to submit UI password:', error);
        const shellLogin = shouldUseDesktopShellPasswordLogin()
          ? await issueDesktopClientTokenViaShell(password, trustDevice, runtime, requestHeaders)
          : null;
        if (!isRuntimeIdentityActive(runtime)) return;
        if (shellLogin?.token) {
          setPassword('');
          setIsTunnelLocked(false);
          if (!(await applyDesktopClientToken(shellLogin.token, runtime, requestHeaders))) return;
          setState('authenticated');
          return;
        }
        if (shellLogin?.status === 401) {
          setErrorMessage('Incorrect password. Try again.');
          setIsTunnelLocked(false);
          setState('locked');
          return;
        }
        if (shellLogin?.status === 429) {
          setRetryAfter(undefined);
          setIsTunnelLocked(false);
          setState('rate-limited');
          return;
        }
        setErrorMessage('Network error. Check connection and retry.');
        setIsTunnelLocked(false);
        setState('error');
      } finally {
        if (isRuntimeIdentityActive(runtime)) {
          setIsSubmitting(false);
        }
      }
    },
    [
      cancelActivePasskey,
      isPasskeyBusy,
      isSubmitting,
      isTunnelLocked,
      password,
      registerPasskeyForCurrentSession,
      supportsPasskeys,
      trustDevice,
    ]
  );

  const handlePasskeyUnlock = React.useCallback(async () => {
    if (isSubmitting || !supportsPasskeys) {
      return;
    }

    if (isPasskeyBusy) {
      cancelActivePasskey();
      return;
    }

    setIsPasskeyBusy(true);
    setActivePasskeyAction('auth');
    setErrorMessage('');
    const runtime = captureRuntimeIdentity();
    const requestHeaders = getRuntimeExtraHeadersSync();

    try {
      const payload = await authenticateWithPasskey(trustDevice, {
        issueClientToken: shouldIssueDesktopClientToken(),
        clientLabel: 'PiChamber Desktop',
        ...desktopClientAuthMetadata(),
      });
      if (!isRuntimeIdentityActive(runtime)) return;
      if (typeof payload?.clientToken === 'string' && payload.clientToken.trim()) {
        const clientToken = payload.clientToken.trim();
        if (!(await applyDesktopClientToken(clientToken, runtime, requestHeaders))) return;
      }
      setIsTunnelLocked(false);
      setState('authenticated');
    } catch (error) {
      if (!isRuntimeIdentityActive(runtime)) return;
      if (isPasskeyCeremonyAbort(error)) {
        return;
      }
      const message = error instanceof Error ? error.message : 'Passkey sign-in failed.';
      setErrorMessage(message);
    } finally {
      if (isRuntimeIdentityActive(runtime)) {
        setActivePasskeyAction(null);
        setIsPasskeyBusy(false);
      }
    }
  }, [
    cancelActivePasskey,
    isPasskeyBusy,
    isSubmitting,
    supportsPasskeys,
    trustDevice,
  ]);

  const handlePasskeySetupOnly = React.useCallback(async () => {
    if (isSubmitting || !supportsPasskeys) {
      return;
    }

    if (isPasskeyBusy) {
      cancelActivePasskey();
      return;
    }

    const runtime = captureRuntimeIdentity();
    setActivePasskeyAction('register');
    setIsPasskeyBusy(true);
    try {
      await registerCurrentDevicePasskey();
      if (!isRuntimeIdentityActive(runtime)) return;
      toast.success('Passkey added');
      await refreshPasskeyStatus(runtime);
    } catch (error) {
      if (!isRuntimeIdentityActive(runtime)) return;
      if (isPasskeyCeremonyAbort(error)) {
        toast.message('Passkey setup canceled');
      } else {
        const message = error instanceof Error ? error.message : 'Passkey setup failed.';
        toast.error(message);
      }
    } finally {
      if (isRuntimeIdentityActive(runtime)) {
        setActivePasskeyAction(null);
        setIsPasskeyBusy(false);
      }
    }
  }, [cancelActivePasskey, isPasskeyBusy, isSubmitting, refreshPasskeyStatus, supportsPasskeys]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await handlePasswordUnlock(false);
  };

  return {
    state,
    password,
    setPassword,
    passwordInputRef,
    isSubmitting,
    errorMessage,
    setErrorMessage,
    retryAfter,
    isTunnelLocked,
    passkeyStatus,
    supportsPasskeys,
    isPasskeyBusy,
    trustDevice,
    setTrustDevice,
    activePasskeyAction,
    showHostSwitcher,
    resetTransientRetry,
    checkStatus,
    handleSubmit,
    handlePasswordUnlock,
    handlePasskeyUnlock,
    handlePasskeySetupOnly,
  };
}
