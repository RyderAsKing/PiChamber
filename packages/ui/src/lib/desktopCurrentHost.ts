import {
  getDesktopHostApiUrl,
  locationMatchesHost,
  normalizeHostUrl,
  redactSensitiveUrl,
  type DesktopHost,
} from '@/lib/desktopHosts';
import { getRuntimeApiBaseUrl, getRuntimeKey } from '@/lib/runtime-switch';

/**
 * Which configured instance the window is actually talking to.
 *
 * This lives outside the host switcher because the header names the same
 * instance on its button. When the header carried its own copy of the matching
 * rules it was missing the relay branch, so a relay instance — whose API base
 * is the window origin and therefore matches no host URL — fell through to the
 * word "Instance" while the switcher two clicks away named it correctly.
 */

export const LOCAL_HOST_ID = 'local';

export const buildLocalDesktopHost = (localOrigin?: string | null): DesktopHost => ({
  id: LOCAL_HOST_ID,
  label: 'Local',
  url: localOrigin || getLocalDesktopOrigin(),
});

export const getLocalDesktopOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  return window.__PICHAMBER_LOCAL_ORIGIN__ || window.location.origin;
};

export const runtimeKeyForDesktopHost = (host: DesktopHost): string => {
  if (host.id === LOCAL_HOST_ID) return 'local';
  return `host:${host.id}`;
};

const DESKTOP_HOST_RUNTIME_KEY_PREFIX = 'host:';

export type DesktopHostIdentity =
  | { kind: 'local' }
  | { kind: 'host'; host: DesktopHost };

/**
 * Map the active runtime onto a saved desktop host. Prefer the stable
 * `host:<id>` key (relay hosts share the window origin, so URL matching cannot
 * tell them apart), then the API URL, then the local origin.
 */
export const resolveDesktopHostIdentity = (options: {
  runtimeKey: string;
  apiBaseUrl: string;
  hosts: DesktopHost[];
  localOrigin?: string | null;
}): DesktopHostIdentity | null => {
  const runtimeKey = options.runtimeKey.trim();
  if (runtimeKey === LOCAL_HOST_ID) return { kind: 'local' };
  if (runtimeKey.startsWith(DESKTOP_HOST_RUNTIME_KEY_PREFIX)) {
    const hostId = runtimeKey.slice(DESKTOP_HOST_RUNTIME_KEY_PREFIX.length);
    const host = options.hosts.find((entry) => entry.id === hostId);
    if (host) return { kind: 'host', host };
  }

  const remoteMatch = options.hosts.find((host) => (
    options.apiBaseUrl ? locationMatchesHost(options.apiBaseUrl, getDesktopHostApiUrl(host)) : false
  ));
  if (remoteMatch) return { kind: 'host', host: remoteMatch };

  if (options.localOrigin && options.apiBaseUrl && locationMatchesHost(options.apiBaseUrl, options.localOrigin)) {
    return { kind: 'local' };
  }
  return null;
};

type ResolvedDesktopHost = {
  id: string;
  label: string;
  url: string;
};

export const resolveCurrentDesktopHost = (hosts: DesktopHost[]): ResolvedDesktopHost => {
  const currentHref = typeof window === 'undefined' ? '' : window.location.href;
  const localOrigin = hosts.find((host) => host.id === LOCAL_HOST_ID)?.url || getLocalDesktopOrigin();
  const runtimeApiBaseUrl = getRuntimeApiBaseUrl();
  const normalizedLocal = normalizeHostUrl(localOrigin) || localOrigin;
  const normalizedCurrent = normalizeHostUrl(currentHref) || currentHref;

  // Relay hosts share the window origin as their (virtual) API base, so URL
  // matching can't distinguish them — identify the active relay host by its
  // stable runtime key instead.
  const activeRuntimeKey = getRuntimeKey();
  const relayMatch = hosts.find((host) => host.relay && runtimeKeyForDesktopHost(host) === activeRuntimeKey);
  if (relayMatch) {
    return { id: relayMatch.id, label: relayMatch.label, url: relayMatch.url };
  }

  if (runtimeApiBaseUrl && locationMatchesHost(runtimeApiBaseUrl, localOrigin)) {
    return { id: LOCAL_HOST_ID, label: 'Local', url: normalizedLocal };
  }

  const runtimeMatch = hosts.find((host) => (
    runtimeApiBaseUrl ? locationMatchesHost(runtimeApiBaseUrl, getDesktopHostApiUrl(host)) : false
  ));

  if (runtimeMatch) {
    return {
      id: runtimeMatch.id,
      label: runtimeMatch.label,
      url: normalizeHostUrl(getDesktopHostApiUrl(runtimeMatch)) || getDesktopHostApiUrl(runtimeMatch),
    };
  }

  if (currentHref && locationMatchesHost(currentHref, localOrigin)) {
    return { id: LOCAL_HOST_ID, label: 'Local', url: normalizedLocal };
  }

  const match = hosts.find((host) => (currentHref ? locationMatchesHost(currentHref, host.url) : false));

  if (match) {
    return { id: match.id, label: match.label, url: normalizeHostUrl(match.url) || match.url };
  }

  if (currentHref.startsWith('pichamber-ui://')) {
    return { id: LOCAL_HOST_ID, label: 'Local', url: normalizedLocal };
  }

  // Nothing configured matches. Naming the address is still more use than the
  // bare word "Instance"; the redaction strips anything credential-shaped.
  return {
    id: 'custom',
    label: redactSensitiveUrl(normalizedCurrent || 'Instance'),
    url: normalizedCurrent,
  };
};
