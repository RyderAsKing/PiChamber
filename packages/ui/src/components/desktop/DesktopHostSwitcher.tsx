import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { isElectronShell, isDesktopShell } from '@/lib/desktop';
import { Icon } from "@/components/icon/Icon";
import { useUIStore } from '@/stores/useUIStore';
import {
  desktopHostProbe,
  desktopHostsGet,
  desktopHostsSet,
  desktopLocalClientTokenGet,
  desktopOpenNewWindowAtUrl,
  desktopOpenNewWindowForHost,
  getDesktopHostApiUrl,
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
import { adoptRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { createRelayTunnelClient } from '@/lib/relay/tunnel-client';
import { subscribeRuntimeEndpointChanged, switchRuntimeEndpoint } from '@/lib/runtime-switch';

type HostStatus = {
  status: HostProbeResult['status'];
  latencyMs: number;
  /** Which transport the successful probe used (multi-transport hosts). */
  via?: 'relay';
};

// Last known statuses survive the dropdown unmounting (it remounts on every
// open). Rows show the previous result immediately — refreshed quietly by the
// open-probe — instead of shouting "Unknown" at the user for a few seconds.
const lastKnownHostStatuses: Record<string, HostStatus> = {};

type HostDisplayStatus = HostProbeResult['status'] | 'checking' | null;

const toNavigationUrl = (rawUrl: string): string => {
  const normalized = normalizeHostUrl(rawUrl);
  if (!normalized) {
    return rawUrl.trim();
  }

  try {
    const url = new URL(normalized);
    if (!url.pathname.endsWith('/')) {
      url.pathname = `${url.pathname}/`;
    }
    return url.toString();
  } catch {
    return normalized;
  }
};

const getLocalClientToken = async (): Promise<string> => {
  if (!isElectronShell()) return '';
  return desktopLocalClientTokenGet().catch(() => '');
};

const statusDotClass = (status: HostDisplayStatus): string => {
  if (status === 'ok') return 'bg-status-success';
  if (status === 'auth') return 'bg-status-warning';
  if (status === 'update-recommended') return 'bg-status-warning';
  if (status === 'incompatible') return 'bg-status-error';
  if (status === 'wrong-service') return 'bg-status-error';
  if (status === 'unreachable') return 'bg-status-error';
  if (status === 'checking') return 'bg-status-info';
  return 'bg-muted-foreground/40';
};

// Text tone matching statusDotClass, for the per-row status line.
const statusTextClass = (status: HostDisplayStatus): string => {
  if (status === 'ok') return 'text-[var(--status-success)]';
  if (status === 'auth' || status === 'update-recommended') return 'text-[var(--status-warning)]';
  if (status === 'incompatible' || status === 'wrong-service' || status === 'unreachable') return 'text-[var(--status-error)]';
  return 'text-muted-foreground';
};

const isBlockedHostStatus = (status: HostProbeResult['status'] | null): boolean => {
  return status === 'unreachable' || status === 'wrong-service' || status === 'incompatible';
};

const isBlockedDisplayStatus = (status: HostDisplayStatus): boolean => {
  return status === 'unreachable' || status === 'wrong-service' || status === 'incompatible';
};

const statusLabel = (status: HostDisplayStatus): string => {
  if (status === 'ok') return 'Connected';
  if (status === 'auth') return 'Auth required';
  if (status === 'checking') return 'Checking';
  if (status === 'update-recommended') return 'Update recommended';
  if (status === 'incompatible') return 'Incompatible';
  if (status === 'wrong-service') return 'Wrong service';
  if (status === 'unreachable') return 'Unreachable';
  return 'Unknown';
};

type DesktopHostSwitcherDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  embedded?: boolean;
  onHostSwitched?: () => void;
};

export function DesktopHostSwitcherDialog({
  open,
  onOpenChange,
  embedded = false,
  onHostSwitched,
}: DesktopHostSwitcherDialogProps) {
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);

  const [configHosts, setConfigHosts] = React.useState<DesktopHost[]>([]);
  const [defaultHostId, setDefaultHostId] = React.useState<string | null>(null);
  const [statusById, setStatusById] = React.useState<Record<string, HostStatus>>(() => ({ ...lastKnownHostStatuses }));
  React.useEffect(() => {
    Object.assign(lastKnownHostStatuses, statusById);
  }, [statusById]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isProbing, setIsProbing] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [switchingHostId, setSwitchingHostId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string>('');
  const [localOrigin, setLocalOrigin] = React.useState<string>(() => getLocalDesktopOrigin());

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editLabel, setEditLabel] = React.useState('');
  const [editUrl, setEditUrl] = React.useState('');

  const [runtimeEndpointEpoch, setRuntimeEndpointEpoch] = React.useState(0);

  const allHosts = React.useMemo(() => {
    const local = buildLocalDesktopHost(localOrigin);
    const normalizedRemote = configHosts.map((h) => ({
      ...h,
      url: normalizeHostUrl(h.url) || h.url,
    }));
    return [local, ...normalizedRemote];
  }, [configHosts, localOrigin]);

  React.useEffect(() => {
    return subscribeRuntimeEndpointChanged(() => setRuntimeEndpointEpoch((epoch) => epoch + 1));
  }, []);

  const current = React.useMemo(() => {
    void runtimeEndpointEpoch;
    return resolveCurrentDesktopHost(allHosts);
  }, [allHosts, runtimeEndpointEpoch]);
  const currentDefaultLabel = React.useMemo(() => {
    const id = defaultHostId || LOCAL_HOST_ID;
    return allHosts.find((h) => h.id === id)?.label || "Local";
  }, [allHosts, defaultHostId]);

  const persist = React.useCallback(async (nextHosts: DesktopHost[], nextDefaultHostId: string | null) => {
    if (!isDesktopShell()) return;
    setIsSaving(true);
    setError('');
    try {
      const remote = nextHosts.filter((h) => h.id !== LOCAL_HOST_ID);
      await desktopHostsSet({ hosts: remote, defaultHostId: nextDefaultHostId });
      setConfigHosts(remote);
      setDefaultHostId(nextDefaultHostId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setIsSaving(false);
    }
  }, []);

  const openRemoteInstancesSettings = React.useCallback(() => {
    setSettingsPage('remote-instances');
    setSettingsDialogOpen(true);
    onOpenChange(false);
  }, [onOpenChange, setSettingsDialogOpen, setSettingsPage]);

  const refresh = React.useCallback(async () => {
    if (!isDesktopShell()) return;
    setIsLoading(true);
    setError('');
    try {
      const cfg = await desktopHostsGet();
      if (cfg.localOrigin) {
        setLocalOrigin(cfg.localOrigin);
      }
      setConfigHosts(cfg.hosts || []);
      setDefaultHostId(cfg.defaultHostId ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
      setConfigHosts([]);
      setDefaultHostId(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const probeAll = React.useCallback(async (hosts: DesktopHost[]) => {
    if (!isDesktopShell()) return;
    setIsProbing(true);
    try {
      const localClientToken = await getLocalClientToken();
      const results = await Promise.all(
        hosts.map(async (h) => {
          const clientToken = h.id === LOCAL_HOST_ID ? localClientToken : (h.clientToken || '');
          const probeRelayLeg = async (): Promise<HostStatus> => {
            const res = await probeRelayDesktopHost(h.relay!, { clientToken, requestHeaders: h.requestHeaders || null }).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
            return { status: res.status, latencyMs: res.latencyMs, ...(res.status === 'ok' ? { via: 'relay' as const } : {}) };
          };
          // Relay-only host: no HTTP address — probe through the E2EE tunnel.
          if (h.relay && !h.apiUrl) {
            return [h.id, await probeRelayLeg()] as const;
          }
          const url = normalizeHostUrl(isElectronShell() ? getDesktopHostApiUrl(h) : h.url);
          if (!url) {
            return [h.id, { status: 'unreachable' as const, latencyMs: 0 } satisfies HostStatus] as const;
          }
          const res = await desktopHostProbe(url, { clientToken: clientToken || null, requestHeaders: h.requestHeaders || null }).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
          // Multi-transport host away from its network: the direct leg fails
          // but the relay may still reach it.
          if (isBlockedHostStatus(res.status) && h.relay) {
            const relayStatus = await probeRelayLeg();
            if (relayStatus.status === 'ok') return [h.id, relayStatus] as const;
          }
          return [h.id, { status: res.status, latencyMs: res.latencyMs } satisfies HostStatus] as const;
        })
      );
      const next: Record<string, HostStatus> = {};
      for (const [id, val] of results) {
        next[id] = val;
      }
      setStatusById(next);
    } finally {
      setIsProbing(false);
    }
  }, []);

  React.useEffect(() => {
    if (!open) {
      setEditingId(null);
      setEditLabel('');
      setEditUrl('');
      setSwitchingHostId(null);
      setError('');
      return;
    }
    void refresh();
  }, [open, refresh]);

  React.useEffect(() => {
    if (!open) return;
    void probeAll(allHosts);
  }, [open, allHosts, probeAll]);

  const handleSwitch = React.useCallback(async (host: DesktopHost) => {
    // Relay legs ride the E2EE tunnel activated in-renderer via
    // switchRuntimeEndpoint({ relay }); the runtime fetch/socket layers route
    // through the tunnel from the singleton registry.
    const activateRelay = (relay: NonNullable<DesktopHost['relay']>, liveTunnel?: ReturnType<typeof createRelayTunnelClient>) => {
      // Adopt the probe's live tunnel (when it kept one) BEFORE the switch: the
      // activate call inside switchRuntimeEndpoint sees an equal descriptor and
      // reuses it — no second WebSocket connect + E2EE handshake.
      if (liveTunnel) {
        adoptRelayTunnel({ relayUrl: relay.relayUrl, serverId: relay.serverId, hostEncPubJwk: relay.hostEncPubJwk }, liveTunnel);
      }
      switchRuntimeEndpoint({
        apiBaseUrl: typeof window !== 'undefined' ? window.location.origin : '',
        clientToken: host.clientToken || null,
        runtimeKey: runtimeKeyForDesktopHost(host),
        relay,
      });
      // On the relay: learn the server's current LAN address in the background
      // and hot-switch back to direct if the stored one merely went stale.
      scheduleDesktopHostCandidateRefresh(host.id);
    };

    const origin = host.id === LOCAL_HOST_ID ? localOrigin : (normalizeHostUrl(host.url) || '');
    const apiOrigin = host.id === LOCAL_HOST_ID ? localOrigin : (normalizeHostUrl(getDesktopHostApiUrl(host)) || '');
    const relayOnly = Boolean(host.relay) && !host.apiUrl && host.id !== LOCAL_HOST_ID;
    if (!origin && !relayOnly) return;

    if (isElectronShell()) {
      if (!apiOrigin && !host.relay) return;
      setSwitchingHostId(host.id);
      const clientToken = host.id === LOCAL_HOST_ID ? await getLocalClientToken() : (host.clientToken || '');

      // The dropdown already probed every host when it opened — act on that
      // result instead of re-probing (re-probes doubled the switch latency and
      // flashed transient Unreachable states over a known-good host).
      const cached = statusById[host.id];
      if (cached?.status === 'ok') {
        if (cached.via === 'relay' && host.relay) {
          activateRelay(host.relay);
        } else if (apiOrigin) {
          switchRuntimeEndpoint({ apiBaseUrl: apiOrigin, clientToken: clientToken || null, requestHeaders: host.requestHeaders || null, runtimeKey: runtimeKeyForDesktopHost(host) });
        } else if (host.relay) {
          activateRelay(host.relay);
        }
        onHostSwitched?.();
        setSwitchingHostId(null);
        return;
      }

      // No usable probe result — probe now: direct first, relay fallback.
      // Statuses are written once, with the final outcome, so the row never
      // flashes intermediate failures while the fallback is still running.
      let finalStatus: HostStatus = { status: 'unreachable', latencyMs: 0 };
      let transport: 'direct' | 'relay' | null = null;
      if (apiOrigin) {
        const probe = await desktopHostProbe(apiOrigin, { clientToken: clientToken || null, requestHeaders: host.requestHeaders || null }).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
        finalStatus = { status: probe.status, latencyMs: probe.latencyMs };
        if (!isBlockedHostStatus(probe.status)) transport = 'direct';
      }
      let relayProbeTunnel: ReturnType<typeof createRelayTunnelClient> | undefined;
      if (!transport && host.relay) {
        const probe = await probeRelayDesktopHost(host.relay, { keepTunnel: true, clientToken: clientToken || null, requestHeaders: host.requestHeaders || null })
          .catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
        if (probe.status === 'ok') {
          finalStatus = { status: probe.status, latencyMs: probe.latencyMs, via: 'relay' };
          transport = 'relay';
          relayProbeTunnel = 'tunnel' in probe ? probe.tunnel : undefined;
        }
      }
      setStatusById((prev) => ({ ...prev, [host.id]: finalStatus }));

      if (!transport) {
        toast.error(`Instance "${redactSensitiveUrl(host.label)}" is unreachable`);
        setSwitchingHostId(null);
        return;
      }
      if (transport === 'relay' && host.relay) {
        activateRelay(host.relay, relayProbeTunnel);
      } else {
        switchRuntimeEndpoint({ apiBaseUrl: apiOrigin, clientToken: clientToken || null, requestHeaders: host.requestHeaders || null, runtimeKey: runtimeKeyForDesktopHost(host) });
      }
      onHostSwitched?.();
      setSwitchingHostId(null);
      return;
    }

    if (host.id !== LOCAL_HOST_ID && isDesktopShell()) {
      setSwitchingHostId(host.id);
      const probe = await desktopHostProbe(origin, { clientToken: host.clientToken || null, requestHeaders: host.requestHeaders || null }).catch((): HostProbeResult => ({ status: 'unreachable', latencyMs: 0 }));
      setStatusById((prev) => ({
        ...prev,
        [host.id]: { status: probe.status, latencyMs: probe.latencyMs },
      }));

      if (isBlockedHostStatus(probe.status)) {
        toast.error(`Instance "${redactSensitiveUrl(host.label)}" is unreachable`);
        setSwitchingHostId(null);
        return;
      }
    }

    const target = toNavigationUrl(origin);
    onHostSwitched?.();

    try {
      window.location.assign(target);
    } catch {
      window.location.href = target;
    }
  }, [localOrigin, onHostSwitched, statusById]);

  const cancelEdit = React.useCallback(() => {
    setEditingId(null);
    setEditLabel('');
    setEditUrl('');
  }, []);

  const stopDropdownTypeahead = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
  }, []);

  const commitEdit = React.useCallback(async () => {
    if (!editingId) return;
    if (editingId === LOCAL_HOST_ID) {
      cancelEdit();
      return;
    }

    const resolved = resolveDesktopHostUrl(editUrl);
    if (!resolved) {
      setError("Invalid URL (must be http/https)");
      return;
    }
    const url = resolved.persistedUrl;

    const label = (editLabel || redactSensitiveUrl(url)).trim();
    const nextHosts = configHosts.map((h) => (h.id === editingId ? { ...h, label, url, apiUrl: url } : h));
    await persist(nextHosts, defaultHostId);
    cancelEdit();
    if (resolved.redeemUrl) {
      window.location.assign(resolved.redeemUrl);
    }
  }, [cancelEdit, configHosts, defaultHostId, editLabel, editUrl, editingId, persist]);

  const setDefault = React.useCallback(async (id: string) => {
    const next = id === LOCAL_HOST_ID ? LOCAL_HOST_ID : id;
    await persist(configHosts, next);
  }, [configHosts, persist]);

  const openInNewWindow = React.useCallback((host: DesktopHost) => {
    const reportFailure = (err: unknown) => {
      toast.error("Failed to open new window", {
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
    const target = toNavigationUrl(origin);
    desktopOpenNewWindowAtUrl(target, { clientToken: host.clientToken || null, requestHeaders: host.requestHeaders || null }).catch(reportFailure);
  }, [localOrigin]);

  if (!isDesktopShell()) {
    return null;
  }

  const desktopAvailable = isDesktopShell();

  const content = (
    <>
      {embedded ? (
        <div className="flex-shrink-0 border-b border-[var(--interactive-border)] px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex items-baseline gap-1.5 typography-ui-label">
              <span className="font-medium text-foreground">{"Current"}</span>
              <span className="max-w-[9rem] truncate text-muted-foreground">{redactSensitiveUrl(current.label)}</span>
              <span className="text-muted-foreground/50">•</span>
              <span className="font-medium text-foreground">{"Default"}</span>
              <span className="max-w-[9rem] truncate text-muted-foreground">{redactSensitiveUrl(currentDefaultLabel)}</span>
            </div>
            <button
              type="button"
              className={cn(
                'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors',
                'hover:text-foreground hover:bg-interactive-hover',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
              )}
              onClick={() => void probeAll(allHosts)}
              disabled={!desktopAvailable || isLoading || isProbing}
              aria-label={"Refresh instances"}
            >
              <Icon name="refresh" className={cn('h-4 w-4', isProbing && 'animate-spin')} />
            </button>
          </div>
        </div>
      ) : (
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Icon name="server" className="h-5 w-5" />
            {"Instance"}
          </DialogTitle>
          <DialogDescription>
            {"Switch between Local and remote PiChamber servers"}
          </DialogDescription>
        </DialogHeader>
      )}

      {!embedded && (
        <div className="flex items-center justify-between gap-2 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="typography-meta text-muted-foreground">{"Current:"}</span>
            <span className="typography-ui-label text-foreground truncate">{redactSensitiveUrl(current.label)}</span>
            <span className="typography-meta text-muted-foreground">{"Current default:"}</span>
            <span className="typography-ui-label text-foreground truncate">{redactSensitiveUrl(currentDefaultLabel)}</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void probeAll(allHosts)}
              disabled={!desktopAvailable || isLoading || isProbing}
            >
              <Icon name="refresh" className={cn('h-4 w-4', isProbing && 'animate-spin')} />
              {"Refresh"}
            </Button>
          </div>
        </div>
      )}

        {!desktopAvailable && (
          <div className="flex-shrink-0 rounded-lg border border-border/50 bg-muted/20 p-3">
            <div className="typography-meta text-muted-foreground">
              {"Instance switcher is limited on this page. Use Local to recover."}
            </div>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className={cn('space-y-1', embedded && 'space-y-1.5 px-3 py-1')}>
            {isLoading ? (
              <div className="px-2 py-2 text-muted-foreground text-sm">{"Loading..."}</div>
            ) : (
              allHosts.map((host) => {
                const isLocal = host.id === LOCAL_HOST_ID;
                const isActive = host.id === current.id;
                const isDefault = (defaultHostId || LOCAL_HOST_ID) === host.id;
                const status = statusById[host.id] || null;
                // While a probe runs, keep showing the last known result (quiet
                // refresh); only fall back to "Checking" when there has never
                // been one. "Unknown" is never shown — an unprobed host is by
                // definition being checked.
                const statusKind: HostDisplayStatus = status?.status ?? 'checking';
                const isEditing = editingId === host.id;
                const effectiveUrl = isLocal ? localOrigin : (normalizeHostUrl(host.url) || host.url);
                const displayLabel = host.id === LOCAL_HOST_ID
                  ? "Local"
                  : redactSensitiveUrl(host.label);
                // Relay-only hosts have a relay:// pseudo-URL that means nothing
                // to a person — say how the connection works instead. Hosts with
                // a direct leg show their address.
                const displayUrl = host.relay && !host.apiUrl ? "via PiChamber Relay" : redactSensitiveUrl(effectiveUrl);

                return (
                  <div
                    key={host.id}
                    className={cn(
                      'group flex items-center gap-2 px-2.5 py-2 rounded-md overflow-hidden',
                      // Dropdown (embedded): mobile-style card per host; the
                      // active host reads as selected, not just labelled.
                      embedded && 'rounded-xl bg-[var(--surface-muted)] px-3 py-2.5',
                      embedded && isActive && 'bg-[var(--interactive-selection)]/25',
                      isEditing ? 'bg-interactive-hover/20' : 'hover:bg-interactive-hover/30'
                    )}
                  >
                    <button
                      type="button"
                      className={cn(
                        'flex items-center gap-2 flex-1 min-w-0 text-left',
                        isEditing && 'pointer-events-none opacity-70'
                      )}
                      onClick={() => void handleSwitch(host)}
                      disabled={switchingHostId === host.id}
                      aria-label={`Switch to ${displayLabel}`}
                    >
                      <span className={cn('h-2 w-2 rounded-full flex-shrink-0', statusDotClass(statusKind))} />
                      {/* Same reading order as the settings device list: name +
                          badges on the first line, a toned status line under it,
                          then the address. */}
                      <div className="flex-1 min-w-0 space-y-0.5">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="typography-ui-label font-medium truncate text-foreground">
                            {displayLabel}
                          </span>
                          {isActive && (
                            <span className="typography-micro flex-shrink-0 text-muted-foreground bg-muted px-1 rounded leading-none pb-px border border-border/50">
                              {"Current"}
                            </span>
                          )}
                        </div>
                        <div className={cn('typography-micro truncate', statusTextClass(statusKind))}>
                          {statusLabel(statusKind)}
                          {statusKind === 'ok' && typeof status?.latencyMs === 'number'
                            ? ` · ${Math.max(0, Math.round(status.latencyMs))}ms ping`
                            : ''}
                          {status?.via === 'relay' ? ` · ${"Relay"}` : ''}
                        </div>
                        <div className="typography-micro text-muted-foreground/70 truncate font-mono">
                          {displayUrl}
                        </div>
                      </div>
                    </button>

                    <div className="flex items-center gap-2 flex-shrink-0">


                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className={cn(
                              'h-8 w-8 rounded-md inline-flex items-center justify-center hover:bg-interactive-hover transition-colors',
                              isDefault
                                ? 'text-primary hover:text-primary/80'
                                : 'text-muted-foreground/60 hover:text-primary/80',
                            )}
                            onClick={() => void setDefault(host.id)}
                            aria-label={isDefault ? "Default instance" : "Set as default"}
                            disabled={isSaving || (!isDefault && isBlockedDisplayStatus(statusKind))}
                          >
                            {isDefault ? <Icon name="star-fill" className="h-4 w-4" /> : <Icon name="star" className="h-4 w-4" />}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>
                          {isDefault ? "Default" : "Set as default"}
                        </TooltipContent>
                      </Tooltip>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                              className={cn(
                                'h-8 w-8 rounded-md inline-flex items-center justify-center hover:bg-interactive-hover transition-colors',
                                isBlockedDisplayStatus(statusKind)
                                  ? 'text-muted-foreground/30 cursor-not-allowed'
                                  : 'text-muted-foreground/60 hover:text-foreground',
                              )}
                            onClick={(e) => {
                              e.stopPropagation();
                              openInNewWindow(host);
                            }}
                            disabled={isBlockedDisplayStatus(statusKind)}
                            aria-label={"Open in new window"}
                          >
                            <Icon name="window" className="h-4 w-4" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent sideOffset={6}>
                          {isBlockedDisplayStatus(statusKind)
                            ? "Instance unreachable"
                            : "Open in new window"}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {desktopAvailable && editingId && editingId !== LOCAL_HOST_ID && (
          <div className="flex-shrink-0 rounded-lg border border-border/50 bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="typography-ui-label font-medium text-foreground">{"Edit instance"}</div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={cancelEdit} disabled={isSaving}>
                  {"Cancel"}
                </Button>
                <Button type="button" size="sm" onClick={() => void commitEdit()} disabled={isSaving}>
                  {isSaving ? <Icon name="loader-4" className="h-4 w-4 animate-spin" /> : null}
                  {"Save"}
                </Button>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                onKeyDown={stopDropdownTypeahead}
                placeholder={"Label"}
                disabled={isSaving}
              />
              <Input
                value={editUrl}
                onChange={(e) => setEditUrl(e.target.value)}
                onKeyDown={stopDropdownTypeahead}
                placeholder={"https://host:port"}
                disabled={isSaving}
              />
            </div>
          </div>
        )}

        <div className="flex-shrink-0 border-t border-[var(--interactive-border)]">
          <button
            type="button"
            className="w-full flex items-center gap-2 px-2 py-2 text-left text-muted-foreground hover:text-foreground hover:bg-interactive-hover/30 transition-colors"
            onClick={openRemoteInstancesSettings}
          >
            <Icon name="add" className="h-4 w-4" />
            <span className="typography-ui-label">{"Add instance"}</span>
          </button>
        </div>

        {error && (
          <div className="flex-shrink-0 typography-meta text-status-error">{error}</div>
        )}
    </>
  );

  if (embedded) {
    return (
      <div className="w-full max-h-[70vh] flex flex-col overflow-hidden gap-2">
        {content}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(42rem,calc(100vw-2rem))] max-w-none max-h-[70vh] flex flex-col overflow-hidden gap-3">
        {content}
      </DialogContent>
    </Dialog>
  );
}

export function DesktopHostSwitcherInline() {
  const [open, setOpen] = React.useState(false);

  if (!isDesktopShell()) {
    return null;
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-oc-host-switcher
        className="w-full justify-center"
        onClick={() => setOpen(true)}
      >
        <Icon name="server" className="h-4 w-4" />
        {"Switch instance"}
      </Button>
      <DesktopHostSwitcherDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
