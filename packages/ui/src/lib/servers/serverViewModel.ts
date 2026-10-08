/**
 * Shared server view-model: how PiChamber presents "servers" (PiChamber
 * backends the app connects to) on every runtime.
 *
 * Pure TypeScript — no React, no platform imports (not even type imports from
 * platform modules, so this file stays runtime-agnostic and mobile-ready).
 * Callers redact addresses before display by passing a `redactUrl` function;
 * route addresses stored on items are already safe to render.
 *
 * One status vocabulary (`ServerStatus`) replaces the per-surface copies in
 * the desktop switcher and the servers settings page. Adapters translate a
 * runtime-specific saved connection into a `ServerListItem`; desktop ships
 * `desktopHostToServerListItem` below.
 *
 * Mobile adoption (part 2): add a `mobileConnectionToServerListItem`
 * function next to the desktop adapter, in this file or in a mobile-owned
 * module that imports these shared types. A mobile saved connection holds
 * `candidates` (lan/tunnel/tailscale/relay) plus an optional achieved
 * transport from its last probe; map each candidate to a `ServerRoute` with
 * the labels below (direct candidates classified with `classifyDirectRoute`,
 * relay candidates as `{ kind: 'relay', address: null }`), mark the achieved
 * transport as the active route, reuse `probeStatusToServerStatus` and
 * `resolveQuietStatus` for status, reuse `sortServerListItems` for ordering,
 * and set `canOpenInNewWindow: false` (phones have no new window). The shared
 * `ServerRow`/`ServerList`/`AddServerDialog` components consume only
 * `ServerListItem` plus callbacks, so no component changes are needed.
 */

export type ServerStatus =
  | 'checking'
  | 'connected'
  | 'reachable'
  | 'offline'
  | 'sign-in-required'
  | 'update-required'
  | 'update-recommended'
  | 'incompatible'
  | 'wrong-service'
  | 'unknown';

export type ServerRouteKind = 'local' | 'lan' | 'tailscale' | 'relay' | 'tunnel' | 'direct';

export type ServerRoute = {
  kind: ServerRouteKind;
  label: string;
  address: string | null;
};

export type ServerListItem = {
  id: string;
  label: string;
  isCurrent: boolean;
  isDefault: boolean;
  isLocal: boolean;
  routes: ServerRoute[];
  activeRoute: ServerRoute | null;
  status: ServerStatus;
  latencyMs: number | null;
  canEdit: boolean;
  canRemove: boolean;
  canOpenInNewWindow: boolean;
};

export const SERVER_ROUTE_LABELS: Record<ServerRouteKind, string> = {
  local: 'This computer',
  lan: 'Local network',
  tailscale: 'Tailscale',
  relay: 'PiChamber Relay',
  tunnel: 'Tunnel',
  direct: 'Direct',
};

export type ServerStatusTone = 'success' | 'warning' | 'error' | 'info' | 'muted';

export const SERVER_STATUS_META: Record<
  ServerStatus,
  { label: string; tone: ServerStatusTone; description: string }
> = {
  checking: {
    label: 'Checking',
    tone: 'info',
    description: 'Probing the server for reachability.',
  },
  connected: {
    label: 'Connected',
    tone: 'success',
    description: 'The server answered and accepted the saved credential.',
  },
  reachable: {
    label: 'Reachable',
    tone: 'info',
    description: 'The server answered, but sign-in state is not verified.',
  },
  offline: {
    label: 'Offline',
    tone: 'error',
    description: 'The server did not answer.',
  },
  'sign-in-required': {
    label: 'Sign-in required',
    tone: 'warning',
    description: 'The server rejected the saved credential.',
  },
  'update-required': {
    label: 'Update required',
    tone: 'error',
    description: 'The server version is too old to connect.',
  },
  'update-recommended': {
    label: 'Update recommended',
    tone: 'warning',
    description: 'The server works, but a newer version is available.',
  },
  incompatible: {
    label: 'Incompatible',
    tone: 'error',
    description: 'The server version cannot work with this app.',
  },
  'wrong-service': {
    label: 'Wrong service',
    tone: 'error',
    description: 'The address answered, but it is not a PiChamber server.',
  },
  unknown: {
    label: 'Unknown',
    tone: 'muted',
    description: 'This server has not been probed yet.',
  },
};

/**
 * Probe outcomes understood by the shared model. Covers every existing
 * desktop probe result (`ok`, `auth`, `update-recommended`, `incompatible`,
 * `wrong-service`, `unreachable`) plus `update-required` and `reachable`,
 * which current desktop probes never emit but the vocabulary reserves for
 * version gates and unverified reachability (mobile part 2 may use them).
 */
export type ServerProbeStatus =
  | 'ok'
  | 'auth'
  | 'update-required'
  | 'update-recommended'
  | 'incompatible'
  | 'wrong-service'
  | 'unreachable'
  | 'reachable';

export type ServerProbeSnapshot = {
  status: ServerProbeStatus;
  latencyMs: number;
  /** Which transport the successful probe used (multi-transport servers). */
  via?: 'relay';
};

export const probeStatusToServerStatus = (status: ServerProbeStatus): ServerStatus => {
  switch (status) {
    case 'ok':
      return 'connected';
    case 'auth':
      return 'sign-in-required';
    case 'update-required':
      return 'update-required';
    case 'update-recommended':
      return 'update-recommended';
    case 'incompatible':
      return 'incompatible';
    case 'wrong-service':
      return 'wrong-service';
    case 'unreachable':
      return 'offline';
    case 'reachable':
      return 'reachable';
  }
};

export type QuietStatus = {
  status: ServerStatus;
  latencyMs: number | null;
  /** A probe is in flight; keep showing `status`, with a subtle indicator. */
  refreshing: boolean;
};

/**
 * Quiet refresh: while a probe runs, keep showing the last known status with
 * a subtle checking indicator — never flash "Checking…" over a known result.
 * "Unknown" is never shown for a server that is being probed; an unprobed
 * server under probe reads as "Checking".
 */
export const resolveQuietStatus = (
  cached: ServerProbeSnapshot | null | undefined,
  probing: boolean,
): QuietStatus => {
  if (!cached) {
    return { status: probing ? 'checking' : 'unknown', latencyMs: null, refreshing: probing };
  }
  return {
    status: probeStatusToServerStatus(cached.status),
    latencyMs: Math.max(0, Math.round(cached.latencyMs)),
    refreshing: probing,
  };
};

/** Statuses for which switching, defaulting, or opening is pointless. */
export const isServerStatusBlocked = (status: ServerStatus): boolean => {
  return status === 'offline' || status === 'wrong-service' || status === 'incompatible';
};

const hostnameOf = (raw: string): string | null => {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const isPrivateIPv4 = (hostname: string): boolean => {
  return (
    /^10\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname)
  );
};

const isLanHostname = (hostname: string): boolean => {
  if (isPrivateIPv4(hostname)) return true;
  return (
    hostname.endsWith('.local') ||
    hostname.endsWith('.lan') ||
    hostname.endsWith('.home') ||
    hostname.endsWith('.internal')
  );
};

/** Classify a direct HTTP(S) address into a human route kind. */
export const classifyDirectRoute = (rawUrl: string): ServerRouteKind => {
  const hostname = hostnameOf(rawUrl);
  if (!hostname) return 'direct';
  if (hostname.endsWith('.ts.net')) return 'tailscale';
  if (hostname.endsWith('.trycloudflare.com') || hostname.endsWith('.cfargotunnel.com')) {
    return 'tunnel';
  }
  if (isLanHostname(hostname)) return 'lan';
  return 'direct';
};

const makeRoute = (kind: ServerRouteKind, address: string | null): ServerRoute => ({
  kind,
  label: SERVER_ROUTE_LABELS[kind],
  address,
});

export const sameServerRoute = (left: ServerRoute, right: ServerRoute): boolean => {
  return left.kind === right.kind && (left.address || null) === (right.address || null);
};

/** Minimal saved-host shape the desktop adapter reads. Matches DesktopHost. */
export type ServerHostInput = {
  id: string;
  label: string;
  url: string;
  apiUrl?: string | null;
  relay?: { relayUrl: string; serverId: string } | null;
};

export type ServerListItemContext = {
  isCurrent: boolean;
  isDefault: boolean;
  isLocal: boolean;
  probe: ServerProbeSnapshot | null | undefined;
  /** A probe is in flight; resolved status keeps the last known value. */
  probing?: boolean;
  /** Origin of the local server, shown as the local route address. */
  localOrigin?: string | null;
  /** Redact sensitive addresses (tokens, userinfo) before display. */
  redactUrl?: (raw: string) => string;
};

const redact = (redactUrl: ((raw: string) => string) | undefined, raw: string): string => {
  try {
    return redactUrl ? redactUrl(raw) : raw;
  } catch {
    return raw;
  }
};

/**
 * Desktop adapter: saved `DesktopHost` + probe snapshot + selection state →
 * `ServerListItem`. A relay-only server (relay set, no apiUrl) yields a
 * single `{ kind: 'relay', address: null }` route — the `relay://` pseudo-URL
 * never reaches the UI. Hosts with both a direct address and relay
 * configuration yield both routes; the active route follows the last
 * successful probe transport (`via: 'relay'`), and is null until a probe
 * succeeds.
 */
export const desktopHostToServerListItem = (
  host: ServerHostInput,
  ctx: ServerListItemContext,
): ServerListItem => {
  const quiet = resolveQuietStatus(ctx.probe, ctx.probing === true);
  const label = ctx.redactUrl ? redact(ctx.redactUrl, host.label) : host.label;

  let routes: ServerRoute[];
  if (ctx.isLocal) {
    const origin = (ctx.localOrigin || host.apiUrl || host.url || '').trim();
    routes = [makeRoute('local', origin ? redact(ctx.redactUrl, origin) : null)];
  } else if (host.relay && !host.apiUrl) {
    routes = [makeRoute('relay', null)];
  } else {
    const directAddress = redact(ctx.redactUrl, host.apiUrl || host.url);
    const direct: ServerRoute = makeRoute(classifyDirectRoute(host.apiUrl || host.url), directAddress);
    routes = host.relay ? [direct, makeRoute('relay', null)] : [direct];
  }

  let activeRoute: ServerRoute | null = null;
  if (ctx.probe && probeStatusToServerStatus(ctx.probe.status) === 'connected') {
    if (ctx.probe.via === 'relay') {
      activeRoute = routes.find((route) => route.kind === 'relay') || routes[0] || null;
    } else {
      activeRoute = routes.find((route) => route.kind !== 'relay') || routes[0] || null;
    }
  }

  const relayOnly = Boolean(host.relay) && !host.apiUrl && !ctx.isLocal;
  return {
    id: host.id,
    label,
    isCurrent: ctx.isCurrent,
    isDefault: ctx.isDefault,
    isLocal: ctx.isLocal,
    routes,
    activeRoute,
    status: quiet.status,
    latencyMs: quiet.latencyMs,
    // Relay-only servers cannot be edited address-wise (there is no address);
    // they are re-imported instead. Matches the servers page rule.
    canEdit: !ctx.isLocal && !relayOnly,
    canRemove: !ctx.isLocal,
    // Capability flag: desktop can always open another window; phones cannot
    // (mobile sets false). Blocked-status gating happens at render time.
    canOpenInNewWindow: true,
  };
};

/** Current first, then default, then by label. */
export const sortServerListItems = <T extends ServerListItem>(items: T[]): T[] => {
  return [...items].sort(
    (a, b) =>
      Number(b.isCurrent) - Number(a.isCurrent) ||
      Number(b.isDefault) - Number(a.isDefault) ||
      a.label.localeCompare(b.label),
  );
};

/** Display address: active route first, then the first route with an address. */
export const serverDisplayAddress = (item: Pick<ServerListItem, 'routes' | 'activeRoute'>): string | null => {
  if (item.activeRoute?.address) return item.activeRoute.address;
  return item.routes.find((route) => route.address)?.address || null;
};
