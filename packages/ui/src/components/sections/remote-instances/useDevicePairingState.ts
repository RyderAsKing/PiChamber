import React from 'react';
import QRCode from 'qrcode';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import type { ClientAuthAPI, PendingPairingRecord, RemoteClientRecord } from '@/lib/api/types';
import {
  buildPairingConnectionPayload,
  encodePairingConnectionPayload,
  type PairingEndpointCandidate,
} from '@/lib/connectionPayload';
import { desktopHostsGet, desktopHostsSet, normalizeHostUrl } from '@/lib/desktopHosts';
import { isDesktopShell } from '@/lib/desktop';
import { getRuntimeApiBaseUrl, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import {
  getRuntimePort,
  isLoopbackUrl,
  resolvePairingServerUrl,
} from './remoteInstanceHelpers';

export function useDevicePairingState(clientAuth: ClientAuthAPI | undefined) {
  const [remoteClients, setRemoteClients] = React.useState<RemoteClientRecord[]>([]);
  const [pendingPairings, setPendingPairings] = React.useState<PendingPairingRecord[]>([]);
  const [remoteClientsLoading, setRemoteClientsLoading] = React.useState(false);
  const [remoteClientLabel, setRemoteClientLabel] = React.useState('');
  const [remoteClientError, setRemoteClientError] = React.useState<string | null>(null);
  const [pairingUrl, setPairingUrl] = React.useState<string | null>(null);
  const [createdPairingId, setCreatedPairingId] = React.useState<string | null>(null);
  const [pairingQrDataUrl, setPairingQrDataUrl] = React.useState<string | null>(null);
  const [pairingCopied, setPairingCopied] = React.useState(false);
  const [addDeviceOpen, setAddDeviceOpen] = React.useState(false);
  const [addDevicePhase, setAddDevicePhase] = React.useState<'configure' | 'result'>('configure');
  const [addDeviceCreating, setAddDeviceCreating] = React.useState(false);
  const [addDeviceTransport, setAddDeviceTransport] = React.useState<'local' | 'lan' | 'relay'>('relay');
  const [addDeviceFallback, setAddDeviceFallback] = React.useState(true);
  const [transportOptions, setTransportOptions] = React.useState<{
    localUrl: string | null;
    lanUrl: string | null;
    relayAvailable: boolean;
  } | null>(null);

  const revokedClientCount = React.useMemo(
    () => remoteClients.filter((client) => Boolean(client.revokedAt)).length,
    [remoteClients],
  );

  const loadRemoteClients = React.useCallback(
    async (options?: { silent?: boolean }) => {
      if (!clientAuth) return;
      if (!options?.silent) setRemoteClientsLoading(true);
      if (!options?.silent) setRemoteClientError(null);
      try {
        const [clients, pending] = await Promise.all([
          clientAuth.listClients(),
          clientAuth.listPendingPairings().catch(() => null),
        ]);
        setRemoteClients(clients);
        if (pending) setPendingPairings(pending);
      } catch (err) {
        if (!options?.silent) setRemoteClientError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!options?.silent) setRemoteClientsLoading(false);
      }
    },
    [clientAuth],
  );

  const pairingSeenPendingRef = React.useRef(false);
  React.useEffect(() => {
    if (!addDeviceOpen || addDevicePhase !== 'result' || !createdPairingId) return;
    if (pendingPairings.some((pending) => pending.id === createdPairingId)) {
      pairingSeenPendingRef.current = true;
      return;
    }
    if (!pairingSeenPendingRef.current) return;
    setCreatedPairingId(null);
    setAddDeviceOpen(false);
    if (remoteClients.some((client) => client.pairingId === createdPairingId)) {
      toast.success('Device connected.');
    }
  }, [addDeviceOpen, addDevicePhase, createdPairingId, pendingPairings, remoteClients]);

  const cancelPendingPairing = React.useCallback(
    async (id: string) => {
      if (!clientAuth) return;
      try {
        await clientAuth.cancelPairing(id);
        setPendingPairings((prev) => prev.filter((entry) => entry.id !== id));
        await loadRemoteClients({ silent: true });
      } catch (err) {
        setRemoteClientError(err instanceof Error ? err.message : String(err));
      }
    },
    [clientAuth, loadRemoteClients],
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

  const resolveTransportOptions = React.useCallback(async (): Promise<{
    localUrl: string | null;
    lanUrl: string | null;
    relayAvailable: boolean;
  }> => {
    if (clientAuth?.getPairingTransports) {
      try {
        const transports = await clientAuth.getPairingTransports();
        return {
          localUrl: transports.local,
          lanUrl: transports.lan,
          relayAvailable: transports.relayAvailable,
        };
      } catch {
        // Fall back
      }
    }
    const port = getRuntimePort();
    const localUrl = port
      ? `http://127.0.0.1:${port}`
      : isLoopbackUrl(window.location.origin)
        ? window.location.origin
        : null;
    let lanUrl: string | null = null;
    try {
      const resolved = normalizeHostUrl(await resolvePairingServerUrl());
      lanUrl = resolved && !isLoopbackUrl(resolved) ? resolved : null;
    } catch {
      // keep null
    }
    return { localUrl, lanUrl, relayAvailable: true };
  }, [clientAuth]);

  const openAddDevice = React.useCallback(async () => {
    setRemoteClientError(null);
    setPairingUrl(null);
    setPairingQrDataUrl(null);
    setPairingCopied(false);
    setCreatedPairingId(null);
    setAddDevicePhase('configure');
    setAddDeviceFallback(true);
    setAddDeviceOpen(true);
    const opts = await resolveTransportOptions();
    setTransportOptions(opts);
    setAddDeviceTransport(opts.relayAvailable ? 'relay' : opts.lanUrl ? 'lan' : 'local');
  }, [resolveTransportOptions]);

  const createPairingLink = React.useCallback(async () => {
    if (!clientAuth?.createPairingSession || !transportOptions) return;
    setRemoteClientError(null);
    setAddDeviceCreating(true);
    try {
      const label = remoteClientLabel.trim() || undefined;
      let serverUrl: string | undefined;
      let includeRelay: boolean;
      let includeDirect = true;
      if (addDeviceTransport === 'local') {
        serverUrl = transportOptions.localUrl ?? undefined;
        includeRelay = false;
      } else if (addDeviceTransport === 'lan') {
        serverUrl = transportOptions.lanUrl ?? undefined;
        includeRelay = addDeviceFallback;
      } else if (addDeviceFallback && transportOptions.lanUrl) {
        serverUrl = transportOptions.lanUrl;
        includeRelay = true;
      } else {
        includeDirect = false;
        includeRelay = true;
      }
      const { pairing, server } = await clientAuth.createPairingSession({
        label,
        allowedClientKinds: ['mobile', 'desktop'],
        serverUrl,
        includeRelay,
        includeDirect,
      });
      const payload = buildPairingConnectionPayload({
        pairingId: pairing.id,
        secret: pairing.secret,
        label: server.label,
        fingerprint: pairing.fingerprint ?? undefined,
        expiresAt: pairing.expiresAt,
        candidates: server.candidates as unknown as PairingEndpointCandidate[],
      });
      const encoded = encodePairingConnectionPayload(payload);
      setPairingUrl(encoded);
      setPairingQrDataUrl(
        await QRCode.toDataURL(encoded, { width: 1024, margin: 2, errorCorrectionLevel: 'L' }),
      );
      setPairingCopied(false);
      pairingSeenPendingRef.current = false;
      setCreatedPairingId(pairing.id);
      setAddDevicePhase('result');
      await loadRemoteClients({ silent: true });
    } catch (err) {
      setRemoteClientError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddDeviceCreating(false);
    }
  }, [clientAuth, transportOptions, addDeviceTransport, addDeviceFallback, remoteClientLabel, loadRemoteClients]);

  const handleCopyPairing = React.useCallback(() => {
    if (!pairingUrl) return;
    void copyTextToClipboard(pairingUrl).then((result) => {
      if (!result.ok) return;
      setPairingCopied(true);
      window.setTimeout(() => setPairingCopied(false), 2000);
    });
  }, [pairingUrl]);

  const revokeRemoteClient = React.useCallback(
    async (client: RemoteClientRecord) => {
      if (!clientAuth) return;
      const isLocalDesktopClient = client.clientKind === 'desktop-local';
      setRemoteClientError(null);
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
        setRemoteClientError(err instanceof Error ? err.message : String(err));
      }
    },
    [clientAuth, loadRemoteClients],
  );

  const purgeRevokedRemoteClients = React.useCallback(async () => {
    if (!clientAuth) return;
    setRemoteClientError(null);
    try {
      await clientAuth.purgeRevokedClients();
      await loadRemoteClients();
    } catch (err) {
      setRemoteClientError(err instanceof Error ? err.message : String(err));
    }
  }, [clientAuth, loadRemoteClients]);

  return {
    remoteClients,
    pendingPairings,
    remoteClientsLoading,
    remoteClientLabel,
    setRemoteClientLabel,
    remoteClientError,
    pairingUrl,
    pairingQrDataUrl,
    pairingCopied,
    addDeviceOpen,
    setAddDeviceOpen,
    addDevicePhase,
    addDeviceCreating,
    addDeviceTransport,
    setAddDeviceTransport,
    addDeviceFallback,
    setAddDeviceFallback,
    transportOptions,
    revokedClientCount,
    openAddDevice,
    createPairingLink,
    handleCopyPairing,
    revokeRemoteClient,
    purgeRevokedRemoteClients,
    cancelPendingPairing,
  };
}
