import React from 'react';

import type { AnimationHandlers, ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { isTurnAssistantWorking, resolveTurnStreamingAssistantId } from '../lib/turns/assistantWorkingState';
import type { ChatMessageEntry, TurnGroupingContext, TurnRecord } from '../lib/turns/types';
import { isHiddenUserMessage } from '../message/hiddenUserMessage';
import type { StreamPhase } from '../message/types';
import {
  isSessionRetryMessage,
  resolveMessageRole,
  turnContainsMessageId,
} from '../lib/messageListHelpers';
import TurnItem from './TurnItem';
import { MessageRow } from './MessageRow';

export interface TurnBlockProps {
  turn: TurnRecord;
  isLastTurn: boolean;
  nextEntryFirstMessage?: ChatMessageEntry;
  /** Catalog busy is still passed through, but last-turn `isWorking` follows the live stream id. */
  sessionIsWorking: boolean;
  onMessageContentChange: (reason?: ContentChangeReason) => void;
  getAnimationHandlers: (messageId: string) => AnimationHandlers;
  scrollToBottom?: () => void;
  stickyUserHeader?: boolean;
  shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
  onUserAnimationConsumed: (messageId: string) => void;
  activeStreamingMessageId?: string | null;
  activeStreamingPhase?: StreamPhase | null;
}

export const TurnBlock = React.memo(
  ({
    turn,
    isLastTurn,
    nextEntryFirstMessage,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    stickyUserHeader = true,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
  }: TurnBlockProps) => {
    const userMessageHidden = React.useMemo(
      () => isHiddenUserMessage(turn.userMessage),
      [turn.userMessage],
    );

    const messageOrder = React.useMemo(() => {
      const ordered = [turn.userMessage, ...turn.assistantMessages];
      const lookup = new Map<string, number>();
      ordered.forEach((message, index) => {
        lookup.set(message.info.id, index);
      });
      return { ordered, lookup };
    }, [turn.assistantMessages, turn.userMessage]);

    const streamingAssistantMessageId = React.useMemo(
      () =>
        resolveTurnStreamingAssistantId({
          activeStreamingMessageId,
          assistantMessages: turn.assistantMessages,
        }),
      [activeStreamingMessageId, turn.assistantMessages],
    );

    const visibleAssistantMessages = turn.assistantMessages;

    const visibleAssistantIds = React.useMemo(() => {
      const ids = new Map<string, number>();
      visibleAssistantMessages.forEach((assistant, index) => {
        ids.set(assistant.info.id, index);
      });
      return ids;
    }, [visibleAssistantMessages]);

    const turnIsInActiveStream = React.useMemo(() => {
      return turnContainsMessageId(turn, streamingAssistantMessageId);
    }, [turn, streamingAssistantMessageId]);

    const activityOwnerMessageId = React.useMemo(() => {
      if (turnIsInActiveStream && streamingAssistantMessageId) {
        return streamingAssistantMessageId;
      }
      return visibleAssistantMessages[0]?.info.id;
    }, [streamingAssistantMessageId, turnIsInActiveStream, visibleAssistantMessages]);

    const visibleActivityParts = turn.activityParts;
    const visibleActivitySegments = turn.activitySegments;

    const turnGroupingContextBase = React.useMemo(() => {
      const userCreatedAt = (turn.userMessage.info.time as { created?: number } | undefined)
        ?.created;
      // Hydrated historical user messages may store variant either at top level or under model.
      // Prefer the new location, fall back to the legacy one for older servers.
      const info = turn.userMessage.info as
        | { variant?: unknown; model?: { variant?: unknown } }
        | undefined;
      const rawVariant = info?.model?.variant ?? info?.variant;
      const userMessageVariant =
        typeof rawVariant === 'string' && rawVariant.trim().length > 0 ? rawVariant : undefined;
      return {
        turnId: turn.turnId,
        summaryBody: turn.summaryText,
        activityParts: visibleActivityParts,
        activityGroupSegments: visibleActivitySegments,
        headerMessageId: turn.headerMessageId,
        hasTools: turn.hasTools,
        hasReasoning: turn.hasReasoning,
        diffStats: turn.diffStats,
        changedFiles: turn.changedFiles,
        userMessageCreatedAt: typeof userCreatedAt === 'number' ? userCreatedAt : undefined,
        userMessageVariant,
      };
    }, [
      turn.changedFiles,
      turn.diffStats,
      turn.hasReasoning,
      turn.hasTools,
      turn.headerMessageId,
      turn.summaryText,
      turn.turnId,
      turn.userMessage.info,
      visibleActivityParts,
      visibleActivitySegments,
    ]);

    const renderMessage = React.useCallback(
      (message: ChatMessageEntry) => {
        const messageRole = resolveMessageRole(message);
        const isUserMessage = messageRole === 'user';
        const messageIndex = messageOrder.lookup.get(message.info.id);
        const assistantIndex = visibleAssistantIds.get(message.info.id) ?? -1;
        const isAssistantMessage = assistantIndex >= 0;
        const isFirstAssistant = assistantIndex === 0;
        const isLastAssistant = assistantIndex === visibleAssistantMessages.length - 1;
        const isActivityOwner =
          Boolean(activityOwnerMessageId) && message.info.id === activityOwnerMessageId;
        const shouldAttachFullTurnContext = isActivityOwner || isFirstAssistant || isLastAssistant;
        const assistantHeaderMessageId =
          visibleAssistantMessages[0]?.info.id ?? turn.headerMessageId;

        const previousMessage = isUserMessage
          ? undefined
          : isAssistantMessage
            ? isFirstAssistant
              ? turn.userMessage
              : undefined
            : typeof messageIndex === 'number' && messageIndex > 0
              ? messageOrder.ordered[messageIndex - 1]
              : undefined;
        const nextMessage =
          isAssistantMessage && isLastAssistant ? nextEntryFirstMessage : undefined;

        const turnGroupingContext = isAssistantMessage
          ? ({
              turnId: turn.turnId,
              activityOwnerMessageId,
              isFirstAssistantInTurn: isFirstAssistant,
              isLastAssistantInTurn: isLastAssistant,
              isLatestTurn: isLastTurn,
              isWorking: isTurnAssistantWorking({
                messageId: message.info.id,
                activeStreamingMessageId,
                isRetrying: isSessionRetryMessage(message),
              }),
              hasTools: turn.hasTools,
              hasReasoning: turn.hasReasoning,
              ...(shouldAttachFullTurnContext
                ? {
                    summaryBody: turnGroupingContextBase.summaryBody,
                    activityParts: turnGroupingContextBase.activityParts,
                    activityGroupSegments: turnGroupingContextBase.activityGroupSegments,
                    headerMessageId: turnGroupingContextBase.headerMessageId,
                    diffStats: turnGroupingContextBase.diffStats,
                    changedFiles: turnGroupingContextBase.changedFiles,
                    userMessageCreatedAt: turnGroupingContextBase.userMessageCreatedAt,
                    userMessageVariant: turnGroupingContextBase.userMessageVariant,
                  }
                : {}),
            } satisfies TurnGroupingContext)
          : undefined;

        return (
          <MessageRow
            key={message.info.id}
            message={message}
            previousMessage={previousMessage}
            nextMessage={nextMessage}
            turnGroupingContext={turnGroupingContext}
            assistantHeaderMessageId={assistantHeaderMessageId}
            isInActiveTurn={
              Boolean(streamingAssistantMessageId) &&
              message.info.id === streamingAssistantMessageId
            }
            activeStreamingPhase={
              message.info.id === streamingAssistantMessageId ? activeStreamingPhase : null
            }
            animateUserOnMount={shouldAnimateUserMessage(message)}
            onUserAnimationConsumed={onUserAnimationConsumed}
            onContentChange={onMessageContentChange}
            animationHandlers={getAnimationHandlers(message.info.id)}
            scrollToBottom={scrollToBottom}
          />
        );
      },
      [
        getAnimationHandlers,
        isLastTurn,
        nextEntryFirstMessage,
        messageOrder.lookup,
        messageOrder.ordered,
        onMessageContentChange,
        scrollToBottom,
        turn.headerMessageId,
        turn.hasReasoning,
        turn.hasTools,
        turn.turnId,
        turn.userMessage,
        turnGroupingContextBase,
        streamingAssistantMessageId,
        activeStreamingMessageId,
        activeStreamingPhase,
        visibleAssistantMessages,
        visibleAssistantIds,
        activityOwnerMessageId,
        shouldAnimateUserMessage,
        onUserAnimationConsumed,
      ],
    );

    // Only the authoritative live message keeps a large turn fully mounted.
    // Catalog busy and incomplete historical timestamps must not make settled
    // sessions pay the full remount cost on every navigation.
    const deferEarlierAssistantMessages = !turnContainsMessageId(turn, activeStreamingMessageId);

    return (
      <TurnItem
        turn={turn}
        stickyUserHeader={stickyUserHeader && !userMessageHidden}
        renderMessage={renderMessage}
        deferEarlierAssistantMessages={deferEarlierAssistantMessages}
      />
    );
  },
);

TurnBlock.displayName = 'TurnBlock';
