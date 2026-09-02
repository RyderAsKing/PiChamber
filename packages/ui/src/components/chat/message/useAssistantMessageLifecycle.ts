import React from 'react';
import type { Part, ToolPart as ToolPartType } from '@/lib/chat/types';
import type { TurnGroupingContext } from '../lib/turns/types';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import type { TimeFormatPreference } from '@/stores/useUIStore';
import { extractLoopbackUrls } from '@/lib/url';
import { formatTurnDuration } from './turnDuration';
import { formatTimestampForDisplay } from './timeFormat';

const TOOL_REVEAL_CACHE_MAX = 200;
const revealedToolIdsByMessage = new Map<string, Set<string>>();

const readRevealedToolIds = (messageId: string): Set<string> => {
  const cached = revealedToolIdsByMessage.get(messageId);
  return cached ? new Set(cached) : new Set<string>();
};

const writeRevealedToolIds = (messageId: string, value: Set<string>): void => {
  if (revealedToolIdsByMessage.size >= TOOL_REVEAL_CACHE_MAX && !revealedToolIdsByMessage.has(messageId)) {
    const oldest = revealedToolIdsByMessage.keys().next().value;
    if (oldest) {
      revealedToolIdsByMessage.delete(oldest);
    }
  }
  revealedToolIdsByMessage.set(messageId, new Set(value));
};

export function useAssistantMessageLifecycle({
  messageId,
  visibleParts,
  isMessageCompleted,
  messageFinish,
  messageCompletedAt,
  messageCreatedAt,
  durationMs,
  turnGroupingContext,
  errorMessage,
  isMobile,
  isMiniChatSurface,
  timeFormatPreference,
  onAuxiliaryContentComplete,
  onContentChange,
}: {
  messageId: string;
  visibleParts: Part[];
  isMessageCompleted: boolean;
  messageFinish?: string;
  messageCompletedAt?: number;
  messageCreatedAt?: number;
  durationMs?: number;
  turnGroupingContext?: TurnGroupingContext;
  errorMessage?: string;
  isMobile: boolean;
  isMiniChatSurface: boolean;
  timeFormatPreference: TimeFormatPreference;
  onAuxiliaryContentComplete?: () => void;
  onContentChange?: (reason?: ContentChangeReason, messageId?: string) => void;
}) {
  const toolRevealReadyRef = React.useRef(false);

  React.useEffect(() => {
    toolRevealReadyRef.current = true;
  }, []);

  const toolParts = React.useMemo(() => {
    return visibleParts.filter((part): part is ToolPartType => part.type === 'tool');
  }, [visibleParts]);

  const assistantTextParts = React.useMemo(() => {
    return visibleParts.filter((part) => part.type === 'text');
  }, [visibleParts]);

  const reasoningParts = React.useMemo(() => {
    return visibleParts.filter((part) => part.type === 'reasoning');
  }, [visibleParts]);

  const toolRevealStateRef = React.useRef<{
    messageId: string;
    hasCommitted: boolean;
    persistedToolIds: Set<string>;
    animatedToolIds: Set<string>;
  }>({
    messageId,
    hasCommitted: false,
    persistedToolIds: readRevealedToolIds(messageId),
    animatedToolIds: new Set<string>(),
  });

  if (toolRevealStateRef.current.messageId !== messageId) {
    toolRevealStateRef.current = {
      messageId,
      hasCommitted: false,
      persistedToolIds: readRevealedToolIds(messageId),
      animatedToolIds: new Set<string>(),
    };
  }

  const currentToolIds = React.useMemo(() => {
    const ids = new Set<string>();

    for (const toolPart of toolParts) {
      ids.add(toolPart.id);
    }

    const activitySegments = turnGroupingContext?.activityGroupSegments;
    if (Array.isArray(activitySegments)) {
      for (const segment of activitySegments) {
        if (segment.anchorMessageId !== messageId) {
          continue;
        }
        for (const activity of segment.parts) {
          if (activity.kind !== 'tool') {
            continue;
          }
          const toolId = (activity.part as { id?: unknown }).id;
          if (typeof toolId === 'string' && toolId.length > 0) {
            ids.add(toolId);
          }
        }
      }
    }

    return Array.from(ids);
  }, [messageId, toolParts, turnGroupingContext?.activityGroupSegments]);

  const shouldAnimateNewToolMount = Boolean(turnGroupingContext?.isWorking && toolRevealReadyRef.current);
  const persistedToolIds = toolRevealStateRef.current.persistedToolIds;
  const animatedToolIds = toolRevealStateRef.current.animatedToolIds;

  if (shouldAnimateNewToolMount && toolRevealStateRef.current.hasCommitted) {
    for (const toolId of currentToolIds) {
      if (!persistedToolIds.has(toolId)) {
        animatedToolIds.add(toolId);
      }
    }
  }

  const animatedToolIdsKey = Array.from(animatedToolIds).join('\u0000');
  const animatedToolIdsLookup = React.useMemo(
    () => new Set(animatedToolIdsKey ? animatedToolIdsKey.split('\u0000') : []),
    [animatedToolIdsKey],
  );

  React.useEffect(() => {
    const nextPersistedToolIds = new Set(toolRevealStateRef.current.persistedToolIds);
    for (const toolId of currentToolIds) {
      nextPersistedToolIds.add(toolId);
    }
    toolRevealStateRef.current.persistedToolIds = nextPersistedToolIds;
    toolRevealStateRef.current.hasCommitted = true;
    writeRevealedToolIds(messageId, nextPersistedToolIds);
  }, [currentToolIds, messageId]);

  const messagePreviewUrl = React.useMemo(() => {
    if (isMobile || isMiniChatSurface) {
      return null;
    }

    for (const part of assistantTextParts) {
      const text = (part as { text?: unknown }).text;
      if (typeof text !== 'string' || text.length === 0) {
        continue;
      }
      const url = extractLoopbackUrls(text)[0];
      if (!url) {
        continue;
      }
      return url.includes('0.0.0.0') ? url.replace('0.0.0.0', '127.0.0.1') : url;
    }
    for (const part of toolParts) {
      const state = (part as unknown as { state?: unknown }).state as Record<string, unknown> | undefined;
      const output = state && typeof state.output === 'string' ? state.output : null;
      if (!output) {
        continue;
      }
      // eslint-disable-next-line no-control-regex
      const url = extractLoopbackUrls(output.replace(/\x1b\[[0-9;]*m/g, ''))[0];
      if (!url) {
        continue;
      }
      return url.includes('0.0.0.0') ? url.replace('0.0.0.0', '127.0.0.1') : url;
    }
    return null;
  }, [assistantTextParts, isMobile, isMiniChatSurface, toolParts]);

  const isLastAssistantInTurn = turnGroupingContext?.isLastAssistantInTurn ?? false;
  const isTurnWorking = Boolean(turnGroupingContext?.isWorking);
  const hasStopFinish = messageFinish === 'stop' || (isMessageCompleted && !errorMessage);
  const awaitingMessageCompletion = !isMessageCompleted;
  const hasTools = toolParts.length > 0;

  const hasPendingTools = React.useMemo(() => {
    return toolParts.some((toolPart) => {
      const state = ((toolPart as Record<string, unknown>).state as Record<string, unknown> | undefined) ?? {};
      const status = state?.status;
      return status === 'pending' || status === 'running' || status === 'started';
    });
  }, [toolParts]);

  const isToolFinalized = React.useCallback((toolPart: ToolPartType) => {
    const state = ((toolPart as Record<string, unknown>).state as Record<string, unknown> | undefined) ?? {};
    const status = state?.status;
    if (status === 'pending' || status === 'running' || status === 'started') {
      return false;
    }
    if (
      status === 'completed' ||
      status === 'cancelled' ||
      status === 'canceled' ||
      status === 'error' ||
      status === 'failed' ||
      status === 'aborted' ||
      status === 'timeout'
    ) {
      return true;
    }
    const time = (state?.time as Record<string, unknown> | undefined) ?? {};
    const endTime = typeof time?.end === 'number' ? time.end : undefined;
    const startTime = typeof time?.start === 'number' ? time.start : undefined;
    if (typeof endTime !== 'number') {
      return false;
    }
    if (typeof startTime === 'number' && endTime < startTime) {
      return false;
    }
    return true;
  }, []);

  const allToolsFinalized = React.useMemo(() => {
    if (toolParts.length === 0) {
      return true;
    }
    if (hasPendingTools) {
      return false;
    }
    return toolParts.every((toolPart) => isToolFinalized(toolPart));
  }, [toolParts, hasPendingTools, isToolFinalized]);

  const reasoningComplete = React.useMemo(() => {
    if (reasoningParts.length === 0) {
      return true;
    }
    return reasoningParts.every((part) => {
      const time = (part as Record<string, unknown>).time as { end?: number } | undefined;
      return typeof time?.end === 'number';
    });
  }, [reasoningParts]);

  const hasOpenStep = !isMessageCompleted && typeof messageFinish !== 'string';

  const shouldHoldForReasoning =
    reasoningParts.length > 0 && hasTools && (hasPendingTools || hasOpenStep || !allToolsFinalized);

  const shouldHoldTools =
    awaitingMessageCompletion || (hasTools && (hasPendingTools || hasOpenStep || !allToolsFinalized));
  const shouldHoldReasoning = awaitingMessageCompletion || shouldHoldForReasoning;

  const hasAuxiliaryContent = hasTools || reasoningParts.length > 0;
  const isTextlessAssistantMessage = assistantTextParts.length === 0;
  const auxiliaryContentComplete =
    hasAuxiliaryContent &&
    isTextlessAssistantMessage &&
    !shouldHoldTools &&
    !shouldHoldReasoning &&
    allToolsFinalized &&
    reasoningComplete;

  const auxiliaryCompletionAnnouncedRef = React.useRef(false);
  const soloReasoningScrollTriggeredRef = React.useRef(false);

  React.useEffect(() => {
    soloReasoningScrollTriggeredRef.current = false;
  }, [messageId]);

  React.useEffect(() => {
    if (!auxiliaryContentComplete) {
      auxiliaryCompletionAnnouncedRef.current = false;
      return;
    }
    if (auxiliaryCompletionAnnouncedRef.current) {
      return;
    }
    auxiliaryCompletionAnnouncedRef.current = true;
    onAuxiliaryContentComplete?.();
  }, [auxiliaryContentComplete, onAuxiliaryContentComplete]);

  React.useEffect(() => {
    if (awaitingMessageCompletion) {
      soloReasoningScrollTriggeredRef.current = false;
      return;
    }
    if (hasTools) {
      soloReasoningScrollTriggeredRef.current = false;
      return;
    }
    if (reasoningParts.length === 0) {
      return;
    }
    if (shouldHoldReasoning || !reasoningComplete) {
      return;
    }
    if (soloReasoningScrollTriggeredRef.current) {
      return;
    }
    soloReasoningScrollTriggeredRef.current = true;
    onContentChange?.('structural');
  }, [awaitingMessageCompletion, hasTools, onContentChange, reasoningComplete, reasoningParts.length, shouldHoldReasoning]);

  const turnDurationText = React.useMemo(() => {
    if (!isLastAssistantInTurn || isTurnWorking) return undefined;
    if (typeof durationMs === 'number' && durationMs > 0) {
      return formatTurnDuration(durationMs);
    }
    if (
      typeof messageCompletedAt === 'number' &&
      typeof messageCreatedAt === 'number' &&
      messageCompletedAt > messageCreatedAt
    ) {
      return formatTurnDuration(messageCompletedAt - messageCreatedAt);
    }
    const userCreatedAt = turnGroupingContext?.userMessageCreatedAt;
    if (
      typeof userCreatedAt === 'number' &&
      typeof messageCompletedAt === 'number' &&
      messageCompletedAt > userCreatedAt
    ) {
      return formatTurnDuration(messageCompletedAt - userCreatedAt);
    }
    return undefined;
  }, [isLastAssistantInTurn, isTurnWorking, durationMs, messageCompletedAt, messageCreatedAt, turnGroupingContext?.userMessageCreatedAt]);

  const footerTimestamp = React.useMemo(() => {
    const timestamp =
      typeof messageCompletedAt === 'number' && messageCompletedAt > 0
        ? messageCompletedAt
        : typeof messageCreatedAt === 'number' && messageCreatedAt > 0
          ? messageCreatedAt
          : null;
    if (timestamp === null) return null;

    const formatted = formatTimestampForDisplay(timestamp, timeFormatPreference);
    return formatted.length > 0 ? formatted : null;
  }, [messageCompletedAt, messageCreatedAt, timeFormatPreference]);

  return {
    toolParts,
    assistantTextParts,
    reasoningParts,
    animatedToolIdsLookup,
    messagePreviewUrl,
    isLastAssistantInTurn,
    isTurnWorking,
    hasStopFinish,
    awaitingMessageCompletion,
    turnDurationText,
    footerTimestamp,
  };
}
