import React from 'react';

import { AboutSettings } from '@/components/sections/pichamber/AboutSettings';
import { ChatView } from '@/components/views/ChatView';
import { SettingsView } from '@/components/views/SettingsView';
import { ArchiveView } from '@/components/views/ArchiveView';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { readTabletLayout, useOrientation, useTabletLayout } from '@/lib/device';
import { useHardwareKeyboard } from '@/lib/hardwareKeyboard';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useUpdateStore } from '@/stores/useUpdateStore';
import type { ViewTarget } from './deepLinks';

import { MobileHeader } from './MobileHeader';
import { MobileInstancesSurface } from './MobileInstancesSurface';
import { MobileSessionsSheet } from './MobileSessionsSheet';
import { MobileFullscreenSurface } from './MobileFullscreenSurface';
import { MobileWorkspaceDrawer, type MobileWorkspaceTab } from './MobileWorkspaceDrawer';
import { DedicatedMobileAppProvider, type MobileAppActions } from './mobileAppContext';
import { getAutoConnectTargetLabel } from './mobileConnections';
import { isCapacitorMobileApp, useNativeAndroidBackButton } from './mobileNativeChrome';
import { useDeepLinkHandlers } from './deepLinkNavigation';
import { useEdgeSwipe } from './useEdgeSwipe';
import {
  applyPhoneDrawerProgress,
  applyTabletPanelProgress,
  beginPhoneDrawerDrag,
  beginTabletPanelDrag,
  settlePhoneDrawerViaRefs,
  settleTabletPanel,
} from './drawerSurface';
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

export type MobileSurface = 'instances' | 'settings' | 'update';

// Sidebar state changes must not rerender the transcript/composer tree. ChatView
// subscribes to its own session state, so parent layout changes can safely be
// memoized away here.
const MobileChatView = React.memo(ChatView);

export type MobileShellProps = {
  onActiveConnectionDeleted: () => void;
};

export const MobileShell: React.FC<MobileShellProps> = ({ onActiveConnectionDeleted }) => {
  const [sessionsSheetOpen, setSessionsSheetOpen] = React.useState(false);
  const [activeSurface, setActiveSurface] = React.useState<MobileSurface | null>(null);
  // Phone right drawer with the workspace tabs; the tab persists across
  // open/close so the right-edge swipe reopens where the user left off.
  const [workspaceOpen, setWorkspaceOpen] = React.useState(false);
  const [workspaceTab, setWorkspaceTab] = React.useState<MobileWorkspaceTab>('changes');

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
