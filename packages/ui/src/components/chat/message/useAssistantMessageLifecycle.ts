import React from 'react';
import type { Part } from '@/lib/chat/types';
import type { TurnGroupingContext } from '../lib/turns/types';
import type { TimeFormatPreference } from '@/stores/useUIStore';
import { extractLoopbackUrls } from '@/lib/url';
import { formatTimestampForDisplay } from './timeFormat';

/**
 * Footer/timing lifecycle for the assistant response body.
 *
 * The response body receives already-filtered final parts
 * (`filterAssistantFinalParts` in ChatMessage): tool, reasoning, and
 * rail-projected justification parts never reach this hook, so its only
 * concerns are the turn footer animation gate, duration/timestamp text,
 * completion state, and the loopback preview URL advertised by final text.
 */
export function useAssistantMessageLifecycle({
  visibleParts,
  isMessageCompleted,
  messageFinish,
  messageCompletedAt,
  messageCreatedAt,
  turnGroupingContext,
  errorMessage,
  isMobile,
  isMiniChatSurface,
  timeFormatPreference,
}: {
  visibleParts: Part[];
  isMessageCompleted: boolean;
  messageFinish?: string;
  messageCompletedAt?: number;
  messageCreatedAt?: number;
  turnGroupingContext?: TurnGroupingContext;
  errorMessage?: string;
  isMobile: boolean;
  isMiniChatSurface: boolean;
  timeFormatPreference: TimeFormatPreference;
}) {
  const assistantTextParts = React.useMemo(() => {
    return visibleParts.filter((part) => part.type === 'text');
  }, [visibleParts]);

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
    return null;
  }, [assistantTextParts, isMobile, isMiniChatSurface]);

  const isLastAssistantInTurn = turnGroupingContext?.isLastAssistantInTurn ?? false;
  const isTurnWorking = Boolean(turnGroupingContext?.isWorking);
  const previouslyWorkingRef = React.useRef(isTurnWorking);
  const shouldAnimateTurnFooter = previouslyWorkingRef.current && !isTurnWorking;

  React.useEffect(() => {
    previouslyWorkingRef.current = isTurnWorking;
  }, [isTurnWorking]);

  const hasStopFinish = messageFinish === 'stop' || (isMessageCompleted && !errorMessage);
  const awaitingMessageCompletion = !isMessageCompleted;


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
    messagePreviewUrl,
    isLastAssistantInTurn,
    isTurnWorking,
    shouldAnimateTurnFooter,
    hasStopFinish,
    awaitingMessageCompletion,
    footerTimestamp,
  };
}
