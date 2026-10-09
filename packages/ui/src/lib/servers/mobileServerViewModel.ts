/**
 * Mobile adapter for the shared server view-model.
 *
 * A mobile saved connection holds `candidates` (direct and/or relay) plus —
 * for the current connection only — a live transport from the runtime layer.
 * This module maps that shape onto `ServerListItem` so the mobile sheet, the
 * first-run welcome screen, and the mobile servers settings page render the
 * same `ServerList`/`ServerRow`/`AddServerDialog` components as desktop.
 *
 * Runtime-agnostic and pure: no React, no Capacitor, no transport imports.
 * The structural input below matches `MobileSavedConnection` (extra fields
 * are ignored), so callers pass saved connections directly. Live state
 * arrives as a `MobileServerStatusInput`, translated by the caller (see
 * `useMobileServers`) from existing mobile signals:
 *
 * | Mobile live state            | `ServerStatus`      | Notes                                  |
 * |------------------------------|---------------------|----------------------------------------|
 * | connected (direct / relay)   | `connected`         | Active route follows the transport.    |
 * | needs-login (auth-invalid)   | `sign-in-required`  | Pending password/token unlock.         |
 * | unreachable / retrying       | `offline`           | Recovery retrying shows offline.       |
 * | connecting                   | `checking`          | Unprobed row under probe.              |
 * | unknown (never probed)       | `unknown`           | Saved rows are not probed on mobile.   |
 * | background refresh in flight | keeps last status   | Via `probing` (quiet refresh).         |
 *
 * Mobile intentionally never probes saved rows: opening a relay tunnel per
 * row costs radio/battery, so non-current rows stay `unknown` until connected
 * (desktop probes on open; phones do not). One route is emitted per route
 * kind (direct candidates classify with `classifyDirectRoute`, so LAN,
 * Tailscale, and Tunnel candidates each get their own labeled route); the
 * first candidate wins when several share a kind. Relay candidates yield a
 * `{ kind: 'relay', address: null }` route — the `relay://` pseudo-URL never
 * reaches the UI. Mobile has no default server and no new window, so
 * `isDefault` is always false and `canOpenInNewWindow` is always false.
 * `canEdit` follows the existing rule (direct only: relay-only rows are
 * re-paired, not edited); every row is removable.
 */

import {
  classifyDirectRoute,
  resolveQuietStatus,
  SERVER_ROUTE_LABELS,
  type ServerListItem,
  type ServerProbeSnapshot,
  type ServerRoute,
} from './serverViewModel';

/** Structural saved-connection shape; matches `MobileSavedConnection`. */
export type MobileServerConnectionInput = {
  id: string;
  label: string;
  candidates: Array<{ kind: 'direct'; url: string } | { kind: 'relay' }>;
};

export type MobileServerStatusInput =
  | { kind: 'connected'; transport: 'direct' | 'relay'; latencyMs?: number | null }
  | { kind: 'needs-login' }
  | { kind: 'unreachable' }
  | { kind: 'connecting' }
  | { kind: 'unknown' };

export type MobileServerListItemContext = {
  isCurrent: boolean;
  status: MobileServerStatusInput;
  /** A probe/connect is in flight; resolved status keeps the last known value. */
  probing?: boolean;
};

const statusToProbe = (status: MobileServerStatusInput): ServerProbeSnapshot | null => {
  switch (status.kind) {
    case 'connected':
      return { status: 'ok', latencyMs: 0 };
    case 'needs-login':
      return { status: 'auth', latencyMs: 0 };
    case 'unreachable':
      return { status: 'unreachable', latencyMs: 0 };
    case 'connecting':
    case 'unknown':
      return null;
  }
};

export const mobileConnectionToServerListItem = (
  connection: MobileServerConnectionInput,
  ctx: MobileServerListItemContext,
): ServerListItem => {
  const probe = statusToProbe(ctx.status);
  const quiet = resolveQuietStatus(probe, ctx.probing === true);

  // One route per kind; direct candidates classify by address (LAN,
  // Tailscale, Tunnel, Direct) and relay candidates carry no address.
  const routes: ServerRoute[] = [];
  for (const candidate of connection.candidates) {
    if (candidate.kind === 'relay') {
      if (!routes.some((route) => route.kind === 'relay')) {
        routes.push({ kind: 'relay', label: SERVER_ROUTE_LABELS.relay, address: null });
      }
      continue;
    }
    const kind = classifyDirectRoute(candidate.url);
    if (!routes.some((route) => route.kind === kind)) {
      routes.push({ kind, label: SERVER_ROUTE_LABELS[kind], address: candidate.url });
    }
  }

  let activeRoute: ServerRoute | null = null;
  if (ctx.isCurrent && ctx.status.kind === 'connected') {
    activeRoute =
      ctx.status.transport === 'relay'
        ? (routes.find((route) => route.kind === 'relay') ?? null)
        : (routes.find((route) => route.kind !== 'relay') ?? null);
  }

  const hasDirectRoute = routes.some((route) => route.kind !== 'relay');
  return {
    id: connection.id,
    label: connection.label,
    isCurrent: ctx.isCurrent,
    isDefault: false,
    isLocal: false,
    routes,
    activeRoute,
    status: quiet.status,
    // Mobile live state carries no latency signal; never render a bogus 0ms.
    latencyMs:
      ctx.status.kind === 'connected' ? (ctx.status.latencyMs ?? null) : quiet.latencyMs,
    // Relay-only rows have no address to edit — re-pair instead, matching the
    // previous mobile sheet rule (edit affordance hidden for relay-only).
    canEdit: hasDirectRoute,
    canRemove: true,
    // Phones have no new window.
    canOpenInNewWindow: false,
  };
};
