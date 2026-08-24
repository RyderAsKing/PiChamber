import React from 'react';

import { AboutSettings } from '@/components/sections/pichamber/AboutSettings';
import { MobileAppUpdateToast } from '@/components/update/MobileAppUpdateToast';
import { ConfigUpdateOverlay } from '@/components/ui/ConfigUpdateOverlay';
import { Button } from '@/components/ui/button';
import { PiChamberLogo } from '@/components/ui/PiChamberLogo';
import { ChatView } from '@/components/views/ChatView';
import { SettingsView } from '@/components/views/SettingsView';
import { ArchiveView } from '@/components/views/ArchiveView';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { SessionDialogs } from '@/components/session/SessionDialogs';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { PerfHudHost } from '@/components/perf/PerfHudHost';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { useRouter } from '@/hooks/useRouter';
import { DeferredUpdatePolling } from '@/hooks/useUpdatePolling';
import { WindowTitleEffect } from '@/hooks/useWindowTitle';
import { opencodeClient } from '@/lib/pi/legacy-ui-client';
import type { RuntimeAPIs } from '@/lib/api/types';
import { readTabletLayout, useOrientation, useTabletLayout } from '@/lib/device';
import { useHardwareKeyboard } from '@/lib/hardwareKeyboard';
import { getRuntimeApiBaseUrl, getRuntimeKey, subscribeRuntimeEndpointChanged, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { syncDesktopSettings } from '@/lib/persistence';
import { startMobileErrorLogCapture } from '@/lib/mobile-error-log';
import { refreshGlobalSessions, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { clearLastActiveSession, readLastActiveSession } from '@/sync/last-session-cache';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useUIStore } from '@/stores/useUIStore';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { PiSessionProvider } from '@/sync/pi-session-context';
import { FireworksProvider } from '@/contexts/FireworksContext';
import type { ViewTarget } from './deepLinks';

import { SyncAppEffects } from './AppEffects';
import { BusyDots } from '@/components/chat/message/parts/BusyDots';
import { MobileConnectionWelcome, type MobileConnectionNotice } from './MobileConnectionWelcome';
import { MobileHeader } from './MobileHeader';
import { MobileInstancesSurface } from './MobileInstancesSurface';
import { MobileSessionsSheet } from './MobileSessionsSheet';
import { MobileFullscreenSurface } from './MobileFullscreenSurface';
import { MobileWorkspaceDrawer, type MobileWorkspaceTab } from './MobileWorkspaceDrawer';
import { DedicatedMobileAppProvider, type MobileAppActions } from './mobileAppContext';
import { autoConnectLastInstance, getAutoConnectTargetLabel, reprobeActiveConnection, type AutoConnectOutcome } from './mobileConnections';
import { isCapacitorMobileApp, useNativeAndroidBackButton, useNativeMobileChrome, useNativeMobileLifecycle } from './mobileNativeChrome';
import { reconnectAppForTransportSwitch, resetAppForRuntimeEndpointChange } from './runtimeEndpointReset';
import { useAppFontEffects } from './useAppFontEffects';
import { useFontsReady } from './useFontsReady';
import { useDeepLinkHandlers, useDeepLinkSource } from './deepLinkNavigation';
import { useEdgeSwipe } from './useEdgeSwipe';
import {
  applyPhoneDrawerProgress,
  applyTabletPanelProgress,
  beginPhoneDrawerDrag,
  beginTabletPanelDrag,
  settlePhoneDrawerViaRefs,
  settleTabletPanel,
} from './drawerSurface';
import { useNativePushRegistration } from './useNativePushRegistration';
import { IpadSidebarResizeHandle } from './IpadSidebarResizeHandle';
import { Header } from '@/components/layout/Header';
import { TitlebarLeftControls } from '@/components/layout/TitlebarLeftControls';
import { usePanelSlide } from '@/components/layout/usePanelSlide';
import {
  IPAD_LEFT_SIDEBAR_WIDTH,
  IPAD_RIGHT_SIDEBAR_WIDTH,
  IPAD_WORKSPACE_SIDEBAR_MAX_WIDTH,
  useIpadSidebarResize,
} from './ipadSidebarResize';

type MobileAppProps = {
  apis: RuntimeAPIs;
};

const NATIVE_RESUME_SYNC_EVENT_THROTTLE_MS = 1_000;

/** The fullscreen app-level surfaces, reachable from the sessions drawer
    footer. Exactly one can be open at a time — opening another replaces it,
    closing returns to the chat. The sessions drawer and the workspace drawer
    (Changes / Files / Terminal / Notes / MCP) are separate layers. */
type MobileSurface = 'instances' | 'settings' | 'update';

// Sidebar state changes must not rerender the transcript/composer tree. ChatView
// subscribes to its own session state, so parent layout changes can safely be
// memoized away here.
const MobileChatView = React.memo(ChatView);

/* settlePhoneDrawer moved to drawerSurface adapter; MobileApp stays open-state only */

const MobileShell: React.FC<{ onActiveConnectionDeleted: () => void }> = ({ onActiveConnectionDeleted }) => {
  
  const [sessionsSheetOpen, setSessionsSheetOpen] = React.useState(false);
  const [activeSurface, setActiveSurface] = React.useState<MobileSurface | null>(null);
  // Phone right drawer with the workspace tabs; the tab persists across
  // open/close so the right-edge swipe reopens where the user left off.
  const [workspaceOpen, setWorkspaceOpen] = React.useState(false);
  const [workspaceTab, setWorkspaceTab] = React.useState<MobileWorkspaceTab>('changes');
  // A plan opened from the workspace drawer's Notes tab, shown as a fullscreen
  // layer on top of it (back returns to the notes).

  const [settingsInitialMobileStage, setSettingsInitialMobileStage] = React.useState<'nav' | 'page-content'>('nav');
  // When set, the Changes surface opens directly into the per-file diff for this path.
  const [pendingChangesDiff, setPendingChangesDiff] = React.useState<{ path: string; staged: boolean } | null>(null);
  // Track imperative timeouts so a second drag doesn't have its transition
  // cleared by a stale timeout from the previous drag (which caused the
  // “hang after 1-2 pulls” - drawer stuck mid-way with transition cleared).
  const dragTimeoutsRef = React.useRef<number[]>([]);
  const clearDragTimeouts = React.useCallback(() => {
    dragTimeoutsRef.current.forEach((id) => window.clearTimeout(id));
    dragTimeoutsRef.current = [];
  }, []);
  React.useEffect(() => () => clearDragTimeouts(), [clearDragTimeouts]);
  // Ref-based drawer surfaces: phone drawers use these instead of querySelector per touchmove
  const phoneLeftDrawerRef = React.useRef<HTMLElement | null>(null);
  const phoneLeftScrimRef = React.useRef<HTMLButtonElement | null>(null);
  const phoneLeftRootRef = React.useRef<HTMLElement | null>(null);
  const phoneRightDrawerRef = React.useRef<HTMLElement | null>(null);
  const phoneRightScrimRef = React.useRef<HTMLButtonElement | null>(null);
  const phoneRightRootRef = React.useRef<HTMLElement | null>(null);
  // Tablet two-layer inner surfaces: shell width stays committed, inner translates during drag
  const leftPanelInnerRef = React.useRef<HTMLElement | null>(null);
  const rightPanelInnerRef = React.useRef<HTMLElement | null>(null);
  const leftDragProgressRef = React.useRef(0);
  const rightDragProgressRef = React.useRef(0);
  const setSessionsSheetOpenSafely = React.useCallback((open: boolean) => {
    clearDragTimeouts();
    setSessionsSheetOpen(open);
  }, [clearDragTimeouts]);
  const setWorkspaceOpenSafely = React.useCallback((open: boolean) => {
    clearDragTimeouts();
    setWorkspaceOpen(open);
  }, [clearDragTimeouts]);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const isArchivePageOpen = useUIStore((state) => state.isArchivePageOpen);
  const setArchivePageOpen = useUIStore((state) => state.setArchivePageOpen);
  const wideChatLayoutEnabled = useUIStore((state) => state.wideChatLayoutEnabled);
  const updateAvailable = useUpdateStore((state) => state.available);
  const updateRuntimeType = useUpdateStore((state) => state.runtimeType);
  const showCapacitorOnlyFeatures = React.useMemo(() => isCapacitorMobileApp(), []);
  const showUpdateItem = !showCapacitorOnlyFeatures
    && updateAvailable
    && (updateRuntimeType === 'desktop' || updateRuntimeType === 'web');

  // NOTE: pendingChangesDiff is intentionally NOT cleared on close — it keys
  // the persistent Changes pane in the workspace drawer, and clearing it would
  // remount the pane (losing its navigation) on every close.
  const closeSurface = React.useCallback(() => {
    setActiveSurface(null);
  }, []);

  const openSurface = React.useCallback((surface: MobileSurface) => {
    setActiveSurface(surface);
  }, []);

  const closeWorkspace = React.useCallback(() => {
    setWorkspaceOpenSafely(false);
  }, [setWorkspaceOpenSafely]);

  const openSettingsSurface = React.useCallback((stage: 'nav' | 'page-content') => {
    setSettingsInitialMobileStage(stage);
    openSurface('settings');
  }, [openSurface]);

  // Tablet: sessions live in a persistent full-height left sidebar instead of
  // the phone's drawer. Everything else — the workspace drawer, the header, the
  // app-level surfaces — is shared with phones.
  //
  // A SIZE class, not a device check: an unfolded book foldable is a tablet
  // until it is folded shut, and the shell keeps running across that change.
  const { enabled: isTabletLayout, roomyForPanels } = useTabletLayout();
  const orientation = useOrientation();
  const isPortrait = orientation === 'portrait';
  const hasHardwareKeyboard = useHardwareKeyboard();
  const setSidebarOpen = useUIStore((state) => state.setSidebarOpen);
  const sidebarOpen = useUIStore((state) => state.isSidebarOpen);
  const wasTabletLayoutRef = React.useRef(false);

  // Folding shut (or losing the room for a side-by-side layout) must not leave
  // a sidebar open over a phone-width screen.
  React.useLayoutEffect(() => {
    if (isTabletLayout && !wasTabletLayoutRef.current) {
      setSidebarOpen(readTabletLayout().roomyForPanels);
    }
    if (!isTabletLayout && wasTabletLayoutRef.current) {
      setSidebarOpen(false);
    }
    wasTabletLayoutRef.current = isTabletLayout;
  }, [isTabletLayout, setSidebarOpen]);

  const openFilesSurface = React.useCallback(() => {
    setPendingChangesDiff(null);
    setWorkspaceTab('files');
    setWorkspaceOpenSafely(true);
  }, [setWorkspaceOpenSafely]);

  const openChangesSurface = React.useCallback((diff: { path: string; staged: boolean } | null = null) => {
    setPendingChangesDiff(diff);
    setWorkspaceTab('changes');
    setWorkspaceOpenSafely(true);
  }, [setWorkspaceOpenSafely]);

  const leftResize = useIpadSidebarResize('left', 'pichamber.ipad.leftSidebarWidth', IPAD_LEFT_SIDEBAR_WIDTH);
  const rightResize = useIpadSidebarResize(
    'right',
    'pichamber.ipad.rightSidebarWidth',
    IPAD_RIGHT_SIDEBAR_WIDTH,
    IPAD_WORKSPACE_SIDEBAR_MAX_WIDTH,
  );
  // The workspace becomes a real side panel only where the screen can host the
  // sidebar, the panel AND a readable chat at once. Everywhere else — a tablet
  // in portrait, and an unfolded foldable in EITHER orientation, since its long
  // side is barely wider than a tablet's short one — it stays the full-cover
  // drawer, which is the layout that actually works at that width.
  const workspaceAsPanel = roomyForPanels;
  const workspacePanelWidth = workspaceAsPanel && workspaceOpen ? rightResize.width : 0;
  const sidebarSlide = usePanelSlide(isTabletLayout && sidebarOpen);
  const sidebarWidth = isTabletLayout && sidebarOpen ? leftResize.width : 0;

  const handleTabletWorkspaceTabSelect = React.useCallback((nextTab: MobileWorkspaceTab) => {
    if (workspaceOpen && workspaceTab === nextTab) {
      setWorkspaceOpenSafely(false);
    } else {
      setWorkspaceTab(nextTab);
      setWorkspaceOpenSafely(true);
    }
  }, [workspaceOpen, workspaceTab, setWorkspaceOpenSafely]);

  const handleToggleWorkspace = React.useCallback(() => {
    setWorkspaceOpenSafely(!workspaceOpen);
  }, [workspaceOpen, setWorkspaceOpenSafely]);

  const handleTabletSessionsOpenChange = React.useCallback((nextOpen: boolean) => {
    if (!nextOpen && !roomyForPanels) setSidebarOpen(false);
  }, [roomyForPanels, setSidebarOpen]);

  // Publish the chat column's insets so overlays portaled to <body> (model
  // picker, directory picker, every MobileOverlayPanel) can center on the CHAT
  // rather than on the window. Zero on phones, where the two are the same.
  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.style.setProperty('--oc-chat-inset-left', `${sidebarWidth}px`);
    root.style.setProperty('--oc-chat-inset-right', `${workspacePanelWidth}px`);
    return () => {
      root.style.removeProperty('--oc-chat-inset-left');
      root.style.removeProperty('--oc-chat-inset-right');
    };
  }, [sidebarWidth, workspacePanelWidth]);

  // Wide chat layout: the shared chat columns key off this root class, but only
  // the desktop App set it — so on a tablet, where the chat column is finally
  // wide enough for the setting to mean something, it did nothing. Applied for
  // every mobile surface; on a phone the viewport is narrower than even the
  // normal clamp, so it is a no-op there.
  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.classList.toggle('wide-chat-layout', wideChatLayoutEnabled);
    return () => root.classList.remove('wide-chat-layout');
  }, [wideChatLayoutEnabled]);

  // The draft screen keeps its starter chips while the keyboard is up when
  // there is room for both: a tablet in portrait, or any tablet orientation
  // with a hardware keyboard (then no software keyboard eats the screen at
  // all). Landscape on the software keyboard still hides them — see mobile.css.
  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    const keep = isTabletLayout && (isPortrait || hasHardwareKeyboard);
    const root = document.documentElement;
    root.classList.toggle('oc-keep-draft-starters', keep);
    return () => root.classList.remove('oc-keep-draft-starters');
  }, [hasHardwareKeyboard, isTabletLayout, isPortrait]);

  const closeAllDrawers = React.useCallback(() => {
    setSessionsSheetOpenSafely(false);
    setWorkspaceOpenSafely(false);
  }, [setSessionsSheetOpenSafely, setWorkspaceOpenSafely]);

  const mobileActions = React.useMemo<MobileAppActions>(
    () => ({
      openChanges: ({ diffPath, staged } = {}) => {
        openChangesSurface(diffPath ? { path: diffPath, staged: staged === true } : null);
      },
      openFiles: () => openFilesSurface(),
      openSettings: (section?: string) => {
        if (section) setSettingsPage(section as Parameters<typeof setSettingsPage>[0]);
        openSettingsSurface(section ? 'page-content' : 'nav');
      },
      openInstances: showCapacitorOnlyFeatures ? () => openSurface('instances') : undefined,
      instanceLabel: showCapacitorOnlyFeatures ? getAutoConnectTargetLabel() : null,
      openUpdate: showUpdateItem ? () => openSurface('update') : undefined,
      closeDrawers: closeAllDrawers,
    }),
    [closeAllDrawers, openChangesSurface, openFilesSurface, openSettingsSurface, openSurface, setSettingsPage, showCapacitorOnlyFeatures, showUpdateItem],
  );

  // Expose the shell's panel-opening actions to the deep-link layer so pichamber:// URLs
  // (and notification taps / widgets) can navigate to these surfaces. Session and
  // new-session intents resolve directly against the store, so they aren't wired here.
  const deepLinkHandlers = React.useMemo(
    () => ({
      openSessions: () => {
        if (isTabletLayout) setSidebarOpen(true);
        else setSessionsSheetOpenSafely(true);
      },
      openView: (target: ViewTarget) => {
        if (target === 'files') {
          openFilesSurface();
          return;
        }
        if (target === 'instances' || target === 'update' || target === 'mcp') {
          openSurface(target as MobileSurface);
        }
      },
      openChanges: ({ path, staged }: { path?: string; staged?: boolean } = {}) => {
        openChangesSurface(path ? { path, staged: staged === true } : null);
      },
      openSettings: (section?: string) => {
        if (section) setSettingsPage(section as Parameters<typeof setSettingsPage>[0]);
        openSettingsSurface(section ? 'page-content' : 'nav');
      },
    }),
    [isTabletLayout, openChangesSurface, openFilesSurface, openSettingsSurface, openSurface, setSettingsPage, setSessionsSheetOpenSafely, setSidebarOpen],
  );
  useDeepLinkHandlers(deepLinkHandlers);

  // Horizontal swipes anywhere in the chat open or close the drawers. Vertical
  // scrolling and controls keep their normal touch behavior.
  const chatMainRef = React.useRef<HTMLElement>(null);
  useEdgeSwipe(chatMainRef, {
    leftOpen: isTabletLayout ? sidebarOpen : sessionsSheetOpen,
    rightOpen: workspaceOpen,
    leftWidth: () => {
      if (isTabletLayout) return leftResize.width;
      return phoneLeftDrawerRef.current?.offsetWidth || window.innerWidth * 0.72;
    },
    rightWidth: () => {
      if (isTabletLayout) return rightResize.width;
      return phoneRightDrawerRef.current?.offsetWidth || window.innerWidth;
    },
    onLeftProgress: (progress) => {
      leftDragProgressRef.current = progress;
      if (isTabletLayout) {
        applyTabletPanelProgress(
          { shell: leftResize.asideRef as React.RefObject<HTMLElement | null>, inner: leftPanelInnerRef },
          progress,
          leftResize.width,
          'left',
        );
        return;
      }
      applyPhoneDrawerProgress(
        { drawer: phoneLeftDrawerRef as React.RefObject<HTMLElement | null>, scrim: phoneLeftScrimRef as React.RefObject<HTMLElement | null>, root: phoneLeftRootRef as React.RefObject<HTMLElement | null> },
        'left',
        progress,
      );
    },
    onRightProgress: (progress) => {
      rightDragProgressRef.current = progress;
      if (isTabletLayout && roomyForPanels) {
        applyTabletPanelProgress(
          { shell: rightResize.asideRef as React.RefObject<HTMLElement | null>, inner: rightPanelInnerRef },
          progress,
          rightResize.width,
          'right',
        );
        return;
      }
      applyPhoneDrawerProgress(
        { drawer: phoneRightDrawerRef as React.RefObject<HTMLElement | null>, scrim: phoneRightScrimRef as React.RefObject<HTMLButtonElement | null>, root: phoneRightRootRef as React.RefObject<HTMLElement | null> },
        'right',
        progress,
      );
    },
    onLeftOpen: () => {
      if (isTabletLayout) setSidebarOpen(true);
      else setSessionsSheetOpenSafely(true);
    },
    onLeftClose: () => {
      if (isTabletLayout) setSidebarOpen(false);
      else setSessionsSheetOpenSafely(false);
    },
    onRightOpen: () => setWorkspaceOpenSafely(true),
    onRightClose: () => setWorkspaceOpenSafely(false),
    onDragStart: (side) => {
      clearDragTimeouts();
      if (side === 'left') {
        leftDragProgressRef.current = isTabletLayout
          ? (sidebarOpen ? 1 : 0)
          : (sessionsSheetOpen ? 1 : 0);
        if (isTabletLayout) {
          beginTabletPanelDrag({
            shell: leftResize.asideRef as React.RefObject<HTMLElement | null>,
            inner: leftPanelInnerRef,
          });
        } else {
          beginPhoneDrawerDrag({
            drawer: phoneLeftDrawerRef as React.RefObject<HTMLElement | null>,
            scrim: phoneLeftScrimRef as React.RefObject<HTMLElement | null>,
            root: phoneLeftRootRef as React.RefObject<HTMLElement | null>,
          });
        }
        return;
      }

      rightDragProgressRef.current = workspaceOpen ? 1 : 0;
      if (isTabletLayout && roomyForPanels) {
        beginTabletPanelDrag({
          shell: rightResize.asideRef as React.RefObject<HTMLElement | null>,
          inner: rightPanelInnerRef,
        });
      } else {
        beginPhoneDrawerDrag({
          drawer: phoneRightDrawerRef as React.RefObject<HTMLElement | null>,
          scrim: phoneRightScrimRef as React.RefObject<HTMLElement | null>,
          root: phoneRightRootRef as React.RefObject<HTMLElement | null>,
        });
      }
    },
    onDragEnd: (side, didSettleOpen) => {
      if (side === 'left') {
        const shouldOpen = typeof didSettleOpen === 'boolean'
          ? didSettleOpen
          : leftDragProgressRef.current > 0.5;
        leftDragProgressRef.current = shouldOpen ? 1 : 0;
        if (isTabletLayout) {
          const timeoutId = settleTabletPanel(
            {
              shell: leftResize.asideRef as React.RefObject<HTMLElement | null>,
              inner: leftPanelInnerRef,
            },
            shouldOpen,
            leftResize.width,
            'left',
          );
          if (timeoutId !== undefined) dragTimeoutsRef.current.push(timeoutId);
        } else {
          settlePhoneDrawerViaRefs('left', shouldOpen, {
            drawer: phoneLeftDrawerRef as React.RefObject<HTMLElement | null>,
            scrim: phoneLeftScrimRef as React.RefObject<HTMLElement | null>,
            root: phoneLeftRootRef as React.RefObject<HTMLElement | null>,
          });
        }
        return;
      }

      const shouldOpen = typeof didSettleOpen === 'boolean'
        ? didSettleOpen
        : rightDragProgressRef.current > 0.5;
      rightDragProgressRef.current = shouldOpen ? 1 : 0;
      if (isTabletLayout && roomyForPanels) {
        const timeoutId = settleTabletPanel(
          {
            shell: rightResize.asideRef as React.RefObject<HTMLElement | null>,
            inner: rightPanelInnerRef,
          },
          shouldOpen,
          rightResize.width,
          'right',
        );
        if (timeoutId !== undefined) dragTimeoutsRef.current.push(timeoutId);
      } else {
        settlePhoneDrawerViaRefs('right', shouldOpen, {
          drawer: phoneRightDrawerRef as React.RefObject<HTMLElement | null>,
          scrim: phoneRightScrimRef as React.RefObject<HTMLElement | null>,
          root: phoneRightRootRef as React.RefObject<HTMLElement | null>,
        });
      }
    },
  });

  // Top-most layer first: a plan or fullscreen surface can sit ABOVE a drawer
  // (opened from the drawer footer / workspace tabs), so they close before the
  // drawers underneath.
  const handleNativeBack = React.useCallback(() => {
    if (isArchivePageOpen) {
      setArchivePageOpen(false);
      return true;
    }
    if (activeSurface) {
      closeSurface();
      return true;
    }
    if (workspaceOpen) {
      closeWorkspace();
      return true;
    }
    if (sessionsSheetOpen) {
      setSessionsSheetOpenSafely(false);
      return true;
    }
    return false;
  }, [activeSurface, closeSurface, closeWorkspace, isArchivePageOpen, sessionsSheetOpen, setArchivePageOpen, setSessionsSheetOpenSafely, workspaceOpen]);

  useNativeAndroidBackButton(handleNativeBack);

  // Tablets pack the app-level pages (settings, instances, a plan) into a
  // centered dialog instead of covering the whole screen.
  const surfaceVariant = isTabletLayout ? 'dialog' as const : 'fullscreen' as const;

  return (
    <DedicatedMobileAppProvider actions={mobileActions}>
      <div
        className="oc-mobile-app-shell main-content-safe-area relative flex h-[100dvh] flex-row bg-background text-foreground"
        data-page-scroll-lock="true"
      >
        {/* iPad: persistent full-height sessions sidebar; the chat column and
            its header butt against it (iPadOS-style split layout). The shell
            commits layout width once; the inner surface owns the animation. */}
        {isTabletLayout ? (
          <aside
            ref={leftResize.asideRef}
            className={cn(
              'relative flex h-full shrink-0 flex-col overflow-hidden border-r border-border/70 bg-sidebar motion-reduce:transition-none',
              !sidebarOpen && 'border-r-0',
            )}
            style={{
              width: sidebarWidth,
              minWidth: sidebarWidth,
              maxWidth: sidebarWidth,
              ['--oc-ipad-sidebar-width' as string]: `${leftResize.width}px`,
              overflowX: 'clip',
              paddingTop: 'var(--oc-safe-area-top, 0px)',
            }}
            inert={!sidebarOpen}
            data-page-scroll-lock="true"
          >
            <div
              ref={leftPanelInnerRef as React.RefObject<HTMLDivElement>}
              className={cn(
                'flex h-full shrink-0 flex-col',
                leftResize.isResizing && 'pointer-events-none',
                !sidebarOpen && 'pointer-events-none select-none',
              )}
              style={{
                width: 'var(--oc-ipad-sidebar-width)',
                overflowX: 'hidden',
                transform: leftResize.isResizing || sidebarSlide.slidIn ? 'translateX(0)' : 'translateX(-100%)',
                transition: leftResize.isResizing ? 'none' : 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)',
              }}
            >
              <ErrorBoundary>
                <MobileSessionsSheet
                  open={sidebarOpen}
                  variant="sidebar"
                  // The surface asks to close after picking a session/project
                  // or creating a worktree: give the space back to the chat
                  // where the sidebar is a guest, keep it put where it is not.
                  onOpenChange={handleTabletSessionsOpenChange}
                />
              </ErrorBoundary>
            </div>
            {/* After the content, not before it: panes stack their own overlays
                and the handle has to sit above every one of them. */}
            {sidebarOpen ? (
              <IpadSidebarResizeHandle
                side="left"
                isResizing={leftResize.isResizing}
                ariaLabel={"Resize left panel"}
                handleProps={leftResize.handleProps}
              />
            ) : null}
          </aside>
        ) : null}

        <div className="relative flex h-full min-w-0 flex-1 flex-col" data-page-scroll-lock="true">
          {isTabletLayout ? (
            <>
              <TitlebarLeftControls />
              <Header
                onToggleRightDrawer={handleToggleWorkspace}
                rightDrawerOpen={workspaceOpen}
                tabletWorkspaceTab={workspaceTab}
                onSelectTabletWorkspaceTab={handleTabletWorkspaceTabSelect}
              />
            </>
          ) : (
            <MobileHeader
              onOpenSessions={() => setSessionsSheetOpenSafely(true)}
              onOpenWorkspace={() => setWorkspaceOpenSafely(true)}
            />
          )}
          <main ref={chatMainRef} className="relative min-h-0 flex-1 overflow-hidden" data-page-scroll-lock="true" style={{ touchAction: 'pan-x pan-y' } as React.CSSProperties}>
            <div className="h-full w-full">
              <ErrorBoundary>
                <MobileChatView />
              </ErrorBoundary>
            </div>
          </main>
        </div>

        {/* Mounted permanently on phones (parked off-screen while closed) so
            the sessions/worktree state stays warm and the drawer opens with
            data already on screen — see MobileSessionsDrawerContainer. */}
        {!isTabletLayout ? (
          <MobileSessionsSheet
            open={sessionsSheetOpen}
            onOpenChange={setSessionsSheetOpenSafely}
            drawerRefExternal={phoneLeftDrawerRef as React.RefObject<HTMLDivElement | null>}
            scrimRefExternal={phoneLeftScrimRef as React.RefObject<HTMLButtonElement | null>}
            rootRefExternal={phoneLeftRootRef as React.RefObject<HTMLDivElement | null>}
          />
        ) : null}

        {/* Tablet: the workspace lives inside a side-panel shell so landscape
            gets a real sidebar. The drawer element keeps its position in the
            tree across rotation — only its `variant` changes — so the mounted
            panes (open diff, edited file, attached terminal) survive it. In
            portrait the drawer portals itself out and this shell stays at 0. */}
        {isTabletLayout ? (
          <aside
            ref={rightResize.asideRef}
            className={cn(
              'relative flex h-full shrink-0 flex-col overflow-hidden border-l border-border/70 bg-background motion-reduce:transition-none',
              !workspacePanelWidth && 'border-l-0',
            )}
            style={{
              width: workspacePanelWidth,
              minWidth: workspacePanelWidth,
              maxWidth: workspacePanelWidth,
              ['--oc-ipad-sidebar-width' as string]: `${rightResize.width}px`,
              overflowX: 'clip',
              paddingTop: 'var(--oc-safe-area-top, 0px)',
            }}
            inert={!workspacePanelWidth}
            data-page-scroll-lock="true"
          >
            <div
              ref={rightPanelInnerRef as React.RefObject<HTMLDivElement>}
              className={cn(
                'flex h-full min-h-0 shrink-0 flex-col transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                rightResize.isResizing && 'pointer-events-none',
                !workspacePanelWidth && 'pointer-events-none select-none opacity-0',
              )}
              style={{
                width: 'var(--oc-ipad-sidebar-width)',
                overflowX: 'hidden',
                transform: workspacePanelWidth ? 'translateX(0)' : 'translateX(100%)',
                transition: rightResize.isResizing ? 'none' : 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1), opacity 200ms cubic-bezier(0.22, 1, 0.36, 1)',
              }}
            >
              <ErrorBoundary>
                <MobileWorkspaceDrawer
                  open={workspaceOpen}
                  onClose={closeWorkspace}
                  tab={workspaceTab}
                  onTabChange={setWorkspaceTab}
                  pendingChangesDiff={pendingChangesDiff}
                  variant={workspaceAsPanel ? 'panel' : 'drawer'}
                  drawerRefExternal={phoneRightDrawerRef as React.RefObject<HTMLElement | null>}
                  scrimRefExternal={phoneRightScrimRef as React.RefObject<HTMLButtonElement | null>}
                  rootRefExternal={phoneRightRootRef as React.RefObject<HTMLDivElement | null>}
                />
              </ErrorBoundary>
            </div>
            {workspacePanelWidth ? (
              <IpadSidebarResizeHandle
                side="right"
                isResizing={rightResize.isResizing}
                ariaLabel={"Resize right panel"}
                handleProps={rightResize.handleProps}
              />
            ) : null}
          </aside>
        ) : (
          <MobileWorkspaceDrawer
            open={workspaceOpen}
            onClose={closeWorkspace}
            tab={workspaceTab}
            onTabChange={setWorkspaceTab}
            pendingChangesDiff={pendingChangesDiff}
            drawerRefExternal={phoneRightDrawerRef as React.RefObject<HTMLElement | null>}
            scrimRefExternal={phoneRightScrimRef as React.RefObject<HTMLButtonElement | null>}
            rootRefExternal={phoneRightRootRef as React.RefObject<HTMLDivElement | null>}
          />
        )}

        {/* Layered above the workspace drawer's Notes tab, which opened it. */}


        {activeSurface === 'instances' && showCapacitorOnlyFeatures ? (
          <MobileFullscreenSurface
            open
            variant={surfaceVariant}
            dialogAlign="app"
            onClose={closeSurface}
            ariaLabel={"Instances"}
            title={"Instances"}
          >
            <MobileInstancesSurface
              onConnect={closeSurface}
              onActiveConnectionDeleted={onActiveConnectionDeleted}
            />
          </MobileFullscreenSurface>
        ) : null}

        {activeSurface === 'settings' ? (
          <MobileFullscreenSurface
            open
            variant={surfaceVariant}
            dialogAlign="app"
            onClose={closeSurface}
            ariaLabel={"Settings"}
            headerless
          >
            <ErrorBoundary>
              <SettingsView
                forceMobile={!isTabletLayout}
                isWindowed
                initialMobileStage={settingsInitialMobileStage}
                onClose={closeSurface}
              />
            </ErrorBoundary>
          </MobileFullscreenSurface>
        ) : null}

        {activeSurface === 'update' ? (
          <MobileFullscreenSurface
            open
            variant={surfaceVariant}
            dialogAlign="app"
            onClose={closeSurface}
            ariaLabel={"Update"}
            title={"Update"}
          >
            <ErrorBoundary>
              <div className="h-full overflow-auto px-5 py-4">
                <AboutSettings initialUpdateDialogOpen />
              </div>
            </ErrorBoundary>
          </MobileFullscreenSurface>
        ) : null}

        <ErrorBoundary>
          <ArchiveView />
        </ErrorBoundary>
      </div>
    </DedicatedMobileAppProvider>
  );
};

export function MobileApp({ apis }: MobileAppProps) {
  
  const initializeApp = useConfigStore((state) => state.initializeApp);
  const isInitialized = useConfigStore((state) => state.isInitialized);
  const isConnected = useConfigStore((state) => state.isConnected);
  const connectionPhase = useConfigStore((state) => state.connectionPhase);
  const providersCount = useConfigStore((state) => state.providers.length);
  const agentsCount = useConfigStore((state) => state.agents.length);
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const loadAgents = useConfigStore((state) => state.loadAgents);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const error = useSessionUIStore((state) => state.error);
  const clearError = useSessionUIStore((state) => state.clearError);
  const setIsMobile = useUIStore((state) => state.setIsMobile);
  const refreshGitHubAuthStatus = useGitHubAuthStore((state) => state.refreshStatus);
  const [connectionEpoch, setConnectionEpoch] = React.useState(0);
  const [runtimeEndpointEpoch, setRuntimeEndpointEpoch] = React.useState(0);
  const [showConnectionRecovery, setShowConnectionRecovery] = React.useState(false);
  // Cold-launch auto-connect to the last instance: 'pending'/'attempting' hold the
  // splash so we don't flash the connect screen; 'done' means we either connected or
  // exhausted the attempt (then the connect screen shows).
  const [autoConnectPhase, setAutoConnectPhase] = React.useState<'pending' | 'attempting' | 'done'>('pending');
  // Why the cold-launch auto-connect fell through to the connect screen.
  const [autoConnectNotice, setAutoConnectNotice] = React.useState<MobileConnectionNotice | null>(null);
  // The instance the splash says we are connecting to. Read once on mount —
  // auto-connect targets the most-recent saved connection from the same list.
  const autoConnectLabel = React.useMemo(() => getAutoConnectTargetLabel(), []);
  // Bumped to force a re-render (and thus a fresh `sdk` prop for SyncProvider)
  // after a same-device transport swap — reconnects the sync layer in place with
  // no remount. The value itself is unused; only the re-render matters.
  const [, bumpTransportSwitch] = React.useReducer((count: number) => count + 1, 0);
  const isNativeMobileApp = React.useMemo(() => isCapacitorMobileApp(), []);
  const lastNativeResumeSyncEventAtRef = React.useRef(0);
  const nativeResumeValidationSeqRef = React.useRef(0);

  const handleNativeResume = React.useCallback(() => {
    const apiBaseUrl = getRuntimeApiBaseUrl();
    const validationSeq = nativeResumeValidationSeqRef.current + 1;
    nativeResumeValidationSeqRef.current = validationSeq;

    if (!apiBaseUrl) {
      // Already disconnected — e.g. a previous re-probe ran mid network flux
      // (Android Wi-Fi switch with no cellular fallback) and found nothing
      // reachable. When a resume/online signal arrives, silently retry the last
      // saved instance instead of dead-ending on the connect screen until the
      // user restarts the app. Success fires runtime-endpoint-changed, which
      // re-bootstraps everything.
      void autoConnectLastInstance();
      return;
    }

    // Re-probe the active device's transports on resume: the network may have
    // changed while the app slept, so hot-switch LAN⇄relay if a better transport
    // is now reachable — no re-pairing. A 'switched' outcome already fired the
    // runtime-endpoint-changed subscription (which re-bootstraps the app), so we
    // only refresh in place when the transport is 'unchanged'.
    const refreshInPlace = () => {
      void initializeApp();
      void refreshGitHubAuthStatus(apis.github, { force: true });
      if (providersCount === 0) void loadProviders({ source: 'mobileApp:nativeResume' });
      if (agentsCount === 0) void loadAgents({ source: 'mobileApp:nativeResume' });
    };
    const disconnect = () => {
      switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
      setConnectionEpoch((value) => value + 1);
    };

    void reprobeActiveConnection().then((outcome) => {
      if (nativeResumeValidationSeqRef.current !== validationSeq) return;
      if (outcome === 'no-connection') {
        disconnect();
        return;
      }
      if (outcome === 'needs-login') {
        // Token explicitly rejected (revoked/expired) — tell the user why they
        // land back on the connect screen instead of silently bouncing them.
        setAutoConnectNotice({ kind: 'auth-expired', label: getAutoConnectTargetLabel() ?? '' });
        disconnect();
        return;
      }
      if (outcome === 'unreachable') {
        // Right after a resume or Wi-Fi switch the network is often still
        // settling (on Android without a SIM there is NO connectivity at all for
        // a few seconds), so a single fast probe races the network coming up.
        // Retry once after a grace period before tearing the connection down.
        window.setTimeout(() => {
          if (nativeResumeValidationSeqRef.current !== validationSeq) return;
          void reprobeActiveConnection().then((retry) => {
            if (nativeResumeValidationSeqRef.current !== validationSeq) return;
            if (retry === 'switched') return;
            if (retry === 'unchanged') {
              refreshInPlace();
              return;
            }
            if (retry === 'needs-login') {
              setAutoConnectNotice({ kind: 'auth-expired', label: getAutoConnectTargetLabel() ?? '' });
            }
            disconnect();
          });
        }, 4000);
        return;
      }
      if (outcome === 'switched') return;

      refreshInPlace();
    });

    const now = Date.now();
    if (now - lastNativeResumeSyncEventAtRef.current >= NATIVE_RESUME_SYNC_EVENT_THROTTLE_MS) {
      lastNativeResumeSyncEventAtRef.current = now;
      window.dispatchEvent(new Event('pichamber:system-resume'));
    }
  }, [agentsCount, apis.github, initializeApp, loadAgents, loadProviders, providersCount, refreshGitHubAuthStatus]);

  useNativeMobileChrome();
  useNativeMobileLifecycle(handleNativeResume);

  React.useEffect(() => startMobileErrorLogCapture(), []);

  // Network-change re-probe. The resume hook only fires on background→foreground,
  // but on Android switching Wi-Fi (quick-settings tile) does NOT background the
  // app — no visibility/appState event ever fires, so the app would sit on a dead
  // LAN transport instead of hot-switching to relay. The webview's `online` event
  // fires on connectivity changes (new Wi-Fi, cellular back, airplane off), so
  // run the same re-probe then. Debounced: the first seconds after `online` the
  // route is often not usable yet, and rapid offline/online flaps must collapse
  // into one probe. iOS also gets this (harmless — same seq-guarded operation the
  // resume path runs; a concurrent duplicate supersedes via the seq ref).
  React.useEffect(() => {
    if (!isNativeMobileApp) return;
    let timer: number | undefined;
    const handleOnline = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => handleNativeResume(), 1500);
    };
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.clearTimeout(timer);
    };
  }, [isNativeMobileApp, handleNativeResume]);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  // Switching instances (or disconnecting) only changes the runtime endpoint; the
  // stores still hold the previous instance's data. Mirror the web App.tsx reset
  // sequence so the UI fully re-bootstraps against the new server instead of going
  // stale. The SyncProvider is keyed by runtimeEndpointEpoch so it remounts too.
  React.useEffect(() => {
    return subscribeRuntimeEndpointChanged((detail) => {
      // A LAN⇄relay swap for the SAME device keeps the runtime key stable. Treat
      // that as a transport-only change: rebind the sync layer to the new
      // transport but keep the user's session/connection state — no reconnecting
      // screen, no bounce back to the draft. Only a real instance switch (key
      // change) does the full reset.
      const sameDevice = Boolean(detail.runtimeKey) && detail.runtimeKey === detail.previousRuntimeKey;
      if (sameDevice) {
        // Transport-only swap for the same device: rebind the SDK to the new
        // transport and force a re-render so SyncProvider receives the new `sdk`
        // prop. Its event-pipeline + bootstrap effects (keyed on `sdk`) then
        // reconnect over the new transport WITHOUT remounting — so the message
        // pagination refs, the open session, and the whole view are preserved.
        // No key bump, no flash, no bounce to the draft.
        reconnectAppForTransportSwitch();
        bumpTransportSwitch();
        return;
      }
      resetAppForRuntimeEndpointChange(detail);
      setRuntimeEndpointEpoch((epoch) => epoch + 1);
      setConnectionEpoch((epoch) => epoch + 1);
    });
  }, []);

  React.useEffect(() => {
    // Runtime settings must be reloaded after the new endpoint is
    // authenticated. If the switch requires login, this component unmounts
    // while the auth gate is pending and avoids an avoidable 401 burst.
    void syncDesktopSettings();
  }, [runtimeEndpointEpoch]);

  // On cold launch, silently reconnect to the most-recent saved instance so a
  // returning user — and notification deep-links — land in the app instead of the
  // connect screen. The splash is held while we try (see render below). If there's
  // no saved instance, it's unreachable, or it needs a (re)login, we fall through
  // to the connect screen. A successful switchRuntimeEndpoint fires the endpoint-
  // changed subscription above, which bumps the epochs and bootstraps the app.
  React.useEffect(() => {
    if (!isNativeMobileApp || isConnected || getRuntimeApiBaseUrl()) {
      setAutoConnectPhase('done');
      return;
    }
    let cancelled = false;
    setAutoConnectPhase('attempting');
    void autoConnectLastInstance()
      .catch((): AutoConnectOutcome => ({ status: 'no-candidate' }))
      .then((outcome) => {
        if (cancelled) return;
        // Landing on the connect screen silently reads as data loss — say WHY
        // the saved instance didn't come back (unreachable vs revoked auth).
        if (outcome.status === 'unreachable') {
          setAutoConnectNotice({ kind: 'unreachable', label: outcome.label });
        } else if (outcome.status === 'needs-login') {
          setAutoConnectNotice({ kind: 'auth-expired', label: outcome.label });
        }
        setAutoConnectPhase('done');
      });
    return () => {
      cancelled = true;
    };
    // Run once on mount — auto-connect is a cold-launch concern only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cold launch with a PERSISTED runtime endpoint (the auto-connect effect
  // above skips this case): the app used to just sit on the recovery splash
  // for 8s while bootstrap failed, then show a vague "unable to reach server"
  // screen. Classify the failure with a fast re-probe instead: unreachable or
  // rejected auth drops straight to the connect screen with a banner saying
  // why; a switched/alive transport lets bootstrap proceed as usual.
  React.useEffect(() => {
    // NOTE: do NOT gate on isConnected here — the persisted store can claim a
    // stale `isConnected: true` at mount, which would skip the classification
    // exactly when it's needed. Check it at resolution time instead.
    if (!isNativeMobileApp || !getRuntimeApiBaseUrl()) return;
    let cancelled = false;
    const dropToConnectScreen = (notice: MobileConnectionNotice | null) => {
      if (notice) setAutoConnectNotice(notice);
      switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
      setConnectionEpoch((value) => value + 1);
    };
    void reprobeActiveConnection().then(async (outcome) => {
      if (cancelled) return;
      // A genuinely live connection established itself while we probed.
      if (outcome === 'switched' || outcome === 'unchanged') return;
      const label = getAutoConnectTargetLabel();
      if (outcome === 'needs-login') {
        dropToConnectScreen({ kind: 'auth-expired', label: label ?? '' });
        return;
      }
      if (outcome === 'unreachable') {
        dropToConnectScreen(label ? { kind: 'unreachable', label } : null);
        return;
      }
      // 'no-connection': at cold start the runtime key may not map to a saved
      // connection yet — fall back to the auto-connect path, which both
      // classifies the failure and connects when everything is actually fine.
      const fallback = await autoConnectLastInstance().catch((): AutoConnectOutcome => ({ status: 'no-candidate' }));
      if (cancelled || fallback.status === 'connected') return;
      if (fallback.status === 'needs-login') {
        dropToConnectScreen({ kind: 'auth-expired', label: fallback.label });
      } else if (fallback.status === 'unreachable') {
        dropToConnectScreen({ kind: 'unreachable', label: fallback.label });
      } else {
        dropToConnectScreen(null);
      }
    });
    return () => {
      cancelled = true;
    };
    // Run once on mount — a cold-launch classification only; live drops are
    // handled by the resume/online re-probe paths.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    setIsMobile(true);
  }, [setIsMobile]);

  React.useEffect(() => {
    // Never bootstrap without a runtime endpoint on native: with apiBaseUrl ''
    // the resolver falls back to the webview's own origin, where Capacitor's
    // static server answers every request with index.html — the bootstrap
    // "succeeds" against a fake backend and flips isConnected back on, leaving
    // the user in an empty shell after a disconnect.
    if (isNativeMobileApp && !getRuntimeApiBaseUrl()) return;
    void initializeApp();
  }, [connectionEpoch, initializeApp, isNativeMobileApp]);

  React.useEffect(() => {
    if (!isConnected) return;
    if (providersCount === 0) void loadProviders({ source: 'mobileApp:recovery' });
    if (agentsCount === 0) void loadAgents({ source: 'mobileApp:recovery' });
  }, [agentsCount, isConnected, loadAgents, loadProviders, providersCount]);

  // Cold-launch continuity: after the launch instance connects, reopen the
  // session that was open on this instance last time — but only after an
  // authoritative sessions snapshot confirms it still exists, and only if the
  // user hasn't opened a session in the meantime. An open new-session draft
  // does NOT block the restore: ChatContainer auto-opens the draft whenever no
  // session is active, so at this point it reflects the boot default, not a
  // user choice. Runs once per successful launch connect; in-app instance
  // switches keep using the in-memory per-runtime session memory instead.
  const lastSessionRestoreDoneRef = React.useRef(false);
  // While true, a logo overlay covers the shell so the user never sees the
  // intermediate auto-opened draft before the restore decision lands.
  const [lastSessionRestorePending, setLastSessionRestorePending] = React.useState(isNativeMobileApp);
  React.useEffect(() => {
    if (!isNativeMobileApp || !isConnected || lastSessionRestoreDoneRef.current) return;
    if (useSessionUIStore.getState().currentSessionId) {
      lastSessionRestoreDoneRef.current = true;
      setLastSessionRestorePending(false);
      return;
    }
    const runtimeKey = getRuntimeKey();
    const persisted = readLastActiveSession(runtimeKey);
    if (!persisted) {
      lastSessionRestoreDoneRef.current = true;
      setLastSessionRestorePending(false);
      return;
    }
    let cancelled = false;
    // Safety valve: the overlay must never strand the user on the splash if
    // the snapshot hangs — fall through to the draft after a bounded wait.
    const overlayTimeoutId = window.setTimeout(() => setLastSessionRestorePending(false), 6000);
    void (async () => {
      // `null` = fetch failure — keep the ref unset so the next connect (a
      // stale persisted isConnected can fire this early) retries the restore.
      const snapshot = await refreshGlobalSessions().catch(() => null);
      if (cancelled) return;
      if (!snapshot) {
        setLastSessionRestorePending(false);
        return;
      }
      lastSessionRestoreDoneRef.current = true;
      const session = snapshot.activeSessions.find((entry) => entry.id === persisted.sessionId);
      if (!session) {
        // Authoritative snapshot says the session is gone (deleted/archived) —
        // drop the stale pointer instead of retrying it on every launch.
        clearLastActiveSession(runtimeKey);
        setLastSessionRestorePending(false);
        return;
      }
      const latest = useSessionUIStore.getState();
      if (!latest.currentSessionId) {
        void latest.setCurrentSession(
          session.id,
          resolveGlobalSessionDirectory(session) ?? persisted.directory ?? undefined,
        );
      }
      setLastSessionRestorePending(false);
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(overlayTimeoutId);
    };
  }, [connectionEpoch, isConnected, isNativeMobileApp]);

  React.useEffect(() => {
    if (!isConnected) return;
    opencodeClient.setDirectory(currentDirectory);
  }, [currentDirectory, isConnected]);

  // Gated on isConnected (and re-run on reconnect/instance switch): probing the
  // GitHub auth status before the runtime is reachable cached a "not connected"
  // answer that stuck until something else forced a re-check.
  React.useEffect(() => {
    if (!isConnected) return;
    void refreshGitHubAuthStatus(apis.github, { force: true });
  }, [apis.github, isConnected, refreshGitHubAuthStatus]);



  React.useEffect(() => {
    if (!error) return;
    const timeout = window.setTimeout(() => clearError(), 5000);
    return () => window.clearTimeout(timeout);
  }, [clearError, error]);

  React.useEffect(() => {
    // Native: only while an instance is selected and reconnecting. Browser: the
    // runtime is same-origin (no explicit base URL), so any not-connected spell
    // counts — the splash holds until this fires, then the error screen shows.
    const waitingOnConnection = !isConnected && (isNativeMobileApp ? Boolean(getRuntimeApiBaseUrl()) : true);
    if (!waitingOnConnection) {
      setShowConnectionRecovery(false);
      return;
    }
    // Native decides faster: the cold-start classification has usually already
    // resolved by then, so this is the "server picked but bootstrap won't
    // finish" fallback (e.g. older servers where auth can't be probed).
    const timeout = window.setTimeout(() => {
      setShowConnectionRecovery(true);
    }, isNativeMobileApp ? 4000 : 8000);
    return () => window.clearTimeout(timeout);
  }, [isConnected, isNativeMobileApp, connectionEpoch, runtimeEndpointEpoch]);

  useAppFontEffects();
  usePushVisibilityBeacon({ enabled: true });
  useRouter();
  // APNs is the only notification channel on the native app (background-capable,
  // focus-suppressed server-side via the visibility beacon). Local notifications are
  // intentionally disabled — they can't tell foreground from background in a WKWebView
  // (document.hasFocus() is unreliable) and leaked while the app was open; the in-app SSE
  // notification dispatch is no-op'd for native in renderMobileApp.
  useNativePushRegistration({ enabled: isNativeMobileApp && isConnected });
  // Single native deep-link entry point: notification taps AND the pichamber:// URL
  // scheme (widgets, Live Activities, external links). Registered unconditionally so a
  // cold-launch tap/open isn't lost on the connect/splash screen; intents stash until
  // the app is ready (connected + initialized) and shell handlers are registered.
  useDeepLinkSource({ ready: isNativeMobileApp && isConnected && isInitialized });
  const fontsReady = useFontsReady();

  // `isConnected` is a LIVE flag that flips false on every transient SSE/WS drop and
  // back true on reconnect. We must NOT blank the whole app to a loader on those —
  // only on the initial connect / instance switch (connectionPhase 'connecting').
  // While 'reconnecting' (we were connected before), keep MobileShell mounted so the
  // UI doesn't reload on every network blip.
  const isReconnecting = !isConnected && connectionPhase === 'reconnecting';

  // Hold a logo splash until the UI web font is loaded, so the first UI the user sees
  // already uses the real font instead of flashing the fallback and reflowing (FOUT).
  if (!fontsReady) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background text-foreground">
        <PiChamberLogo width={120} height={120} isAnimated />
      </main>
    );
  }

  // No runtime endpoint on native = explicitly disconnected (last instance
  // deleted, revoked token, unreachable). The connect screen is the only valid
  // UI then — regardless of what a stale isConnected flag claims (the store can
  // be poisoned by a bootstrap that ran against the webview's own origin).
  const hasRuntimeEndpoint = Boolean(getRuntimeApiBaseUrl());

  if (isNativeMobileApp && (!hasRuntimeEndpoint || (!isConnected && !isReconnecting))) {
    // A runtime endpoint is already selected (first connect or switching instances):
    // show a loader while it re-bootstraps instead of flashing the onboarding screen.
    if (hasRuntimeEndpoint) {
      return (
        <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-center text-foreground">
          <div className="flex max-w-sm flex-col items-center gap-4">
            <PiChamberLogo width={120} height={120} isAnimated={!showConnectionRecovery} />
            {showConnectionRecovery ? (
              <>
                <div className="space-y-2">
                  <h1 className="typography-h3 text-foreground">{"Unable to reach server"}</h1>
                  {/* Native copy — the browser-oriented sessionAuth description
                      (Desktop Network Access etc.) reads as noise here. */}
                  <p className="typography-body text-muted-foreground">{"Could not connect to the saved server. Check that it is running, or pick another instance."}</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
                    setConnectionEpoch((value) => value + 1);
                  }}
                >
                  {"Use another server"}
                </Button>
              </>
            ) : null}
          </div>
        </main>
      );
    }
    // Cold-launch auto-connect is still resolving — hold the splash instead of
    // flashing the connect screen. Only show the connect screen once we've finished
    // (no saved instance, unreachable, or needs re-login).
    if (autoConnectPhase !== 'done') {
      return (
        <main className="relative flex min-h-dvh items-center justify-center bg-background text-foreground">
          <PiChamberLogo width={120} height={120} isAnimated />
          {/* Absolutely positioned below the (still perfectly centered) logo so
              the text never pushes it up. 50% + half the 120px logo + a gap. */}
          {autoConnectLabel ? (
            <div className="absolute inset-x-0 top-[calc(50%+84px)] flex flex-col items-center gap-0.5 px-6 text-center">
              <p className="typography-small text-muted-foreground">{"Connecting to device:"}</p>
              <p className="typography-small text-foreground">
                {autoConnectLabel}
                <BusyDots />
              </p>
            </div>
          ) : null}
        </main>
      );
    }
    return (
      <>
        <MobileConnectionWelcome
          onConnected={() => setConnectionEpoch((value) => value + 1)}
          notice={autoConnectNotice}
        />
      </>
    );
  }

  if (!isConnected && !isReconnecting) {
    // Browser: the initial connect takes a beat — hold the logo splash instead
    // of flashing the unreachable-server error while it resolves. The error
    // only shows once the recovery delay has expired (genuinely unreachable).
    if (!showConnectionRecovery) {
      return (
        <main className="flex min-h-dvh items-center justify-center bg-background text-foreground">
          <PiChamberLogo width={120} height={120} isAnimated />
        </main>
      );
    }
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-center text-foreground">
        <div className="max-w-sm space-y-3">
          <h1 className="typography-h3 text-foreground">{"Unable to reach server"}</h1>
          <p className="typography-body text-muted-foreground">{"We could not verify the UI session. If you're opening PiChamber from another device on your local network, make sure Desktop Network Access is enabled on the desktop app and use the LAN address shown in Settings."}</p>
        </div>
      </main>
    );
  }

  return (
    <ErrorBoundary>
      <PiSessionProvider key={runtimeEndpointEpoch}>
        <RuntimeAPIProvider apis={apis}>
          <WindowTitleEffect />
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            <FireworksProvider>
              <DeferredUpdatePolling />
              <div className="h-full bg-background text-foreground">
                {/* Cold-launch continuity: keep the boot logo up over the shell
                    until the last-session restore decides between session and
                    draft — otherwise the auto-opened draft flashes first. The
                    shell (and sync) still mounts and warms up underneath. */}
                {isNativeMobileApp && lastSessionRestorePending ? (
                  <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
                    <PiChamberLogo width={120} height={120} isAnimated />
                  </div>
                ) : null}
                <SyncAppEffects embeddedBackgroundWorkEnabled={isInitialized} />
                <MobileAppUpdateToast />
                <MobileShell onActiveConnectionDeleted={() => {
                  switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' });
                  setConnectionEpoch((value) => value + 1);
                }} />
                <SessionDialogs />
                <Toaster position="top-center" offset="calc(var(--oc-safe-area-top, 0px) + 16px)" />
                <PerfHudHost />
                {isInitialized ? <ConfigUpdateOverlay /> : null}
              </div>
            </FireworksProvider>
          </TooltipProvider>
        </RuntimeAPIProvider>
      </PiSessionProvider>
    </ErrorBoundary>
  );
}
