import { invokeDesktop, isDesktopShell } from '@/lib/desktop';
import { resolveDesktopHostIdentity } from '@/lib/desktopCurrentHost';
import { desktopHostsGet, desktopHostsSet, normalizeHostUrl } from '@/lib/desktopHosts';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { runtimeIdentityMatches, type RuntimeIdentity } from './sessionAuthGateState';

export const STATUS_CHECK_ENDPOINT = '/auth/session';
export const TRANSIENT_RETRY_MAX_ATTEMPTS = 4;
export const TRANSIENT_RETRY_BASE_DELAY_MS = 1_500;
export const TRUST_DEVICE_STORAGE_KEY = 'pichamber.uiAuth.trustDevice';
export const LOCAL_DESKTOP_CLIENT_KIND = 'desktop-local';
export const LOCAL_DESKTOP_CLIENT_DEDUPE_KEY = 'desktop-local';

export const readLocalOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  const injected = (window as typeof window & { __PICHAMBER_LOCAL_ORIGIN__?: string }).__PICHAMBER_LOCAL_ORIGIN__;
  return typeof injected === 'string' ? injected.trim() : '';
};

export const sameOrigin = (left: string, right: string): boolean => {
  const normalizedLeft = normalizeHostUrl(left);
  const normalizedRight = normalizeHostUrl(right);
  if (!normalizedLeft || !normalizedRight) return false;
  try {
    return new URL(normalizedLeft).origin === new URL(normalizedRight).origin;
  } catch {
    return false;
  }
};

export const shouldIssueDesktopClientToken = (): boolean => {
  return isDesktopShell();
};

export const isLoopbackHostname = (hostname: string): boolean => {
  const clean = hostname.replace(/^\[|\]$/g, '');
  return clean === 'localhost' || clean === '127.0.0.1' || clean === '::1';
};

export const isLocalDesktopRuntime = (): boolean => {
  if (!isDesktopShell()) return false;
  const localOrigin = readLocalOrigin();
  if (!localOrigin) return false;
  const apiBaseUrl = getRuntimeApiBaseUrl();
  const effectiveTarget = apiBaseUrl || (typeof window !== 'undefined' ? window.location.origin : '');
  if (sameOrigin(localOrigin, effectiveTarget)) return true;
  try {
    const normalized = normalizeHostUrl(effectiveTarget);
    return Boolean(normalized && isLoopbackHostname(new URL(normalized).hostname));
  } catch {
    return false;
  }
};

export const desktopClientAuthMetadata = (): { clientKind?: string; dedupeKey?: string } => {
  if (!isLocalDesktopRuntime()) return {};
  return {
    clientKind: LOCAL_DESKTOP_CLIENT_KIND,
    dedupeKey: LOCAL_DESKTOP_CLIENT_DEDUPE_KEY,
  };
};

export const fetchSessionStatus = async (): Promise<Response> => {
  const response = await runtimeFetch(STATUS_CHECK_ENDPOINT, {
    method: 'GET',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
    },
  });
  return response;
};

export const readStoredTrustDevice = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }
  return window.localStorage.getItem(TRUST_DEVICE_STORAGE_KEY) === 'true';
};

export const submitPassword = async (password: string, trustDevice: boolean): Promise<Response> => {
  const issueClientToken = shouldIssueDesktopClientToken();
  const response = await runtimeFetch(STATUS_CHECK_ENDPOINT, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      password,
      trustDevice,
      issueClientToken,
      clientLabel: 'PiChamber Desktop',
      ...desktopClientAuthMetadata(),
    }),
  });
  return response;
};

export const issueDesktopClientToken = async (): Promise<string> => {
  if (!isDesktopShell()) {
    return '';
  }

  const response = await runtimeFetch('/api/client-auth/clients', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ label: 'PiChamber Desktop', ...desktopClientAuthMetadata() }),
  }).catch(() => null);
  if (!response?.ok) {
    return '';
  }

  const payload = await response.json().catch(() => null) as { token?: unknown } | null;
  return typeof payload?.token === 'string' ? payload.token.trim() : '';
};

export const shouldUseDesktopShellPasswordLogin = (): boolean => {
  return isDesktopShell() && !isLocalDesktopRuntime();
};

export const captureRuntimeIdentity = (): RuntimeIdentity => ({
  apiBaseUrl: getRuntimeApiBaseUrl(),
  runtimeKey: getRuntimeKey(),
});

export const isRuntimeIdentityActive = (identity: RuntimeIdentity): boolean => {
  return runtimeIdentityMatches(identity, captureRuntimeIdentity());
};

export type DesktopPasswordLoginResult = {
  token: string;
  status?: number;
};

export const issueDesktopClientTokenViaShell = async (
  password: string,
  trustDevice: boolean,
  runtime: RuntimeIdentity,
  requestHeaders: Record<string, string>,
): Promise<DesktopPasswordLoginResult | null> => {
  if (!isDesktopShell() || typeof window === 'undefined') {
    return null;
  }
  const response = await invokeDesktop('desktop_remote_password_login', {
    url: runtime.apiBaseUrl,
    password,
    trustDevice,
    requestHeaders,
  }).catch(() => null);
  if (!response || typeof response !== 'object') {
    return null;
  }
  const token = (response as { token?: unknown }).token;
  const status = (response as { status?: unknown }).status;
  return {
    token: typeof token === 'string' ? token.trim() : '',
    ...(typeof status === 'number' ? { status } : {}),
  };
};

export const persistDesktopClientToken = async (runtime: RuntimeIdentity, clientToken: string): Promise<boolean> => {
  if (!isDesktopShell() || !clientToken || !isRuntimeIdentityActive(runtime)) return false;
  const cfg = await desktopHostsGet().catch(() => null);
  if (!cfg || !isRuntimeIdentityActive(runtime)) return false;
  const identity = resolveDesktopHostIdentity({
    runtimeKey: runtime.runtimeKey,
    apiBaseUrl: runtime.apiBaseUrl,
    hosts: cfg.hosts,
    localOrigin: cfg.localOrigin,
  });
  if (!identity) return true;
  if (identity.kind === 'local') {
    await desktopHostsSet({
      hosts: cfg.hosts,
      defaultHostId: cfg.defaultHostId,
      initialHostChoiceCompleted: cfg.initialHostChoiceCompleted,
      localClientToken: clientToken,
    }).catch(() => undefined);
    return isRuntimeIdentityActive(runtime);
  }
  if (identity.host.clientToken === clientToken) return true;
  if (!isRuntimeIdentityActive(runtime)) return false;
  await desktopHostsSet({
    hosts: cfg.hosts.map((host) => (host.id === identity.host.id ? { ...host, clientToken } : host)),
    defaultHostId: cfg.defaultHostId,
    initialHostChoiceCompleted: cfg.initialHostChoiceCompleted,
  }).catch(() => undefined);
  return isRuntimeIdentityActive(runtime);
};

export const applyDesktopClientToken = async (
  clientToken: string,
  runtime: RuntimeIdentity,
  requestHeaders: Record<string, string>,
): Promise<boolean> => {
  if (!clientToken || !isRuntimeIdentityActive(runtime)) return false;
  if (!await persistDesktopClientToken(runtime, clientToken)) return false;
  if (!isRuntimeIdentityActive(runtime)) return false;
  switchRuntimeEndpoint({
    apiBaseUrl: runtime.apiBaseUrl,
    clientToken,
    requestHeaders: Object.keys(requestHeaders).length > 0 ? requestHeaders : null,
    runtimeKey: runtime.runtimeKey,
  });
  return true;
};
