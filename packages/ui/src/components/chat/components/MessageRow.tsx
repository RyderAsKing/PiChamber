import React from 'react';

import type { AnimationHandlers, ContentChangeReason } from '@/hooks/useChatAutoFollow';
import ChatMessage from '../ChatMessage';
import { ExtensionMessageCard } from '../message/parts/extension/ExtensionMessageCard';
import {
  areOptionalNeighborMessagesEqual,
  areRelevantTurnGroupingContextsEqual,
  areRenderRelevantMessagesEqual,
} from '../message/renderCompare';
import type { StreamPhase } from '../message/types';
import { resolveMessageRole } from '../lib/messageListHelpers';
import type { ChatMessageEntry, TurnGroupingContext } from '../lib/turns/types';

export interface MessageRowProps {
  message: ChatMessageEntry;
  previousMessage?: ChatMessageEntry;
  nextMessage?: ChatMessageEntry;
  turnGroupingContext?: TurnGroupingContext;
  assistantHeaderMessageId?: string;
  isInActiveTurn?: boolean;
  activeStreamingPhase?: StreamPhase | null;
  animateUserOnMount?: boolean;
  onUserAnimationConsumed?: (messageId: string) => void;
  onContentChange: (reason?: ContentChangeReason) => void;
  animationHandlers: AnimationHandlers;
  scrollToBottom?: () => void;
}

export const MessageRow = React.memo<MessageRowProps>(
  ({
    message,
    previousMessage,
    nextMessage,
    turnGroupingContext,
    assistantHeaderMessageId,
    isInActiveTurn,
    activeStreamingPhase,
    animateUserOnMount,
    onUserAnimationConsumed,
    onContentChange,
    animationHandlers,
    scrollToBottom,
  }) => {
    const info = message.info as {
      role?: string;
      sessionID?: string;
      customType?: string;
      data?: unknown;
      details?: unknown;
      text?: string;
    };

    // Extension-authored content renders through the extension card instead of
    // the user/assistant turn pipeline.
    if (info.role === 'extension') {
      return (
        <ExtensionMessageCard
          sessionId={info.sessionID}
          messageId={message.info.id}
          customType={info.customType}
          text={typeof info.text === 'string' ? info.text : undefined}
          data={info.data}
          details={info.details}
        />
      );
    }

    return (
      <ChatMessage
        message={message}
        previousMessage={previousMessage}
        nextMessage={nextMessage}
        animateUserOnMount={animateUserOnMount}
        onUserAnimationConsumed={onUserAnimationConsumed}
        onContentChange={onContentChange}
        animationHandlers={animationHandlers}
        scrollToBottom={scrollToBottom}
        turnGroupingContext={turnGroupingContext}
        assistantHeaderMessageId={assistantHeaderMessageId}
        isInActiveTurn={isInActiveTurn}
        activeStreamingPhase={activeStreamingPhase}
      />
    );
  },
  (prev, next) => {
    const prevTurn = prev.turnGroupingContext;
    const nextTurn = next.turnGroupingContext;

    return (
      areRenderRelevantMessagesEqual(prev.message, next.message) &&
      areOptionalNeighborMessagesEqual(prev.previousMessage, next.previousMessage) &&
      areOptionalNeighborMessagesEqual(prev.nextMessage, next.nextMessage) &&
      prev.animateUserOnMount === next.animateUserOnMount &&
      prev.onUserAnimationConsumed === next.onUserAnimationConsumed &&
      prev.onContentChange === next.onContentChange &&
      prev.scrollToBottom === next.scrollToBottom &&
      areRelevantTurnGroupingContextsEqual(
        prevTurn,
        nextTurn,
        prev.message.info.id,
        resolveMessageRole(prev.message) === 'user',
      ) &&
      prev.assistantHeaderMessageId === next.assistantHeaderMessageId &&
      prev.isInActiveTurn === next.isInActiveTurn &&
      prev.activeStreamingPhase === next.activeStreamingPhase &&
      prev.animationHandlers?.onChunk === next.animationHandlers?.onChunk &&
      prev.animationHandlers?.onComplete === next.animationHandlers?.onComplete &&
      prev.animationHandlers?.onStreamingCandidate ===
        next.animationHandlers?.onStreamingCandidate &&
      prev.animationHandlers?.onAnimationStart === next.animationHandlers?.onAnimationStart &&
      prev.animationHandlers?.onReservationCancelled ===
        next.animationHandlers?.onReservationCancelled &&
      prev.animationHandlers?.onReasoningBlock === next.animationHandlers?.onReasoningBlock &&
      prev.animationHandlers?.onAnimatedHeightChange ===
        next.animationHandlers?.onAnimatedHeightChange
    );
  },
);

MessageRow.displayName = 'MessageRow';
