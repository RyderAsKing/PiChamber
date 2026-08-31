import { isElectronShell } from '@/lib/desktop';
import { resolveDesktopHostIdentity, runtimeKeyForDesktopHost } from '@/lib/desktopCurrentHost';
import {
  desktopHostProbe,
  desktopHostsGet,
  desktopHostsSet,
  desktopLocalClientTokenGet,
  getDesktopHostApiUrl,
  locationMatchesHost,
  normalizeHostUrl,
  type DesktopHost,
  type DesktopHostsConfig,
} from '@/lib/desktopHosts';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { getRuntimeBearerTokenSync } from '@/lib/runtime-auth';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';

// Let the post-switch bootstrap traffic settle before the background refresh.
const CANDIDATE_REFRESH_DELAY_MS = 5_000;

// How long the stored direct address keeps startup to itself before the relay
// takes over. A live LAN probe answers well inside this window; a dead one no
// longer stalls startup for the probe's full timeout.
const DIRECT_PROBE_HEADSTART_MS = 1_500;

let candidateRefreshInFlight = false;

/**
 * Background candidate refresh for a relay-connected desktop host: ask the
 * server (over the live authenticated transport) for its CURRENT LAN addresses,
 * update the stored host's direct `apiUrl` if it moved (pairing-time addresses
 * go stale when DHCP reassigns the host machine's IP), then probe the fresh
 * address — identity-gated by the host's pinned relay serverId — and hot-switch
 * relay → direct when it is reachable. The runtime key stays `host:<id>`, so the
 * swap is a transport change, not an instance switch.
 *
 * This rewrites only the direct address of an ALREADY-TRUSTED host, learned from
 * that host itself over the E2EE tunnel pinned to its key — the token and trust
 * boundary are unchanged, so no user confirmation is required. An https apiUrl
 * (stable tunnel hostname) is never overwritten: the DHCP problem does not apply
 * to it and the server does not know its own public hostnames.
 */
export const refreshDesktopHostCandidates = async (hostId: string): Promise<void> => {
  if (!isElectronShell() || candidateRefreshInFlight) return;
  const runtimeKey = `host:${hostId}`;
  // The candidates fetch rides the active runtime's transport — only meaningful
  // while this host IS the active runtime.
  if (getRuntimeKey() !== runtimeKey) return;
  candidateRefreshInFlight = true;
  try {
    const config = await desktopHostsGet().catch(() => null);
    const host = config?.hosts.find((entry) => entry.id === hostId);
    if (!config || !host?.relay) return;
    const currentApiUrl = host.apiUrl ? normalizeHostUrl(host.apiUrl) : null;
    if (currentApiUrl && currentApiUrl.startsWith('https://')) return;

    const response = await runtimeFetch('/api/client-auth/connection/candidates').catch(() => null);
    if (!response?.ok) return;
    const payload = await response.json().catch(() => null) as { serverId?: unknown; candidates?: unknown } | null;
    // Identity gate: the refresh must come from the server this host entry is
    // pinned to; anything else (including old servers without serverId) is ignored.
    if (!payload || payload.serverId !== host.relay.serverId) return;
    const reported = Array.isArray(payload.candidates) ? payload.candidates : [];
    const lanUrls: string[] = [];
    for (const entry of reported) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      if (record.type !== 'lan' || typeof record.url !== 'string') continue;
      const url = normalizeHostUrl(record.url);
      if (url && !lanUrls.includes(url)) lanUrls.push(url);
    }
    // Empty answer (loopback-only bind / scan failure) must not erase a stored
    // address — a stale one only costs a fast failed probe on the next start.
    if (lanUrls.length === 0) return;

    const nextApiUrl = currentApiUrl && lanUrls.includes(currentApiUrl) ? currentApiUrl : lanUrls[0];
    if (nextApiUrl !== currentApiUrl) {
      await desktopHostsSet({
        hosts: config.hosts.map((entry) => (entry.id === hostId ? { ...entry, apiUrl: nextApiUrl } : entry)),
        defaultHostId: config.defaultHostId,
        initialHostChoiceCompleted: config.initialHostChoiceCompleted,
      }).catch(() => undefined);
    }

    // We are on the relay for this host (the refresh call itself proves the
    // tunnel works) — if the fresh direct address answers AND proves the same
    // server identity, hot-switch to it.
    const probe = await desktopHostProbe(nextApiUrl, {
      clientToken: host.clientToken || null,
      requestHeaders: host.requestHeaders || null,
      expectedServerId: host.relay.serverId,
    }).catch(() => ({ status: 'unreachable' as const, latencyMs: 0 }));
    if (probe.status === 'unreachable' || probe.status === 'wrong-service' || probe.status === 'incompatible') return;
    if (getRuntimeKey() !== runtimeKey) return; // user switched away meanwhile
    switchRuntimeEndpoint({
      apiBaseUrl: nextApiUrl,
      clientToken: host.clientToken || null,
      requestHeaders: host.requestHeaders || null,
      runtimeKey,
    });
  } finally {
    candidateRefreshInFlight = false;
  }
};

/** Fire-and-forget wrapper: schedule the refresh after a relay switch settles. */
export const scheduleDesktopHostCandidateRefresh = (hostId: string): void => {
  if (typeof window === 'undefined') return;
  window.setTimeout(() => {
    void refreshDesktopHostCandidates(hostId).catch(() => undefined);
  }, CANDIDATE_REFRESH_DELAY_MS);
};

const resolveRestoreIdentity = (
  config: DesktopHostsConfig,
  targetHostId?: string,
): ReturnType<typeof resolveDesktopHostIdentity> => {
  if (targetHostId) {
    const host = config.hosts.find((entry) => entry.id === targetHostId);
    return host ? { kind: 'host', host } : null;
  }
  const hydrated = resolveDesktopHostIdentity({
    runtimeKey: getRuntimeKey(),
    apiBaseUrl: getRuntimeApiBaseUrl(),
    hosts: config.hosts,
    localOrigin: config.localOrigin,
  });
  if (hydrated) return hydrated;
  if (config.defaultHostId && config.defaultHostId !== 'local') {
    const host = config.hosts.find((entry) => entry.id === config.defaultHostId);
    if (host) return { kind: 'host', host };
  }
  return { kind: 'local' };
};

const applyHostTokenInPlace = (host: DesktopHost, runtimeKey: string): void => {
  const token = host.clientToken || '';
  if (!token || getRuntimeBearerTokenSync() === token) return;
  switchRuntimeEndpoint({
    apiBaseUrl: getRuntimeApiBaseUrl() || getDesktopHostApiUrl(host),
    clientToken: token,
    requestHeaders: host.requestHeaders || null,
    runtimeKey,
    relay: isRelayModeActive() ? host.relay : undefined,
  });
};

/**
 * Reconnect the last desktop runtime before SessionAuthGate runs.
 *
 * Ctrl+R re-hydrates `apiBaseUrl` + `runtimeKey` from
 * `pichamber:lastRuntimeEndpoint.v1`, but the client token is stored in the
 * Electron host config (never localStorage). Without this restore the auth
 * gate probes the last server with the injected/empty bootstrap token and
 * prompts for the password again.
 *
 * When the hydrated runtime already names this host, only the stored token is
 * reapplied — transport stays as the last session left it. A cold start that
 * has not yet selected a runtime still probes relay-capable default hosts
 * (direct first, E2EE fallback).
 *
 * Safe to call unconditionally; it is a no-op outside the Electron shell.
 */
export const restoreDesktopRelayRuntime = async (targetHostId?: string): Promise<void> => {
  if (!isElectronShell()) return;
  const config = await desktopHostsGet().catch(() => null);
  if (!config) return;

  const identity = resolveRestoreIdentity(config, targetHostId);
  if (!identity) return;

  if (identity.kind === 'local') {
    const token = await desktopLocalClientTokenGet();
    if (!token) return;
    const apiBaseUrl = config.localOrigin || getRuntimeApiBaseUrl();
    if (!apiBaseUrl) return;
    if (getRuntimeKey() === 'local' && getRuntimeBearerTokenSync() === token) return;
    switchRuntimeEndpoint({ apiBaseUrl, clientToken: token, runtimeKey: 'local' });
    return;
  }

  const host = identity.host;
  const runtimeKey = runtimeKeyForDesktopHost(host);
  const switchToDirect = (url: string) => {
    switchRuntimeEndpoint({
      apiBaseUrl: url,
      clientToken: host.clientToken || null,
      requestHeaders: host.requestHeaders || null,
      runtimeKey,
    });
  };
  const switchToRelay = () => {
    switchRuntimeEndpoint({
      apiBaseUrl: typeof window !== 'undefined' ? window.location.origin : '',
      clientToken: host.clientToken || null,
      runtimeKey,
      relay: host.relay ?? undefined,
    });
    // On the relay because the stored direct address did not answer (yet) —
    // ask the server for its current LAN address in the background and
    // hot-switch back to direct if it simply moved (DHCP re-lease).
    scheduleDesktopHostCandidateRefresh(host.id);
  };

  if (getRuntimeKey() === runtimeKey) {
    const directUrl = host.apiUrl ? normalizeHostUrl(getDesktopHostApiUrl(host)) : '';
    const onDirect = Boolean(directUrl && locationMatchesHost(getRuntimeApiBaseUrl(), directUrl));
    if (onDirect || !host.relay) {
      applyHostTokenInPlace(host, runtimeKey);
      return;
    }
    switchToRelay();
    return;
  }
  if (!host.relay) {
    const url = getDesktopHostApiUrl(host);
    if (!url) return;
    switchToDirect(url);
    return;
  }

  const directUrl = host.apiUrl ? normalizeHostUrl(getDesktopHostApiUrl(host)) : null;
  if (!directUrl) {
    switchToRelay();
    return;
  }

  // Race the direct probe against a short headstart instead of serializing the
  // full probe timeout in front of the relay fallback: a live LAN answers well
  // inside the window (direct keeps priority); a dead one no longer delays
  // startup — the relay takes over and a late direct success hot-switches back
  // (stable runtimeKey → transport-only swap, same as the candidate refresh).
  const probeOk = (probe: { status: string }) =>
    probe.status !== 'unreachable' && probe.status !== 'wrong-service' && probe.status !== 'incompatible';
  const probePromise = desktopHostProbe(directUrl, {
    clientToken: host.clientToken || null,
    requestHeaders: host.requestHeaders || null,
    // Identity gate: a re-leased LAN address may now belong to a different
    // machine; the probe must not send the token on a serverId mismatch.
    expectedServerId: host.relay.serverId,
  }).catch(() => ({ status: 'unreachable' as const, latencyMs: 0 }));

  const winner = await Promise.race([
    probePromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), DIRECT_PROBE_HEADSTART_MS)),
  ]);
  if (winner) {
    if (probeOk(winner)) {
      switchToDirect(directUrl);
      return;
    }
    switchToRelay();
    return;
  }

  // Headstart expired: connect via relay now; adopt the direct transport if the
  // still-running probe succeeds a moment later.
  switchToRelay();
  void probePromise.then((probe) => {
    if (!probeOk(probe)) return;
    if (getRuntimeKey() !== runtimeKey) return; // user switched away meanwhile
    switchToDirect(directUrl);
  });
};
