import * as React from 'react';

import type { ClientAuthAPI, PairingTransports } from '@/lib/api/types';

export interface PairingTransportsState {
  transports: PairingTransports | null;
  loading: boolean;
  /** The fetch failed. Never presented as "no routes". */
  failed: boolean;
}

/**
 * One read of `/api/client-auth/pairing/transports` for the Ways to connect
 * rows. Without a `getPairingTransports` capability it settles to no
 * transports and not failed; rows render that as Unknown.
 */
export const usePairingTransportsState = (clientAuth: ClientAuthAPI | undefined): PairingTransportsState => {
  const [state, setState] = React.useState<PairingTransportsState>({ transports: null, loading: true, failed: false });

  React.useEffect(() => {
    if (!clientAuth?.getPairingTransports) {
      setState({ transports: null, loading: false, failed: false });
      return;
    }
    // A different server's transports must not show while this one loads.
    setState({ transports: null, loading: true, failed: false });
    let cancelled = false;
    void (async () => {
      try {
        const next = await clientAuth.getPairingTransports();
        if (!cancelled) setState({ transports: next, loading: false, failed: false });
      } catch {
        if (!cancelled) setState({ transports: null, loading: false, failed: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientAuth]);

  return state;
};
