import * as React from 'react';

import {
  getTailscaleStatus,
  retryTailscale,
  updateTailscaleConfig,
  type TailscaleHttpsPort,
  type TailscaleStatus,
} from '@/lib/tailscale';
import {
  getTailscaleModeValue,
  getTailscalePollIntervalMs,
  requiresPublicConfirm,
  type TailscaleModeValue,
} from './tailscaleViewModel';

/**
 * Authoritative Tailscale state for the Remote Access page.
 *
 * - Loads once on mount; polls every ~2s while transitional
 *   (starting/needs-approval), otherwise every ~15s while the page is
 *   visible. Polling pauses while the document is hidden and stops on
 *   unmount.
 * - A failed fetch preserves the last authoritative status and is surfaced
 *   distinctly — never rendered as "Off".
 * - Mode/port mutations are optimistic (pending display) and reconcile to
 *   the authoritative PUT response; API errors (403 auth_required, 422
 *   invalid_config) surface inline with their server code.
 * - Stale async completions are rejected via a generation counter.
 */
export interface TailscaleAccessApi {
  status: TailscaleStatus | null;
  initialLoading: boolean;
  loadFailed: boolean;
  loadError: string | null;
  actionError: string | null;
  actionErrorCode: string | null;
  mutationInFlight: boolean;
  pendingMode: TailscaleModeValue | null;
  confirmPublicOpen: boolean;
  setMode: (mode: TailscaleModeValue) => void;
  confirmPublic: () => void;
  cancelPublicConfirm: () => void;
  setPort: (port: TailscaleHttpsPort) => void;
  retryNow: () => void;
  reload: () => void;
}

export const useTailscaleAccessState = (): TailscaleAccessApi => {
  const [status, setStatus] = React.useState<TailscaleStatus | null>(null);
  const [initialLoading, setInitialLoading] = React.useState(true);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [actionErrorCode, setActionErrorCode] = React.useState<string | null>(null);
  const [mutationInFlight, setMutationInFlight] = React.useState(false);
  const [pendingMode, setPendingMode] = React.useState<TailscaleModeValue | null>(null);
  const [confirmPublicOpen, setConfirmPublicOpen] = React.useState(false);
  const generationRef = React.useRef(0);

  const applyStatus = React.useCallback((next: TailscaleStatus) => {
    setStatus(next);
    setLoadFailed(false);
    setLoadError(null);
  }, []);

  const load = React.useCallback(async (options?: { initial?: boolean }) => {
    const generation = generationRef.current;
    try {
      const next = await getTailscaleStatus();
      if (generationRef.current !== generation) return;
      applyStatus(next);
    } catch (cause) {
      if (generationRef.current !== generation) return;
      // Preserve prior authoritative state; a failed fetch is never Off.
      if (options?.initial && !status) {
        setLoadFailed(true);
      }
      setLoadError(cause instanceof Error ? cause.message : 'Failed to load Tailscale status');
    } finally {
      if (generationRef.current === generation && options?.initial) {
        setInitialLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyStatus]);

  // Initial load.
  React.useEffect(() => {
    void load({ initial: true });
    return () => {
      generationRef.current += 1;
    };
  }, [load]);

  // Polling: fast while transitional, slow otherwise; paused while hidden.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        schedule(getTailscalePollIntervalMs(status?.state ?? null));
        return;
      }
      await load();
      if (!stopped) schedule(getTailscalePollIntervalMs(status?.state ?? null));
    };

    const schedule = (delayMs: number) => {
      if (stopped) return;
      timer = setTimeout(() => void tick(), delayMs);
    };

    schedule(getTailscalePollIntervalMs(status?.state ?? null));

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        if (timer) clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, status?.state]);

  const runMutation = React.useCallback(async (patch: { enabled?: boolean; mode?: 'private' | 'public'; httpsPort?: TailscaleHttpsPort }) => {
    const generation = generationRef.current;
    setMutationInFlight(true);
    setActionError(null);
    setActionErrorCode(null);
    try {
      const next = await updateTailscaleConfig(patch);
      if (generationRef.current !== generation) return;
      applyStatus(next);
    } catch (cause) {
      if (generationRef.current !== generation) return;
      const code = (cause as { code?: unknown }).code;
      setActionError(cause instanceof Error ? cause.message : 'Failed to update Tailscale');
      setActionErrorCode(typeof code === 'string' ? code : null);
    } finally {
      if (generationRef.current === generation) {
        setMutationInFlight(false);
        setPendingMode(null);
      }
    }
  }, [applyStatus]);

  const setMode = React.useCallback((mode: TailscaleModeValue) => {
    if (!status || mutationInFlight) return;
    const current = getTailscaleModeValue(status);
    if (mode === current) return;
    if (requiresPublicConfirm(current, mode)) {
      setConfirmPublicOpen(true);
      return;
    }
    setPendingMode(mode);
    void runMutation(mode === 'off' ? { enabled: false } : { enabled: true, mode });
  }, [status, mutationInFlight, runMutation]);

  const confirmPublic = React.useCallback(() => {
    setConfirmPublicOpen(false);
    if (!status || mutationInFlight) return;
    setPendingMode('public');
    void runMutation({ enabled: true, mode: 'public' });
  }, [status, mutationInFlight, runMutation]);

  const cancelPublicConfirm = React.useCallback(() => {
    setConfirmPublicOpen(false);
  }, []);

  const setPort = React.useCallback((port: TailscaleHttpsPort) => {
    if (!status || mutationInFlight) return;
    if (status.config.httpsPort === port) return;
    void runMutation({ httpsPort: port });
  }, [status, mutationInFlight, runMutation]);

  const retryNow = React.useCallback(async () => {
    const generation = generationRef.current;
    setMutationInFlight(true);
    setActionError(null);
    setActionErrorCode(null);
    try {
      const next = await retryTailscale();
      if (generationRef.current !== generation) return;
      applyStatus(next);
    } catch (cause) {
      if (generationRef.current !== generation) return;
      const code = (cause as { code?: unknown }).code;
      setActionError(cause instanceof Error ? cause.message : 'Tailscale retry failed');
      setActionErrorCode(typeof code === 'string' ? code : null);
    } finally {
      if (generationRef.current === generation) {
        setMutationInFlight(false);
        setPendingMode(null);
      }
    }
  }, [applyStatus]);

  const reload = React.useCallback(() => {
    setInitialLoading(true);
    setLoadFailed(false);
    setLoadError(null);
    void load({ initial: true });
  }, [load]);

  return {
    status,
    initialLoading,
    loadFailed,
    loadError,
    actionError,
    actionErrorCode,
    mutationInFlight,
    pendingMode,
    confirmPublicOpen,
    setMode,
    confirmPublic,
    cancelPublicConfirm,
    setPort,
    retryNow,
    reload,
  };
};
