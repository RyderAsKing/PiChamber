/* eslint-disable react-refresh/only-export-components */
import React from 'react';

import { getPiSessionStore, subscribePendingInputTransitions, type PendingInputTransition } from '@/apps/pi-session-store';
import { toast } from '@/components/ui';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { isDesktopShell } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { getSessionDisplayTitle } from '@/lib/chat/sessionTitle';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';
import { dispatchInputNeededNotification } from '@/sync/notification-store';
import { liveSessionRecordToUiSession, selectSessionsNeedingInput } from '@/sync/pi-session-catalog';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { useSessionsNeedingInput } from '@/sync/sync-context';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { PiPendingInputSummary } from '@/lib/pi/protocol';
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

const readAlertContext = (sessionId: string, pending: PiPendingInputSummary): InputAlertContext => {
  const isCurrent = useSessionUIStore.getState().currentSessionId === sessionId;
  const visible = typeof document !== 'undefined' && document.visibilityState === 'visible';
  let focused = false;
  try {
    focused = typeof document !== 'undefined' && document.hasFocus();
  } catch {
    focused = false;
  }
  const mode = useUIStore.getState().notificationMode;
  return {
    isCurrent,
    visible,
    focused,
    mode: mode === 'always' ? 'always' : 'hidden-only',
    ageMs: Date.now() - pending.since,
  };
};

const navigateToSession = (sessionId: string, directory: string | null): void => {
  void useSessionUIStore.getState().setCurrentSession(sessionId, directory);
};

const showInputToast = (sessionId: string, directory: string, pending: PiPendingInputSummary): void => {
  toast.warning(alertTitleForKind(pending.kind), {
    id: toastIdForSession(sessionId),
    description: displayTitleForSession(sessionId),
    duration: Infinity,
    action: {
      label: 'Open session',
      onClick: () => navigateToSession(sessionId, directory || null),
    },
  });
};

export const NeedsInputAlerts: React.FC = () => {
  // Opening the session clears its alert surfaces (the dock strip takes over).
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  // sessionId -> raised OS notification tag, so `cleared` can close it.
  const raisedTagsRef = React.useRef(new Map<string, string>());
  // Every toast id this mount raised, so unmount/runtime-switch can clear them.
  const raisedToastsRef = React.useRef(new Set<string>());

  const dismissSessionAlert = React.useCallback((sessionId: string) => {
    const toastId = toastIdForSession(sessionId);
    raisedToastsRef.current.delete(toastId);
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
    const decision = decideInputAlert(readAlertContext(transition.sessionId, pending));
    if (decision === 'none') return;
    raisedToastsRef.current.add(toastIdForSession(transition.sessionId));
    showInputToast(transition.sessionId, transition.directory, pending);
    if (decision === 'toast-and-notify') {
      const tag = `pichamber:input:${transition.sessionId}:${pending.since}`;
      raisedTagsRef.current.set(transition.sessionId, tag);
      dispatchInputNeededNotification({
        sessionId: transition.sessionId,
        directory: transition.directory,
        since: pending.since,
        kind: pending.kind,
        title: displayTitleForSession(transition.sessionId),
      });
    }
  }), [dismissSessionAlert]);

  // The user opened the session: the dock strip owns it now.
  React.useEffect(() => {
    if (currentSessionId) dismissSessionAlert(currentSessionId);
  }, [currentSessionId, dismissSessionAlert]);

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
