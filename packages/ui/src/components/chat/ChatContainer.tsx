import React from 'react';
import type { Message, Session } from '@/lib/chat/types';

import { ChatInput } from './ChatInput';
import { ExtensionDialogOverlay } from './ExtensionDialogOverlay';
import { ExtensionStatusStrip, ExtensionNoticeToasts, ExtensionWidgetStrip } from './ExtensionStatusWidgets';
import { ExtensionPanelDock } from './extension/ExtensionPanelDock';
import { ExtensionAppSurfaces } from './extension/ExtensionAppSurfaces';
import { ComposerCommandTriggers } from './composer/ui/ComposerCommandTriggers';
import { useUIStore } from '@/stores/useUIStore';
import { PiChamberLogo } from '@/components/ui/PiChamberLogo';
import ChatEmptyState from './ChatEmptyState';
import { type MessageListHandle } from './MessageList';
import ScrollToBottomButton from './components/ScrollToBottomButton';
import { useChatAutoFollow } from '@/hooks/useChatAutoFollow';
import { useChatTimelineController } from './hooks/useChatTimelineController';
import { TimelineDialog } from './TimelineDialog';
import { useChatTurnNavigation } from './hooks/useChatTurnNavigation';
import { useChatSurfaceMode } from './chatSurfaceContext';
import { useDeviceInfo } from '@/lib/device';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';

// New sync system imports
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isNewSessionDraftSendPending } from '@/sync/session-ui-draft-helpers';
import {
    useSessionStreamingMessageId,
    usePiConnectionState,
    useSessionMessageCount,
    useSessionMessageRecords,
    useSessionMessageLoadState,
    useSyncDirectory,
    useSessionRenderable,
    useSessionStatus,
    useSessionCompaction,
    useScopedBlockingPermissions,
    useScopedBlockingQuestions,
    useParentSession,
} from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { createFirstVisibleSessionPerformanceTracker } from '@/sync/session-load-performance';
import { isSessionAssistantWorking } from './lib/turns/assistantWorkingState';
import { useGlobalSyncStore } from '@/sync/global-sync-store';
import { parseRoute } from '@/lib/router';
import {
    EMPTY_MESSAGES,
    IDLE_SESSION_STATUS,
    CHAT_FORCE_SCROLL_BOTTOM_EVENT,
    DEFAULT_RETRY_MESSAGE,
    composerBarClassName,
    shouldIgnoreChatNavigationTarget,
    shouldIgnoreChatNavigationForFocus,
    hasBlockingChatOverlay,
} from './chatContainerNavigation';
import { DraftWelcome } from './DraftWelcome';
import { ChatViewport } from './ChatViewport';

type ChatContainerProps = {
    active?: boolean;
    autoOpenDraft?: boolean;
};

export const ChatContainer: React.FC<ChatContainerProps> = ({ active = true, autoOpenDraft = true }) => {
    
    // Session UI state
    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const currentSessionDirectory = useSessionUIStore((s) => s.currentSessionDirectory);
    const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
    const setCurrentSession = useSessionUIStore((s) => s.setCurrentSession);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const sendingNewSessionDraftId = useSessionUIStore((s) => s.sendingNewSessionDraftId);
    const isSendingNewSession = isNewSessionDraftSendPending(
        newSessionDraft,
        currentSessionId,
        sendingNewSessionDraftId,
    );

    // Sync actions
    const sync = useSync();
    const syncDirectory = useSyncDirectory();
    const effectiveSessionDirectory = currentSessionDirectory ?? syncDirectory;
    const currentSessionKey = currentSessionId
        ? JSON.stringify([getRuntimeKey(), effectiveSessionDirectory, currentSessionId])
        : null;
    const ensureSessionRenderable = React.useCallback(
        (sessionId: string) => sync.ensureSessionRenderable(sessionId),
        [sync],
    );
    const loadMoreMessages = React.useCallback(
        () => sync.loadMore(),
        [sync],
    );

    // UI store
    const isExpandedInput = useUIStore((state) => state.isExpandedInput);
    const stickyUserHeader = useUIStore((state) => state.stickyUserHeader);
    const promptNavigatorEnabled = useUIStore((state) => state.promptNavigatorEnabled);
    const isTimelineDialogOpen = useUIStore((s) => s.isTimelineDialogOpen);
    const setTimelineDialogOpen = useUIStore((s) => s.setTimelineDialogOpen);

    // Streaming id comes from the Pi reducer, not the unused broad streaming store
    // streaming store. Transcript freeze is default in
    // `useSessionMessageRecords`; this id only drives the live-tail overlay.
    const connection = usePiConnectionState();
    const reducerStreamingMessageId = useSessionStreamingMessageId(currentSessionId ?? '');
    const streamingMessageId = connection === 'ready' ? reducerStreamingMessageId : null;
    const activeStreamingPhase = streamingMessageId ? 'streaming' : null;
    const sessionMessageCount = useSessionMessageCount(currentSessionId ?? '', effectiveSessionDirectory);
    const hasRenderableSessionSnapshot = useSessionRenderable(currentSessionId ?? '', effectiveSessionDirectory);
    // Messages from sync system
    const sessionMessageRecords = useSessionMessageRecords(currentSessionId ?? '', effectiveSessionDirectory);
    const sessionMessages = currentSessionId ? sessionMessageRecords : EMPTY_MESSAGES;
    const sessionMessageLoadState = useSessionMessageLoadState(
        currentSessionId ?? '',
        effectiveSessionDirectory,
    );
    const [firstVisiblePerformance] = React.useState(createFirstVisibleSessionPerformanceTracker);

    React.useEffect(() => {
        if (!active || !currentSessionKey || !hasRenderableSessionSnapshot || sessionMessages.length === 0) return;
        return firstVisiblePerformance.schedule(currentSessionKey, sessionMessages.length);
    }, [active, currentSessionKey, firstVisiblePerformance, hasRenderableSessionSnapshot, sessionMessages.length]);



    // Session status from sync system
    const sessionStatusForCurrent = useSessionStatus(currentSessionId ?? '', effectiveSessionDirectory) ?? IDLE_SESSION_STATUS;

    // Scoped blocking requests — only subscribe to permissions/questions for
    // the current session + descendant subagent sessions, not all sessions in
    // the directory.
    const sessionPermissions = useScopedBlockingPermissions();
    const sessionQuestions = useScopedBlockingQuestions();

    const sessionIsWorking = React.useMemo(() => {
        if (!currentSessionId || sessionPermissions.length > 0 || sessionQuestions.length > 0) {
            return false;
        }

        const statusType = sessionStatusForCurrent.type ?? 'idle';
        const lastMessage = sessionMessages[sessionMessages.length - 1]?.info as Message | undefined;
        const lastFinish = typeof (lastMessage as { finish?: string } | undefined)?.finish === 'string'
            ? (lastMessage as { finish?: string }).finish
            : undefined;
        const hasPendingAssistant = Boolean(
            lastMessage
            && lastMessage.role === 'assistant'
            && typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== 'number'
            && lastFinish !== 'stop'
            && lastFinish !== 'error',
        );
        return isSessionAssistantWorking({
            connection,
            authoritativeWorking: statusType === 'busy' || statusType === 'retry',
            hasPendingAssistant,
        });
    }, [connection, currentSessionId, sessionMessages, sessionPermissions.length, sessionQuestions.length, sessionStatusForCurrent.type]);
    const activeRetryStatus = React.useMemo(() => {
        if (!currentSessionId || sessionStatusForCurrent.type !== 'retry') {
            return null;
        }

        const rawMessage = typeof (sessionStatusForCurrent as { message?: string }).message === 'string'
            ? (((sessionStatusForCurrent as { message?: string }).message) ?? '').trim()
            : '';

        return {
            sessionId: currentSessionId,
            message: rawMessage || DEFAULT_RETRY_MESSAGE,
            confirmedAt: (sessionStatusForCurrent as { confirmedAt?: number }).confirmedAt,
        };
    }, [currentSessionId, sessionStatusForCurrent]);
    const compaction = useSessionCompaction(currentSessionId ?? '');
    const compactionOverlay = React.useMemo(() => currentSessionId && compaction
        ? { sessionId: currentSessionId, compaction }
        : null, [compaction, currentSessionId]);
    const [retryFallbackTimestamp, setRetryFallbackTimestamp] = React.useState<number>(0);
    const retryFallbackSessionRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!activeRetryStatus || typeof activeRetryStatus.confirmedAt === 'number') {
            retryFallbackSessionRef.current = null;
            setRetryFallbackTimestamp(0);
            return;
        }

        if (retryFallbackSessionRef.current !== activeRetryStatus.sessionId) {
            retryFallbackSessionRef.current = activeRetryStatus.sessionId;
            setRetryFallbackTimestamp(Date.now());
        }
    }, [activeRetryStatus]);

    const retryOverlay = React.useMemo(() => {
        if (!activeRetryStatus) {
            return null;
        }

        return {
            ...activeRetryStatus,
            fallbackTimestamp: retryFallbackTimestamp,
        };
    }, [activeRetryStatus, retryFallbackTimestamp]);

    // History metadata — use sync's hasMore/isLoading
    const historyMeta = React.useMemo(() => {
        if (!currentSessionId) return null;
        return {
            limit: sessionMessages.length,
            complete: sessionMessageLoadState.complete || !sessionMessageLoadState.cursor,
            loading: sessionMessageLoadState.status === 'loading',
        };
    }, [currentSessionId, sessionMessageLoadState.complete, sessionMessageLoadState.cursor, sessionMessageLoadState.status, sessionMessages.length]);

    const { isMobile } = useDeviceInfo();
    const chatSurfaceMode = useChatSurfaceMode();
    const draftOpen = Boolean(newSessionDraft?.open);
    const initError = useGlobalSyncStore((s) => s.error);
    // Despite the historical name, this now covers mobile fullscreen composer
    // (drag-handle swipe-up). Desktop focus mode is gone.
    const isDesktopExpandedInput = isMobile && isExpandedInput;
    const useCompactDraftLayout = isMobile || chatSurfaceMode === 'mini-chat';

    const messageListRef = React.useRef<MessageListHandle | null>(null);
    const parentSession = useParentSession();

    const handleReturnToParentSession = React.useCallback(() => {
        if (!parentSession) return;
        const parentDirectory = (parentSession as Session & { directory?: string | null }).directory ?? null;
        setCurrentSession(parentSession.id, parentDirectory);
    }, [parentSession, setCurrentSession]);

    const returnToParentButton = parentSession ? (
        <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={handleReturnToParentSession}
            className="absolute left-3 top-3 z-20 !font-normal bg-[var(--surface-background)]/95"
            aria-label={"Return to parent session"}
            title={parentSession.title?.trim()
                ? `Return to: ${parentSession.title}`
                : "Return to parent session"}
        >
            <Icon name="arrow-left" className="h-4 w-4" />
            {"Parent"}
        </Button>
    ) : null;

    React.useEffect(() => {
        const route = parseRoute();
        if (route.sessionId) return;
        if (autoOpenDraft && !currentSessionId && !draftOpen) {
            // Programmatic fallback, not user navigation — must not clear the
            // persisted last-session pointer the cold-launch restore reads.
            openNewSessionDraft({ automatic: true });
        }
    }, [autoOpenDraft, currentSessionId, draftOpen, openNewSessionDraft]);

    const activeTurnChangeRef = React.useRef<(turnId: string | null) => void>(() => {});
    const handleActiveTurnChange = React.useCallback((turnId: string | null) => {
        activeTurnChangeRef.current(turnId);
    }, []);

    const {
        scrollRef,
        notifyContentChange: handleMessageContentChange,
        getAnimationHandlers,
        goToBottom,
        scrollToBottomOnSend,
        releaseAutoFollow,
        restoreSnapshot,
        isPinned,
        isFollowingProgrammatically,
        showScrollButton,
    } = useChatAutoFollow({
        currentSessionId,
        currentSessionKey,
        sessionMessageCount,
        sessionIsWorking,
        isMobile,
        onActiveTurnChange: handleActiveTurnChange,
    });

    const viewportMessages = sessionMessages;

    const timelineController = useChatTimelineController({
        sessionId: currentSessionId,
        sessionKey: currentSessionKey,
        messages: viewportMessages,
        historyMeta,
        scrollRef,
        messageListRef,
        loadMoreMessages,
        goToBottom,
        releaseAutoFollow,
        isPinned,
        showScrollButton,
    });
    const resumeToLatestInstant = React.useCallback(() => {
        goToBottom('instant');
    }, [goToBottom]);
    // Mobile loads older history via an explicit top button instead of a
    // scroll-position trigger (see handleHistoryScroll in the controller).
    const showLoadOlderButton = isMobileSurfaceRuntime()
        && timelineController.historySignals.canLoadEarlier;
    const timelineLoadEarlier = timelineController.loadEarlier;
    const handleLoadOlderClick = React.useCallback(() => {
        void timelineLoadEarlier({ userInitiated: true });
    }, [timelineLoadEarlier]);

    React.useEffect(() => {
        activeTurnChangeRef.current = timelineController.handleActiveTurnChange;
    }, [timelineController.handleActiveTurnChange]);

    React.useEffect(() => {
        if (sessionPermissions.length === 0 && sessionQuestions.length === 0) {
            return;
        }
        handleMessageContentChange('permission');
    }, [handleMessageContentChange, sessionPermissions, sessionQuestions]);

    const navigation = useChatTurnNavigation({
        sessionId: currentSessionId,
        turnIds: timelineController.turnIds,
        activeTurnId: timelineController.activeTurnId,
        scrollToTurn: timelineController.scrollToTurn,
        scrollToMessage: timelineController.scrollToMessage,
        resumeToBottom: timelineController.resumeToBottomInstant,
    });
    const handlePromptNavigatorSelect = React.useCallback((turnId: string) => {
        void navigation.scrollToTurnId(turnId, { behavior: 'smooth' });
    }, [navigation]);
    const canLoadEarlierPrompts = timelineController.historySignals.canLoadEarlier;
    const showPromptNavigator = !isMobile
        && !isDesktopExpandedInput
        && promptNavigatorEnabled
        && timelineController.turnIds.length >= 2;

    React.useEffect(() => {
        if (!showPromptNavigator) {
            useUIStore.getState().setPromptNavigatorPanelOpen(false);
        }
    }, [showPromptNavigator]);

    React.useEffect(() => {
        if (typeof window === 'undefined' || !currentSessionId) return;

        const handleForceScrollBottom = (event: Event) => {
            const customEvent = event as CustomEvent<{ sessionId?: string }>;
            if (customEvent.detail?.sessionId && customEvent.detail.sessionId !== currentSessionId) return;
            goToBottom('instant');
        };

        window.addEventListener(CHAT_FORCE_SCROLL_BOTTOM_EVENT, handleForceScrollBottom as EventListener);
        return () => {
            window.removeEventListener(CHAT_FORCE_SCROLL_BOTTOM_EVENT, handleForceScrollBottom as EventListener);
        };
    }, [currentSessionId, goToBottom]);

    React.useEffect(() => {
        if (typeof window === 'undefined' || !currentSessionId || isDesktopExpandedInput) {
            return;
        }

        const handleChatTurnKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.isComposing) {
                return;
            }

            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
                return;
            }

            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
                return;
            }

            const { activeMainTab } = useUIStore.getState();
            if (activeMainTab !== 'chat' || hasBlockingChatOverlay()) {
                return;
            }

            const scrollContainer = scrollRef.current;
            if (shouldIgnoreChatNavigationForFocus(document.activeElement, scrollContainer)) {
                return;
            }

            if (shouldIgnoreChatNavigationTarget(event.target)) {
                return;
            }

            event.preventDefault();
            const offset = event.key === 'ArrowUp' ? -1 : 1;
            void navigation.scrollByTurnOffset(offset, { resumePastEnd: false });
        };

        window.addEventListener('keydown', handleChatTurnKeyDown);
        return () => {
            window.removeEventListener('keydown', handleChatTurnKeyDown);
        };
    }, [currentSessionId, isDesktopExpandedInput, navigation, scrollRef]);

    React.useLayoutEffect(() => {
        const container = scrollRef.current;
        if (!container) return;

        const updateChatScrollHeight = () => {
            container.style.setProperty('--chat-scroll-height', `${container.clientHeight}px`);
        };

        updateChatScrollHeight();

        let rafId = 0;
        const scheduleUpdate = () => {
            if (rafId) return;
            rafId = requestAnimationFrame(() => {
                rafId = 0;
                updateChatScrollHeight();
            });
        };

        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', scheduleUpdate);
            return () => {
                if (rafId) cancelAnimationFrame(rafId);
                window.removeEventListener('resize', scheduleUpdate);
            };
        }

        const resizeObserver = new ResizeObserver(scheduleUpdate);
        resizeObserver.observe(container);

        return () => {
            if (rafId) cancelAnimationFrame(rafId);
            resizeObserver.disconnect();
        };
    }, [currentSessionId, isDesktopExpandedInput, scrollRef]);

    const lastScrolledSessionKeyRef = React.useRef<string | null>(null);

    const isSessionHydrating =
        Boolean(currentSessionId)
        && !hasRenderableSessionSnapshot;
    const isSessionLoading =
        Boolean(currentSessionId)
        && (isSessionHydrating || sessionMessageLoadState.status === 'loading');
    const retrySessionLoad = React.useCallback(() => {
        if (!active || !currentSessionId) return;
        void sync.ensureSessionRenderable(currentSessionId);
    }, [active, currentSessionId, sync]);

    React.useEffect(() => {
        if (!active || !currentSessionId) return;
        if (lastScrolledSessionKeyRef.current === currentSessionKey) return;

        const hasHashTarget = typeof window !== 'undefined' && window.location.hash.length > 0;
        lastScrolledSessionKeyRef.current = currentSessionKey;
        if (hasHashTarget) {
            // Hash navigation handler will scroll to target; we just release auto-follow.
            releaseAutoFollow();
            return;
        }

        const run = () => {
            void restoreSnapshot();
        };
        if (typeof window === 'undefined') {
            run();
        } else {
            window.requestAnimationFrame(run);
        }
    }, [active, currentSessionId, currentSessionKey, releaseAutoFollow, restoreSnapshot]);

    React.useEffect(() => {
        if (!active || !currentSessionId) return;
        if (hasRenderableSessionSnapshot) return;
        void ensureSessionRenderable(currentSessionId);
    }, [active, currentSessionId, ensureSessionRenderable, hasRenderableSessionSnapshot]);

	if (!currentSessionId && !draftOpen) {
		// With auto-open, the draft welcome opens on the next tick (effect below),
		// so the empty state is only ever transient here — render a neutral
		// background instead of flashing the logo / "start a new chat" on refresh.
		// Keep the empty state when there's nothing to auto-open or an init error to show.
		if (autoOpenDraft && !initError) {
			return <div className="flex h-full flex-col bg-background" />;
		}
		return (
			<div className="flex flex-col h-full bg-background">
				<ChatEmptyState isNewSession />
			</div>
		);
	}

	if (!currentSessionId && draftOpen) {
		return (
			// No transform on this root: it would become the containing block for
			// the fullscreen composer's position:fixed visual-viewport pinning in
			// mobile browsers (see ChatInput's composerFormRef effect).
			<div data-composer-bound className="relative flex h-full flex-col bg-background animate-in fade-in-0 duration-200 motion-reduce:animate-none">
				{useCompactDraftLayout && !isDesktopExpandedInput ? <DraftWelcome /> : null}
				<div
					className={cn(
						'relative z-10 flex min-h-0',
						isDesktopExpandedInput
							? 'flex-1 bg-background'
							: useCompactDraftLayout
								? 'shrink-0 bg-background px-0'
								: 'flex-1 items-center justify-center bg-background px-0 pb-[6vh]'
					)}
				>
                        <ChatInput scrollToBottom={scrollToBottomOnSend} />
				</div>
			</div>
        );
    }

    if (!currentSessionId) {
        return null;
    }

	if (isSessionLoading) {
		if (sessionMessageLoadState.status === 'error') {
			return (
			<div data-composer-bound className="relative flex h-full flex-col bg-background animate-in fade-in-0 duration-200 motion-reduce:animate-none">
				{returnToParentButton}
				<div className="flex min-h-0 flex-1 items-center justify-center px-6">
						<div className="max-w-sm text-center">
							<div className="mx-auto mb-3 flex size-9 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--status-error)_10%,transparent)] text-[var(--status-error)]">
								<Icon name="error-warning" className="size-4" />
							</div>
							<p className="typography-ui-label font-medium text-foreground">{"Session could not be loaded"}</p>
							<p className="typography-meta mt-1 text-muted-foreground">{"Check the connection and try loading this session again."}</p>
							<Button variant="outline" size="sm" className="mt-4" onClick={retrySessionLoad}>
								{"Try again"}
							</Button>
						</div>
					</div>
					<div className={composerBarClassName(false)}>
						<ChatInput scrollToBottom={scrollToBottomOnSend} />
					</div>
				</div>
			);
		}
		return (
			<div data-composer-bound className="relative flex flex-col h-full bg-background animate-in fade-in-0 duration-200 motion-reduce:animate-none">
				{returnToParentButton}
				<div
					className={cn(
						'relative min-h-0 flex items-center justify-center',
                        isDesktopExpandedInput
                            ? 'absolute inset-0 opacity-0 pointer-events-none'
                            : 'flex-1'
                    )}
                    aria-hidden={isDesktopExpandedInput}
                >
                    <div className="flex flex-col items-center gap-3">
                        <PiChamberLogo width={120} height={120} isAnimated />
                        {isSendingNewSession ? (
                            <p role="status" className="typography-meta animate-pulse text-muted-foreground">{"Creating session…"}</p>
                        ) : null}
                    </div>
                </div>
                <div className={composerBarClassName(isDesktopExpandedInput)}>
                    <ChatInput scrollToBottom={scrollToBottomOnSend} />
				</div>
            </div>
        );
    }

	if (sessionMessages.length === 0 && !sessionIsWorking) {
		return (
			// A transcript-less extension command has configured the backend but has
			// not started the conversation. Keep the materialized session selected
			// while presenting the same composer-first surface as a new draft.
			<div data-composer-bound className="relative flex h-full flex-col bg-background animate-in fade-in-0 duration-200 motion-reduce:animate-none">
				{returnToParentButton}
				{useCompactDraftLayout && !isDesktopExpandedInput ? <DraftWelcome /> : null}
				<div
					className={cn(
						'relative z-10 flex min-h-0',
						isDesktopExpandedInput
							? 'flex-1 bg-background'
							: useCompactDraftLayout
								? 'shrink-0 bg-background px-0'
								: 'flex-1 items-center justify-center bg-background px-0 pb-[6vh]'
					)}
				>
					<ChatInput scrollToBottom={scrollToBottomOnSend} />
				</div>
				{/* Extension notices (e.g. mode-switch confirmations) toast here too:
				this branch owns sessions whose transcript is still empty. */}
				<ExtensionNoticeToasts sessionId={currentSessionId} />
			</div>
		);
	}

	return (
		<div data-composer-bound className="relative flex min-w-0 flex-1 flex-col h-full bg-background animate-in fade-in-0 duration-200 motion-reduce:animate-none">
			{returnToParentButton}
			<ChatViewport
				currentSessionId={currentSessionId}
                currentSessionKey={currentSessionKey ?? currentSessionId}
                isDesktopExpandedInput={isDesktopExpandedInput}
                isMobile={isMobile}
                stickyUserHeader={stickyUserHeader}
                directory={effectiveSessionDirectory}
                scrollRef={scrollRef}
                messageListRef={messageListRef}
                pendingRevealWork={timelineController.pendingRevealWork}
                renderedMessages={timelineController.renderedMessages}
                isLoadingOlder={timelineController.isLoadingOlder}
                sessionIsWorking={sessionIsWorking}
                streamingMessageId={streamingMessageId}
                activeStreamingPhase={activeStreamingPhase}
                retryOverlay={retryOverlay}
                compactionOverlay={compactionOverlay}
                handleMessageContentChange={handleMessageContentChange}
                getAnimationHandlers={getAnimationHandlers}
                handleHistoryScroll={timelineController.handleHistoryScroll}
                scrollToBottom={resumeToLatestInstant}
                isProgrammaticFollowActive={isFollowingProgrammatically}
                showLoadOlderButton={showLoadOlderButton}
                onLoadOlder={handleLoadOlderClick}
                turnIds={timelineController.turnIds}
                activeTurnId={timelineController.activeTurnId}
                onSelectTurn={handlePromptNavigatorSelect}
                showPromptNavigator={showPromptNavigator}
                canLoadEarlierPrompts={canLoadEarlierPrompts}
                isLoadingOlderPrompts={timelineController.isLoadingOlder}
                onLoadEarlierPrompts={handleLoadOlderClick}
            />

            <div className={composerBarClassName(isDesktopExpandedInput)}>
                {!isDesktopExpandedInput && sessionMessages.length > 0 && (
                    <ScrollToBottomButton
                        visible={timelineController.showScrollToBottom}
                        onClick={navigation.resumeToLatest}
                    />
                )}
                <ComposerCommandTriggers sessionId={currentSessionId} />
                <ExtensionAppSurfaces sessionId={currentSessionId} />
                <ExtensionPanelDock sessionId={currentSessionId} />
                <ExtensionWidgetStrip sessionId={currentSessionId} placement="aboveEditor" />
                <ExtensionStatusStrip sessionId={currentSessionId} />
                <ChatInput scrollToBottom={scrollToBottomOnSend} />
                <ExtensionWidgetStrip sessionId={currentSessionId} placement="belowEditor" />
            </div>

            <ExtensionDialogOverlay />
            <ExtensionNoticeToasts sessionId={currentSessionId} />

            <TimelineDialog
                open={isTimelineDialogOpen}
                onOpenChange={setTimelineDialogOpen}
                onScrollToMessage={timelineController.scrollToMessage}
                onScrollByTurnOffset={navigation.scrollByTurnOffset}
                onResumeToLatest={resumeToLatestInstant}
                canLoadEarlier={timelineController.historySignals.canLoadEarlier}
                isLoadingEarlier={timelineController.isLoadingOlder}
                onLoadEarlier={handleLoadOlderClick}
                onRevert={async (messageId) => {
                    if (!currentSessionId) return;
                    const entryId = messageId.includes(':') ? messageId.split(':')[0] ?? messageId : messageId;
                    await useSessionUIStore.getState().revertToMessage(currentSessionId, entryId);
                }}
                onFork={async (messageId) => {
                    if (!currentSessionId) return;
                    const entryId = messageId.includes(':') ? messageId.split(':')[0] ?? messageId : messageId;
                    await useSessionUIStore.getState().forkFromMessage(currentSessionId, entryId);
                }}
            />
        </div>
    );
};
