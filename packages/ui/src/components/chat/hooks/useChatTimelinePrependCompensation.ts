import React from 'react';
import type { ChatMessageEntry } from '../lib/turns/types';
import type { MessageListHandle } from '../MessageList';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import {
  hasInsertedBeforeKnownOldest,
  isOlderHistoryPrependCommit,
  setScrollTopDefeatingMomentum,
  type TimelineIdentityToken,
  type ViewportAnchor,
} from './timelineScrollHelpers';

export interface PrePrependSnapshot {
  identity: TimelineIdentityToken;
  height: number;
  top: number;
  anchor: ViewportAnchor | null;
  historyVirtualized: boolean;
  oldestId: string | null;
  newestId: string | null;
}

export function useChatTimelinePrependCompensation({
  sessionKey,
  timelineIdentityRef,
  scrollRef,
  messageListRef,
  renderedMessages,
  isPinnedRef,
  goToBottom,
  captureViewportAnchor,
  restoreViewportAnchor,
}: {
  sessionKey: string | null;
  timelineIdentityRef: React.MutableRefObject<TimelineIdentityToken>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  messageListRef: React.RefObject<MessageListHandle | null>;
  renderedMessages: ChatMessageEntry[];
  isPinnedRef: React.MutableRefObject<boolean>;
  goToBottom: (mode?: 'instant' | 'smooth') => void;
  captureViewportAnchor: () => ViewportAnchor | null;
  restoreViewportAnchor: (anchor: ViewportAnchor) => boolean;
}) {
  const prePrependScrollRef = React.useRef<PrePrependSnapshot | null>(null);

  const prependTrackingRef = React.useRef<{
    oldestId: string | null;
    newestId: string | null;
    scrollHeight: number;
  } | null>(null);

  React.useLayoutEffect(() => {
    prePrependScrollRef.current = null;
    prependTrackingRef.current = null;
  }, [sessionKey]);

  React.useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    let snap = prePrependScrollRef.current;
    const prev = prependTrackingRef.current;
    const currentOldestId = renderedMessages[0]?.info?.id ?? null;
    const currentNewestId = renderedMessages[renderedMessages.length - 1]?.info?.id ?? null;

    const isPrepend = prev
      ? isOlderHistoryPrependCommit({
          previousOldestId: prev.oldestId,
          previousNewestId: prev.newestId,
          currentOldestId,
          currentNewestId,
        }) || hasInsertedBeforeKnownOldest(prev.oldestId, currentOldestId, renderedMessages)
      : false;

    if (snap && snap.identity !== timelineIdentityRef.current) {
      prePrependScrollRef.current = null;
      snap = null;
    }

    const isSnapshotPrepend = snap
      ? isOlderHistoryPrependCommit({
          previousOldestId: snap.oldestId,
          previousNewestId: snap.newestId,
          currentOldestId,
          currentNewestId,
        }) || hasInsertedBeforeKnownOldest(snap.oldestId, currentOldestId, renderedMessages)
      : false;
    const didPrepend = isPrepend || isSnapshotPrepend;
    const shouldConsumeSnapshot = Boolean(snap && (isPrepend || isSnapshotPrepend));

    const updateTracking = () => {
      prependTrackingRef.current = {
        oldestId: currentOldestId,
        newestId: currentNewestId,
        scrollHeight: container.scrollHeight,
      };
    };

    const refreshPendingSnapshot = () => {
      const pending = prePrependScrollRef.current;
      if (!pending) {
        return;
      }

      prePrependScrollRef.current = {
        ...pending,
        height: container.scrollHeight,
        top: container.scrollTop,
        anchor: captureViewportAnchor(),
        oldestId: currentOldestId,
        newestId: currentNewestId,
      };
    };

    if (isPinnedRef.current) {
      if (didPrepend) {
        prePrependScrollRef.current = null;
        goToBottom('instant');
      } else if (snap) {
        refreshPendingSnapshot();
      }
      updateTracking();
      return;
    }

    const historyVirtualized = messageListRef.current?.isHistoryVirtualized() ?? false;

    if (snap && shouldConsumeSnapshot) {
      prePrependScrollRef.current = null;
      if (historyVirtualized) {
        if (!snap.historyVirtualized && snap.anchor) {
          restoreViewportAnchor(snap.anchor);
        }
        updateTracking();
        return;
      }

      const heightDelta = container.scrollHeight - snap.height;
      const applyHeightDelta = (): boolean => {
        if (heightDelta <= 0) {
          return false;
        }
        container.scrollTop = snap.top + heightDelta;
        return true;
      };

      if (isMobileSurfaceRuntime() && heightDelta > 0) {
        setScrollTopDefeatingMomentum(container, snap.top + heightDelta);
        updateTracking();
        return;
      }

      if (!(snap.anchor && restoreViewportAnchor(snap.anchor))) {
        applyHeightDelta();
      }
    } else if (isPrepend && prev && !historyVirtualized) {
      const delta = container.scrollHeight - prev.scrollHeight;
      if (delta > 0) {
        const target = container.scrollTop + delta;
        if (isMobileSurfaceRuntime()) {
          setScrollTopDefeatingMomentum(container, target);
        } else {
          container.scrollTop = target;
        }
      }
    } else if (snap) {
      refreshPendingSnapshot();
    }

    updateTracking();
  }, [captureViewportAnchor, messageListRef, renderedMessages, scrollRef, restoreViewportAnchor, goToBottom, isPinnedRef, timelineIdentityRef]);

  return {
    prePrependScrollRef,
  };
}
