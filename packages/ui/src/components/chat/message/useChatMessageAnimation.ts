import React from 'react';
import type { Message, Part } from '@/lib/chat/types';
import type { AnimationHandlers } from '@/hooks/useChatAutoFollow';
import { MessageFreshnessDetector } from '@/lib/messageFreshness';
import type { StreamPhase } from './types';
import { getMessageInfoProp } from './chatMessageMetadata';

export function useChatMessageAnimation({
  message,
  isUser,
  sessionId,
  streamPhase,
  assistantTextParts,
  shouldCoordinateRendering,
  hasReasoningParts,
  animationHandlers,
  messageContainerRef,
}: {
  message: { info: Message };
  isUser: boolean;
  sessionId: string | undefined;
  streamPhase: StreamPhase;
  assistantTextParts: Part[];
  shouldCoordinateRendering: boolean;
  hasReasoningParts: boolean;
  animationHandlers?: AnimationHandlers;
  messageContainerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const shouldAnimateMessage = React.useMemo(() => {
    if (isUser || !sessionId) return false;
    const freshnessDetector = MessageFreshnessDetector.getInstance();
    return freshnessDetector.shouldAnimateMessage(message.info, sessionId);
  }, [message.info, isUser, sessionId]);

  const resolvedAnimationHandlers = animationHandlers ?? null;
  const hasAnnouncedAuxiliaryScrollRef = React.useRef(false);
  const animationCompletedRef = React.useRef(false);
  const hasRequestedReservationRef = React.useRef(false);
  const animationStartNotifiedRef = React.useRef(false);
  const hasTriggeredReservationOnceRef = React.useRef(false);
  const hasEverStreamedRef = React.useRef(false);

  React.useEffect(() => {
    animationCompletedRef.current = false;
    hasRequestedReservationRef.current = false;
    animationStartNotifiedRef.current = false;
    hasTriggeredReservationOnceRef.current = false;
    hasAnnouncedAuxiliaryScrollRef.current = false;
    hasEverStreamedRef.current = false;
  }, [message.info.id]);

  const isAnimationSettled = Boolean(getMessageInfoProp(message.info, 'animationSettled'));
  const isStreamingPhase = streamPhase === 'streaming' || streamPhase === 'cooldown';

  if (isStreamingPhase) {
    hasEverStreamedRef.current = true;
  }

  const allowAnimation =
    shouldAnimateMessage && !isAnimationSettled && !isStreamingPhase && !hasEverStreamedRef.current;
  const shouldReserveAnimationSpace =
    !isUser && shouldAnimateMessage && assistantTextParts.length > 0 && !shouldCoordinateRendering;

  React.useEffect(() => {
    if (!resolvedAnimationHandlers?.onStreamingCandidate) {
      return;
    }

    if (!shouldReserveAnimationSpace) {
      if (hasRequestedReservationRef.current) {
        if (hasReasoningParts && resolvedAnimationHandlers?.onReasoningBlock) {
          resolvedAnimationHandlers.onReasoningBlock();
        } else if (resolvedAnimationHandlers?.onReservationCancelled) {
          resolvedAnimationHandlers.onReservationCancelled();
        }
        hasRequestedReservationRef.current = false;
      }
      return;
    }

    if (hasTriggeredReservationOnceRef.current) {
      return;
    }

    hasTriggeredReservationOnceRef.current = true;
    resolvedAnimationHandlers.onStreamingCandidate();
    hasRequestedReservationRef.current = true;
  }, [resolvedAnimationHandlers, shouldReserveAnimationSpace, hasReasoningParts]);

  React.useEffect(() => {
    if (!resolvedAnimationHandlers?.onAnimationStart) {
      return;
    }
    if (!allowAnimation) {
      return;
    }
    if (animationStartNotifiedRef.current) {
      return;
    }
    resolvedAnimationHandlers.onAnimationStart();
    animationStartNotifiedRef.current = true;
  }, [resolvedAnimationHandlers, allowAnimation]);

  React.useEffect(() => {
    if (isUser) {
      return;
    }

    const handler = resolvedAnimationHandlers?.onAnimatedHeightChange;
    if (!handler) {
      return;
    }

    const shouldTrackHeight = allowAnimation || shouldReserveAnimationSpace;
    if (!shouldTrackHeight) {
      return;
    }

    const element = messageContainerRef.current;
    if (!element) {
      return;
    }

    if (typeof window === 'undefined' || typeof ResizeObserver === 'undefined') {
      handler(element.getBoundingClientRect().height);
      return;
    }

    let rafId: number | null = null;
    const notifyHeight = (height: number) => {
      if (typeof window === 'undefined') {
        handler(height);
        return;
      }
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      rafId = window.requestAnimationFrame(() => {
        handler(height);
      });
    };

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      notifyHeight(entry.contentRect.height);
    });

    observer.observe(element);
    notifyHeight(element.getBoundingClientRect().height);

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      observer.disconnect();
    };
  }, [allowAnimation, isUser, resolvedAnimationHandlers, shouldReserveAnimationSpace, messageContainerRef]);

  return {
    allowAnimation,
    hasAnnouncedAuxiliaryScrollRef,
  };
}
