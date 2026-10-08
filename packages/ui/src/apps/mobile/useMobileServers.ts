/**
 * Mobile servers hook: the mobile counterpart to `useDesktopServers`.
 *
 * Wraps the existing mobile connection APIs (`useMobileConnection` for
 * list/connect/edit/remove, the transport core for live signals) WITHOUT
 * changing their semantics, and maps the result onto shared `ServerListItem`
 * rows via `mobileConnectionToServerListItem`. Transport behavior is
 * preserved: connect/switch goes through the existing `connect(...)` path
 * (with candidate racing), edit keeps the direct-only rule and preserves
 * relay/HTTPS candidates, remove deletes secure storage, and removing the
 * active (or last) connection drops back to the connect screen through
 * `onActiveConnectionDeleted` — exactly like the previous sheet.
 *
 * Status model (no new polling): rows derive from existing live signals —
 * the active runtime connection, the relay-mode flag, the pending
 * password-unlock connection, the per-row connecting flag, and the recovery
 * uncertainty flag. Saved non-current rows are intentionally `unknown`
 * (mobile never probes rows speculatively; see the adapter docs).
 * Concurrent connects to the same server collapse through the shared
 * `probeDedupe` keyed per connection id, so the sheet and the settings page
 * (both mounted through this hook) share one probe race instead of two.
 */

import * as React from 'react';

import { useMobileConnection, type MobileConnectInput } from '../mobileConnections';
import { readConnections } from './mobileConnectionStorage';
import type { MobileSavedConnection } from './mobileConnectionTypes';
import { isActiveRuntimeConnection } from './mobileConnectionTransport';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { sharedProbeDeduper } from '@/lib/servers/probeDedupe';
import {
  mobileConnectionToServerListItem,
  type MobileServerStatusInput,
} from '@/lib/servers/mobileServerViewModel';
import { sortServerListItems, type ServerListItem } from '@/lib/servers/serverViewModel';
import { useMobileConnectionUncertain } from './mobileRecoveryStatus';

export type UseMobileServersOptions = {
  onConnected: () => void;
  /** Drop back to the connect screen (explicit disconnect + recovery cancel). */
  onActiveConnectionDeleted: () => void;
};

/**
 * Pure fallback decision, extracted for tests: removing the active
 * connection — or the last remaining one — must leave the connect screen,
 * never a stale unbacked UI.
 */
export const shouldLeaveToConnectScreen = (args: {
  wasLast: boolean;
  wasActive: boolean;
}): boolean => args.wasLast || args.wasActive;

/**
 * Translate existing mobile live signals into the adapter's status input.
 * Precedence: explicit unlock beats everything, then the in-flight connect,
 * then the live current-connection state.
 */
export const resolveMobileServerStatus = (args: {
  isCurrent: boolean;
  relayActive: boolean;
  needsLogin: boolean;
  connecting: boolean;
  uncertain: boolean;
}): MobileServerStatusInput => {
  if (args.needsLogin) return { kind: 'needs-login' };
  if (args.connecting) return { kind: 'connecting' };
  if (args.isCurrent) {
    if (args.uncertain) return { kind: 'unreachable' };
    return { kind: 'connected', transport: args.relayActive ? 'relay' : 'direct' };
  }
  return { kind: 'unknown' };
};

export type MobileServerConnectionStore = {
  connections: MobileSavedConnection[];
  connect: (input: MobileConnectInput) => Promise<void>;
  removeConnection: (id: string) => Promise<MobileSavedConnection | null>;
};

/**
 * Connect orchestration with explicit store dependency (the hook wires the
 * real `useMobileConnection` value; tests inject a recording fake). Returns
 * false for an unknown id without touching the transport.
 */
export const connectMobileServerRecord = async (
  store: MobileServerConnectionStore,
  id: string,
): Promise<boolean> => {
  const target = store.connections.find((connection) => connection.id === id);
  if (!target) return false;
  await store.connect({
    id: target.id,
    candidates: target.candidates,
    clientToken: target.clientToken,
    label: target.label,
  });
  return true;
};

/**
 * Remove orchestration with explicit dependencies (the hook wires the real
 * connection value plus fresh storage reads; tests inject fakes). Reads the
 * list fresh from storage so a stale render closure cannot misjudge the
 * last-connection case, then fires the connect-screen fallback exactly when
 * the removed row was the last one or the active runtime connection.
 */
export const removeMobileServerRecord = async (
  store: MobileServerConnectionStore & {
    readConnectionCount: () => number;
    isActive: (connection: MobileSavedConnection) => boolean;
  },
  id: string,
  onActiveConnectionDeleted: () => void,
): Promise<boolean> => {
  const wasLast = store.readConnectionCount() <= 1;
  const removed = await store.removeConnection(id);
  if (!removed) return false;
  if (shouldLeaveToConnectScreen({ wasLast, wasActive: store.isActive(removed) })) {
    onActiveConnectionDeleted();
  }
  return true;
};

/** Per-connection single-flight key for the shared probe deduper. */
const mobileConnectDedupeKey = (id: string): string => `mobile-connect:${id}`;

/**
 * Run a connect through the shared probe deduper so concurrent connects to
 * the same server (sheet + settings page) share one candidate-racing probe
 * instead of firing parallel races. Rejections clear the key via the
 * deduper's finally, so a failed attempt never blocks a later retry.
 */
export const dedupedMobileConnect = <T,>(id: string, run: () => Promise<T>): Promise<T> =>
  sharedProbeDeduper(mobileConnectDedupeKey(id), run);

export type UseMobileServers = {
  items: ServerListItem[];
  connections: MobileSavedConnection[];
  isBusy: boolean;
  isPasswordBusy: boolean;
  error: string | null;
  pendingConnection: ReturnType<typeof useMobileConnection>['pendingConnection'];
  connectingId: string | null;
  conn: ReturnType<typeof useMobileConnection>;
  connectServer: (id: string) => Promise<boolean>;
  removeServer: (id: string) => Promise<boolean>;
};

export function useMobileServers(options: UseMobileServersOptions): UseMobileServers {
  const { onConnected, onActiveConnectionDeleted } = options;
  const conn = useMobileConnection(onConnected);
  const uncertain = useMobileConnectionUncertain();
  const [connectingId, setConnectingId] = React.useState<string | null>(null);
  const relayActive = isRelayModeActive();
  const deletedRef = React.useRef(onActiveConnectionDeleted);
  deletedRef.current = onActiveConnectionDeleted;
  const connRef = React.useRef(conn);
  connRef.current = conn;

  const connectServer = React.useCallback(async (id: string): Promise<boolean> => {
    const known = connRef.current.connections.some((connection) => connection.id === id);
    if (!known) return false;
    setConnectingId(id);
    try {
      // Collapse concurrent taps/surfaces for the same server into one
      // candidate race; a second id still races independently.
      await dedupedMobileConnect(id, () => connectMobileServerRecord(connRef.current, id));
      return true;
    } finally {
      setConnectingId((current) => (current === id ? null : current));
    }
  }, []);

  const removeServer = React.useCallback(async (id: string): Promise<boolean> => {
    return removeMobileServerRecord(
      {
        connections: connRef.current.connections,
        connect: connRef.current.connect,
        removeConnection: connRef.current.removeConnection,
        readConnectionCount: () => readConnections().length,
        isActive: (connection) => isActiveRuntimeConnection(connection),
      },
      id,
      () => deletedRef.current(),
    );
  }, []);

  const pendingId = conn.pendingConnection?.id ?? null;
  const items = React.useMemo<ServerListItem[]>(() => {
    const resolved = conn.connections.map((connection) =>
      mobileConnectionToServerListItem(connection, {
        isCurrent: isActiveRuntimeConnection(connection),
        status: resolveMobileServerStatus({
          isCurrent: isActiveRuntimeConnection(connection),
          relayActive,
          needsLogin: pendingId !== null && pendingId === connection.id,
          connecting: connectingId !== null && connectingId === connection.id,
          uncertain,
        }),
        probing: connectingId !== null && connectingId === connection.id,
      }),
    );
    return sortServerListItems(resolved);
  }, [conn.connections, connectingId, pendingId, relayActive, uncertain]);

  return {
    items,
    connections: conn.connections,
    isBusy: conn.isBusy,
    isPasswordBusy: conn.isPasswordBusy,
    error: conn.error,
    pendingConnection: conn.pendingConnection,
    connectingId,
    conn,
    connectServer,
    removeServer,
  };
}
