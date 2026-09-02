import React from 'react';
import QRCode from 'qrcode';
import { runtimeFetch } from '@/lib/runtime-fetch';
import type {
  TunnelInfo,
  TunnelSessionRecord,
  TunnelState,
  TunnelStatusResponse,
} from './tunnelTypes';
import { formatRemaining } from './tunnelHelpers';

export function useTunnelTimers({
  tunnelInfo,
  state,
  setSessionRecords,
  setSavedTokenPresetIds,
  setLocalPort,
}: {
  tunnelInfo: TunnelInfo | null;
  state: TunnelState;
  setSessionRecords: React.Dispatch<React.SetStateAction<TunnelSessionRecord[]>>;
  setSavedTokenPresetIds: (updater: (prev: Set<string>) => Set<string>) => void;
  setLocalPort: React.Dispatch<React.SetStateAction<number | null>>;
}) {
  const [qrDataUrl, setQrDataUrl] = React.useState<string | null>(null);
  const [remainingText, setRemainingText] = React.useState<string>('');
  const [nowTs, setNowTs] = React.useState<number>(() => Date.now());

  React.useEffect(() => {
    if (!tunnelInfo?.connectUrl) {
      setQrDataUrl(null);
      return;
    }

    let cancelled = false;
    QRCode.toDataURL(tunnelInfo.connectUrl, {
      width: 256,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((dataUrl) => {
        if (!cancelled) {
          setQrDataUrl(dataUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setQrDataUrl(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [tunnelInfo?.connectUrl]);

  React.useEffect(() => {
    if (!tunnelInfo?.bootstrapExpiresAt) {
      setRemainingText('No expiry');
      return;
    }

    let rafId: number | null = null;
    let lastTime = Date.now();

    const updateRemaining = () => {
      const remaining = tunnelInfo.bootstrapExpiresAt ? tunnelInfo.bootstrapExpiresAt - Date.now() : 0;
      if (remaining <= 0) {
        setRemainingText('Expired');
      } else {
        setRemainingText(formatRemaining(remaining));
      }
    };

    const tick = () => {
      const now = Date.now();
      if (now - lastTime >= 1_000) {
        updateRemaining();
        lastTime = now;
      }
      rafId = requestAnimationFrame(tick);
    };

    updateRemaining();

    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      rafId = requestAnimationFrame(tick);
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && rafId === null) {
        rafId = requestAnimationFrame(tick);
      } else if (document.visibilityState !== 'visible' && rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [tunnelInfo?.bootstrapExpiresAt]);

  React.useEffect(() => {
    let rafId: number | null = null;
    let lastTime = Date.now();

    const tick = () => {
      const now = Date.now();
      if (now - lastTime >= 1_000) {
        setNowTs(now);
        lastTime = now;
      }
      rafId = requestAnimationFrame(tick);
    };

    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      rafId = requestAnimationFrame(tick);
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && rafId === null) {
        rafId = requestAnimationFrame(tick);
      } else if (document.visibilityState !== 'visible' && rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, []);

  React.useEffect(() => {
    if (state === 'starting' || state === 'stopping' || state === 'checking') {
      return;
    }

    let cancelled = false;
    const refreshSessions = async () => {
      try {
        const statusRes = await runtimeFetch('/api/pichamber/tunnel/status');
        if (!statusRes.ok || cancelled) {
          return;
        }
        const statusData = (await statusRes.json()) as TunnelStatusResponse;
        if (cancelled) {
          return;
        }
        setSessionRecords(Array.isArray(statusData.activeSessions) ? statusData.activeSessions : []);
        setSavedTokenPresetIds(() =>
          new Set(
            Array.isArray(statusData.managedRemoteTunnelTokenPresetIds)
              ? statusData.managedRemoteTunnelTokenPresetIds
              : [],
          ),
        );
        setLocalPort(typeof statusData.localPort === 'number' ? statusData.localPort : null);
      } catch {
        // ignore transient refresh failures
      }
    };

    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      void refreshSessions();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [setLocalPort, setSavedTokenPresetIds, setSessionRecords, state]);

  return {
    qrDataUrl,
    remainingText,
    nowTs,
  };
}
