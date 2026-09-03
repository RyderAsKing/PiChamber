import React from 'react';
import { acquireRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken, subscribeRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';

export const useAssetAuthRefresh = (
  assetKey: string,
  setFileError: React.Dispatch<React.SetStateAction<string | null>>,
  errorFallback: string,
): { readyKey: string; nonce: number } => {
  const [readyKey, setReadyKey] = React.useState('');
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    if (!assetKey) {
      setReadyKey('');
      return;
    }

    let cancelled = false;
    setReadyKey('');
    const apiBaseUrl = getRuntimeApiBaseUrl();
    const release = acquireRuntimeUrlAuthToken(apiBaseUrl);

    void refreshRuntimeUrlAuthToken(apiBaseUrl)
      .then((token) => {
        if (cancelled || !token) return;
        setReadyKey(assetKey);
        setFileError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setFileError(error instanceof Error ? error.message : errorFallback);
        setReadyKey(assetKey);
      });

    const unsubscribe = subscribeRuntimeUrlAuthToken(() => {
      if (cancelled) return;
      // Token was refreshed underneath us — remount the asset with the fresh URL.
      setReadyKey(assetKey);
      setNonce((n) => n + 1);
      setFileError(null);
    });

    return () => {
      cancelled = true;
      release();
      unsubscribe();
    };
  }, [assetKey, setFileError, errorFallback]);

  return { readyKey, nonce };
};
