import * as React from 'react';
import { isDesktopShell, isElectronShell } from '@/lib/desktop';
import {
  desktopHostProbe,
  desktopHostsGet,
  desktopHostsSet,
  desktopLocalClientTokenGet,
  desktopOpenNewWindowAtUrl,
  desktopOpenNewWindowForHost,
  getDesktopHostApiUrl,
  importDesktopHostPairing,
  normalizeHostUrl,
  probeRelayDesktopHost,
  redactSensitiveUrl,
  resolveDesktopHostUrl,
  type DesktopHost,
  type HostProbeResult,
} from '@/lib/desktopHosts';
import {
  LOCAL_HOST_ID,
  buildLocalDesktopHost,
  getLocalDesktopOrigin,
  resolveCurrentDesktopHost,
  runtimeKeyForDesktopHost,
} from '@/lib/desktopCurrentHost';
import { scheduleDesktopHostCandidateRefresh } from '@/lib/desktopRelayRestore';
import { sharedProbeDeduper } from '@/lib/servers/probeDedupe';
import {
  desktopHostToServerListItem,
  sortServerListItems,
  type ServerListItem,
} from '@/lib/servers/serverViewModel';
import { buildRequestHeaders } from './serverHeaderDrafts';
import type { HeaderDraft } from './serverHeaderDrafts';
import { adoptRelayTunnel } from '@/lib/relay/runtime-tunnel';
import type { createRelayTunnelClient } from '@/lib/relay/tunnel-client';
import { subscribeRuntimeEndpointChanged, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { toast } from '@/components/ui';

export type DesktopProbeSnapshot = {
  status: HostProbeResult['status'];
  latencyMs: number;
  /** Which transport the successful probe used (multi-transport hosts). */
  via?: 'relay';
};

/**
 * Status cache shared by every desktop server surface. Rows show the cached
 * result immediately and refresh it quietly, instead of flashing "Unknown"
 * while a probe runs. Survives unmounting (the switcher dropdown remounts on
 * every open) so one probe cycle serves both the switcher and settings.
 */
const sharedStatusCache = new Map<string, DesktopProbeSnapshot>();

const readSharedStatusCache = (): Record<string, DesktopProbeSnapshot> =>
  Object.fromEntries(sharedStatusCache);

const UNREACHABLE: DesktopProbeSnapshot = { status: 'unreachable', latencyMs: 0 };

const isBlockedHostStatus = (status: HostProbeResult['status']): boolean => {
  return status === 'unreachable' || status === 'wrong-service' || status === 'incompatible';
};

const toNavigationUrl = (rawUrl: string): string => {
  const normalized = normalizeHostUrl(rawUrl);
  if (!normalized) return rawUrl.trim();
  try {
    const url = new URL(normalized);
    if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
    return url.toString();
  } catch {
    return normalized;
  }
};

const getLocalClientToken = async (): Promise<string> => {
  if (!isElectronShell()) return '';
  return desktopLocalClientTokenGet().catch(() => '');
};

const navigateToUrl = (rawUrl: string): void => {
  const target = rawUrl.trim();
  if (!target) return;
  try {
    window.location.assign(target);
  } catch {
    window.location.href = target;
  }
};

export type ImportServerResult = { ok: true; hostId: string } | { ok: false; error: string };
export type SaveServerResult = { ok: true } | { ok: false; error: string };

const INVALID_LINK_ERROR = 'Invalid PiChamber connection link.';
const INVALID_URL_ERROR = 'Invalid URL (must be http/https)';

const pairingErrorMessage = (err: unknown): string => {
  const code = err instanceof Error ? err.message : String(err);
  if (code === 'invalid-connect-link') return INVALID_LINK_ERROR;
  return INVALID_URL_ERROR;
};

export type ManualServerInput = {
  label: string;
  url: string;
  token: string;
  headers: HeaderDraft[];
};

export function useDesktopServers(options?: { autoLoad?: boolean }) {
  const autoLoad = options?.autoLoad !== false;
  const [remoteHosts, setRemoteHosts] = React.useState<DesktopHost[]>([]);
  const [defaultHostId, setDefaultHostId] = React.useState<string | null>(null);
  const [localOrigin, setLocalOrigin] = React.useState<string>(() => getLocalDesktopOrigin());
  const [statusById, setStatusById] = React.useState<Record<string, DesktopProbeSnapshot>>(() =>
    readSharedStatusCache(),
  );
  const [probing, setProbing] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [switchingHostId, setSwitchingHostId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [runtimeEndpointEpoch, setRuntimeEndpointEpoch] = React.useState(0);

  React.useEffect(() => {
    return subscribeRuntimeEndpointChanged(() => setRuntimeEndpointEpoch((epoch) => epoch + 1));
  }, []);

  const allHosts = React.useMemo(() => {
    const local = buildLocalDesktopHost(localOrigin);
    const normalizedRemote = remoteHosts.map((host) => ({
      ...host,
      url: normalizeHostUrl(host.url) || host.url,
    }));
    return [local, ...normalizedRemote];
  }, [remoteHosts, localOrigin]);

  const current = React.useMemo(() => {
    void runtimeEndpointEpoch;
    return resolveCurrentDesktopHost(allHosts);
  }, [allHosts, runtimeEndpointEpoch]);

  const currentDefaultLabel = React.useMemo(() => {
    const id = defaultHostId || LOCAL_HOST_ID;
    return allHosts.find((host) => host.id === id)?.label || 'Local';
  }, [allHosts, defaultHostId]);

  const items = React.useMemo<ServerListItem[]>(() => {
    const resolved = allHosts.map((host) =>
      desktopHostToServerListItem(host, {
        isCurrent: host.id === current.id,
        isDefault: (defaultHostId || LOCAL_HOST_ID) === host.id,
        isLocal: host.id === LOCAL_HOST_ID,
        probe: statusById[host.id] || null,
        probing,
        localOrigin,
        redactUrl: redactSensitiveUrl,
      }),
    );
    return sortServerListItems(resolved);
  }, [allHosts, current, defaultHostId, statusById, probing, localOrigin]);

  const load = React.useCallback(async () => {
    if (!isDesktopShell()) return;
    setLoading(true);
    setError(null);
    try {
      const config = await desktopHostsGet();
      if (config.localOrigin) setLocalOrigin(config.localOrigin);
      setRemoteHosts(config.hosts || []);
      setDefaultHostId(config.defaultHostId ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
      setRemoteHosts([]);
      setDefaultHostId(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (autoLoad) void load();
  }, [autoLoad, load]);

  const persist = React.useCallback(
    async (nextRemote: DesktopHost[], nextDefaultHostId: string | null) => {
      setSaving(true);
      setError(null);
      try {
        await desktopHostsSet({
          hosts: nextRemote,
          defaultHostId: nextDefaultHostId,
          initialHostChoiceCompleted: true,
        });
        setRemoteHosts(nextRemote);
        setDefaultHostId(nextDefaultHostId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save');
        throw err;
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const probeOne = React.useCallback(
    async (host: DesktopHost, localClientToken: string): Promise<DesktopProbeSnapshot> => {
      // Dedupe concurrent probes per host so the switcher and the settings
      // page share one probe cycle instead of firing parallel probes.
      return sharedProbeDeduper(host.id, async (): Promise<DesktopProbeSnapshot> => {
        const clientToken = host.id === LOCAL_HOST_ID ? localClientToken : host.clientToken || '';
        const headers = host.requestHeaders || null;
        const probeRelayLeg = async (): Promise<DesktopProbeSnapshot> => {
          const res = await probeRelayDesktopHost(host.relay!, { clientToken, requestHeaders: headers }).catch(
            (): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }),
          );
          return {
            status: res.status,
            latencyMs: res.latencyMs,
            ...(res.status === 'ok' ? { via: 'relay' as const } : {}),
          };
        };
        // Relay-only host: no HTTP address — probe through the E2EE tunnel.
        if (host.relay && !host.apiUrl) return probeRelayLeg();
        const url = normalizeHostUrl(isElectronShell() ? getDesktopHostApiUrl(host) : host.url);
        if (!url) return { ...UNREACHABLE };
        const res = await desktopHostProbe(url, {
          clientToken: clientToken || null,
          requestHeaders: headers,
          // Pinned direct identity (or the relay serverId for multi-transport
          // hosts): a mismatch never sends the bearer (enforced main-side).
          expectedServerId: host.serverId ?? host.relay?.serverId ?? null,
        }).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
        // Multi-transport host away from its network: the direct leg fails
        // but the relay may still reach it.
        if (isBlockedHostStatus(res.status) && host.relay) {
          const relayStatus = await probeRelayLeg();
          if (relayStatus.status === 'ok') return relayStatus;
        }
        return { status: res.status, latencyMs: res.latencyMs };
      });
    },
    [],
  );

  /**
   * Probe every host (direct first, relay fallback). Cached results stay
   * visible until the whole cycle settles, so rows never flash intermediate
   * failures while a fallback leg is still running.
   */
  const probeAll = React.useCallback(
    async (hosts: DesktopHost[]): Promise<Record<string, DesktopProbeSnapshot>> => {
      if (!isDesktopShell()) return {};
      setProbing(true);
      try {
        const localClientToken = await getLocalClientToken();
        const entries = await Promise.all(
          hosts.map(async (host) => [host.id, await probeOne(host, localClientToken)] as const),
        );
        for (const [id, snapshot] of entries) sharedStatusCache.set(id, snapshot);
        setStatusById((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
        return Object.fromEntries(entries);
      } finally {
        setProbing(false);
      }
    },
    [probeOne],
  );

  const importPairingLink = React.useCallback(
    async (link: string): Promise<ImportServerResult> => {
      setSaving(true);
      setError(null);
      try {
        const { hosts, hostId } = await importDesktopHostPairing(link, remoteHosts);
        await desktopHostsSet({
          hosts,
          defaultHostId,
          initialHostChoiceCompleted: true,
        });
        setRemoteHosts(hosts);
        return { ok: true, hostId };
      } catch (err) {
        const message = pairingErrorMessage(err);
        setError(message);
        return { ok: false, error: message };
      } finally {
        setSaving(false);
      }
    },
    [remoteHosts, defaultHostId],
  );

  const addManualServer = React.useCallback(
    async (input: ManualServerInput): Promise<SaveServerResult> => {
      const resolved = resolveDesktopHostUrl(input.url);
      if (!resolved) {
        setError(INVALID_URL_ERROR);
        return { ok: false, error: INVALID_URL_ERROR };
      }
      const url = resolved.persistedUrl;
      const id =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `host-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const host: DesktopHost = {
        id,
        label: input.label.trim() || redactSensitiveUrl(url),
        url,
        apiUrl: url,
        ...(input.token.trim() ? { clientToken: input.token.trim() } : {}),
        ...(buildRequestHeaders(input.headers)
          ? { requestHeaders: buildRequestHeaders(input.headers) }
          : {}),
      };
      try {
        await persist([host, ...remoteHosts], defaultHostId);
      } catch {
        return { ok: false, error: 'Failed to save' };
      }
      if (resolved.redeemUrl) navigateToUrl(resolved.redeemUrl);
      return { ok: true };
    },
    [remoteHosts, defaultHostId, persist],
  );

  const updateServer = React.useCallback(
    async (id: string, input: ManualServerInput): Promise<SaveServerResult> => {
      const resolved = resolveDesktopHostUrl(input.url);
      if (!resolved) {
        setError(INVALID_URL_ERROR);
        return { ok: false, error: INVALID_URL_ERROR };
      }
      const url = resolved.persistedUrl;
      const nextRemote = remoteHosts.map((host) =>
        host.id === id
          ? {
              ...host,
              label: input.label.trim() || redactSensitiveUrl(url),
              url,
              apiUrl: url,
              clientToken: input.token.trim() || undefined,
              requestHeaders: buildRequestHeaders(input.headers),
            }
          : host,
      );
      try {
        await persist(nextRemote, defaultHostId);
      } catch {
        return { ok: false, error: 'Failed to save' };
      }
      if (resolved.redeemUrl) navigateToUrl(resolved.redeemUrl);
      return { ok: true };
    },
    [remoteHosts, defaultHostId, persist],
  );

  const removeServer = React.useCallback(
    async (id: string): Promise<void> => {
      const nextRemote = remoteHosts.filter((host) => host.id !== id);
      const nextDefault = defaultHostId === id ? LOCAL_HOST_ID : defaultHostId;
      try {
        await persist(nextRemote, nextDefault);
      } catch {
        // persist already surfaced the error.
      }
    },
    [remoteHosts, defaultHostId, persist],
  );

  const setDefaultServer = React.useCallback(
    async (id: string): Promise<void> => {
      try {
        await persist(remoteHosts, id);
      } catch {
        // persist already surfaced the error.
      }
    },
    [remoteHosts, persist],
  );

  const switchToHost = React.useCallback(
    async (hostId: string, options?: { onSwitched?: () => void }): Promise<void> => {
      const host = allHosts.find((entry) => entry.id === hostId);
      if (!host) return;
      // Relay legs ride the E2EE tunnel activated in-renderer via
      // switchRuntimeEndpoint({ relay }); the runtime fetch/socket layers
      // route through the tunnel from the singleton registry.
      const activateRelay = (
        relay: NonNullable<DesktopHost['relay']>,
        liveTunnel?: ReturnType<typeof createRelayTunnelClient>,
      ) => {
        // Adopt the probe's live tunnel (when it kept one) BEFORE the switch:
        // the activate call inside switchRuntimeEndpoint sees an equal
        // descriptor and reuses it — no second WebSocket connect + handshake.
        if (liveTunnel) {
          adoptRelayTunnel(
            { relayUrl: relay.relayUrl, serverId: relay.serverId, hostEncPubJwk: relay.hostEncPubJwk },
            liveTunnel,
          );
        }
        switchRuntimeEndpoint({
          apiBaseUrl: typeof window !== 'undefined' ? window.location.origin : '',
          clientToken: host.clientToken || null,
          runtimeKey: runtimeKeyForDesktopHost(host),
          relay,
        });
        // On the relay: learn the server's current LAN address in the
        // background and hot-switch back to direct if the stored one moved.
        scheduleDesktopHostCandidateRefresh(host.id);
      };

      const origin = host.id === LOCAL_HOST_ID ? localOrigin : normalizeHostUrl(host.url) || '';
      const apiOrigin =
        host.id === LOCAL_HOST_ID ? localOrigin : normalizeHostUrl(getDesktopHostApiUrl(host)) || '';
      const relayOnly = Boolean(host.relay) && !host.apiUrl && host.id !== LOCAL_HOST_ID;
      if (!origin && !relayOnly) return;

      if (isElectronShell()) {
        if (!apiOrigin && !host.relay) return;
        setSwitchingHostId(host.id);
        try {
          const clientToken = host.id === LOCAL_HOST_ID ? await getLocalClientToken() : host.clientToken || '';

          // Act on the cached probe result instead of re-probing (re-probes
          // doubled the switch latency and flashed transient Unreachable
          // states over a known-good host).
          const cached = statusById[host.id];
          if (cached?.status === 'ok') {
            if (cached.via === 'relay' && host.relay) {
              activateRelay(host.relay);
            } else if (apiOrigin) {
              switchRuntimeEndpoint({
                apiBaseUrl: apiOrigin,
                clientToken: clientToken || null,
                requestHeaders: host.requestHeaders || null,
                runtimeKey: runtimeKeyForDesktopHost(host),
              });
            } else if (host.relay) {
              activateRelay(host.relay);
            }
            options?.onSwitched?.();
            return;
          }

          // No usable probe result — probe now: direct first, relay fallback.
          // Statuses are written once, with the final outcome, so the row
          // never flashes intermediate failures while fallback runs.
          let finalStatus: DesktopProbeSnapshot = { ...UNREACHABLE };
          let transport: 'direct' | 'relay' | null = null;
          if (apiOrigin) {
            const probe = await desktopHostProbe(apiOrigin, {
              clientToken: clientToken || null,
              requestHeaders: host.requestHeaders || null,
              expectedServerId: host.serverId ?? host.relay?.serverId ?? null,
            }).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
            finalStatus = { status: probe.status, latencyMs: probe.latencyMs };
            if (!isBlockedHostStatus(probe.status)) transport = 'direct';
          }
          let relayProbeTunnel: ReturnType<typeof createRelayTunnelClient> | undefined;
          if (!transport && host.relay) {
            const probe = await probeRelayDesktopHost(host.relay, {
              keepTunnel: true,
              clientToken: clientToken || null,
              requestHeaders: host.requestHeaders || null,
            }).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
            if (probe.status === 'ok') {
              finalStatus = { status: probe.status, latencyMs: probe.latencyMs, via: 'relay' };
              transport = 'relay';
              relayProbeTunnel = 'tunnel' in probe ? probe.tunnel : undefined;
            }
          }
          const settled = finalStatus;
          sharedStatusCache.set(host.id, settled);
          setStatusById((prev) => ({ ...prev, [host.id]: settled }));

          if (!transport) {
            toast.error(`Server "${redactSensitiveUrl(host.label)}" is unreachable`);
            return;
          }
          if (transport === 'relay' && host.relay) {
            activateRelay(host.relay, relayProbeTunnel);
          } else {
            switchRuntimeEndpoint({
              apiBaseUrl: apiOrigin,
              clientToken: clientToken || null,
              requestHeaders: host.requestHeaders || null,
              runtimeKey: runtimeKeyForDesktopHost(host),
            });
          }
          options?.onSwitched?.();
        } finally {
          setSwitchingHostId(null);
        }
        return;
      }

      if (host.id !== LOCAL_HOST_ID && isDesktopShell()) {
        setSwitchingHostId(host.id);
        try {
          const probe = await desktopHostProbe(origin, {
            clientToken: host.clientToken || null,
            requestHeaders: host.requestHeaders || null,
            expectedServerId: host.serverId ?? host.relay?.serverId ?? null,
          }).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
          const settled: DesktopProbeSnapshot = { status: probe.status, latencyMs: probe.latencyMs };
          sharedStatusCache.set(host.id, settled);
          setStatusById((prev) => ({ ...prev, [host.id]: settled }));

          if (isBlockedHostStatus(probe.status)) {
            toast.error(`Server "${redactSensitiveUrl(host.label)}" is unreachable`);
            return;
          }
        } finally {
          setSwitchingHostId(null);
        }
      }

      options?.onSwitched?.();
      navigateToUrl(toNavigationUrl(origin));
    },
    [allHosts, localOrigin, statusById],
  );

  const openInNewWindow = React.useCallback(
    (hostId: string): void => {
      const host = allHosts.find((entry) => entry.id === hostId);
      if (!host) return;
      const reportFailure = (err: unknown) => {
        toast.error('Failed to open new window', {
          description: err instanceof Error ? err.message : String(err),
        });
      };
      // Relay-capable hosts can't be expressed as a fixed window URL — the new
      // window boots the local UI and picks direct-vs-tunnel itself.
      if (host.relay && host.id !== LOCAL_HOST_ID) {
        desktopOpenNewWindowForHost(host.id).catch(reportFailure);
        return;
      }
      const origin = host.id === LOCAL_HOST_ID ? localOrigin : getDesktopHostApiUrl(host);
      if (!origin) return;
      desktopOpenNewWindowAtUrl(toNavigationUrl(origin), {
        clientToken: host.clientToken || null,
        requestHeaders: host.requestHeaders || null,
      }).catch(reportFailure);
    },
    [allHosts, localOrigin],
  );

  return {
    remoteHosts,
    allHosts,
    defaultHostId,
    localOrigin,
    current,
    currentDefaultLabel,
    items,
    statusById,
    probing,
    loading,
    saving,
    switchingHostId,
    error,
    setError,
    load,
    probeAll,
    importPairingLink,
    addManualServer,
    updateServer,
    removeServer,
    setDefaultServer,
    switchToHost,
    openInNewWindow,
  };
};

export type UseDesktopServers = ReturnType<typeof useDesktopServers>;
