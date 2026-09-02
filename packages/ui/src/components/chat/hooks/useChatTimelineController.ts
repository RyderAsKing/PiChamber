import React from 'react';

import type { ChatMessageEntry } from '../lib/turns/types';
import type { MessageListHandle } from '../MessageList';
import {
  buildTurnWindowModel,
  updateTurnWindowModelIncremental,
  type TurnWindowModel,
} from '../lib/turns/windowTurns';
import type { TurnHistorySignals } from '../lib/turns/historySignals';
import { getMemoryLimits, type SessionHistoryMeta } from '@/stores/types/sessionTypes';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import {
  HISTORY_INTERACTION_GUARD_MS,
  HISTORY_RENDER_WAIT_TIMEOUT_MS,
  isOlderHistoryPrependCommit,
  rememberTurnModel,
  resolveHistoryScrollThreshold,
  SCROLL_PIN_TIMEOUT_MS,
  shouldAutoLoadEarlierForUnderfilledPinnedViewport,
  turnModelCache,
  type PendingScrollRequest,
  type TimelineIdentityToken,
  type ViewportAnchor,
} from './timelineScrollHelpers';
import { useChatTimelinePrependCompensation } from './useChatTimelinePrependCompensation';

export {
  isOlderHistoryPrependCommit,
  shouldAutoLoadEarlierForUnderfilledPinnedViewport,
};

export type {
  TimelineIdentityToken,
  ViewportAnchor,
};

export interface UseChatTimelineControllerOptions {
  sessionId: string | null;
  sessionKey: string | null;
  messages: ChatMessageEntry[];
  historyMeta: SessionHistoryMeta | null;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  messageListRef: React.RefObject<MessageListHandle | null>;
  loadMoreMessages: (sessionId: string, direction: 'up' | 'down') => Promise<void>;
  goToBottom: (mode?: 'instant' | 'smooth') => void;
  releaseAutoFollow: () => void;
  isPinned: boolean;
  showScrollButton: boolean;
}

export interface UseChatTimelineControllerResult {
  turnIds: string[];
  turnStart: number;
  renderedMessages: ChatMessageEntry[];
  historySignals: TurnHistorySignals;
  isLoadingOlder: boolean;
  pendingRevealWork: boolean;
  activeTurnId: string | null;
  showScrollToBottom: boolean;
  turnWindowModel: TurnWindowModel;
  loadEarlier: (options?: { userInitiated?: boolean }) => Promise<void>;
  revealBufferedTurns: () => Promise<boolean>;
  resumeToBottom: () => void;
  resumeToBottomInstant: () => Promise<void>;
  scrollToTurn: (turnId: string, options?: { behavior?: ScrollBehavior }) => Promise<boolean>;
  scrollToMessage: (messageId: string, options?: { behavior?: ScrollBehavior }) => Promise<boolean>;
  handleHistoryScroll: () => void;
  captureViewportAnchor: () => ViewportAnchor | null;
  restoreViewportAnchor: (anchor: ViewportAnchor) => boolean;
  handleActiveTurnChange: (turnId: string | null) => void;
}

export const useChatTimelineController = ({
  sessionId,
  sessionKey,
  messages,
  historyMeta,
  scrollRef,
  messageListRef,
  loadMoreMessages,
  goToBottom,
  releaseAutoFollow,
  isPinned,
  showScrollButton,
}: UseChatTimelineControllerOptions): UseChatTimelineControllerResult => {
  const previousTurnWindowModelRef = React.useRef<TurnWindowModel | null>(null);
  const previousMessagesRef = React.useRef<ChatMessageEntry[] | null>(null);
  const previousTurnWindowKeyRef = React.useRef<string | null>(null);
  const turnWindowModel = React.useMemo(() => {
    const key = sessionKey ?? '';
    if (previousTurnWindowKeyRef.current !== sessionKey) {
      previousTurnWindowKeyRef.current = sessionKey;
      previousTurnWindowModelRef.current = null;
      previousMessagesRef.current = null;
    }
    const cached = key ? turnModelCache.get(key) : undefined;
    if (cached && cached.messages === messages) {
      rememberTurnModel(key, cached);
      previousTurnWindowModelRef.current = cached.model;
      previousMessagesRef.current = messages;
      return cached.model;
    }

    const incrementalModel = updateTurnWindowModelIncremental(
      previousTurnWindowModelRef.current,
      previousMessagesRef.current,
      messages,
    );
    const nextModel = incrementalModel ?? buildTurnWindowModel(messages);
    previousTurnWindowModelRef.current = nextModel;
    previousMessagesRef.current = messages;

    if (key && messages.length > 0) {
      rememberTurnModel(key, { messages, model: nextModel });
    }

    return nextModel;
  }, [messages, sessionKey]);

  const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
  const [pendingRevealWork, setPendingRevealWork] = React.useState(false);
  const [activeTurnId, setActiveTurnId] = React.useState<string | null>(null);

  const turnModelRef = React.useRef(turnWindowModel);
  const isPinnedRef = React.useRef(isPinned);
  const isLoadingOlderRef = React.useRef(isLoadingOlder);
  const pendingRevealWorkRef = React.useRef(pendingRevealWork);
  const sessionIdRef = React.useRef<string | null>(sessionId);
  const timelineIdentityRef = React.useRef<TimelineIdentityToken>({ key: sessionKey });
  if (timelineIdentityRef.current.key !== sessionKey) {
    timelineIdentityRef.current = { key: sessionKey };
  }
  const messagesRef = React.useRef(messages);
  const historyMetaRef = React.useRef<SessionHistoryMeta | null>(historyMeta);
  const initializedSessionKeyRef = React.useRef<string | null>(null);
  const pendingRenderResolversRef = React.useRef<Array<() => void>>([]);
  const pendingScrollRequestRef = React.useRef<PendingScrollRequest | null>(null);
  const scrollPinRef = React.useRef<{ turnId: string; expiresAt: number } | null>(null);
  const historyInteractionRef = React.useRef(false);
  const historyInteractionTimerRef = React.useRef<number | null>(null);

  const historySignals = React.useMemo(() => {
    const defaultLimit = getMemoryLimits().HISTORICAL_MESSAGES;
    const hasBufferedTurns = false;
    const hasMoreAboveTurns = historyMeta
      ? !historyMeta.complete
      : messages.length >= defaultLimit;
    const historyLoading = Boolean(historyMeta?.loading);
    return {
      hasBufferedTurns,
      hasMoreAboveTurns,
      historyLoading,
      canLoadEarlier: hasMoreAboveTurns,
    };
  }, [historyMeta, messages.length]);

  const historySignalsRef = React.useRef(historySignals);

  turnModelRef.current = turnWindowModel;
  isPinnedRef.current = isPinned;
  isLoadingOlderRef.current = isLoadingOlder;
  pendingRevealWorkRef.current = pendingRevealWork;
  historySignalsRef.current = historySignals;
  sessionIdRef.current = sessionId;
  messagesRef.current = messages;
  historyMetaRef.current = historyMeta;

  const beginHistoryInteraction = React.useCallback(() => {
    historyInteractionRef.current = true;
    if (historyInteractionTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(historyInteractionTimerRef.current);
      historyInteractionTimerRef.current = null;
    }
  }, []);

  const settleHistoryInteraction = React.useCallback(() => {
    if (typeof window === 'undefined') {
      historyInteractionRef.current = false;
      return;
    }

    if (historyInteractionTimerRef.current !== null) {
      window.clearTimeout(historyInteractionTimerRef.current);
    }
    historyInteractionTimerRef.current = window.setTimeout(() => {
      historyInteractionTimerRef.current = null;
      historyInteractionRef.current = false;
    }, HISTORY_INTERACTION_GUARD_MS);
  }, []);

  React.useLayoutEffect(() => {
    if (initializedSessionKeyRef.current === sessionKey) {
      return;
    }
    if (historyInteractionTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(historyInteractionTimerRef.current);
      historyInteractionTimerRef.current = null;
    }
    historyInteractionRef.current = false;
    initializedSessionKeyRef.current = sessionKey;
    const pendingScroll = pendingScrollRequestRef.current;
    if (pendingScroll && pendingScroll.identity !== timelineIdentityRef.current) {
      pendingScrollRequestRef.current = null;
      pendingScroll.resolve(false);
    }
    setIsLoadingOlder(false);
    setPendingRevealWork(false);
    scrollPinRef.current = null;
    setActiveTurnId(null);
  }, [sessionKey]);

  React.useLayoutEffect(() => {
    if (!isPinned) {
      return;
    }
    const latestTurnId = turnWindowModel.turnIds[turnWindowModel.turnIds.length - 1];
    if (!latestTurnId) {
      return;
    }
    setActiveTurnId((current) => current === latestTurnId ? current : latestTurnId);
  }, [isPinned, turnWindowModel.turnIds]);

  const resolvePendingRenderWaiters = React.useCallback(() => {
    const resolvers = pendingRenderResolversRef.current;
    if (resolvers.length === 0) {
      return;
    }
    pendingRenderResolversRef.current = [];
    resolvers.forEach((resolve) => resolve());
  }, []);

  const waitForNextRenderCommitOrTimeout = React.useCallback((): Promise<void> => {
    return new Promise<void>((resolve) => {
      if (typeof window === 'undefined') {
        resolve();
        return;
      }

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve();
      };
      pendingRenderResolversRef.current.push(finish);
      const timer = window.setTimeout(finish, HISTORY_RENDER_WAIT_TIMEOUT_MS);
    });
  }, []);

  const resolvePendingScrollRequest = React.useCallback((value: boolean) => {
    const pending = pendingScrollRequestRef.current;
    if (!pending) {
      return;
    }
    pendingScrollRequestRef.current = null;
    pending.resolve(value);
  }, []);

  const attemptPendingScrollRequest = React.useCallback(() => {
    const pending = pendingScrollRequestRef.current;
    if (!pending) {
      return;
    }

    if (pending.identity !== timelineIdentityRef.current) {
      resolvePendingScrollRequest(false);
      return;
    }

    const didScroll = pending.kind === 'turn'
      ? (messageListRef.current?.scrollToTurnId(pending.id, { behavior: pending.behavior }) ?? false)
      : (messageListRef.current?.scrollToMessageId(pending.id, { behavior: pending.behavior }) ?? false);

    if (didScroll) {
      if (pending.turnId) {
        scrollPinRef.current = {
          turnId: pending.turnId,
          expiresAt: Date.now() + SCROLL_PIN_TIMEOUT_MS,
        };
        setActiveTurnId(pending.turnId);
      }
      resolvePendingScrollRequest(true);
      return;
    }

    const targetIndex = pending.kind === 'turn'
      ? turnModelRef.current.turnIndexById.get(pending.id)
      : turnModelRef.current.messageToTurnIndex.get(pending.id);

    if (typeof targetIndex === 'number') {
      resolvePendingScrollRequest(false);
    }
  }, [messageListRef, resolvePendingScrollRequest]);

  React.useEffect(() => {
    return () => {
      if (historyInteractionTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(historyInteractionTimerRef.current);
        historyInteractionTimerRef.current = null;
      }
      resolvePendingRenderWaiters();
      resolvePendingScrollRequest(false);
    };
  }, [resolvePendingRenderWaiters, resolvePendingScrollRequest]);

  const renderedMessages = messages;

  React.useLayoutEffect(() => {
    resolvePendingRenderWaiters();
    attemptPendingScrollRequest();
  }, [attemptPendingScrollRequest, renderedMessages, resolvePendingRenderWaiters]);

  const captureViewportAnchor = React.useCallback((): ViewportAnchor | null => {
    return messageListRef.current?.captureViewportAnchor() ?? null;
  }, [messageListRef]);

  const restoreViewportAnchor = React.useCallback((anchor: ViewportAnchor): boolean => {
    return messageListRef.current?.restoreViewportAnchor(anchor) ?? false;
  }, [messageListRef]);

  const { prePrependScrollRef } = useChatTimelinePrependCompensation({
    sessionKey,
    timelineIdentityRef,
    scrollRef,
    messageListRef,
    renderedMessages,
    isPinnedRef,
    goToBottom,
    captureViewportAnchor,
    restoreViewportAnchor,
  });

  const revealBufferedTurns = React.useCallback(async (): Promise<boolean> => false, []);

  const fetchOlderHistory = React.useCallback(async (input: {
    preserveViewport: boolean;
  }): Promise<boolean> => {
    if (!sessionIdRef.current || !timelineIdentityRef.current.key || isLoadingOlderRef.current) {
      return false;
    }
    if (!historySignalsRef.current.hasMoreAboveTurns) {
      return false;
    }

    const targetSessionId = sessionIdRef.current;
    const targetIdentity = timelineIdentityRef.current;
    if (!targetSessionId || !targetIdentity.key) {
      return false;
    }
    const clearOwnedPrependSnapshot = () => {
      if (prePrependScrollRef.current?.identity === targetIdentity) {
        prePrependScrollRef.current = null;
      }
    };

    const container = scrollRef.current;
    const beforeMessages = messagesRef.current;
    const beforeMessageCount = beforeMessages.length;
    const beforeOldestMessageId = beforeMessages[0]?.info?.id ?? null;
    const beforeLimit = historyMetaRef.current?.limit ?? getMemoryLimits().HISTORICAL_MESSAGES;

    if (input.preserveViewport && container) {
      prePrependScrollRef.current = {
        identity: targetIdentity,
        height: container.scrollHeight,
        top: container.scrollTop,
        anchor: captureViewportAnchor(),
        historyVirtualized: messageListRef.current?.isHistoryVirtualized() ?? false,
        oldestId: beforeOldestMessageId,
        newestId: beforeMessages[beforeMessages.length - 1]?.info?.id ?? null,
      };
    }

    beginHistoryInteraction();
    setIsLoadingOlder(true);

    try {
      let loadedMessageCount = beforeMessageCount;
      let loadedOldestMessageId = beforeOldestMessageId;
      let loadedLimit = beforeLimit;
      const beforeTurnCount = turnModelRef.current.turnCount;

      while (true) {
        await loadMoreMessages(targetSessionId, 'up');
        if (timelineIdentityRef.current !== targetIdentity) {
          clearOwnedPrependSnapshot();
          return false;
        }

        await waitForNextRenderCommitOrTimeout();
        if (timelineIdentityRef.current !== targetIdentity) {
          clearOwnedPrependSnapshot();
          return false;
        }

        const afterMessages = messagesRef.current;
        const afterMessageCount = afterMessages.length;
        const afterOldestMessageId = afterMessages[0]?.info?.id ?? null;
        const afterLimit = historyMetaRef.current?.limit ?? loadedLimit;
        const messageGrowth =
          afterMessageCount > loadedMessageCount
          || (typeof loadedOldestMessageId === 'string'
            && typeof afterOldestMessageId === 'string'
            && loadedOldestMessageId !== afterOldestMessageId)
          || afterLimit > loadedLimit;
        const turnGrowth = turnModelRef.current.turnCount - beforeTurnCount;

        if (turnGrowth > 0) {
          return true;
        }
        if (!messageGrowth) {
          clearOwnedPrependSnapshot();
          return false;
        }
        if (!historySignalsRef.current.hasMoreAboveTurns) {
          return true;
        }

        loadedMessageCount = afterMessageCount;
        loadedOldestMessageId = afterOldestMessageId;
        loadedLimit = afterLimit;
      }
    } catch (error) {
      clearOwnedPrependSnapshot();
      throw error;
    } finally {
      if (timelineIdentityRef.current === targetIdentity) {
        setIsLoadingOlder(false);
        settleHistoryInteraction();
      }
    }
  }, [beginHistoryInteraction, captureViewportAnchor, loadMoreMessages, messageListRef, prePrependScrollRef, scrollRef, settleHistoryInteraction, waitForNextRenderCommitOrTimeout]);

  const loadEarlier = React.useCallback(async (options?: { userInitiated?: boolean }) => {
    const targetIdentity = timelineIdentityRef.current;
    beginHistoryInteraction();
    if (options?.userInitiated) {
      releaseAutoFollow();
    }

    try {
      void (await fetchOlderHistory({ preserveViewport: true }));
    } finally {
      if (timelineIdentityRef.current === targetIdentity) {
        settleHistoryInteraction();
      }
    }
  }, [beginHistoryInteraction, fetchOlderHistory, releaseAutoFollow, settleHistoryInteraction]);

  const handleHistoryScroll = React.useCallback(() => {
    if (isMobileSurfaceRuntime()) return;
    const container = scrollRef.current;
    if (!container) return;
    if (isPinnedRef.current) return;
    if (container.scrollTop >= resolveHistoryScrollThreshold(container.clientHeight)) return;
    if (!historySignalsRef.current.canLoadEarlier) return;
    if (isLoadingOlderRef.current || pendingRevealWorkRef.current) return;

    void loadEarlier({ userInitiated: true });
  }, [loadEarlier, scrollRef]);

  const loadEarlierIfPinnedViewportUnderfilled = React.useCallback(() => {
    if (isMobileSurfaceRuntime()) return;
    if (historyInteractionRef.current) return;
    const container = scrollRef.current;
    if (!container) return;
    if (!shouldAutoLoadEarlierForUnderfilledPinnedViewport({
      sessionId: sessionIdRef.current,
      isPinned: isPinnedRef.current,
      canLoadEarlier: historySignalsRef.current.canLoadEarlier,
      isLoadingOlder: isLoadingOlderRef.current,
      pendingRevealWork: pendingRevealWorkRef.current,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
    })) {
      return;
    }

    void loadEarlier();
  }, [loadEarlier, scrollRef]);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      loadEarlierIfPinnedViewportUnderfilled();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    historySignals.canLoadEarlier,
    isLoadingOlder,
    isPinned,
    loadEarlierIfPinnedViewportUnderfilled,
    pendingRevealWork,
    renderedMessages.length,
    sessionKey,
  ]);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof ResizeObserver === 'undefined') {
      return;
    }

    const container = scrollRef.current;
    if (!container) {
      return;
    }

    let frame: number | null = null;
    const scheduleCheck = () => {
      if (frame !== null) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = null;
        loadEarlierIfPinnedViewportUnderfilled();
      });
    };

    const observer = new ResizeObserver(scheduleCheck);
    observer.observe(container);
    const content = container.firstElementChild;
    if (content instanceof Element) {
      observer.observe(content);
    }
    scheduleCheck();

    return () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      observer.disconnect();
    };
  }, [loadEarlierIfPinnedViewportUnderfilled, scrollRef, sessionKey]);

  const scrollToTurn = React.useCallback(async (
    turnId: string,
    options?: { behavior?: ScrollBehavior },
  ): Promise<boolean> => {
    if (!turnId || !sessionIdRef.current || !timelineIdentityRef.current.key) {
      return false;
    }

    const targetIdentity = timelineIdentityRef.current;
    releaseAutoFollow();
    setPendingRevealWork(true);

    try {
      if (timelineIdentityRef.current !== targetIdentity) {
        return false;
      }

      const turnIndex = turnModelRef.current.turnIndexById.get(turnId);
      if (typeof turnIndex !== 'number') {
        return false;
      }

      const result = await new Promise<boolean>((resolve) => {
        pendingScrollRequestRef.current = {
          identity: targetIdentity,
          kind: 'turn',
          id: turnId,
          behavior: options?.behavior ?? 'auto',
          turnId,
          resolve,
        };
        attemptPendingScrollRequest();
      });

      if (result) {
        return true;
      }

      return false;
    } finally {
      if (timelineIdentityRef.current === targetIdentity) {
        setPendingRevealWork(false);
      }
    }
  }, [attemptPendingScrollRequest, releaseAutoFollow]);

  const scrollToMessage = React.useCallback(async (
    messageId: string,
    options?: { behavior?: ScrollBehavior },
  ): Promise<boolean> => {
    if (!messageId || !sessionIdRef.current || !timelineIdentityRef.current.key) {
      return false;
    }

    const targetIdentity = timelineIdentityRef.current;
    releaseAutoFollow();
    setPendingRevealWork(true);

    try {
      if (timelineIdentityRef.current !== targetIdentity) {
        return false;
      }

      const turnId = turnModelRef.current.messageToTurnId.get(messageId);
      const turnIndex = turnModelRef.current.messageToTurnIndex.get(messageId);

      if (typeof turnIndex !== 'number') {
        return false;
      }

      const result = await new Promise<boolean>((resolve) => {
        pendingScrollRequestRef.current = {
          identity: targetIdentity,
          kind: 'message',
          id: messageId,
          behavior: options?.behavior ?? 'auto',
          turnId: turnId ?? null,
          resolve,
        };
        attemptPendingScrollRequest();
      });

      if (result) {
        return true;
      }

      return false;
    } finally {
      if (timelineIdentityRef.current === targetIdentity) {
        setPendingRevealWork(false);
      }
    }
  }, [attemptPendingScrollRequest, releaseAutoFollow]);

  const resumeToBottom = React.useCallback(async () => {
    setPendingRevealWork(false);
    setIsLoadingOlder(false);
    goToBottom('smooth');
  }, [goToBottom]);

  const resumeToBottomInstant = React.useCallback(async () => {
    setPendingRevealWork(false);
    setIsLoadingOlder(false);
    goToBottom('instant');
  }, [goToBottom]);

  const handleActiveTurnChange = React.useCallback((turnId: string | null) => {
    const pin = scrollPinRef.current;
    if (pin) {
      if (turnId !== pin.turnId && Date.now() < pin.expiresAt) {
        return;
      }
      scrollPinRef.current = null;
    }
    setActiveTurnId(turnId);
  }, []);

  return {
    turnIds: turnWindowModel.turnIds,
    turnStart: 0,
    renderedMessages,
    historySignals,
    isLoadingOlder,
    pendingRevealWork,
    activeTurnId,
    showScrollToBottom: showScrollButton && !pendingRevealWork,
    turnWindowModel,
    loadEarlier,
    revealBufferedTurns,
    resumeToBottom,
    resumeToBottomInstant,
    scrollToTurn,
    scrollToMessage,
    handleHistoryScroll,
    captureViewportAnchor,
    restoreViewportAnchor,
    handleActiveTurnChange,
  };
};
