import React from 'react';

import type { AnimationHandlers, ContentChangeReason } from '@/hooks/useChatAutoFollow';
import type { ChatMessageEntry } from '../lib/turns/types';
import type { StreamPhase } from '../message/types';
import { MessageRow } from './MessageRow';

export interface UngroupedMessageRowProps {
  message: ChatMessageEntry;
  previousMessage?: ChatMessageEntry;
  nextMessage?: ChatMessageEntry;
  onMessageContentChange: (reason?: ContentChangeReason) => void;
  getAnimationHandlers: (messageId: string) => AnimationHandlers;
  scrollToBottom?: () => void;
  shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
  onUserAnimationConsumed: (messageId: string) => void;
  activeStreamingMessageId?: string | null;
  activeStreamingPhase?: StreamPhase | null;
}

export const UngroupedMessageRow = React.memo(
  ({
    message,
    previousMessage,
    nextMessage,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
  }: UngroupedMessageRowProps) => {
    return (
      <MessageRow
        message={message}
        previousMessage={previousMessage}
        nextMessage={nextMessage}
        isInActiveTurn={
          Boolean(activeStreamingMessageId) && message.info.id === activeStreamingMessageId
        }
        activeStreamingPhase={
          message.info.id === activeStreamingMessageId ? activeStreamingPhase : null
        }
        animateUserOnMount={shouldAnimateUserMessage(message)}
        onUserAnimationConsumed={onUserAnimationConsumed}
        onContentChange={onMessageContentChange}
        animationHandlers={getAnimationHandlers(message.info.id)}
        scrollToBottom={scrollToBottom}
      />
    );
  },
);

UngroupedMessageRow.displayName = 'UngroupedMessageRow';
