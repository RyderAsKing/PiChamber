import React from 'react';

export type AutoFollowState = 'following' | 'released';

export type ContentChangeReason = 'text' | 'structural' | 'permission' | 'animation';

export interface AnimationHandlers {
  onChunk: () => void;
  onComplete: () => void;
  onStreamingCandidate?: () => void;
  onAnimationStart?: () => void;
  onReservationCancelled?: () => void;
  onReasoningBlock?: () => void;
  onAnimatedHeightChange?: (height: number) => void;
}

export interface UseChatAutoFollowOptions {
  currentSessionId: string | null;
  currentSessionKey: string | null;
  sessionMessageCount: number;
  sessionIsWorking: boolean;
  isMobile: boolean;
  onActiveTurnChange?: (turnId: string | null) => void;
}

export interface UseChatAutoFollowResult {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  state: AutoFollowState;
  isPinned: boolean;
  isOverflowing: boolean;
  isFollowingProgrammatically: boolean;
  showScrollButton: boolean;
  notifyContentChange: (reason?: ContentChangeReason) => void;
  getAnimationHandlers: (messageId: string) => AnimationHandlers;
  goToBottom: (mode?: 'instant' | 'smooth') => void;
  scrollToBottomOnSend: () => void;
  releaseAutoFollow: () => void;
  saveSnapshotNow: () => void;
  restoreSnapshot: () => Promise<boolean>;
}
