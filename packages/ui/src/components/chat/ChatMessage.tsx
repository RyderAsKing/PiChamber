import React from 'react';
import type { Message, Part } from '@/lib/chat/types';

import { useDeviceInfo } from '@/lib/device';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { cn } from '@/lib/utils';

import type { AnimationHandlers, ContentChangeReason } from '@/hooks/useChatAutoFollow';
import MessageBody from './message/MessageBody';
import { isUserBubbleContentPart } from './message/partUtils';
import type { AgentMentionInfo } from './message/types';
import type { StreamPhase } from './message/types';
import { deriveMessageRole } from './message/messageRole';
import {
  filterAssistantFinalParts,
  filterVisibleParts,
  hasRenderableAssistantContent,
  normalizeParts,
} from './message/partUtils';
import { normalizeUserDisplayParts } from './message/normalizeUserDisplayParts';
import { isHiddenUserMessage } from './message/hiddenUserMessage';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import type { TurnGroupingContext } from './lib/turns/types';
import { copyMarkdownToClipboard, copyTextToClipboard } from '@/lib/clipboard';
import { FadeInOnReveal } from './message/FadeInOnReveal';
import { streamPerfCount } from '@/stores/utils/streamDebug';
import {
  areOptionalNeighborMessagesEqual,
  areRenderRelevantMessagesEqual,
  areRelevantTurnGroupingContextsEqual,
} from './message/renderCompare';
import { getAssistantError, extractMessageTextContent } from './message/chatMessageTextContent';
import { useChatMessageModelMetadata } from './message/useChatMessageModelMetadata';
import { useChatMessageAnimation } from './message/useChatMessageAnimation';
import { useChatMessagePopupState } from './message/useChatMessagePopupState';

const ToolOutputDialog = lazyWithChunkRecovery(() => import('./message/ToolOutputDialog'));

interface ChatMessageProps {
  message: {
    info: Message;
    parts: Part[];
  };
  previousMessage?: {
    info: Message;
    parts: Part[];
  };
  nextMessage?: {
    info: Message;
    parts: Part[];
  };
  onContentChange?: (reason?: ContentChangeReason) => void;
  animationHandlers?: AnimationHandlers;
  scrollToBottom?: () => void;
  turnGroupingContext?: TurnGroupingContext;
  isInActiveTurn?: boolean;
  activeStreamingPhase?: StreamPhase | null;
  animateUserOnMount?: boolean;
  onUserAnimationConsumed?: (messageId: string) => void;
}

const ChatMessage: React.FC<ChatMessageProps> = ({
  message,
  previousMessage,
  nextMessage,
  onContentChange,
  animationHandlers,
  turnGroupingContext,
  isInActiveTurn = false,
  activeStreamingPhase = null,
  animateUserOnMount = false,
  onUserAnimationConsumed,
}) => {
  const { isMobile, isTablet, hasTouchInput } = useDeviceInfo();
  const alwaysShowMessageActions = isMobile || isTablet;
  const { currentTheme } = useThemeSystem();
  const messageContainerRef = React.useRef<HTMLDivElement | null>(null);

  streamPerfCount('ui.chat_message.render');
  if (isInActiveTurn) {
    streamPerfCount('ui.chat_message.render.streaming');
  }

  const [copiedMessage, setCopiedMessage] = React.useState(false);

  const messageRole = React.useMemo(() => deriveMessageRole(message.info), [message.info]);
  const isUser = messageRole.isUser;

  const sessionId = message.info.sessionID;

  const { headerAgentName, headerProviderID, headerModelName, headerVariant } = useChatMessageModelMetadata({
    message,
    previousMessage,
    isUser,
    sessionId,
    isInActiveTurn,
    turnGroupingContext,
  });

  const normalizedParts = React.useMemo(() => {
    const safeParts = normalizeParts(message.parts);
    if (!isUser) {
      return safeParts;
    }

    return normalizeUserDisplayParts(safeParts);
  }, [isUser, message.parts]);

  const messageCompletedAt = React.useMemo(() => {
    const timeInfo = message.info.time as { completed?: number } | undefined;
    return typeof timeInfo?.completed === 'number' ? timeInfo.completed : null;
  }, [message.info.time]);

  const messageCreatedAt = React.useMemo(() => {
    const timeInfo = message.info.time as { created?: number } | undefined;
    return typeof timeInfo?.created === 'number' ? timeInfo.created : null;
  }, [message.info.time]);

  const isMessageCompleted = React.useMemo(() => {
    if (isUser) return true;
    return Boolean(messageCompletedAt && messageCompletedAt > 0);
  }, [isUser, messageCompletedAt]);

  const messageFinish = React.useMemo(() => {
    const finish = (message.info as { finish?: string }).finish;
    return typeof finish === 'string' ? finish : undefined;
  }, [message.info]);

  const visibleParts = React.useMemo(
    () =>
      filterVisibleParts(normalizedParts, {
        includeReasoning: true,
      }),
    [normalizedParts],
  );

  const activityPartIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const activity of turnGroupingContext?.activityParts ?? []) {
      ids.add(activity.id);
    }
    return ids;
  }, [turnGroupingContext?.activityParts]);

  const displayParts = React.useMemo(() => {
    if (isUser) {
      return visibleParts;
    }

    // Assistant responses render final text only; turn activity is owned by
    // the shared process rail, so progress/tool/reasoning/justification parts
    // are always removed from the response body.
    return filterAssistantFinalParts(visibleParts, activityPartIds, message.info.id);
  }, [activityPartIds, isUser, message.info.id, visibleParts]);

  // Attachments render in the footer below the bubble, so a message with
  // files but no text skips the bubble box instead of leaving an empty pill.
  const hasUserBubbleContent = isUser && displayParts.some(isUserBubbleContentPart);

  const assistantTextParts = React.useMemo(() => {
    if (isUser) {
      return [];
    }
    return displayParts.filter((part) => part.type === 'text');
  }, [displayParts, isUser]);

  const toolParts = React.useMemo(() => {
    if (isUser) {
      return [];
    }
    return visibleParts.filter((part) => part.type === 'tool');
  }, [isUser, visibleParts]);

  const {
    popupContent,
    handleShowPopup,
    handlePopupChange,
  } = useChatMessagePopupState();

  const agentMention = React.useMemo(() => {
    if (!isUser) {
      return undefined;
    }
    const mentionPart = normalizedParts.find((part) => part.type === 'agent');
    if (!mentionPart) {
      return undefined;
    }
    const partWithName = mentionPart as { name?: string; source?: { value?: string } };
    const name = typeof partWithName.name === 'string' ? partWithName.name : undefined;
    if (!name) {
      return undefined;
    }
    const rawValue =
      partWithName.source &&
      typeof partWithName.source.value === 'string' &&
      partWithName.source.value.trim().length > 0
        ? partWithName.source.value
        : `@${name}`;
    return { name, token: rawValue } satisfies AgentMentionInfo;
  }, [isUser, normalizedParts]);

  const shouldHideUserMessage = isUser && displayParts.length === 0;

  const hasOpenStep = !isMessageCompleted && typeof messageFinish !== 'string';

  const shouldCoordinateRendering = React.useMemo(() => {
    if (isUser) {
      return false;
    }
    if (assistantTextParts.length === 0 || toolParts.length === 0) {
      return hasOpenStep;
    }
    return true;
  }, [assistantTextParts.length, toolParts.length, hasOpenStep, isUser]);

  const themeVariant = currentTheme?.metadata.variant;
  const isDarkTheme = React.useMemo(() => {
    if (themeVariant) {
      return themeVariant === 'dark';
    }
    if (typeof document !== 'undefined') {
      return document.documentElement.classList.contains('dark');
    }
    return false;
  }, [themeVariant]);

  const nextRole = React.useMemo(() => {
    if (!nextMessage) return null;
    return deriveMessageRole(nextMessage.info);
  }, [nextMessage]);

  const hasTurnGrouping = Boolean(turnGroupingContext);
  const isLastAssistantInTurn = turnGroupingContext?.isLastAssistantInTurn ?? false;

  const nextIsHiddenUserMessage = React.useMemo(
    () => !isUser && isHiddenUserMessage(nextMessage),
    [isUser, nextMessage],
  );

  const isFollowedByAssistant = React.useMemo(() => {
    if (isUser) return false;
    if (hasTurnGrouping) {
      return !isLastAssistantInTurn;
    }
    if (!nextRole) return false;
    return !nextRole.isUser && nextRole.role === 'assistant';
  }, [hasTurnGrouping, isLastAssistantInTurn, isUser, nextRole]);

  const streamPhase: StreamPhase = React.useMemo(() => {
    if (isMessageCompleted) {
      return 'completed';
    }
    if (isInActiveTurn) {
      return activeStreamingPhase ?? 'streaming';
    }
    return 'completed';
  }, [activeStreamingPhase, isInActiveTurn, isMessageCompleted]);

  const hasReasoningParts = React.useMemo(() => {
    if (isUser) {
      return false;
    }
    return displayParts.some((part) => part.type === 'reasoning');
  }, [displayParts, isUser]);

  const { hasAnnouncedAuxiliaryScrollRef } = useChatMessageAnimation({
    message,
    isUser,
    sessionId,
    streamPhase,
    assistantTextParts,
    shouldCoordinateRendering,
    hasReasoningParts,
    animationHandlers,
    messageContainerRef,
  });

  React.useEffect(() => {
    if (!isUser || !animateUserOnMount) {
      return;
    }
    onUserAnimationConsumed?.(message.info.id);
  }, [animateUserOnMount, isUser, message.info.id, onUserAnimationConsumed]);

  const assistantError = React.useMemo(() => {
    if (isUser) {
      return undefined;
    }
    return getAssistantError(message.info);
  }, [isUser, message.info]);

  const assistantErrorText = assistantError?.text;
  const assistantErrorVariant = assistantError?.variant;

  const messageTextContent = React.useMemo(() => {
    return extractMessageTextContent({
      isUser,
      displayParts,
      assistantErrorText,
    });
  }, [assistantErrorText, displayParts, isUser]);

  const hasTextContent = messageTextContent.length > 0;

  const shouldHideEmptyAssistant = React.useMemo(() => {
    if (isUser) {
      return false;
    }
    return !hasRenderableAssistantContent(displayParts, assistantErrorText);
  }, [assistantErrorText, displayParts, isUser]);

  const handleCopyMessage = React.useCallback(async () => {
    let result;
    if (isUser) {
      result = await copyTextToClipboard(messageTextContent);
    } else {
      const { renderMarkdownSync } = await import('./markdown/markdownCore');
      result = await copyMarkdownToClipboard(messageTextContent, renderMarkdownSync(messageTextContent));
    }
    if (!result.ok) {
      return false;
    }
    if (isUser) {
      setCopiedMessage(true);
      setTimeout(() => setCopiedMessage(false), 2000);
    }
    return true;
  }, [isUser, messageTextContent]);

  const handleAuxiliaryContentComplete = React.useCallback(() => {
    if (isUser) {
      return;
    }
    if (hasAnnouncedAuxiliaryScrollRef.current) {
      return;
    }
    hasAnnouncedAuxiliaryScrollRef.current = true;
    onContentChange?.('structural');
  }, [hasAnnouncedAuxiliaryScrollRef, isUser, onContentChange]);

  if (shouldHideUserMessage || shouldHideEmptyAssistant) {
    return null;
  }

  const assistantTopPaddingClass = 'pt-0';
  const userMessageRadius = 'var(--radius-xl)';
  const userMessageBodyProps = {
    sessionId: message.info.sessionID,
    messageId: message.info.id,
    parts: displayParts,
    isUser,
    isMessageCompleted,
    messageFinish,
    messageCreatedAt: messageCreatedAt ?? undefined,
    isMobile,
    alwaysShowActions: alwaysShowMessageActions,
    hasTouchInput,
    onShowPopup: handleShowPopup,
    streamPhase,
    onContentChange,
    hasTextContent,
    onCopyMessage: handleCopyMessage,
    copiedMessage,
    onAuxiliaryContentComplete: handleAuxiliaryContentComplete,
    agentMention,
    errorMessage: assistantErrorText,
    errorVariant: assistantErrorVariant,
    isLatestMessage: !nextMessage,
  };

  return (
    <>
      <div
        className={cn(
          'group w-full',
          isUser ? (isMobile ? 'pt-2' : 'pt-4') : assistantTopPaddingClass,
          isUser ? (isMobile ? 'pb-0' : 'pb-2') : isFollowedByAssistant || nextIsHiddenUserMessage ? 'pb-0' : 'pb-2',
        )}
        id={`message-${message.info.id}`}
        data-message-id={message.info.id}
        ref={messageContainerRef}
      >
        <div className="chat-message-column relative">
          {isUser ? (
            displayParts.length === 0 ? null : (
              <FadeInOnReveal
                forceAnimation
                skipAnimation={!animateUserOnMount}
                ignoreContextDisabled
                respectReducedMotion
              >
                <div className={cn('relative flex justify-end', !isMobile ? 'group/user-shell' : undefined)}>
                  <div className="max-w-[85%]">
                    {hasUserBubbleContent ? (
                      <div
                        style={{
                          backgroundColor: 'var(--chat-user-message-bg)',
                          borderRadius: userMessageRadius,
                          borderBottomRightRadius: 'var(--radius-sm)',
                        }}
                        className={cn(
                          'shadow-none border border-primary/5',
                          isMobile ? 'px-3 py-2' : 'px-5 py-3',
                          !isMobile && 'pb-4',
                        )}
                      >
                        <MessageBody
                          {...userMessageBodyProps}
                          userActionsMode="external-content"
                        />
                      </div>
                    ) : null}
                    <MessageBody {...userMessageBodyProps} userActionsMode="external-actions" />
                  </div>
                </div>
              </FadeInOnReveal>
            )
          ) : (
            <div className="relative">
              <MessageBody
                sessionId={message.info.sessionID}
                messageId={message.info.id}
                parts={displayParts}
                isUser={isUser}
                isMessageCompleted={isMessageCompleted}
                isLatestMessage={!nextMessage}
                messageFinish={messageFinish}
                messageCompletedAt={messageCompletedAt ?? undefined}
                messageCreatedAt={messageCreatedAt ?? undefined}
                durationMs={(message.info as { durationMs?: number }).durationMs}
                isMobile={isMobile}
                alwaysShowActions={alwaysShowMessageActions}
                hasTouchInput={hasTouchInput}
                onShowPopup={handleShowPopup}
                streamPhase={streamPhase}
                onContentChange={onContentChange}
                hasTextContent={hasTextContent}
                onCopyMessage={handleCopyMessage}
                copiedMessage={copiedMessage}
                onAuxiliaryContentComplete={handleAuxiliaryContentComplete}
                agentMention={agentMention}
                turnGroupingContext={turnGroupingContext}
                errorMessage={assistantErrorText}
                errorVariant={assistantErrorVariant}
                footerProviderID={headerProviderID}
                footerModelName={headerModelName}
                footerAgentName={headerAgentName}
                footerVariant={headerVariant}
                isDarkTheme={isDarkTheme}
              />
            </div>
          )}
        </div>
      </div>
      <React.Suspense fallback={null}>
        <ToolOutputDialog popup={popupContent} onOpenChange={handlePopupChange} isMobile={isMobile} />
      </React.Suspense>
    </>
  );
};

export default React.memo(ChatMessage, (prev, next) => {
  return (
    areRenderRelevantMessagesEqual(
      { info: prev.message.info, parts: prev.message.parts },
      { info: next.message.info, parts: next.message.parts },
    ) &&
    areOptionalNeighborMessagesEqual(
      prev.previousMessage ? { info: prev.previousMessage.info, parts: prev.previousMessage.parts } : undefined,
      next.previousMessage ? { info: next.previousMessage.info, parts: next.previousMessage.parts } : undefined,
    ) &&
    areOptionalNeighborMessagesEqual(
      prev.nextMessage ? { info: prev.nextMessage.info, parts: prev.nextMessage.parts } : undefined,
      next.nextMessage ? { info: next.nextMessage.info, parts: next.nextMessage.parts } : undefined,
    ) &&
    prev.isInActiveTurn === next.isInActiveTurn &&
    prev.activeStreamingPhase === next.activeStreamingPhase &&
    prev.animateUserOnMount === next.animateUserOnMount &&
    prev.onUserAnimationConsumed === next.onUserAnimationConsumed &&
    areRelevantTurnGroupingContextsEqual(
      prev.turnGroupingContext,
      next.turnGroupingContext,
      prev.message.info.id,
      deriveMessageRole(prev.message.info).isUser,
    )
  );
});
