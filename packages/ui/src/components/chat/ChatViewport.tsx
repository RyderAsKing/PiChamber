import React from 'react';
import type { Part } from '@/lib/chat/types';
import MessageList, { type MessageListHandle } from './MessageList';
import { StatusRowContainer } from './StatusRowContainer';
import { PromptNavigatorRail } from './components/PromptNavigatorRail';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import type { AnimationHandlers, ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { Button } from '@/components/ui/button';
import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { isFullySyntheticMessage } from '@/lib/messages/synthetic';
import { normalizeUserDisplayParts } from './message/normalizeUserDisplayParts';
import { findShellCommandForMessage, isUserShellMarkerMessage } from './lib/shellBridge';
import type { StreamPhase } from './message/types';
import type { PiCompactionInfo } from '@/lib/pi/types';
import {
  CHAT_SCROLL_STYLE,
  type SessionMessageRecord,
  shouldIgnoreChatNavigationTarget,
} from './chatContainerNavigation';

export type ChatViewportProps = {
  currentSessionId: string;
  currentSessionKey: string;
  isDesktopExpandedInput: boolean;
  isMobile: boolean;
  stickyUserHeader: boolean;
  directory?: string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  messageListRef: React.RefObject<MessageListHandle | null>;
  pendingRevealWork: boolean;
  renderedMessages: SessionMessageRecord[];
  isLoadingOlder: boolean;
  sessionIsWorking: boolean;
  streamingMessageId: string | null;
  activeStreamingPhase: StreamPhase | null;
  retryOverlay: {
    sessionId: string;
    message: string;
    confirmedAt?: number;
    fallbackTimestamp?: number;
  } | null;
  compactionOverlay: {
    sessionId: string;
    compaction: PiCompactionInfo;
  } | null;
  handleMessageContentChange: (reason?: ContentChangeReason) => void;
  getAnimationHandlers: (messageId: string) => AnimationHandlers;
  handleHistoryScroll: () => void;
  scrollToBottom: () => void;
  isProgrammaticFollowActive: boolean;
  showLoadOlderButton: boolean;
  onLoadOlder: () => void;
  turnIds: string[];
  activeTurnId: string | null;
  onSelectTurn: (turnId: string) => void;
  showPromptNavigator: boolean;
  canLoadEarlierPrompts: boolean;
  isLoadingOlderPrompts: boolean;
  onLoadEarlierPrompts: () => void;
};

export const ChatViewport = React.memo(
  ({
    currentSessionId,
    currentSessionKey,
    isDesktopExpandedInput,
    isMobile,
    stickyUserHeader,
    directory,
    scrollRef,
    messageListRef,
    pendingRevealWork,
    renderedMessages,
    isLoadingOlder,
    sessionIsWorking,
    streamingMessageId,
    activeStreamingPhase,
    retryOverlay,
    compactionOverlay,
    handleMessageContentChange,
    getAnimationHandlers,
    handleHistoryScroll,
    scrollToBottom,
    isProgrammaticFollowActive,
    showLoadOlderButton,
    onLoadOlder,
    turnIds,
    activeTurnId,
    onSelectTurn,
    showPromptNavigator,
    canLoadEarlierPrompts,
    isLoadingOlderPrompts,
    onLoadEarlierPrompts,
  }: ChatViewportProps) => {
    const promptPreviewsByTurnIdRef = React.useRef<Map<string, Part[]>>(new Map());
    // Cache normalized parts per source array so unchanged messages keep the
    // same reference and the memo below can bail out to the previous map.
    const normalizedPromptPartsCache = React.useRef(new WeakMap<Part[], Part[]>());
    // Shell-mode prompts show their extracted command; cache by message id so
    // the parts array reference is stable while the command is unchanged.
    const shellPreviewCache = React.useRef<Map<string, { command: string; parts: Part[] }>>(
      new Map()
    );
    const shellPreviewSessionRef = React.useRef(currentSessionId);
    if (shellPreviewSessionRef.current !== currentSessionId) {
      shellPreviewSessionRef.current = currentSessionId;
      shellPreviewCache.current.clear();
    }
    const promptPreviewsByTurnId = React.useMemo(() => {
      const next = new Map<string, Part[]>();
      for (let index = 0; index < renderedMessages.length; index += 1) {
        const message = renderedMessages[index];
        if (message.info.role !== 'user') {
          continue;
        }
        if (isUserShellMarkerMessage(message)) {
          const command = findShellCommandForMessage(renderedMessages, index) ?? '';
          const cached = shellPreviewCache.current.get(message.info.id);
          if (cached && cached.command === command) {
            next.set(message.info.id, cached.parts);
          } else {
            const parts = [{ type: 'text', text: command ? `$ ${command}` : '/shell' } as Part];
            shellPreviewCache.current.set(message.info.id, { command, parts });
            next.set(message.info.id, parts);
          }
          continue;
        }
        // Other fully synthetic user messages (loop continuations,
        // plan-mode injections) are not prompts the user typed — keep
        // them out of the navigator entirely.
        if (isFullySyntheticMessage(message.parts)) {
          continue;
        }
        let displayParts = normalizedPromptPartsCache.current.get(message.parts);
        if (!displayParts) {
          displayParts = normalizeUserDisplayParts(message.parts);
          normalizedPromptPartsCache.current.set(message.parts, displayParts);
        }
        if (displayParts.length === 0) {
          continue;
        }
        next.set(message.info.id, displayParts);
      }
      const prev = promptPreviewsByTurnIdRef.current;
      if (prev.size === next.size) {
        let unchanged = true;
        for (const [id, parts] of next) {
          if (prev.get(id) !== parts) {
            unchanged = false;
            break;
          }
        }
        if (unchanged) {
          return prev;
        }
      }
      promptPreviewsByTurnIdRef.current = next;
      return next;
    }, [renderedMessages]);
    // Only real (non-synthetic) prompts become rail entries; selection still
    // targets the same turn anchors as the timeline.
    const promptTurnIds = React.useMemo(
      () => turnIds.filter((id) => promptPreviewsByTurnId.has(id)),
      [promptPreviewsByTurnId, turnIds]
    );
    // If the viewport sits in a filtered-out (synthetic) turn, treat the
    // nearest preceding real prompt as active so the rail doesn't jump.
    const railActiveTurnId = React.useMemo(() => {
      if (!activeTurnId || promptPreviewsByTurnId.has(activeTurnId)) {
        return activeTurnId;
      }
      const activeIndex = turnIds.indexOf(activeTurnId);
      for (let index = activeIndex - 1; index >= 0; index -= 1) {
        const turnId = turnIds[index];
        if (promptPreviewsByTurnId.has(turnId)) {
          return turnId;
        }
      }
      return null;
    }, [activeTurnId, promptPreviewsByTurnId, turnIds]);
    const focusScrollContainer = React.useCallback(
      (event: React.MouseEvent<HTMLElement>) => {
        if (event.defaultPrevented || shouldIgnoreChatNavigationTarget(event.target)) {
          return;
        }

        if (typeof window !== 'undefined' && window.getSelection()?.type === 'Range') {
          return;
        }

        scrollRef.current?.focus({ preventScroll: true });
      },
      [scrollRef]
    );

    return (
      <div
        className={cn(
          'relative min-h-0',
          isDesktopExpandedInput
            ? 'absolute inset-0 opacity-0 pointer-events-none'
            : 'flex-1'
        )}
        aria-hidden={isDesktopExpandedInput}
      >
        <div className="absolute inset-0">
          <ScrollShadow
            className="absolute inset-0 overflow-y-auto overflow-x-hidden z-0 chat-scroll overlay-scrollbar-target"
            ref={scrollRef}
            style={CHAT_SCROLL_STYLE}
            observeMutations={false}
            hideTopShadow={isMobile && stickyUserHeader}
            tabIndex={0}
            onClick={focusScrollContainer}
            onScroll={handleHistoryScroll}
            data-scroll-shadow="true"
            data-scrollbar="chat"
          >
            <div className="relative z-0 min-h-full">
              {showLoadOlderButton && (
                <div className="flex justify-center pt-3 pb-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={onLoadOlder}
                    disabled={isLoadingOlder}
                  >
                    {isLoadingOlder && (
                      <Icon name="loader-4" className="size-4 animate-spin" />
                    )}
                    {"Load older messages"}
                  </Button>
                </div>
              )}
              <MessageList
                key={currentSessionKey}
                ref={messageListRef}
                sessionKey={currentSessionId}
                disableStaging={pendingRevealWork}
                messages={renderedMessages}
                sessionIsWorking={sessionIsWorking}
                activeStreamingMessageId={streamingMessageId}
                activeStreamingPhase={activeStreamingPhase}
                retryOverlay={retryOverlay}
                compactionOverlay={compactionOverlay}
                onMessageContentChange={handleMessageContentChange}
                getAnimationHandlers={getAnimationHandlers}
                isLoadingOlder={isLoadingOlder}
                scrollToBottom={scrollToBottom}
                scrollRef={scrollRef}
                directory={directory}
              />

              <div className="mb-3">
                <StatusRowContainer />
              </div>

              <div
                className="flex-shrink-0"
                style={{
                  height: isMobile
                    ? 'calc(40px + var(--oc-safe-area-bottom, 0px))'
                    : 'calc(10vh + var(--oc-safe-area-bottom, 0px))',
                }}
                aria-hidden="true"
              />
            </div>
          </ScrollShadow>
          <OverlayScrollbar
            containerRef={scrollRef}
            suppressVisibility={isProgrammaticFollowActive}
            userIntentOnly
            observeMutations={false}
          />
          {showPromptNavigator && promptTurnIds.length >= 2 ? (
            <PromptNavigatorRail
              turnIds={promptTurnIds}
              previewsByTurnId={promptPreviewsByTurnId}
              activeTurnId={railActiveTurnId}
              onSelectTurn={onSelectTurn}
              canLoadEarlier={canLoadEarlierPrompts}
              isLoadingOlder={isLoadingOlderPrompts}
              onLoadEarlier={onLoadEarlierPrompts}
            />
          ) : null}
        </div>
      </div>
    );
  },
  (prev, next) => {
    return (
      prev.currentSessionId === next.currentSessionId &&
      prev.currentSessionKey === next.currentSessionKey &&
      prev.isDesktopExpandedInput === next.isDesktopExpandedInput &&
      prev.isMobile === next.isMobile &&
      prev.stickyUserHeader === next.stickyUserHeader &&
      prev.directory === next.directory &&
      prev.scrollRef === next.scrollRef &&
      prev.messageListRef === next.messageListRef &&
      prev.pendingRevealWork === next.pendingRevealWork &&
      prev.renderedMessages === next.renderedMessages &&
      prev.isLoadingOlder === next.isLoadingOlder &&
      prev.sessionIsWorking === next.sessionIsWorking &&
      prev.streamingMessageId === next.streamingMessageId &&
      prev.activeStreamingPhase === next.activeStreamingPhase &&
      prev.retryOverlay === next.retryOverlay &&
      prev.compactionOverlay === next.compactionOverlay &&
      prev.handleMessageContentChange === next.handleMessageContentChange &&
      prev.getAnimationHandlers === next.getAnimationHandlers &&
      prev.handleHistoryScroll === next.handleHistoryScroll &&
      prev.scrollToBottom === next.scrollToBottom &&
      prev.isProgrammaticFollowActive === next.isProgrammaticFollowActive &&
      prev.showLoadOlderButton === next.showLoadOlderButton &&
      prev.onLoadOlder === next.onLoadOlder &&
      prev.turnIds === next.turnIds &&
      prev.activeTurnId === next.activeTurnId &&
      prev.onSelectTurn === next.onSelectTurn &&
      prev.showPromptNavigator === next.showPromptNavigator &&
      prev.canLoadEarlierPrompts === next.canLoadEarlierPrompts &&
      prev.isLoadingOlderPrompts === next.isLoadingOlderPrompts &&
      prev.onLoadEarlierPrompts === next.onLoadEarlierPrompts
    );
  }
);

ChatViewport.displayName = 'ChatViewport';
