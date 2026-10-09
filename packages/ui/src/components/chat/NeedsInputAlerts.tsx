/* eslint-disable react-refresh/only-export-components */
import React from 'react';

import { getPiSessionStore, subscribePendingInputTransitions, type PendingInputTransition } from '@/apps/pi-session-store';
import { toast } from '@/components/ui';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { isDesktopShell } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { getSessionDisplayTitle } from '@/lib/chat/sessionTitle';
import { toClientTimestamp } from '@/lib/pi/server-clock';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';
import { dispatchInputNeededNotification, inputNeededNotificationTag } from '@/sync/notification-store';
import { liveSessionRecordToUiSession, selectSessionsNeedingInput } from '@/sync/pi-session-catalog';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { useSessionsNeedingInput } from '@/sync/sync-context';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { PiPendingInputSummary } from '@/lib/pi/protocol';
import { TOPIC_CATALOG } from '@/sync/pi-session-store-types';
import { decideInputAlert, PENDING_INPUT_TOAST_ID_PREFIX } from './inputAlertDecision';
import type { InputAlertContext } from './inputAlertDecision';

/**
 * Needs-input alerts and attention badges.
 *
 * A daemon `session.input` transition (`opened`) surfaces a shared warning
 * toast, plus a local OS notification when the app is hidden/unfocused (or
 * the user asked to always be notified). Only the fixed title plus the
 * session title are ever sent — never dialog titles, fields, or notice
 * text. `cleared` (and opening the session) dismisses both surfaces.
 *
 * Mounted once in the full app shell (`App.tsx`) and in `MobileApp.tsx`;
 * never in `ElectronMiniChatApp` (it would duplicate alerts). On native
 * Capacitor the notifications API is a deliberate no-op, so only toasts
 * happen there.
 */

const toastIdForSession = (sessionId: string): string => `${PENDING_INPUT_TOAST_ID_PREFIX}${sessionId}`;

const alertTitleForKind = (kind: PiPendingInputSummary['kind']): string =>
  kind === 'approval' ? 'Approval needed' : 'Input needed';

const displayTitleForSession = (sessionId: string): string => {
  const record = getPiSessionStore().getState().catalog.byId.get(sessionId);
  if (!record) return 'Untitled session';
  return getSessionDisplayTitle(liveSessionRecordToUiSession(record), 'Untitled session');
};

const readAlertContext = (
  sessionId: string,
  pending: PiPendingInputSummary,
  serverNow?: number,
): InputAlertContext => {
  const isCurrent = useSessionUIStore.getState().currentSessionId === sessionId;
  const visible = typeof document !== 'undefined' && document.visibilityState === 'visible';
  let focused = false;
  try {
    focused = typeof document !== 'undefined' && document.hasFocus();
  } catch {
    focused = false;
  }
  const mode = useUIStore.getState().notificationMode;
  const clientNow = Date.now();
  // `since` is a server timestamp: resolve it against the event's server
  // clock sample so client/server skew cannot suppress a fresh request.
  // Without the sample (older server) this falls back to the raw difference
  // and the decision clamps small negative ages to fresh.
  const resolvedSince = toClientTimestamp(pending.since, serverNow, clientNow) ?? pending.since;
  return {
    isCurrent,
    visible,
    focused,
    mode: mode === 'always' ? 'always' : 'hidden-only',
    ageMs: clientNow - resolvedSince,
  };
};

const navigateToSession = (sessionId: string, directory: string | null): void => {
  void useSessionUIStore.getState().setCurrentSession(sessionId, directory);
};

const showInputToast = (
  sessionId: string,
  directory: string,
  pending: PiPendingInputSummary,
  label: string,
): void => {
  toast.warning(alertTitleForKind(pending.kind), {
    id: toastIdForSession(sessionId),
    description: label,
    duration: Infinity,
    action: {
      label: 'Open session',
      onClick: () => navigateToSession(sessionId, directory || null),
    },
  });
};

/** A raised toast plus the session label it currently shows. */
interface RaisedToast {
  directory: string;
  pending: PiPendingInputSummary;
  label: string;
}

/**
 * Raised toasts whose session label changed since they were shown. A
 * session first learned from its `session.input` event has no title or
 * message count yet, so the toast opens with the generic fallback; the
 * metadata backfill then resolves the real label (for example "Awaiting
 * first prompt"), and the toast must follow so every surface agrees.
 */
export const selectRelabeledAlertToasts = (
  raised: ReadonlyMap<string, { label: string }>,
  labelFor: (sessionId: string) => string,
): Array<[sessionId: string, label: string]> => {
  const changed: Array<[string, string]> = [];
  for (const [sessionId, entry] of raised) {
    const label = labelFor(sessionId);
    if (label !== entry.label) changed.push([sessionId, label]);
  }
  return changed;
};

/** One catalog row read for stale-alert reconciliation. */
interface NeedingAlertCatalogEntry {
  /** False when the session row no longer exists. */
  exists: boolean;
  /** Non-null while needing, `null` when known clear, `undefined` when unknown. */
  pendingInput: PiPendingInputSummary | null | undefined;
}

/**
 * Raised sessions the authoritative catalog no longer reports as needing
 * input. Only a known `null` dismisses the toast and OS notification:
 * unknown (`undefined`) is not cleared, and a missing row is left alone
 * because directory listings can drop rows without the session ending
 * (real deletions already emit `cleared` through the deletion path). Non-live paths
 * (global refetch, list rows, snapshots, details, epoch resets) never emit
 * transitions, so without this the alert surfaces would linger forever.
 */
export const selectStaleNeedingAlertSessions = (
  raisedSessionIds: readonly string[],
  needingSessionIds: ReadonlySet<string>,
  lookup: (sessionId: string) => NeedingAlertCatalogEntry,
): string[] => {
  const stale: string[] = [];
  for (const sessionId of raisedSessionIds) {
    if (needingSessionIds.has(sessionId)) continue;
    const entry = lookup(sessionId);
    if (entry.exists && entry.pendingInput === null) stale.push(sessionId);
  }
  return stale;
};

export const NeedsInputAlerts: React.FC = () => {
  // Opening the session clears its alert surfaces (the dock strip takes over).
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  // sessionId -> raised OS notification tag, so `cleared` can close it.
  const raisedTagsRef = React.useRef(new Map<string, string>());
  // Every toast id this mount raised, so unmount/runtime-switch can clear them.
  const raisedToastsRef = React.useRef(new Set<string>());
  // sessionId -> open toast content, so a late-resolving label updates it.
  const toastContentRef = React.useRef(new Map<string, RaisedToast>());

  const dismissSessionAlert = React.useCallback((sessionId: string) => {
    const toastId = toastIdForSession(sessionId);
    raisedToastsRef.current.delete(toastId);
    toastContentRef.current.delete(sessionId);
    toast.dismiss(toastId);
    const tag = raisedTagsRef.current.get(sessionId);
    if (tag !== undefined) {
      raisedTagsRef.current.delete(sessionId);
      const close = getRegisteredRuntimeAPIs()?.notifications?.close;
      if (close) {
        void close(tag).catch(() => undefined);
      }
    }
  }, []);

  const dismissAllAlerts = React.useCallback(() => {
    for (const toastId of raisedToastsRef.current) {
      toast.dismiss(toastId);
    }
    raisedToastsRef.current.clear();
    toastContentRef.current.clear();
    const close = getRegisteredRuntimeAPIs()?.notifications?.close;
    if (close) {
      for (const tag of raisedTagsRef.current.values()) {
        void close(tag).catch(() => undefined);
      }
    }
    raisedTagsRef.current.clear();
  }, []);

  // Live transitions only — the store never fires for list/snapshot/detail/epoch.
  React.useEffect(() => subscribePendingInputTransitions((transition: PendingInputTransition) => {
    if (transition.type === 'cleared' || !transition.pending) {
      dismissSessionAlert(transition.sessionId);
      return;
    }
    const pending = transition.pending;
    const decision = decideInputAlert(readAlertContext(transition.sessionId, pending, transition.serverNow));
    if (decision === 'none') return;
    const label = displayTitleForSession(transition.sessionId);
    raisedToastsRef.current.add(toastIdForSession(transition.sessionId));
    toastContentRef.current.set(transition.sessionId, { directory: transition.directory, pending, label });
    showInputToast(transition.sessionId, transition.directory, pending, label);
    if (decision === 'toast-and-notify') {
      const tag = inputNeededNotificationTag(transition.sessionId, pending.since);
      raisedTagsRef.current.set(transition.sessionId, tag);
      dispatchInputNeededNotification({
        sessionId: transition.sessionId,
        directory: transition.directory,
        since: pending.since,
        kind: pending.kind,
        title: label,
      });
    }
  }), [dismissSessionAlert]);

  // Keep open toasts' session labels in step with the catalog. Re-showing
  // with the same id updates the toast in place. (An OS notification that
  // was already delivered keeps its original text.)
  React.useEffect(() => getPiSessionStore().subscribe(() => {
    if (toastContentRef.current.size === 0) return;
    for (const [sessionId, label] of selectRelabeledAlertToasts(toastContentRef.current, displayTitleForSession)) {
      const entry = toastContentRef.current.get(sessionId);
      if (!entry) continue;
      toastContentRef.current.set(sessionId, { ...entry, label });
      showInputToast(sessionId, entry.directory, entry.pending, label);
    }
  }, TOPIC_CATALOG), []);

  // The user opened the session: the dock strip owns it now.
  React.useEffect(() => {
    if (currentSessionId) dismissSessionAlert(currentSessionId);
  }, [currentSessionId, dismissSessionAlert]);

  // Pending state can also clear through non-live paths — the global
  // pending-input refetch, list rows, snapshots, details, or an epoch
  // reset — which never emit transitions by design. Reconcile every raised
  // alert against the authoritative catalog set so those toasts and OS
  // notifications cannot linger forever. Only a known `null` dismisses.
  const needing = useSessionsNeedingInput();
  React.useEffect(() => {
    const needingIds = new Set(needing.map((entry) => entry.sessionId));
    const raised = new Set<string>(raisedTagsRef.current.keys());
    for (const toastId of raisedToastsRef.current) {
      if (toastId.startsWith(PENDING_INPUT_TOAST_ID_PREFIX)) {
        raised.add(toastId.slice(PENDING_INPUT_TOAST_ID_PREFIX.length));
      }
    }
    if (raised.size === 0) return;
    const catalog = getPiSessionStore().getState().catalog;
    const stale = selectStaleNeedingAlertSessions([...raised], needingIds, (sessionId) => {
      const record = catalog.byId.get(sessionId);
      return record
        ? { exists: true, pendingInput: record.pendingInput }
        : { exists: false, pendingInput: undefined };
    });
    for (const sessionId of stale) dismissSessionAlert(sessionId);
  }, [needing, dismissSessionAlert]);

  // Runtime switch and unmount: never leave another runtime's toasts up.
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
    dismissAllAlerts();
  }), [dismissAllAlerts]);

  React.useEffect(() => () => {
    dismissAllAlerts();
  }, [dismissAllAlerts]);

  return null;
};

/**
 * Drives the attention badge surfaces from the needing-input count:
 * the runtime badge (`NotificationsAPI.setAttentionCount` — web app badge,
 * Electron dock badge) and, for non-desktop browsers, the `(N)` document
 * title prefix. Electron's dock badge covers the desktop case and native
 * Capacitor has no badge surface, so the title prefix skips both.
 *
 * Mount alongside `NeedsInputAlerts` in the full app and `MobileApp`.
 */
export const NeedsInputBadge: React.FC = () => {
  const needing = useSessionsNeedingInput();
  const count = needing.length;
  const dockBadgeEnabled = useUIStore((state) => state.dockBadgeEnabled);

  React.useEffect(() => {
    // The dock-badge setting gates the desktop surface (send 0 when
    // disabled); other runtimes always reflect the true count.
    const effective = isDesktopShell() && !dockBadgeEnabled ? 0 : count;
    try {
      getRegisteredRuntimeAPIs()?.notifications?.setAttentionCount?.(effective);
    } catch {
      // Badge APIs are best-effort; never break the app.
    }
  }, [count, dockBadgeEnabled]);

  // Reset only on unmount so count changes do not flash the badge to 0.
  React.useEffect(() => () => {
    try {
      getRegisteredRuntimeAPIs()?.notifications?.setAttentionCount?.(0);
    } catch {
      // Best-effort reset so the badge does not stick after unmount.
    }
  }, []);

  return null;
};

/** Document-title `(N)` prefix for non-desktop browser runtimes. */
export const useNeedsInputTitlePrefix = (): string => {
  const count = usePiSessionSnapshot(
    (state) => selectSessionsNeedingInput(state.catalog).length,
    Object.is,
    'catalog',
  );
  if (count <= 0) return '';
  if (isDesktopShell() || isCapacitorApp()) return '';
  return `(${count}) `;
};

/**
 * Full-app bridge for `pichamber:open-session` (emitted to all windows by
 * Electron on notification click, and dispatched by web page-notification
 * clicks). Navigates with `setCurrentSession`, mirroring the mini-chat
 * listener. Mount once in the main app shell.
 */
export const NotificationOpenSessionBridge: React.FC = () => {
  React.useEffect(() => {
    const onOpenSession = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; directory?: string }>).detail;
      const sessionId = typeof detail?.sessionId === 'string' ? detail.sessionId.trim() : '';
      if (!sessionId) return;
      const directory = typeof detail?.directory === 'string' && detail.directory.trim().length > 0
        ? detail.directory.trim()
        : null;
      navigateToSession(sessionId, directory);
    };
    window.addEventListener('pichamber:open-session', onOpenSession);
    return () => window.removeEventListener('pichamber:open-session', onOpenSession);
  }, []);
  return null;
};
