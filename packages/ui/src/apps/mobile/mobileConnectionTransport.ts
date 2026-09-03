import { isCapacitorApp } from '@/lib/platform';
import { adoptRelayTunnel, isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { createRelayTunnelClient } from '@/lib/relay/tunnel-client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  getRuntimeApiBaseUrl,
  getRuntimeKey,
  switchRuntimeEndpoint,
} from '@/lib/runtime-switch';
import { recordMobileDiagnostic } from '@/lib/mobile-error-log';
import type { PairingEndpointCandidate } from '@/lib/connectionPayload';
import {
  CANDIDATE_REFRESH_DELAY_MS,
  MOBILE_CONNECT_TIMEOUT_MS,
  MOBILE_FAST_PROBE_TIMEOUT_MS,
  MOBILE_NATIVE_HTTP_TIMEOUT_MS,
  RELAY_CONNECT_TIMEOUT_MS,
  RELAY_RACE_HEADSTART_MS,
  type AutoConnectOutcome,
  type CandidateRefreshResult,
  type ChosenTransport,
  type LiveTransport,
  type MobileFetchResponse,
  type MobileRelayConfig,
  type MobileSavedConnection,
  type MobileSessionStatus,
  type MobileTransportCandidate,
  type ProbeResult,
  type RelayProbeOutcome,
  type RelayProbeResult,
  type ReprobeOutcome,
} from './mobileConnectionTypes';
import {
  directCandidates,
  directCandidatesFromUrl,
  isSameConnectionUrl,
  normalizeConnectionUrl,
  parseRelayConfig,
  readConnections,
  readSecureToken,
  relayCandidateOf,
  relayConnectionRuntimeKey,
  secureTokenKeyOf,
  serializeCandidate,
  upsertMobileConnection,
  migrateLegacyInlineTokens,
} from './mobileConnectionStorage';

export const logDetail = (detail: Record<string, unknown>): string => {
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
};

export const logConnect = (
  step: string,
  detail: Record<string, unknown> = {}
): void => {
  console.info('[mobile-connect]', step, logDetail(detail));
  recordMobileDiagnostic('connect', {
    code: step,
    status: typeof detail.status === 'number' ? detail.status : undefined,
    detail:
      typeof detail.reason === 'string'
        ? detail.reason
        : typeof detail.result === 'string'
          ? detail.result
          : undefined,
  });
};

export const logStorage = (
  step: string,
  detail: Record<string, unknown> = {}
): void => {
  console.info('[mobile-storage]', step, logDetail(detail));
};

export const parseMaybeJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

export const getJsonRequestData = (
  body: BodyInit | null | undefined
): unknown => {
  if (typeof body !== 'string') return body ?? undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
};

export const nativeHttpRequest = async (
  url: string,
  init?: RequestInit
): Promise<MobileFetchResponse | null> => {
  if (!isCapacitorApp()) return null;
  try {
    const { CapacitorHttp } = await import('@capacitor/core');
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const response = await CapacitorHttp.request({
      url,
      method: init?.method || 'GET',
      headers,
      data: getJsonRequestData(init?.body),
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      source: 'native-http',
      json: async () => parseMaybeJson(response.data),
    };
  } catch (error) {
    console.warn(
      '[mobile-connect]',
      'native-http failed',
      logDetail({
        url,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return null;
  }
};

export const browserFetchRequest = async (
  url: string,
  init?: RequestInit
): Promise<MobileFetchResponse | null> => {
  const response = await fetch(url, init).catch((error) => {
    console.warn(
      '[mobile-connect]',
      'browser-fetch failed',
      logDetail({
        url,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return null;
  });
  if (!response) return null;
  return {
    ok: response.ok,
    status: response.status,
    source: 'browser-fetch',
    json: () => response.json(),
  };
};

export const raceWithTimeout = async <T,>(
  timeoutMs: number,
  operation: Promise<T | null>,
  onTimeout?: () => void
): Promise<T | null> => {
  let timeoutId: number | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = window.setTimeout(() => {
      onTimeout?.();
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } catch {
    return null;
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
};

export const requestWithTimeout = async (
  url: string,
  init?: RequestInit,
  options?: { totalTimeoutMs?: number }
): Promise<MobileFetchResponse | null> => {
  const total = options?.totalTimeoutMs ?? MOBILE_CONNECT_TIMEOUT_MS;
  const startedAt = Date.now();
  const native = await raceWithTimeout(
    Math.min(MOBILE_NATIVE_HTTP_TIMEOUT_MS, total),
    nativeHttpRequest(url, init)
  );
  if (native) return native;

  const controller = new AbortController();
  const remainingMs = Math.max(500, total - (Date.now() - startedAt));
  return raceWithTimeout(
    remainingMs,
    browserFetchRequest(url, { ...init, signal: controller.signal }),
    () => controller.abort()
  );
};

export const readSessionStatus = async (
  response: { json: () => Promise<unknown> } | null
): Promise<MobileSessionStatus | null> => {
  if (!response) return null;
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  return {
    authenticated:
      typeof record.authenticated === 'boolean' ? record.authenticated : undefined,
    disabled:
      typeof record.disabled === 'boolean' ? record.disabled : undefined,
    scope: typeof record.scope === 'string' ? record.scope : undefined,
  };
};

export const probeRelaySession = async (
  relay: MobileRelayConfig,
  token?: string,
  grant?: string,
  timeoutMs: number = RELAY_CONNECT_TIMEOUT_MS,
  options?: { keepTunnel?: boolean }
): Promise<RelayProbeResult> => {
  const tunnel = createRelayTunnelClient({
    relayUrl: relay.relayUrl,
    serverId: relay.serverId,
    hostEncPubJwk: relay.hostEncPubJwk,
    ...(grant ? { grant } : {}),
  });
  const finish = (outcome: RelayProbeOutcome): RelayProbeResult => {
    if (outcome === 'ok' && options?.keepTunnel) return { outcome, tunnel };
    tunnel.close();
    return { outcome };
  };
  try {
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const session = await raceWithTimeout(
      timeoutMs,
      tunnel.fetch('/auth/session', { headers }).catch(() => null)
    );
    logConnect('relay:session', {
      ok: session?.ok === true,
      status: session?.status ?? null,
      hasToken: Boolean(token),
    });
    if (!session) return finish('unreachable');
    if (session.status === 401)
      return finish(token ? 'auth-failed' : 'needs-login');
    if (!session.ok && session.status !== 404) return finish('auth-failed');
    const status = await readSessionStatus(session);
    if (status && status.disabled !== true && status.authenticated === false) {
      return finish(token ? 'auth-failed' : 'needs-login');
    }
    return finish('ok');
  } catch (error) {
    tunnel.close();
    throw error;
  }
};

export const switchToRelayRuntime = (
  relay: MobileRelayConfig,
  clientToken: string | null,
  grant?: string,
  runtimeKey?: string,
  liveTunnel?: ReturnType<typeof createRelayTunnelClient>
): void => {
  const apiBaseUrl =
    typeof window !== 'undefined' ? window.location.origin : '';
  const descriptor = {
    relayUrl: relay.relayUrl,
    serverId: relay.serverId,
    hostEncPubJwk: relay.hostEncPubJwk,
    ...(grant ? { grant } : {}),
  };
  if (liveTunnel) {
    adoptRelayTunnel(descriptor, liveTunnel);
  }
  switchRuntimeEndpoint({
    apiBaseUrl,
    clientToken,
    runtimeKey: runtimeKey ?? relayConnectionRuntimeKey(relay),
    relay: descriptor,
  });
};

export const probeConnectionCandidates = async (
  candidates: MobileTransportCandidate[],
  token: string | undefined,
  options?: { fast?: boolean }
): Promise<ProbeResult> => {
  const requestOptions = options?.fast
    ? { totalTimeoutMs: MOBILE_FAST_PROBE_TIMEOUT_MS }
    : undefined;
  const expectedServerId = relayCandidateOf({ candidates })?.serverId ?? null;
  const relayCandidate =
    candidates.find(
      (c): c is Extract<MobileTransportCandidate, { kind: 'relay' }> =>
        c.kind === 'relay'
    ) ?? null;
  const directList = candidates.filter(
    (c): c is Extract<MobileTransportCandidate, { kind: 'direct' }> =>
      c.kind === 'direct'
  );

  const probeDirectChain = async (): Promise<ProbeResult> => {
    for (const candidate of directList) {
      const url = normalizeConnectionUrl(candidate.url) || candidate.url;
      const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
      const health = await requestWithTimeout(
        `${url}/health`,
        { method: 'GET' },
        requestOptions
      );
      if (!health?.ok) continue;
      if (expectedServerId) {
        const payload = await health.json().catch(() => null);
        const reported =
          payload && typeof payload === 'object'
            ? (payload as Record<string, unknown>).serverId
            : null;
        if (
          typeof reported === 'string' &&
          reported &&
          reported !== expectedServerId
        ) {
          logConnect('probe:server-id-mismatch', { url });
          continue;
        }
      }
      const session = await requestWithTimeout(
        `${url}/auth/session`,
        {
          method: 'GET',
          credentials: token ? 'omit' : 'include',
          headers,
        },
        requestOptions
      );
      if (session?.status === 401) return { status: 'needs-login' };
      if (!session || (!session.ok && session.status !== 404)) continue;
      const status = await readSessionStatus(session);
      if (status && status.disabled !== true && status.authenticated === false)
        return { status: 'needs-login' };
      const authDisabled = status?.disabled === true;
      if (
        !token &&
        isCapacitorApp() &&
        !authDisabled &&
        status?.scope !== 'client'
      )
        return { status: 'needs-login' };
      return { status: 'ok', transport: { kind: 'direct', url } };
    }
    return { status: 'unreachable' };
  };

  const probeRelay = async (): Promise<ProbeResult> => {
    if (!relayCandidate) return { status: 'unreachable' };
    const { outcome, tunnel } = await probeRelaySession(
      relayCandidate.relay,
      token,
      undefined,
      options?.fast ? MOBILE_FAST_PROBE_TIMEOUT_MS : undefined,
      { keepTunnel: true }
    );
    if (outcome === 'ok')
      return {
        status: 'ok',
        transport: { kind: 'relay', relay: relayCandidate.relay, tunnel },
      };
    if (outcome === 'needs-login' || outcome === 'auth-failed')
      return { status: 'needs-login' };
    return { status: 'unreachable' };
  };

  if (!relayCandidate) return probeDirectChain();
  if (directList.length === 0) return probeRelay();

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let relayCancelled = false;
    let headstartTimer: number | undefined;
    let directResult: ProbeResult | null = null;
    let relayResult: ProbeResult | null = null;

    const closeUnusedRelayTunnel = (result: ProbeResult | null) => {
      if (result?.status === 'ok' && result.transport.kind === 'relay')
        result.transport.tunnel?.close();
    };
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const startRelayProbe = () => {
      if (relayCancelled || settled) return;
      if (headstartTimer !== undefined) {
        window.clearTimeout(headstartTimer);
        headstartTimer = undefined;
      }
      void probeRelay().then((result) => {
        relayResult = result;
        if (settled || relayCancelled) {
          closeUnusedRelayTunnel(result);
          return;
        }
        if (result.status === 'ok' || result.status === 'needs-login') {
          finish(result);
          return;
        }
        if (directResult) finish(directResult);
      });
    };

    void probeDirectChain().then((result) => {
      directResult = result;
      if (settled) return;
      if (result.status === 'ok' || result.status === 'needs-login') {
        relayCancelled = true;
        if (headstartTimer !== undefined) window.clearTimeout(headstartTimer);
        closeUnusedRelayTunnel(relayResult);
        finish(result);
        return;
      }
      if (relayResult) {
        finish(relayResult);
        return;
      }
      startRelayProbe();
    });

    headstartTimer = window.setTimeout(startRelayProbe, RELAY_RACE_HEADSTART_MS);
  });
};

export const switchToTransport = (
  transport: ChosenTransport,
  token: string | null,
  options?: { runtimeKey?: string; grant?: string }
): void => {
  if (transport.kind === 'relay') {
    switchToRelayRuntime(
      transport.relay,
      token,
      options?.grant,
      options?.runtimeKey,
      transport.tunnel
    );
  } else {
    switchRuntimeEndpoint({
      apiBaseUrl: transport.url,
      clientToken: token,
      runtimeKey: options?.runtimeKey,
    });
  }
  scheduleCandidateRefresh();
};

export const getAutoConnectTargetLabel = (): string | null => {
  const candidate = readConnections()[0];
  return candidate?.label?.trim() ? candidate.label : null;
};

export const autoConnectLastInstance = async (): Promise<AutoConnectOutcome> => {
  await migrateLegacyInlineTokens();
  const candidate = readConnections()[0];
  if (!candidate) return { status: 'no-candidate' };

  let token: string | undefined;
  if (isCapacitorApp()) {
    if (!candidate.hasToken) {
      return { status: 'no-candidate' };
    }
    token = await readSecureToken(secureTokenKeyOf(candidate));
    if (!token) {
      return { status: 'no-candidate' };
    }
  } else {
    token = candidate.clientToken;
    if (!token) return { status: 'no-candidate' };
  }

  const result = await probeConnectionCandidates(candidate.candidates, token, {
    fast: true,
  });
  if (result.status === 'needs-login')
    return { status: 'needs-login', label: candidate.label };
  if (result.status !== 'ok')
    return { status: 'unreachable', label: candidate.label };
  await upsertMobileConnection({
    id: candidate.id,
    label: candidate.label,
    candidates: candidate.candidates,
  });
  switchToTransport(result.transport, token, {
    runtimeKey: secureTokenKeyOf(candidate),
  });
  return { status: 'connected' };
};

export const validateMobileConnectionSession = async (
  input: {
    url: string;
    clientToken?: string | null;
  },
  options?: { fast?: boolean }
): Promise<boolean> => {
  let url = '';
  try {
    url = normalizeConnectionUrl(input.url);
  } catch {
    return false;
  }
  if (!url) return false;

  const token = input.clientToken?.trim() || undefined;
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const requestOptions = options?.fast
    ? { totalTimeoutMs: MOBILE_FAST_PROBE_TIMEOUT_MS }
    : undefined;

  const health = await requestWithTimeout(
    `${url}/health`,
    { method: 'GET', headers },
    requestOptions
  );
  if (!health?.ok) return false;

  const session = await requestWithTimeout(
    `${url}/auth/session`,
    {
      method: 'GET',
      credentials: token ? 'omit' : 'include',
      headers,
    },
    requestOptions
  );
  if (!session || (!session.ok && session.status !== 404)) return false;

  const status = await readSessionStatus(session);
  return !(status && status.disabled !== true && status.authenticated === false);
};

export const establishLiveTransport = async (
  candidates: MobileTransportCandidate[]
): Promise<LiveTransport | null> => {
  const expectedServerId = relayCandidateOf({ candidates })?.serverId ?? null;
  for (const candidate of candidates) {
    if (candidate.kind === 'relay') {
      const tunnel = createRelayTunnelClient(candidate.relay);
      const health = await raceWithTimeout(
        RELAY_CONNECT_TIMEOUT_MS,
        tunnel.fetch('/health').catch(() => null)
      );
      logConnect('establish:relay:health', {
        ok: health?.ok === true,
        status: health?.status ?? null,
      });
      if (health?.ok)
        return { kind: 'relay', relay: candidate.relay, tunnel };
      tunnel.close();
      continue;
    }
    const url = normalizeConnectionUrl(candidate.url) || candidate.url;
    const health = await requestWithTimeout(`${url}/health`, { method: 'GET' });
    logConnect('establish:direct:health', {
      ok: health?.ok === true,
      status: health?.status ?? null,
    });
    if (!health?.ok) continue;
    if (expectedServerId) {
      const payload = await health.json().catch(() => null);
      const reported =
        payload && typeof payload === 'object'
          ? (payload as Record<string, unknown>).serverId
          : null;
      if (
        typeof reported === 'string' &&
        reported &&
        reported !== expectedServerId
      ) {
        logConnect('establish:server-id-mismatch', { url });
        continue;
      }
    }
    return { kind: 'direct', url };
  }
  return null;
};

export const pairingCandidatesToMobile = (
  candidates: PairingEndpointCandidate[]
): MobileTransportCandidate[] =>
  [...candidates]
    .sort((left, right) => {
      const delta = (left.priority ?? 100) - (right.priority ?? 100);
      if (delta !== 0) return delta;
      const rank = (c: PairingEndpointCandidate): number =>
        c.type === 'relay' ? 2 : c.url.startsWith('https://') ? 0 : 1;
      return rank(left) - rank(right);
    })
    .flatMap((c): MobileTransportCandidate[] => {
      if (c.type === 'relay') {
        const relay = parseRelayConfig({
          relayUrl: c.relayUrl,
          serverId: c.serverId,
          hostEncPubJwk: c.hostEncPubJwk,
        });
        return relay ? [{ kind: 'relay', relay }] : [];
      }
      return directCandidatesFromUrl(c.url);
    });

export const validateActiveRuntimeSession = async (
  input: {
    url: string;
    clientToken?: string | null;
  },
  options?: { fast?: boolean }
): Promise<boolean> => {
  if (!isRelayModeActive())
    return validateMobileConnectionSession(input, options);
  const session = await raceWithTimeout(
    options?.fast ? MOBILE_FAST_PROBE_TIMEOUT_MS : RELAY_CONNECT_TIMEOUT_MS,
    runtimeFetch('/auth/session')
      .then((response): Response | null => response)
      .catch(() => null)
  );
  if (!session) return true;
  if (session.status === 401) return false;
  if (!session.ok && session.status !== 404) return true;
  const status = await readSessionStatus(session);
  return !(status && status.disabled !== true && status.authenticated === false);
};

export const transportMatchesCurrentRuntime = (
  transport: ChosenTransport
): boolean =>
  transport.kind === 'relay'
    ? isRelayModeActive()
    : !isRelayModeActive() &&
      isSameConnectionUrl(transport.url, getRuntimeApiBaseUrl());

export const findActiveConnection = (): MobileSavedConnection | null => {
  const runtimeKey = getRuntimeKey();
  if (!runtimeKey) return null;
  return (
    readConnections().find(
      (connection) => secureTokenKeyOf(connection) === runtimeKey
    ) ?? null
  );
};

export const isActiveRuntimeConnection = (
  connection: MobileSavedConnection
): boolean => {
  const runtimeKey = getRuntimeKey();
  return Boolean(runtimeKey) && secureTokenKeyOf(connection) === runtimeKey;
};

export const reprobeActiveConnection = async (): Promise<ReprobeOutcome> => {
  const active = findActiveConnection();
  if (!active) return 'no-connection';

  let token: string | undefined;
  if (isCapacitorApp()) {
    token = active.hasToken
      ? await readSecureToken(secureTokenKeyOf(active))
      : undefined;
  } else {
    token = active.clientToken;
  }
  if (!token) return 'unreachable';

  const currentIndex = active.candidates.findIndex((candidate) =>
    transportMatchesCurrentRuntime(
      candidate.kind === 'relay'
        ? { kind: 'relay', relay: candidate.relay }
        : { kind: 'direct', url: candidate.url }
    )
  );

  const higher =
    currentIndex >= 0
      ? active.candidates.slice(0, currentIndex)
      : active.candidates;
  const better = await probeConnectionCandidates(higher, token, { fast: true });
  if (better.status === 'ok') {
    await upsertMobileConnection({
      id: active.id,
      label: active.label,
      candidates: active.candidates,
    });
    switchToTransport(better.transport, token, {
      runtimeKey: secureTokenKeyOf(active),
    });
    return 'switched';
  }
  if (better.status === 'needs-login') return 'needs-login';

  if (currentIndex >= 0) {
    const stillValid = await validateActiveRuntimeSession(
      { url: getRuntimeApiBaseUrl(), clientToken: token },
      { fast: true }
    );
    if (stillValid) {
      scheduleCandidateRefresh();
      return 'unchanged';
    }
  }

  const lower =
    currentIndex >= 0 ? active.candidates.slice(currentIndex + 1) : [];
  const fallback = await probeConnectionCandidates(lower, token, { fast: true });
  if (fallback.status === 'ok') {
    await upsertMobileConnection({
      id: active.id,
      label: active.label,
      candidates: active.candidates,
    });
    switchToTransport(fallback.transport, token, {
      runtimeKey: secureTokenKeyOf(active),
    });
    return 'switched';
  }
  if (fallback.status === 'needs-login') return 'needs-login';
  return 'unreachable';
};

let candidateRefreshInFlight = false;

export const refreshActiveConnectionCandidates =
  async (): Promise<CandidateRefreshResult> => {
    if (candidateRefreshInFlight) return 'skipped';
    const active = findActiveConnection();
    if (!active) {
      logConnect('candidates:refresh-skip', { reason: 'no-active-connection' });
      return 'skipped';
    }
    const relay = relayCandidateOf(active);
    if (!relay) {
      logConnect('candidates:refresh-skip', { reason: 'no-relay-candidate' });
      return 'skipped';
    }
    candidateRefreshInFlight = true;
    try {
      const response = await raceWithTimeout(
        RELAY_CONNECT_TIMEOUT_MS,
        runtimeFetch('/api/client-auth/connection/candidates')
          .then((r): Response | null => r)
          .catch(() => null)
      );
      if (!response?.ok) {
        logConnect('candidates:refresh-skip', {
          reason: 'fetch-failed',
          status: response?.status ?? null,
        });
        return 'skipped';
      }
      const payload = (await response.json().catch(() => null)) as {
        serverId?: unknown;
        candidates?: unknown;
      } | null;
      if (!payload || payload.serverId !== relay.serverId) {
        logConnect('candidates:refresh-skip', { reason: 'server-id-mismatch' });
        return 'skipped';
      }
      const reported = Array.isArray(payload.candidates)
        ? payload.candidates
        : [];
      const lanUrls: string[] = [];
      for (const entry of reported) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        if (record.type !== 'lan' || typeof record.url !== 'string') continue;
        try {
          const url = normalizeConnectionUrl(record.url);
          if (url && !lanUrls.includes(url)) lanUrls.push(url);
        } catch {
          // invalid URL → drop
        }
      }
      if (lanUrls.length === 0) {
        logConnect('candidates:refresh-skip', { reason: 'no-lan-reported' });
        return 'skipped';
      }
      const preservedHttps = directCandidates(active).filter((candidate) =>
        candidate.url.startsWith('https://')
      );
      const next: MobileTransportCandidate[] = [
        ...lanUrls.map((url): MobileTransportCandidate => ({ kind: 'direct', url })),
        ...preservedHttps,
        { kind: 'relay', relay },
      ];
      const unchanged =
        JSON.stringify(active.candidates.map(serializeCandidate)) ===
        JSON.stringify(next.map(serializeCandidate));
      if (unchanged) return 'unchanged';
      logConnect('candidates:refreshed', { lanCount: lanUrls.length });
      await upsertMobileConnection({
        id: active.id,
        label: active.label,
        candidates: next,
      });
      return 'updated';
    } finally {
      candidateRefreshInFlight = false;
    }
  };

export const scheduleCandidateRefresh = (): void => {
  if (typeof window === 'undefined') return;
  window.setTimeout(() => {
    void (async () => {
      const result = await refreshActiveConnectionCandidates().catch(
        (): CandidateRefreshResult => 'skipped'
      );
      logConnect('candidates:refresh-result', { result });
      if (result === 'updated' && isRelayModeActive()) {
        await reprobeActiveConnection().catch(() => null);
      }
    })();
  }, CANDIDATE_REFRESH_DELAY_MS);
};
