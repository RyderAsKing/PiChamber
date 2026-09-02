import React from 'react';
import QRCode from 'qrcode';
import { Button } from '@/components/ui/button';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useUIStore } from '@/stores/useUIStore';
import { useDeviceInfo } from '@/lib/device';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { PendingPairingRecord, RemoteClientRecord } from '@/lib/api/types';
import { buildPairingConnectionPayload, encodePairingConnectionPayload, parsePairingConnectionPayload, type PairingEndpointCandidate } from '@/lib/connectionPayload';
import {
  desktopHostProbe,
  desktopHostsGet,
  desktopHostsSet,
  desktopInstallIdGet,
  getDesktopHostApiUrl,
  normalizeHostUrl,
  probeRelayDesktopHost,
  redactSensitiveUrl,
  resolveDesktopHostUrl,
  relayHostDisplayUrl,
  type DesktopHost,
  type DesktopHostRelay,
  type HostProbeResult,
} from '@/lib/desktopHosts';
import { createRelayTunnelClient } from '@/lib/relay/tunnel-client';
import { isDesktopShell } from '@/lib/desktop';
import { getRuntimeApiBaseUrl, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import {
  desktopPlatformName,
  devicePlatformLabel,
  type HeaderDraft,
  buildRequestHeaders,
  readRequestHeaderDrafts,
  getRuntimePort,
  isLoopbackUrl,
  resolvePairingServerUrl,
  navigateToUrl,
} from './remoteInstanceHelpers';
import { AddDeviceDialog } from './AddDeviceDialog';
import { AddDirectHostDialog, EditDirectHostDialog, ImportDirectConnectDialog } from './DirectHostDialogs';

export const RemoteInstancesPage: React.FC = () => {
    const { isMobile } = useDeviceInfo();
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const { clientAuth } = useRuntimeAPIs();
  const showInstanceManagement = isDesktopShell();
  const [directHosts, setDirectHosts] = React.useState<DesktopHost[]>([]);
  // Live reachability per saved host (undefined = probe in flight), mirroring
  // the host switcher's status line so this list is not just dead text.
  const [directHostStatus, setDirectHostStatus] = React.useState<Record<string, HostProbeResult>>({});
  const [directDefaultHostId, setDirectDefaultHostId] = React.useState<string | null>('local');
  const [directLoading, setDirectLoading] = React.useState(false);
  const [directSaving, setDirectSaving] = React.useState(false);
  const [directLabel, setDirectLabel] = React.useState('');
  const [directUrl, setDirectUrl] = React.useState('');
  const [directToken, setDirectToken] = React.useState('');
  const [directHeaders, setDirectHeaders] = React.useState<HeaderDraft[]>([]);
  const [directConnectLink, setDirectConnectLink] = React.useState('');
  const [directError, setDirectError] = React.useState<string | null>(null);
  const [directAddDialogOpen, setDirectAddDialogOpen] = React.useState(false);
  const [directImportDialogOpen, setDirectImportDialogOpen] = React.useState(false);
  const [directEditingId, setDirectEditingId] = React.useState<string | null>(null);
  const [directEditLabel, setDirectEditLabel] = React.useState('');
  const [directEditUrl, setDirectEditUrl] = React.useState('');
  const [directEditToken, setDirectEditToken] = React.useState('');
  const [directEditHeaders, setDirectEditHeaders] = React.useState<HeaderDraft[]>([]);
  const [remoteClients, setRemoteClients] = React.useState<RemoteClientRecord[]>([]);
  const [pendingPairings, setPendingPairings] = React.useState<PendingPairingRecord[]>([]);
  const [remoteClientsLoading, setRemoteClientsLoading] = React.useState(false);
  const [remoteClientLabel, setRemoteClientLabel] = React.useState('');
  const [remoteClientError, setRemoteClientError] = React.useState<string | null>(null);
  const [pairingUrl, setPairingUrl] = React.useState<string | null>(null);
  // The pairing session shown in the QR dialog; used to auto-close the dialog
  // once the device redeems it (the pairing leaves the pending list).
  const [createdPairingId, setCreatedPairingId] = React.useState<string | null>(null);
  const [pairingQrDataUrl, setPairingQrDataUrl] = React.useState<string | null>(null);
  const [pairingCopied, setPairingCopied] = React.useState(false);
  // "Add a device" dialog: a configure phase (name + transport + fallback) then a
  // result phase (QR + link). The QR only ever shows inside this dialog.
  const [addDeviceOpen, setAddDeviceOpen] = React.useState(false);
  const [addDevicePhase, setAddDevicePhase] = React.useState<'configure' | 'result'>('configure');
  const [addDeviceCreating, setAddDeviceCreating] = React.useState(false);
  const [addDeviceTransport, setAddDeviceTransport] = React.useState<'local' | 'lan' | 'relay'>('relay');
  const [addDeviceFallback, setAddDeviceFallback] = React.useState(true);
  const [transportOptions, setTransportOptions] = React.useState<{ localUrl: string | null; lanUrl: string | null; relayAvailable: boolean } | null>(null);
  const revokedClientCount = React.useMemo(() => remoteClients.filter((client) => Boolean(client.revokedAt)).length, [remoteClients]);


  const loadDirectHosts = React.useCallback(async () => {
    setDirectLoading(true);
    setDirectError(null);
    try {
      const config = await desktopHostsGet();
      setDirectHosts(config.hosts || []);
      setDirectDefaultHostId(config.defaultHostId || 'local');
    } catch (err) {
      setDirectError(err instanceof Error ? err.message : String(err));
    } finally {
      setDirectLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadDirectHosts();
  }, [loadDirectHosts]);

  const persistDirectHosts = React.useCallback(async (hosts: DesktopHost[], defaultHostId: string | null = directDefaultHostId) => {
    setDirectSaving(true);
    setDirectError(null);
    try {
      await desktopHostsSet({ hosts, defaultHostId, initialHostChoiceCompleted: true });
      setDirectHosts(hosts);
      setDirectDefaultHostId(defaultHostId);
    } catch (err) {
      setDirectError(err instanceof Error ? err.message : String(err));
    } finally {
      setDirectSaving(false);
    }
  }, [directDefaultHostId]);

  const handleAddDirectHost = React.useCallback(async () => {
    const resolved = resolveDesktopHostUrl(directUrl);
    if (!resolved) {
      setDirectError("Invalid URL (must be http/https)");
      return;
    }
    const url = resolved.persistedUrl;
    const id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `host-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const host: DesktopHost = {
      id,
      label: directLabel.trim() || redactSensitiveUrl(url),
      url,
      apiUrl: url,
      ...(directToken.trim() ? { clientToken: directToken.trim() } : {}),
      ...(buildRequestHeaders(directHeaders) ? { requestHeaders: buildRequestHeaders(directHeaders) } : {}),
    };
    await persistDirectHosts([host, ...directHosts], directDefaultHostId);
    setDirectLabel('');
    setDirectUrl('');
    setDirectToken('');
    setDirectHeaders([]);
    setDirectAddDialogOpen(false);
    if (resolved.redeemUrl) {
      navigateToUrl(resolved.redeemUrl);
    }
  }, [directDefaultHostId, directHeaders, directHosts, directLabel, directToken, directUrl, persistDirectHosts]);

  const importDirectConnectLink = React.useCallback(async () => {
    const payload = parsePairingConnectionPayload(directConnectLink);
    if (!payload) {
      setDirectError("Invalid PiChamber connection link.");
      return;
    }
    // The redeem body is identical across every transport (the desktop is the
    // same device however it reaches the server). The install-id dedupe key
    // collapses re-pairing / re-auth of this desktop into one device record.
    const installId = await desktopInstallIdGet().catch(() => '');
    const redeemBody = JSON.stringify({
      pairingId: payload.pairingId,
      secret: payload.secret,
      clientLabel: payload.label || 'PiChamber Desktop',
      clientKind: 'desktop',
      deviceName: 'PiChamber Desktop',
      devicePlatform: desktopPlatformName(),
      ...(installId ? { dedupeKey: `desktop:${installId}` } : {}),
    });
    const redeemInit: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: redeemBody,
    };
    const tokenFromResponse = async (response: Response): Promise<string | null> => {
      if (!response.ok) return null;
      const body = (await response.json().catch(() => null)) as { clientToken?: unknown } | null;
      const token = typeof body?.clientToken === 'string' ? body.clientToken.trim() : '';
      return token || null;
    };

    // Try direct (LAN/tunnel) candidates first — they're cheaper and don't need
    // relay infrastructure — then fall back to relay. Ordered by payload priority.
    const ordered = [...payload.candidates].sort(
      (a, b) => (a.type === 'relay' ? 1 : 0) - (b.type === 'relay' ? 1 : 0),
    );

    let redeemed:
      | { kind: 'direct'; url: string; token: string }
      | { kind: 'relay'; relay: DesktopHostRelay; token: string }
      | null = null;

    for (const candidate of ordered) {
      if (candidate.type === 'relay') {
        // Open a throwaway E2EE tunnel just to redeem the one-time secret; the
        // grant (if any) authorizes admission to the relay for this serverId.
        const tunnel = createRelayTunnelClient({
          relayUrl: candidate.relayUrl,
          serverId: candidate.serverId,
          hostEncPubJwk: candidate.hostEncPubJwk,
          ...(candidate.grant ? { grant: candidate.grant } : {}),
        });
        try {
          const response = await tunnel.fetch('/api/client-auth/pairing/redeem', redeemInit);
          const token = await tokenFromResponse(response);
          if (token) {
            redeemed = {
              kind: 'relay',
              // grant is intentionally not persisted (one-time pairing artifact).
              relay: { relayUrl: candidate.relayUrl, serverId: candidate.serverId, hostEncPubJwk: candidate.hostEncPubJwk },
              token,
            };
            break;
          }
        } catch {
          // Relay unreachable / handshake failed — try the next candidate.
        } finally {
          tunnel.close();
        }
        continue;
      }
      // Direct: the remote instance is a user-provided URL, so a plain
      // cross-origin fetch is correct here (not the active runtime).
      const candidateUrl = normalizeHostUrl(candidate.url);
      if (!candidateUrl) continue;
      try {
        const response = await fetch(`${candidateUrl}/api/client-auth/pairing/redeem`, redeemInit);
        const token = await tokenFromResponse(response);
        if (token) {
          redeemed = { kind: 'direct', url: candidateUrl, token };
          break;
        }
      } catch {
        // Unreachable candidate — try the next one.
      }
    }

    if (!redeemed) {
      setDirectError("Invalid URL (must be http/https)");
      return;
    }

    const makeId = (): string => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `host-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    // Persist EVERY transport the link carried, not just the one that answered
    // the redeem — a multi-transport host connects directly on the home network
    // and falls back to the relay away from it (same model as mobile devices).
    // The single token works over both transports.
    const linkRelayCandidate = payload.candidates.find(
      (candidate): candidate is Extract<PairingEndpointCandidate, { type: 'relay' }> => candidate.type === 'relay',
    );
    const relay: DesktopHostRelay | undefined = redeemed.kind === 'relay'
      ? redeemed.relay
      : linkRelayCandidate
        ? { relayUrl: linkRelayCandidate.relayUrl, serverId: linkRelayCandidate.serverId, hostEncPubJwk: linkRelayCandidate.hostEncPubJwk }
        : undefined;
    const firstDirectUrl = payload.candidates
      .filter((candidate): candidate is Extract<PairingEndpointCandidate, { type: 'lan' | 'tunnel' }> => candidate.type !== 'relay')
      .map((candidate) => normalizeHostUrl(candidate.url))
      .find((value): value is string => Boolean(value));
    const directUrl = redeemed.kind === 'direct' ? redeemed.url : firstDirectUrl;
    const { token } = redeemed;

    const url = directUrl || (relay ? relayHostDisplayUrl(relay.serverId) : null);
    if (!url) {
      setDirectError("Invalid URL (must be http/https)");
      return;
    }
    const transportFields = {
      url,
      apiUrl: directUrl || undefined,
      clientToken: token,
      ...(relay ? { relay } : {}),
    };
    // One host per server: match by relay serverId when the link has a relay
    // leg, else by direct URL — re-importing updates the record in place.
    const existing = directHosts.find((host) => (
      relay ? host.relay?.serverId === relay.serverId : (!host.relay && normalizeHostUrl(host.apiUrl || host.url) === url)
    ));
    if (existing) {
      const nextHosts = directHosts.map((host) => host.id === existing.id
        ? { ...host, label: payload.label || host.label, ...transportFields }
        : host);
      await persistDirectHosts(nextHosts, directDefaultHostId);
    } else {
      // payload.label is normally the issuing server's hostname.
      await persistDirectHosts([{ id: makeId(), label: payload.label || redactSensitiveUrl(url), ...transportFields }, ...directHosts], directDefaultHostId);
    }
    setDirectConnectLink('');
    setDirectError(null);
    setDirectImportDialogOpen(false);
  }, [directConnectLink, directDefaultHostId, directHosts, persistDirectHosts]);

  const handleRemoveDirectHost = React.useCallback(async (id: string) => {
    const nextHosts = directHosts.filter((host) => host.id !== id);
    const nextDefault = directDefaultHostId === id ? 'local' : directDefaultHostId;
    await persistDirectHosts(nextHosts, nextDefault);
    if (directEditingId === id) {
      setDirectEditingId(null);
    }
  }, [directDefaultHostId, directEditingId, directHosts, persistDirectHosts]);

  const beginEditDirectHost = React.useCallback((host: DesktopHost) => {
    setDirectEditingId(host.id);
    setDirectEditLabel(host.label);
    setDirectEditUrl(host.apiUrl || host.url);
    setDirectEditToken(host.clientToken || '');
    setDirectEditHeaders(readRequestHeaderDrafts(host.requestHeaders));
    setDirectError(null);
  }, []);

  const saveDirectHostEdit = React.useCallback(async () => {
    if (!directEditingId) return;
    const resolved = resolveDesktopHostUrl(directEditUrl);
    if (!resolved) {
      setDirectError("Invalid URL (must be http/https)");
      return;
    }
    const url = resolved.persistedUrl;
    const nextHosts = directHosts.map((host) => host.id === directEditingId
      ? {
        ...host,
        label: directEditLabel.trim() || redactSensitiveUrl(url),
        url,
        apiUrl: url,
        clientToken: directEditToken.trim() || undefined,
        requestHeaders: buildRequestHeaders(directEditHeaders),
      }
      : host);
    await persistDirectHosts(nextHosts, directDefaultHostId);
    setDirectEditingId(null);
    if (resolved.redeemUrl) {
      navigateToUrl(resolved.redeemUrl);
    }
  }, [directDefaultHostId, directEditHeaders, directEditLabel, directEditToken, directEditUrl, directEditingId, directHosts, persistDirectHosts]);

  const setDefaultDirectHost = React.useCallback(async (id: string) => {
    await persistDirectHosts(directHosts, id);
  }, [directHosts, persistDirectHosts]);

  // Probe saved hosts whenever the list changes so each row shows a live
  // Connected/Unreachable status like the host switcher does. One pass per
  // list identity — no polling; the row set changes rarely.
  React.useEffect(() => {
    if (!showInstanceManagement || directHosts.length === 0) return;
    let cancelled = false;
    void Promise.all(directHosts.map(async (host) => {
      const relayProbe = () => probeRelayDesktopHost(host.relay!, { clientToken: host.clientToken || null, requestHeaders: host.requestHeaders || null }).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
      // Relay-only host: tunnel probe. Multi-transport host: direct first,
      // relay as the away-from-home fallback.
      if (host.relay && !host.apiUrl) {
        return [host.id, await relayProbe()] as const;
      }
      const url = normalizeHostUrl(getDesktopHostApiUrl(host));
      if (!url) {
        return [host.id, host.relay ? await relayProbe() : ({ status: 'unreachable', latencyMs: 0 } as HostProbeResult)] as const;
      }
      const direct = await desktopHostProbe(url, { clientToken: host.clientToken || null, requestHeaders: host.requestHeaders || null })
        .catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
      if (direct.status === 'unreachable' && host.relay) {
        const relayResult = await relayProbe();
        if (relayResult.status === 'ok') return [host.id, relayResult] as const;
      }
      return [host.id, direct] as const;
    })).then((entries) => {
      if (cancelled) return;
      setDirectHostStatus(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [directHosts, showInstanceManagement]);

  const loadRemoteClients = React.useCallback(async (options?: { silent?: boolean }) => {
    if (!clientAuth) return;
    if (!options?.silent) setRemoteClientsLoading(true);
    if (!options?.silent) setRemoteClientError(null);
    try {
      // Pending fetch failure returns null (NOT []) so a transient blip neither
      // blanks the pending list nor fakes a "pairing redeemed" signal for the
      // QR dialog's auto-close below.
      const [clients, pending] = await Promise.all([
        clientAuth.listClients(),
        clientAuth.listPendingPairings().catch(() => null),
      ]);
      setRemoteClients(clients);
      if (pending) setPendingPairings(pending);
    } catch (err) {
      // A silent poll must not surface a transient error over the live list.
      if (!options?.silent) setRemoteClientError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!options?.silent) setRemoteClientsLoading(false);
    }
  }, [clientAuth]);

  // Auto-close the QR/link dialog once the device connects: the pairing session
  // is single-use, so it leaving the pending list means it was redeemed (or
  // expired/cancelled — the dialog is stale either way). Armed only after the
  // pairing has been SEEN in the pending list — the result phase renders before
  // the refreshed list arrives, and closing on that stale "absent" would blink
  // the dialog shut immediately. Successful-fetch-only updates keep transient
  // poll failures from faking the disappearance.
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
    // Celebrate only an actual redeem (a client minted from this pairing exists);
    // an expired or cancelled session closes the stale dialog silently.
    if (remoteClients.some((client) => client.pairingId === createdPairingId)) {
      toast.success("Device connected.");
    }
  }, [addDeviceOpen, addDevicePhase, createdPairingId, pendingPairings, remoteClients]);

  const cancelPendingPairing = React.useCallback(async (id: string) => {
    if (!clientAuth) return;
    try {
      await clientAuth.cancelPairing(id);
      setPendingPairings((prev) => prev.filter((entry) => entry.id !== id));
      await loadRemoteClients({ silent: true });
    } catch (err) {
      setRemoteClientError(err instanceof Error ? err.message : String(err));
    }
  }, [clientAuth, loadRemoteClients]);

  // Load on mount, then poll while the page is visible so a device that redeems
  // a pairing link shows up in the list without reopening settings.
  React.useEffect(() => {
    if (!clientAuth) return;
    void loadRemoteClients();
    const interval = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void loadRemoteClients({ silent: true });
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [clientAuth, loadRemoteClients]);

  // Available direct transports for the create dialog. The server is authoritative
  // for LAN reachability (derived from its bind, not the UI origin), so "Local
  // network" works even when the UI is opened on localhost. Falls back to the
  // client-side guess if the endpoint is unavailable.
  const resolveTransportOptions = React.useCallback(async (): Promise<{ localUrl: string | null; lanUrl: string | null; relayAvailable: boolean }> => {
    if (clientAuth?.getPairingTransports) {
      try {
        const transports = await clientAuth.getPairingTransports();
        return { localUrl: transports.local, lanUrl: transports.lan, relayAvailable: transports.relayAvailable };
      } catch {
        // fall through to the client-side guess
      }
    }
    const port = getRuntimePort();
    const localUrl = port ? `http://127.0.0.1:${port}` : (isLoopbackUrl(window.location.origin) ? window.location.origin : null);
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
    // "Anywhere" (relay, with home-network preference) is the right default for
    // most people; fall back to narrower options only when relay is unavailable.
    setAddDeviceTransport(opts.relayAvailable ? 'relay' : opts.lanUrl ? 'lan' : 'local');
  }, [resolveTransportOptions]);

  const createPairingLink = React.useCallback(async () => {
    if (!clientAuth?.createPairingSession || !transportOptions) return;
    setRemoteClientError(null);
    setAddDeviceCreating(true);
    try {
      const label = remoteClientLabel.trim() || undefined;
      // Map the chosen transport (+ fallback) to the per-link candidate request.
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
        // Relay, but prefer the local network when available: carry both.
        serverUrl = transportOptions.lanUrl;
        includeRelay = true;
      } else {
        // Relay only.
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
        // The typed name (`label`) is the per-device label shown in THIS server's
        // device list; it already went to createPairingSession above. The payload
        // label is what the paired device names its connection by, which must be
        // the issuing server's name (hostname), not the device's own name.
        label: server.label,
        fingerprint: pairing.fingerprint ?? undefined,
        expiresAt: pairing.expiresAt,
        candidates: server.candidates as unknown as PairingEndpointCandidate[],
      });
      const encoded = encodePairingConnectionPayload(payload);
      setPairingUrl(encoded);
      // Pairing payloads are dense (multiple transport candidates + the relay
      // E2EE key), so render at high resolution with low error-correction.
      setPairingQrDataUrl(await QRCode.toDataURL(encoded, { width: 1024, margin: 2, errorCorrectionLevel: 'L' }));
      setPairingCopied(false);
      pairingSeenPendingRef.current = false;
      setCreatedPairingId(pairing.id);
      setAddDevicePhase('result');
      // Loads the pending list including this pairing BEFORE the result phase
      // polls it, so the auto-close effect sees "present -> gone" transitions.
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

  const revokeRemoteClient = React.useCallback(async (client: RemoteClientRecord) => {
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
        setRemoteClients((clients) => clients.map((entry) => entry.id === client.id
          ? { ...entry, revokedAt: new Date().toISOString() }
          : entry));
        switchRuntimeEndpoint({ apiBaseUrl: getRuntimeApiBaseUrl(), clientToken: null, runtimeKey: 'local' });
        return;
      }
      await loadRemoteClients();
    } catch (err) {
      setRemoteClientError(err instanceof Error ? err.message : String(err));
    }
  }, [clientAuth, loadRemoteClients]);

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

  return (
      <SettingsPageLayout title={isMobile ? undefined : "Remote Instances"}>
        {clientAuth ? (
          <SettingsSection
            title={"Connect to this server"}
            info={"Create a secure link or token so PiChamber Desktop can connect to this server."}
            divider={false}
            settingsItem="remote-instances.client-auth"
            contentClassName="space-y-3"
          >
              <div>
                <Button type="button" size="xs" className="!font-normal" onClick={() => void openAddDevice()}>
                  <Icon name="add" className="h-3.5 w-3.5" />
                  {"Add a device"}
                </Button>
              </div>
              <div className="space-y-2.5">
                {revokedClientCount > 0 ? (
                  <div className="flex justify-end">
                    <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void purgeRevokedRemoteClients()}>
                      {"Clear revoked"}
                    </Button>
                  </div>
                ) : null}
                {remoteClientsLoading && remoteClients.length === 0 && pendingPairings.length === 0 ? (
                  <p className="typography-meta text-muted-foreground">{"Loading tokens..."}</p>
                ) : remoteClients.length === 0 && pendingPairings.length === 0 ? (
                  <p className="typography-meta text-muted-foreground">{"No devices connected yet."}</p>
                ) : (
                  <>
                    {pendingPairings.map((pending) => (
                      <div key={`pending-${pending.id}`} className="flex items-center justify-between gap-3 py-1.5">
                        <div className="min-w-0 space-y-0.5">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--status-warning)] animate-pulse" />
                            <p className="typography-ui-label text-foreground truncate">{pending.label || "Device name — e.g. My iPhone"}</p>
                            {pending.usesRelay ? (
                              <span className="typography-micro text-muted-foreground bg-muted px-1 rounded shrink-0 leading-none pb-px border border-border/50">{"Relay"}</span>
                            ) : null}
                          </div>
                          <p className="typography-micro text-muted-foreground truncate">{"Waiting to connect…"}</p>
                        </div>
                        <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void cancelPendingPairing(pending.id)}>
                          {"Cancel"}
                        </Button>
                      </div>
                    ))}
                    {remoteClients.map((client) => {
                      const isLocalDesktopClient = client.clientKind === 'desktop-local';
                      // Live presence: the server refreshes lastUsedAt on every
                      // authenticated request (writes throttled to 60s), so a
                      // device with activity in the last 90s is connected NOW.
                      // The list polls every 5s, keeping this fresh.
                      const lastUsedMs = client.lastUsedAt ? Date.parse(client.lastUsedAt) : Number.NaN;
                      const isOnline = !client.revokedAt
                        && (isLocalDesktopClient || (Number.isFinite(lastUsedMs) && Date.now() - lastUsedMs < 90_000));
                      const statusText = client.revokedAt
                        ? "Revoked"
                        : isOnline
                          ? (client.lastTransport === 'relay' && !isLocalDesktopClient
                            ? "Connected · Relay"
                            : "Connected · Local network")
                          : Number.isFinite(lastUsedMs)
                            ? `Last used ${formatDateTimeForPreference(lastUsedMs, timeFormatPreference, {
                                  month: 'short',
                                  day: 'numeric',
                                  hour: 'numeric',
                                  minute: '2-digit',
                                })}`
                            : "Never used";
                      return (
                        <div key={client.id} className="flex items-center justify-between gap-3 py-1.5">
                          <div className="min-w-0">
                            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                              <span className={cn(
                                'h-2 w-2 shrink-0 rounded-full',
                                client.revokedAt ? 'bg-muted-foreground/20' : isOnline ? 'bg-[var(--status-success)]' : 'bg-muted-foreground/30',
                              )} />
                              <p className="typography-ui-label text-foreground truncate">{client.label}</p>
                              {devicePlatformLabel(client.devicePlatform) ? (
                                <span className="typography-micro text-muted-foreground bg-muted px-1 rounded shrink-0 leading-none pb-px border border-border/50">
                                  {devicePlatformLabel(client.devicePlatform)}
                                </span>
                              ) : null}
                              {isLocalDesktopClient ? (
                                <span className="typography-micro text-muted-foreground bg-muted px-1 rounded flex-shrink-0 leading-none pb-px border border-border/50">
                                  {"This device"}
                                </span>
                              ) : null}
                              <span className={cn('typography-micro truncate', isOnline && !client.revokedAt ? 'text-[var(--status-success)]' : 'text-muted-foreground')}>{statusText}</span>
                            </div>
                          </div>
                          <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void revokeRemoteClient(client)} disabled={Boolean(client.revokedAt)}>
                            {"Revoke"}
                          </Button>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
              {remoteClientError ? <p className="typography-meta text-[var(--status-error)]">{remoteClientError}</p> : null}
          </SettingsSection>
        ) : null}

        {showInstanceManagement ? <SettingsSection
          title={"Other PiChamber servers"}
          info={"Servers this app can switch to. Import a pairing link from the other server, or add one by address."}
          settingsItem="remote-instances.direct-hosts"
          contentClassName="space-y-4"
          headerAction={(
            /* Importing a pairing link is the flagship path; add-by-address is
               the manual fallback. The token-storage note lives in the add
               dialog next to the token field it describes. */
            <div className="flex shrink-0 items-center gap-2">
              <Button type="button" size="xs" className="!font-normal" onClick={() => setDirectImportDialogOpen(true)} disabled={directSaving}>
                {"Import Link"}
              </Button>
              <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setDirectAddDialogOpen(true)} disabled={directSaving}>
                <Icon name="add" className="h-3.5 w-3.5" />
                {"Add Server"}
              </Button>
            </div>
          )}
        >
            <div className="space-y-2.5">
              {directLoading ? (
                <p className="typography-meta text-muted-foreground">{"Loading instances..."}</p>
              ) : directHosts.length === 0 ? (
                <p className="typography-meta text-muted-foreground">{"No other servers added yet."}</p>
              ) : directHosts.map((host) => {
                const probe = directHostStatus[host.id];
                const statusLabel = !probe
                  ? 'Checking'
                  : probe.status === 'ok'
                    ? 'Connected'
                    : probe.status === 'auth'
                      ? 'Auth required'
                      : probe.status === 'update-recommended'
                        ? 'Update recommended'
                        : probe.status === 'incompatible'
                          ? 'Incompatible'
                          : probe.status === 'wrong-service'
                            ? 'Wrong service'
                            : 'Unreachable';
                const isOnline = probe?.status === 'ok';
                return (
                <div key={host.id} className="py-1.5">
                  <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className={cn(
                            'h-2 w-2 shrink-0 rounded-full',
                            !probe ? 'bg-muted-foreground/30 animate-pulse' : isOnline ? 'bg-[var(--status-success)]' : 'bg-[var(--status-error)]',
                          )} />
                          <p className="typography-ui-label text-foreground truncate">{redactSensitiveUrl(host.label)}</p>
                          {directDefaultHostId === host.id ? <span className="typography-micro text-muted-foreground shrink-0">{"Default"}</span> : null}
                          <span className={cn('typography-micro shrink-0', isOnline ? 'text-[var(--status-success)]' : 'text-muted-foreground')}>
                            {statusLabel}
                            {isOnline && typeof probe?.latencyMs === 'number'
                              ? ` · ${Math.max(0, Math.round(probe.latencyMs))}ms ping`
                              : ''}
                          </span>
                        </div>
                        <p className={cn('typography-micro text-muted-foreground truncate', host.apiUrl && 'font-mono')}>
                          {host.relay && !host.apiUrl ? "via PiChamber Relay" : redactSensitiveUrl(host.apiUrl || host.url)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void setDefaultDirectHost(host.id)} disabled={directSaving || directDefaultHostId === host.id} aria-label={"Set as default"}>
                          {directDefaultHostId === host.id ? <Icon name="star-fill" className="h-3.5 w-3.5" /> : <Icon name="star" className="h-3.5 w-3.5" />}
                        </Button>
                        {/* The edit form is URL/token-centric; relay-ONLY hosts have
                            nothing it can edit and are re-imported via a fresh pairing
                            link instead. Multi-transport hosts keep their relay leg
                            through the edit (object spread preserves it). */}
                        {host.relay && !host.apiUrl ? null : (
                          <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => beginEditDirectHost(host)} disabled={directSaving}>
                            <Icon name="pencil" className="h-3.5 w-3.5" />
                            {"Edit"}
                          </Button>
                        )}
                        <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => void handleRemoveDirectHost(host.id)} disabled={directSaving}>
                          <Icon name="delete-bin" className="h-3.5 w-3.5" />
                          {"Delete"}
                        </Button>
                      </div>
                  </div>
                </div>
                );
              })}
            </div>

            {directError ? <p className="typography-meta text-[var(--status-error)]">{directError}</p> : null}
        </SettingsSection> : null}

        {showInstanceManagement ? (
          <>
            <AddDirectHostDialog
              open={directAddDialogOpen}
              onOpenChange={setDirectAddDialogOpen}
              label={directLabel}
              onLabelChange={setDirectLabel}
              url={directUrl}
              onUrlChange={setDirectUrl}
              token={directToken}
              onTokenChange={setDirectToken}
              headers={directHeaders}
              onHeadersChange={setDirectHeaders}
              saving={directSaving}
              onAdd={handleAddDirectHost}
            />

            <EditDirectHostDialog
              open={Boolean(directEditingId)}
              onOpenChange={(open) => {
                if (!open) setDirectEditingId(null);
              }}
              label={directEditLabel}
              onLabelChange={setDirectEditLabel}
              url={directEditUrl}
              onUrlChange={setDirectEditUrl}
              token={directEditToken}
              onTokenChange={setDirectEditToken}
              headers={directEditHeaders}
              onHeadersChange={setDirectEditHeaders}
              saving={directSaving}
              onSave={saveDirectHostEdit}
            />

            <ImportDirectConnectDialog
              open={directImportDialogOpen}
              onOpenChange={setDirectImportDialogOpen}
              link={directConnectLink}
              onLinkChange={setDirectConnectLink}
              saving={directSaving}
              onImport={importDirectConnectLink}
            />
          </>
        ) : null}

        <AddDeviceDialog
          open={addDeviceOpen}
          onOpenChange={setAddDeviceOpen}
          phase={addDevicePhase}
          remoteClientLabel={remoteClientLabel}
          onRemoteClientLabelChange={setRemoteClientLabel}
          remoteClientError={remoteClientError}
          addDeviceTransport={addDeviceTransport}
          onAddDeviceTransportChange={setAddDeviceTransport}
          addDeviceFallback={addDeviceFallback}
          onAddDeviceFallbackChange={setAddDeviceFallback}
          transportOptions={transportOptions}
          addDeviceCreating={addDeviceCreating}
          onCreatePairingLink={createPairingLink}
          pairingQrDataUrl={pairingQrDataUrl}
          pairingUrl={pairingUrl}
          pairingCopied={pairingCopied}
          onCopyPairing={handleCopyPairing}
        />
      </SettingsPageLayout>
  );
};
