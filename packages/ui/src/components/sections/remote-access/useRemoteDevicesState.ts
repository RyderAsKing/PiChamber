import * as React from 'react';

import type { ClientAuthAPI, PendingPairingRecord, RemoteClientRecord } from '@/lib/api/types';
import { desktopHostsGet, desktopHostsSet } from '@/lib/desktopHosts';
import { isDesktopShell } from '@/lib/desktop';
import { getRuntimeApiBaseUrl, switchRuntimeEndpoint } from '@/lib/runtime-switch';

/**
 * Devices-with-access list state (trusted-device clients + pending pairings).
 *
 * Split out of the old mixed remote-instances state so the Remote Access page
 * owns incoming devices and the Servers page owns outgoing servers. Behavior
 * is preserved, including the local-desktop-client revoke special case and
 * the 5s visible-only refresh.
 */
export interface RemoteDevicesApi {
  remoteClients: RemoteClientRecord[];
  pendingPairings: PendingPairingRecord[];
  loading: boolean;
  error: string | null;
  revokedClientCount: number;
  reload: () => void;
  revokeRemoteClient: (client: RemoteClientRecord) => void;
  purgeRevokedRemoteClients: () => void;
  cancelPendingPairing: (id: string) => void;
}

export const useRemoteDevicesState = (clientAuth: ClientAuthAPI | undefined): RemoteDevicesApi => {
  const [remoteClients, setRemoteClients] = React.useState<RemoteClientRecord[]>([]);
  const [pendingPairings, setPendingPairings] = React.useState<PendingPairingRecord[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const revokedClientCount = React.useMemo(
    () => remoteClients.filter((client) => Boolean(client.revokedAt)).length,
    [remoteClients],
  );

  const loadRemoteClients = React.useCallback(
    async (options?: { silent?: boolean }) => {
      if (!clientAuth) return;
      if (!options?.silent) setLoading(true);
      if (!options?.silent) setError(null);
      try {
        const [clients, pending] = await Promise.all([
          clientAuth.listClients(),
          clientAuth.listPendingPairings().catch(() => null),
        ]);
        setRemoteClients(clients);
        if (pending) setPendingPairings(pending);
      } catch (err) {
        if (!options?.silent) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!options?.silent) setLoading(false);
      }
    },
    [clientAuth],
  );

  React.useEffect(() => {
    if (!clientAuth) return;
    void loadRemoteClients();
    const interval = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void loadRemoteClients({ silent: true });
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [clientAuth, loadRemoteClients]);

  const cancelPendingPairing = React.useCallback(
    async (id: string) => {
      if (!clientAuth) return;
      try {
        await clientAuth.cancelPairing(id);
        setPendingPairings((prev) => prev.filter((entry) => entry.id !== id));
        await loadRemoteClients({ silent: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [clientAuth, loadRemoteClients],
  );

  const revokeRemoteClient = React.useCallback(
    async (client: RemoteClientRecord) => {
      if (!clientAuth) return;
      const isLocalDesktopClient = client.clientKind === 'desktop-local';
      setError(null);
      try {
        await clientAuth.revokeClient(client.id);
        if (isLocalDesktopClient && isDesktopShell()) {
          const config = await desktopHostsGet();
          await desktopHostsSet({
            hosts: config.hosts,
            defaultHostId: config.defaultHostId,
            initialHostChoiceCompleted: config.initialHostChoiceCompleted,
            localClientToken: null,
          });
          setRemoteClients((clients) =>
            clients.map((entry) =>
              entry.id === client.id ? { ...entry, revokedAt: new Date().toISOString() } : entry,
            ),
          );
          switchRuntimeEndpoint({ apiBaseUrl: getRuntimeApiBaseUrl(), clientToken: null, runtimeKey: 'local' });
          return;
        }
        await loadRemoteClients();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [clientAuth, loadRemoteClients],
  );

  const purgeRevokedRemoteClients = React.useCallback(async () => {
    if (!clientAuth) return;
    setError(null);
    try {
      await clientAuth.purgeRevokedClients();
      await loadRemoteClients();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [clientAuth, loadRemoteClients]);

  const reload = React.useCallback(() => {
    void loadRemoteClients({ silent: true });
  }, [loadRemoteClients]);

  return {
    remoteClients,
    pendingPairings,
    loading,
    error,
    revokedClientCount,
    reload,
    revokeRemoteClient: (client) => void revokeRemoteClient(client),
    purgeRevokedRemoteClients: () => void purgeRevokedRemoteClients(),
    cancelPendingPairing: (id) => void cancelPendingPairing(id),
  };
};
