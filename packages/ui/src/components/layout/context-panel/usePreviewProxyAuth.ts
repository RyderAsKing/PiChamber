import React from 'react';

import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';

export function usePreviewProxyAuthReadyKey(proxyUrlAuthKey: string): string {
  const [readyKey, setReadyKey] = React.useState('');

  React.useEffect(() => {
    if (!proxyUrlAuthKey) {
      setReadyKey('');
      return;
    }

    let cancelled = false;
    setReadyKey('');
    void refreshRuntimeUrlAuthToken(getRuntimeApiBaseUrl())
      .then((token) => {
        if (!cancelled && token) setReadyKey(proxyUrlAuthKey);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [proxyUrlAuthKey]);

  return readyKey;
}
