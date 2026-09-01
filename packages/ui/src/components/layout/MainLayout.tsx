import React, { useRef, useEffect } from 'react';
import { animate, motion, useMotionValue } from 'motion/react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { TitlebarLeftControls } from './TitlebarLeftControls';
import { ContextPanel } from './ContextPanel';
import { ContextPanelRail } from './ContextPanelRail';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { CommandPalette } from '../ui/CommandPalette';
import { HelpDialog } from '../ui/HelpDialog';
import { SessionSidebar } from '@/components/session/SessionSidebar';
import { SessionDialogs } from '@/components/session/SessionDialogs';
import { ArchiveView } from '@/components/views/ArchiveView';
import { DiffWorkerProvider } from '@/contexts/DiffWorkerProvider';
import { TerminalView } from '@/components/views/TerminalView';
import { DrawerProvider } from '@/contexts/DrawerContext';

import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { DeferredUpdatePolling } from '@/hooks/useUpdatePolling';
import { useDeviceInfo } from '@/lib/device';
import { useEdgeSwipe } from '@/apps/useEdgeSwipe';
import { cn } from '@/lib/utils';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';

import { ChatView } from '@/components/views/ChatView';

// Keep TerminalView eager: the bottom dock reserves its height immediately, so
// suspending here leaves a large blank panel on slower machines.
// Other heavy views stay on-demand to reduce initial bundle parse time:
// DiffView/FilesView pull the CodeMirror and @pierre/diffs stacks into the
// startup graph when imported statically.
const GitView = lazyWithChunkRecovery(() => import('@/components/views/GitView').then(m => ({ default: m.GitView })));
const DiffView = lazyWithChunkRecovery(() => import('@/components/views/DiffView').then(m => ({ default: m.DiffView })));
const FilesView = lazyWithChunkRecovery(() => import('@/components/views/FilesView').then(m => ({ default: m.FilesView })));
const DiagramView = lazyWithChunkRecovery(() => import('@/components/views/DiagramView').then(m => ({ default: m.DiagramView })));
const SettingsView = lazyWithChunkRecovery(() => import('@/components/views/SettingsView').then(m => ({ default: m.SettingsView })));
const SettingsWindow = lazyWithChunkRecovery(() => import('@/components/views/SettingsWindow').then(m => ({ default: m.SettingsWindow })));

export const MainLayout: React.FC = () => {
    const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
    const activeMainTab = useUIStore((state) => state.activeMainTab);
    const setIsMobile = useUIStore((state) => state.setIsMobile);
    const isSessionSwitcherOpen = useUIStore((state) => state.isSessionSwitcherOpen);
    const isSettingsDialogOpen = useUIStore((state) => state.isSettingsDialogOpen);
    const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
    // Mount the windowed settings dialog only after its first open: rendering
    // the lazy component (even closed) makes React fetch the SettingsView
    // chunk graph (CodeMirror editor, vim mode, theme tooling) on startup.
    // Once opened it stays mounted so the close animation and state behave as
    // before.
    const [settingsWindowMounted, setSettingsWindowMounted] = React.useState(false);
    React.useEffect(() => {
        if (isSettingsDialogOpen) {
            setSettingsWindowMounted(true);
        }
    }, [isSettingsDialogOpen]);
    React.useEffect(() => {
        const closeSurfacePages = () => useUIStore.getState().closeMainSurfaces();
        const unsubscribeSession = useSessionUIStore.subscribe((state, prev) => {
            const sessionSelected = Boolean(state.currentSessionId) && state.currentSessionId !== prev.currentSessionId;
            // Draft identity change covers re-opening a draft while one is
            // already open (the boolean alone never transitions then).
            const draftOpened = Boolean(state.newSessionDraft?.open) && state.newSessionDraft !== prev.newSessionDraft;
            if (sessionSelected || draftOpened) closeSurfacePages();
        });
        const unsubscribeTab = useUIStore.subscribe((state, prev) => {
            if (state.activeMainTab !== prev.activeMainTab) closeSurfacePages();
        });
        return () => {
            unsubscribeSession();
            unsubscribeTab();
        };
    }, []);
    const { isMobile } = useDeviceInfo();
    const mobilePanelsResetRef = React.useRef(false);

    // Mobile drawer state
    const [mobileLeftDrawerOpen, setMobileLeftDrawerOpen] = React.useState(false);
    const [mobileRightSidebarOpen, setMobileRightSidebarOpen] = React.useState(false);
    const [mobileLeftDrawerVisible, setMobileLeftDrawerVisible] = React.useState(false);
    const [mobileRightDrawerVisible, setMobileRightDrawerVisible] = React.useState(false);
    const setMobileSessionPanelOpen = React.useCallback((open: boolean) => {
        setMobileLeftDrawerOpen(open);
        useUIStore.getState().setSessionSwitcherOpen(open);
    }, []);
    const initialDrawerWidthRef = React.useRef(typeof window === 'undefined' ? 0 : window.innerWidth);
    const mainInteractiveRef = React.useRef<HTMLElement>(null);
    const isDraggingRef = React.useRef(false);
    const dragStartLeftOpenRef = React.useRef(false);
    const dragStartRightOpenRef = React.useRef(false);
    const leftAnimateRef = React.useRef<ReturnType<typeof animate> | null>(null);
    const rightAnimateRef = React.useRef<ReturnType<typeof animate> | null>(null);

    // Left drawer motion value
    const leftDrawerX = useMotionValue(-initialDrawerWidthRef.current);
    const leftDrawerWidth = useRef(0);

    // Right drawer motion value
    const rightDrawerX = useMotionValue(initialDrawerWidthRef.current);
    const rightDrawerWidth = useRef(0);

    // Compute drawer width
    useEffect(() => {
        if (isMobile) {
            leftDrawerWidth.current = window.innerWidth;
            rightDrawerWidth.current = window.innerWidth;
        }
    }, [isMobile]);

    // Keep widths in sync on resize/orientation change so the off-screen
    // position stays correctly at -width. Without this a rotation would leave
    // the closed drawer peeking at the old width.
    useEffect(() => {
        if (!isMobile) return;
        const syncWidths = () => {
            const w = window.innerWidth;
            leftDrawerWidth.current = w;
            rightDrawerWidth.current = w;
            // If closed, snap to new off-screen position without animation
            if (!mobileLeftDrawerOpen) {
                const cur = leftDrawerX.get();
                if (cur < -10) leftDrawerX.set(-w);
            }
            if (!mobileRightSidebarOpen) {
                const cur = rightDrawerX.get();
                if (cur > 10) rightDrawerX.set(w);
            }
        };
        window.addEventListener('resize', syncWidths);
        window.addEventListener('orientationchange', syncWidths as EventListener);
        return () => {
            window.removeEventListener('resize', syncWidths);
            window.removeEventListener('orientationchange', syncWidths as EventListener);
        };
    }, [isMobile, leftDrawerX, rightDrawerX, mobileLeftDrawerOpen, mobileRightSidebarOpen]);

    // Sync left drawer state and motion value
    useEffect(() => {
        if (!isMobile) {
            setMobileLeftDrawerVisible(false);
            return;
        }
        if (mobileLeftDrawerOpen) {
            setMobileLeftDrawerVisible(true);
        }
        const w = leftDrawerWidth.current || initialDrawerWidthRef.current || (typeof window !== 'undefined' ? window.innerWidth : 0);
        const controls = animate(leftDrawerX, mobileLeftDrawerOpen ? 0 : -w, {
            type: 'spring',
            stiffness: 400,
            damping: 35,
            mass: 0.8,
        });
        leftAnimateRef.current = controls;
        return () => controls.stop();
    }, [mobileLeftDrawerOpen, isMobile, leftDrawerX]);

    // Sync right drawer state and motion value
    useEffect(() => {
        if (!isMobile) {
            setMobileRightDrawerVisible(false);
            return;
        }
        if (mobileRightSidebarOpen) {
            setMobileRightDrawerVisible(true);
        }
        const w = rightDrawerWidth.current || initialDrawerWidthRef.current || (typeof window !== 'undefined' ? window.innerWidth : 0);
        const controls = animate(rightDrawerX, mobileRightSidebarOpen ? 0 : w, {
            type: 'spring',
            stiffness: 400,
            damping: 35,
            mass: 0.8,
        });
        rightAnimateRef.current = controls;
        return () => controls.stop();
    }, [isMobile, mobileRightSidebarOpen, rightDrawerX]);

    useEffect(() => {
        if (!isMobile) return;
        return leftDrawerX.on('change', (value) => {
            const width = leftDrawerWidth.current || initialDrawerWidthRef.current;
            const visible = mobileLeftDrawerOpen || value > -width + 0.5;
            setMobileLeftDrawerVisible((previous) => previous === visible ? previous : visible);
        });
    }, [isMobile, leftDrawerX, mobileLeftDrawerOpen]);

    useEffect(() => {
        if (!isMobile) return;
        return rightDrawerX.on('change', (value) => {
            const width = rightDrawerWidth.current || initialDrawerWidthRef.current;
            const visible = mobileRightSidebarOpen || value < width - 0.5;
            setMobileRightDrawerVisible((previous) => previous === visible ? previous : visible);
        });
    }, [isMobile, mobileRightSidebarOpen, rightDrawerX]);

    // Sync session switcher close events to left drawer.
    useEffect(() => {
        if (isMobile && !isSessionSwitcherOpen && mobileLeftDrawerOpen) {
            setMobileSessionPanelOpen(false);
        }
    }, [isSessionSwitcherOpen, isMobile, mobileLeftDrawerOpen, setMobileSessionPanelOpen]);

    useEffect(() => {
        if (!isMobile) {
            mobilePanelsResetRef.current = false;
            return;
        }

        if (mobilePanelsResetRef.current) {
            return;
        }

        mobilePanelsResetRef.current = true;
        setMobileSessionPanelOpen(false);
        setMobileRightSidebarOpen(false);
    }, [isMobile, setMobileSessionPanelOpen]);

    useEffect(() => {
        if (!isMobile || activeMainTab !== 'chat' || mobileLeftDrawerOpen || mobileRightSidebarOpen || isSettingsDialogOpen) {
            return;
        }

        let disposed = false;
        let timeoutId: number | undefined;

        const scheduleDraftOpen = (delayMs: number) => {
            timeoutId = window.setTimeout(() => {
                if (disposed) {
                    return;
                }

                const sessionState = useSessionUIStore.getState();
                const uiState = useUIStore.getState();
                if (uiState.activeMainTab !== 'chat' || uiState.isSettingsDialogOpen || sessionState.currentSessionId || sessionState.newSessionDraft?.open) {
                    return;
                }

                if (sessionState.isLoading) {
                    scheduleDraftOpen(250);
                    return;
                }

                sessionState.openNewSessionDraft({ automatic: true });
            }, delayMs);
        };

        scheduleDraftOpen(500);

        return () => {
            disposed = true;
            if (timeoutId !== undefined) {
                window.clearTimeout(timeoutId);
            }
        };
    }, [activeMainTab, isMobile, isSettingsDialogOpen, mobileLeftDrawerOpen, mobileRightSidebarOpen]);

    // Ensure mobile drawers are closed when opening full-screen settings
    useEffect(() => {
        if (!isMobile || !isSettingsDialogOpen) {
            return;
        }

        setMobileSessionPanelOpen(false);
        setMobileRightSidebarOpen(false);
    }, [isMobile, isSettingsDialogOpen, setMobileSessionPanelOpen]);

    React.useEffect(() => {
        const previous = useUIStore.getState().isMobile;
        if (previous !== isMobile) {
            setIsMobile(isMobile);
        }
    }, [isMobile, setIsMobile]);

    const handleToggleMobileRightDrawer = React.useCallback(() => {
        if (mobileLeftDrawerOpen) {
            setMobileSessionPanelOpen(false);
        }
        setMobileRightSidebarOpen(!mobileRightSidebarOpen);
    }, [mobileLeftDrawerOpen, mobileRightSidebarOpen, setMobileSessionPanelOpen]);

    // Horizontal drawer swipes follow the finger and settle with velocity and
    // progress. Motion values update frame-by-frame without React state.
    useEdgeSwipe(mainInteractiveRef, {
        enabled: isMobile,
        leftOpen: mobileLeftDrawerOpen,
        rightOpen: mobileRightSidebarOpen,
        leftWidth: () => leftDrawerWidth.current || initialDrawerWidthRef.current || (typeof window !== 'undefined' ? window.innerWidth : 0),
        rightWidth: () => rightDrawerWidth.current || initialDrawerWidthRef.current || (typeof window !== 'undefined' ? window.innerWidth : 0),
        onLeftProgress: (p) => {
            const w = leftDrawerWidth.current || initialDrawerWidthRef.current || (typeof window !== 'undefined' ? window.innerWidth : 0);
            leftDrawerX.set(w * (p - 1));
        },
        onRightProgress: (p) => {
            const w = rightDrawerWidth.current || initialDrawerWidthRef.current || (typeof window !== 'undefined' ? window.innerWidth : 0);
            rightDrawerX.set(w * (1 - p));
        },
        onLeftOpen: () => {
            if (mobileRightSidebarOpen) setMobileRightSidebarOpen(false);
            setMobileSessionPanelOpen(true);
        },
        onLeftClose: () => setMobileSessionPanelOpen(false),
        onRightOpen: () => {
            if (mobileLeftDrawerOpen) setMobileSessionPanelOpen(false);
            setMobileRightSidebarOpen(true);
        },
        onRightClose: () => setMobileRightSidebarOpen(false),
        onDragStart: (side) => {
            isDraggingRef.current = true;
            if (side === 'left') {
                dragStartLeftOpenRef.current = mobileLeftDrawerOpen;
                leftAnimateRef.current?.stop();
                if (!mobileLeftDrawerVisible) setMobileLeftDrawerVisible(true);
            } else {
                dragStartRightOpenRef.current = mobileRightSidebarOpen;
                rightAnimateRef.current?.stop();
                if (!mobileRightDrawerVisible) setMobileRightDrawerVisible(true);
            }
        },
        onDragEnd: (side, didSettleOpen) => {
            isDraggingRef.current = false;
            // If the gesture settled to the same state it started from
            // (e.g. dragged 30% but didn't cross threshold), the
            // open-state hasn't changed so the spring effect above won't
            // re-run — manually spring back to the start position.
            if (side === 'left' && typeof didSettleOpen === 'boolean') {
                const startedOpen = dragStartLeftOpenRef.current;
                if (didSettleOpen === startedOpen) {
                    const w = leftDrawerWidth.current || initialDrawerWidthRef.current || (typeof window !== 'undefined' ? window.innerWidth : 0);
                    const controls = animate(leftDrawerX, startedOpen ? 0 : -w, {
                        type: 'spring',
                        stiffness: 400,
                        damping: 35,
                        mass: 0.8,
                    });
                    leftAnimateRef.current = controls;
                }
            }
            if (side === 'right' && typeof didSettleOpen === 'boolean') {
                const startedOpen = dragStartRightOpenRef.current;
                if (didSettleOpen === startedOpen) {
                    const w = rightDrawerWidth.current || initialDrawerWidthRef.current || (typeof window !== 'undefined' ? window.innerWidth : 0);
                    const controls = animate(rightDrawerX, startedOpen ? 0 : w, {
                        type: 'spring',
                        stiffness: 400,
                        damping: 35,
                        mass: 0.8,
                    });
                    rightAnimateRef.current = controls;
                }
            }
        },
    });

    const secondaryView = React.useMemo(() => {
        // Desktop surfaces live in the context panel; the only full-view
        // overlays left there are the terminal (promoted by project actions)
        // and the diagram viewer. Mobile keeps the full tab set; the Git view
        // is normally opened in the right drawer and is not mounted at startup.
        // A route-addressable active Git tab remains available as a full view.
        if (!isMobile && activeMainTab !== 'terminal' && activeMainTab !== 'diagram') {
            return null;
        }
        const mobileGitDrawerVisible = mobileRightSidebarOpen || mobileRightDrawerVisible;
        if (isMobile && activeMainTab === 'git' && mobileGitDrawerVisible) {
            return null;
        }
        switch (activeMainTab) {
            case 'git':
                // Mobile keeps the route-addressable full view when the drawer is closed;
                // otherwise URLs such as ?tab=git would leave the main area blank.
                return <React.Suspense fallback={null}><GitView isActive={true} /></React.Suspense>;
            case 'diff':
                return <React.Suspense fallback={null}><DiffView /></React.Suspense>;
            case 'terminal':
                return <TerminalView />;
            case 'files':
                return <React.Suspense fallback={null}><FilesView /></React.Suspense>;
            case 'diagram':
                return <React.Suspense fallback={null}><DiagramView /></React.Suspense>;
            default:
                return null;
        }
    }, [activeMainTab, isMobile, mobileRightDrawerVisible, mobileRightSidebarOpen]);

    const isChatActive = activeMainTab === 'chat';

    return (
        <DiffWorkerProvider>
            <DeferredUpdatePolling />
            <div
                data-page-scroll-lock="true"
                className={cn(
                    'main-content-safe-area',
                    isMobile ? 'flex h-[100dvh] flex-col' : 'relative flex h-[100dvh]',
                    'bg-background'
                )}
            >
                <CommandPalette />
                <HelpDialog />
                <SessionDialogs />

                {isMobile ? (
                <DrawerProvider value={{
                    leftDrawerOpen: mobileLeftDrawerOpen,
                    rightDrawerOpen: mobileRightSidebarOpen,
                    toggleLeftDrawer: () => {
                        const nextOpen = !mobileLeftDrawerOpen;
                        if (mobileRightSidebarOpen) {
                            setMobileRightSidebarOpen(false);
                        }
                        setMobileSessionPanelOpen(nextOpen);
                    },
                    toggleRightDrawer: handleToggleMobileRightDrawer,
                    leftDrawerX,
                    rightDrawerX,
                    leftDrawerWidth,
                    rightDrawerWidth,
                    setMobileLeftDrawerOpen: setMobileSessionPanelOpen,
                    setRightSidebarOpen: setMobileRightSidebarOpen,
                }}>
                    {/* Mobile: header + drawer mode */}
                    {!isSettingsDialogOpen && <Header 
                        onToggleLeftDrawer={() => {
                            const nextOpen = !mobileLeftDrawerOpen;
                            if (mobileRightSidebarOpen) {
                                setMobileRightSidebarOpen(false);
                            }
                            setMobileSessionPanelOpen(nextOpen);
                        }}
                        onToggleRightDrawer={() => {
                            handleToggleMobileRightDrawer();
                        }}
                        leftDrawerOpen={mobileLeftDrawerOpen}
                        rightDrawerOpen={mobileRightSidebarOpen}
                    />}
                    
                    {/* Main content area (fixed) */}
                    <div
                        data-page-scroll-lock="true"
                        className={cn(
                            'flex flex-1 overflow-hidden relative',
                            isSettingsDialogOpen && 'hidden'
                        )}
                    >
                        <main ref={mainInteractiveRef as React.RefObject<HTMLElement>} className="w-full h-full overflow-hidden bg-background relative" data-page-scroll-lock="true" style={{ touchAction: 'pan-x pan-y' as const }}>
                            <div className={cn('absolute inset-0', !isChatActive && 'invisible')}>
                                <ErrorBoundary><ChatView active={isChatActive && !isSettingsDialogOpen} /></ErrorBoundary>
                            </div>
                            {secondaryView && (
                                <div className="absolute inset-0">
                                    <ErrorBoundary>{secondaryView}</ErrorBoundary>
                                </div>
                            )}
                            <ErrorBoundary><ArchiveView /></ErrorBoundary>
                            {/* Always mount SessionSidebar on mobile to match desktop behavior.
                                Conditional mount (mobileLeftDrawerVisible && ...) caused a
                                data-loading cascade on every drawer open: paginated sessions
                                fetch, worktree discovery, repo status, PR status, and 10+ memo
                                recomputations. On Android PWA this manifested as a >10s delay
                                before the drawer became interactive (issue #1695). Visibility is
                                controlled by the leftDrawerX transform (off-screen when closed).
                                The invisible class matters when fully hidden: leftDrawerWidth is
                                not recomputed on resize/rotation, so a closed drawer translated by
                                the old width could otherwise peek into the viewport; it also keeps
                                the off-screen sidebar out of the tab order and skips painting it. */}
                            <motion.div
                                className={cn(
                                    'absolute inset-0 z-20 bg-sidebar',
                                    !mobileLeftDrawerVisible && 'pointer-events-none invisible',
                                )}
                                data-page-scroll-lock="true"
                                style={{ x: leftDrawerX }}
                                aria-hidden={!mobileLeftDrawerOpen}
                            >
                                <ErrorBoundary>
                                    <SessionSidebar mobileVariant isVisible={mobileLeftDrawerVisible} />
                                </ErrorBoundary>
                            </motion.div>
                            <motion.div
                                className={cn(
                                    'absolute inset-0 z-20 bg-sidebar',
                                    !mobileRightDrawerVisible && 'pointer-events-none invisible',
                                )}
                                data-page-scroll-lock="true"
                                style={{ x: rightDrawerX }}
                                aria-hidden={!mobileRightSidebarOpen}
                            >
                                <ErrorBoundary>
                                    {(mobileRightSidebarOpen || mobileRightDrawerVisible) ? (
                                        <React.Suspense fallback={null}><GitView isActive={mobileRightSidebarOpen} /></React.Suspense>
                                    ) : null}
                                </ErrorBoundary>
                            </motion.div>
                        </main>
                    </div>

                    {/* Mobile settings: full screen */}
                    {isSettingsDialogOpen && (
                        <div
                            className="absolute inset-0 z-10 bg-background"
                            style={{ paddingTop: 'var(--oc-safe-area-top, 0px)' }}
                        >
                            <ErrorBoundary>
                                <React.Suspense fallback={null}>
                                    <SettingsView onClose={() => setSettingsDialogOpen(false)} />
                                </React.Suspense>
                            </ErrorBoundary>
                        </div>
                    )}
                </DrawerProvider>
            ) : (
                <>
                    {/* Persistent top-left window chrome; the collapsed-sidebar
                        toggle also lives here so it stays reachable. */}
                    <TitlebarLeftControls />
                    {/* Desktop: full-height Sidebar beside [Header above (chat | RightSidebar)] */}
                    <div className="flex flex-1 overflow-hidden" data-page-scroll-lock="true">
                        <Sidebar
                            isOpen={isSidebarOpen}
                            isMobile={isMobile}
                        >
                            <SessionSidebar isVisible={isSidebarOpen} />
                        </Sidebar>
                        <div className="relative flex flex-1 min-w-0 flex-col overflow-hidden bg-background" data-page-scroll-lock="true">
                            <Header />
                            <div className="relative flex flex-1 min-h-0 overflow-hidden bg-background" data-page-scroll-lock="true">
                                <div className="relative flex flex-1 min-w-0 flex-col overflow-hidden border-t border-border bg-background" data-page-scroll-lock="true">
                                    <div className="flex flex-1 min-h-0 overflow-hidden" data-page-scroll-lock="true">
                                        {/* Holds the chat and the context panel together. */}
                                        <div className="relative flex flex-1 min-h-0 min-w-0 overflow-hidden" data-page-scroll-lock="true" data-chat-area="true">
                                            <main className="flex-1 overflow-hidden bg-background relative" data-page-scroll-lock="true">
                                                <div className={cn('absolute inset-0', !isChatActive && 'invisible')}>
                                                    <ErrorBoundary><ChatView active={isChatActive && !isSettingsDialogOpen} /></ErrorBoundary>
                                                </div>
                                                {secondaryView && (
                                                    <div className="absolute inset-0">
                                                        <ErrorBoundary>{secondaryView}</ErrorBoundary>
                                                    </div>
                                                )}
                                                <ErrorBoundary><ArchiveView /></ErrorBoundary>
                                            </main>
                                            <ContextPanel />
                                        </div>
                                    </div>
                                </div>
                                <div className="border-t border-border" data-page-scroll-lock="true">
                                    <ErrorBoundary><ContextPanelRail /></ErrorBoundary>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Desktop settings: windowed dialog with blur */}
                    {settingsWindowMounted ? (
                        <React.Suspense fallback={null}>
                            <SettingsWindow
                                open={isSettingsDialogOpen}
                                onOpenChange={setSettingsDialogOpen}
                            />
                        </React.Suspense>
                    ) : null}
                </>
            )}

        </div>
    </DiffWorkerProvider>
    );
};
