import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { parseRoute, updateBrowserURL, hasRouteParams } from '@/lib/router';
import type { RouteState, AppRouteState } from '@/lib/router';
import type { MainTab } from '@/stores/useUIStore';
import { resolveSettingsSlug } from '@/lib/settings/metadata';
import { isEmbeddedSessionChat } from '@/components/layout/contextPanelEmbeddedChat';
import { routeSessionIdForState } from '@/lib/router/session-intent';

import { getPiSessionStore } from '@/apps/pi-session-store';

/**
 * Hook that provides bidirectional URL routing for PiChamber.
 *
 * On mount:
 * - Parses URL parameters and applies them to app state
 * - Sets up subscriptions to sync state changes back to URL
 * - Listens for browser back/forward navigation
 *
 * Works in:
 * - Web: Full bidirectional sync
 * - Desktop: Full bidirectional sync
 * - Embedded session-chat iframe (`?ocPanel=session-chat`): No URL updates.
 *   The iframe's session identity is fixed at mount (the parent builds the
 *   src with `sessionId`); in-place subtask navigation must NOT rewrite the
 *   URL, otherwise `ocPanel` (and `directory`/`readOnly`) get stripped and
 *   `isEmbeddedSessionChat()` starts returning false, breaking subsequent
 *   "Open subtask" clicks.
 */
export function useRouter(): void {
  // Captured once at mount: the iframe's embedded-ness never changes during
  // its lifetime (a parent src swap is a full reload).
  const isEmbeddedChat = React.useMemo(() => isEmbeddedSessionChat(), []);

  // Track initialization to avoid duplicate applies
  const initializedRef = React.useRef(false);
  const isApplyingRouteRef = React.useRef(false);

  // Get store actions (stable references)
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const navigateToDiff = useUIStore((state) => state.navigateToDiff);

  /**
   * Apply a parsed route state to the application stores.
   */
  const applyRoute = React.useCallback(
    async (route: RouteState) => {
      if (isApplyingRouteRef.current) {
        return;
      }

      isApplyingRouteRef.current = true;

      try {
        // 1. Apply session first (may trigger async operations)
        if (route.sessionId) {
          const currentSessionId = useSessionUIStore.getState().currentSessionId;
          const piSelectedId = getPiSessionStore().getState().selectedSessionId;
          if (route.sessionId !== currentSessionId || route.sessionId !== piSelectedId) {
            const embeddedDirectory = isEmbeddedChat && typeof window !== 'undefined'
              ? new URLSearchParams(window.location.search).get('directory')
              : null;
            const directoryHint = embeddedDirectory
              || useSessionUIStore.getState().getDirectoryForSession(route.sessionId);
            setCurrentSession(route.sessionId, directoryHint);
          }
        }

        // 2. Handle settings (takes precedence over tabs - it's a full-screen overlay)
        if (route.settingsPath) {
          setSettingsPage(resolveSettingsSlug(route.settingsPath));
          setSettingsDialogOpen(true);
          // Don't process tab when settings is open
          return;
        }

        // Close settings if URL has no settings section
        if (useUIStore.getState().isSettingsDialogOpen) {
          setSettingsDialogOpen(false);
        }

        // 3. Apply tab
        if (route.tab) {
          setActiveMainTab(route.tab);
        }

        // 4. Apply diff file (only if going to diff tab)
        if (route.diffFile && (route.tab === 'diff' || !route.tab)) {
          navigateToDiff(route.diffFile);
        }
      } finally {
        isApplyingRouteRef.current = false;
      }
    },
    [isEmbeddedChat, setCurrentSession, setActiveMainTab, setSettingsDialogOpen, setSettingsPage, navigateToDiff]
  );

  /**
   * Get current app state for URL serialization.
   */
  const getCurrentAppState = React.useCallback((): AppRouteState => {
    const sessionState = useSessionUIStore.getState();
    const piState = getPiSessionStore().getState();
    const uiState = useUIStore.getState();

    return {
      sessionId: routeSessionIdForState({
        currentSessionId: sessionState.currentSessionId,
        piSelectedSessionId: piState.selectedSessionId,
        draft: sessionState.newSessionDraft,
      }),
      tab: uiState.activeMainTab,
      isSettingsOpen: uiState.isSettingsDialogOpen,
      settingsPath: uiState.settingsPage,
      diffFile: uiState.pendingDiffFile,
    };
  }, []);

  /**
   * Sync current app state to URL.
   */
  const syncURLFromState = React.useCallback(
    (options: { replace?: boolean } = {}) => {
      if (isEmbeddedChat || isApplyingRouteRef.current) {
        return;
      }

      const state = getCurrentAppState();
      updateBrowserURL(state, options);
    },
    [isEmbeddedChat, getCurrentAppState]
  );

  // Initialize: parse URL and apply route on mount
  React.useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;

    // Only process if URL has route params
    if (!hasRouteParams()) {
      // No route params - just set up sync (URL will update when user navigates)
      return;
    }

    const route = parseRoute();

    // Apply the initial route
    const initializeRoute = async () => {
      await applyRoute(route);

      // After applying, update URL to normalized form (use replaceState).
      // Use the parsed route values instead of an immediate store snapshot so
      // deep links do not briefly normalize `?session=...` back to `/` while
      // the session's directory/message bootstrap is still catching up.
      if (!isEmbeddedChat) {
        updateBrowserURL({
          ...getCurrentAppState(),
          sessionId: route.sessionId ?? routeSessionIdForState({
            currentSessionId: useSessionUIStore.getState().currentSessionId,
            piSelectedSessionId: getPiSessionStore().getState().selectedSessionId,
            draft: useSessionUIStore.getState().newSessionDraft,
          }),
          tab: route.tab ?? useUIStore.getState().activeMainTab,
          settingsPath: route.settingsPath ?? useUIStore.getState().settingsPage,
          diffFile: route.diffFile ?? useUIStore.getState().pendingDiffFile,
        }, { replace: true, force: true });
      }
    };

    void initializeRoute();
  }, [applyRoute, getCurrentAppState, isEmbeddedChat]);

  // Subscribe to session changes
  React.useEffect(() => {
    if (isEmbeddedChat) {
      return;
    }

    const readRouteSessionId = () => {
      const uiState = useSessionUIStore.getState();
      const piState = getPiSessionStore().getState();
      return routeSessionIdForState({
        currentSessionId: uiState.currentSessionId,
        piSelectedSessionId: piState.selectedSessionId,
        draft: uiState.newSessionDraft,
      });
    };

    let prevSessionId: string | null = readRouteSessionId();
    let prevDraftOpen = useSessionUIStore.getState().newSessionDraft?.open === true;

    const syncIfChanged = () => {
      const uiState = useSessionUIStore.getState();
      const nextSessionId = readRouteSessionId();
      const nextDraftOpen = uiState.newSessionDraft?.open === true;
      if (
        (nextSessionId === prevSessionId && nextDraftOpen === prevDraftOpen)
        || isApplyingRouteRef.current
      ) {
        return;
      }
      prevSessionId = nextSessionId;
      prevDraftOpen = nextDraftOpen;
      syncURLFromState({ replace: true });
    };

    const unsubscribeUI = useSessionUIStore.subscribe(() => {
      syncIfChanged();
    });

    const unsubscribePi = getPiSessionStore().subscribe(() => {
      syncIfChanged();
    });

    return () => {
      unsubscribeUI();
      unsubscribePi();
    };
  }, [isEmbeddedChat, syncURLFromState]);

  // Subscribe to UI store changes (tab, settings)
  React.useEffect(() => {
    if (isEmbeddedChat) {
      return;
    }

    let prevTab: MainTab = useUIStore.getState().activeMainTab;
    let prevSettingsOpen: boolean = useUIStore.getState().isSettingsDialogOpen;
    let prevSettingsPath: string = useUIStore.getState().settingsPage;
    let prevDiffFile: string | null = useUIStore.getState().pendingDiffFile;

    const unsubscribe = useUIStore.subscribe((state) => {
      // Skip if we're currently applying a route
      if (isApplyingRouteRef.current) {
        return;
      }

      const tabChanged = state.activeMainTab !== prevTab;
      const settingsOpenChanged = state.isSettingsDialogOpen !== prevSettingsOpen;
      const settingsPathChanged = state.settingsPage !== prevSettingsPath;
      const diffFileChanged = state.pendingDiffFile !== prevDiffFile && state.activeMainTab === 'diff';

      // Update tracking vars
      prevTab = state.activeMainTab;
      prevSettingsOpen = state.isSettingsDialogOpen;
      prevSettingsPath = state.settingsPage;
      prevDiffFile = state.pendingDiffFile;

      // Only sync if something relevant changed
      if (tabChanged || settingsOpenChanged || settingsPathChanged || diffFileChanged) {
        syncURLFromState();
      }
    });

    return unsubscribe;
  }, [isEmbeddedChat, syncURLFromState]);

  // Listen for browser back/forward navigation
  React.useEffect(() => {
    if (typeof window === 'undefined' || isEmbeddedChat) {
      return;
    }

    const handlePopState = () => {
      // Parse the new URL and apply it
      const route = parseRoute();

      // Check if this is a route with any params, or if we should restore defaults
      if (hasRouteParams()) {
        void applyRoute(route);
      } else {
        // URL has no route params - this might be a "back to home" navigation
        // Close settings if open, keep current session
        const uiState = useUIStore.getState();
        if (uiState.isSettingsDialogOpen) {
          setSettingsDialogOpen(false);
        }
        // Reset to chat tab if not already there
        if (uiState.activeMainTab !== 'chat') {
          setActiveMainTab('chat');
        }
      }
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [applyRoute, isEmbeddedChat, setActiveMainTab, setSettingsDialogOpen]);
}
