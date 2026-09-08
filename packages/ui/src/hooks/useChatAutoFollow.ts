import React from 'react';

import { MessageFreshnessDetector } from '@/lib/messageFreshness';
import type {
  AnimationHandlers,
  AutoFollowState,
  ContentChangeReason,
  UseChatAutoFollowOptions,
  UseChatAutoFollowResult,
} from './autoFollow/autoFollowTypes';
import {
  ANIMATION_GUARD_MS,
  AUTO_MARK_TTL_MS,
  AUTO_MATCH_TOLERANCE_PX,
  ENTRY_STICK_MAX_MS,
  ENTRY_STICK_QUIESCENCE_MS,
  SETTLE_MS,
  canScroll,
  distanceFromBottom,
  isNearBottom,
  now,
} from './autoFollow/autoFollowHelpers';
import { useAutoFollowTurnObserver } from './autoFollow/useAutoFollowTurnObserver';
import { useAutoFollowKeyboardGestures } from './autoFollow/useAutoFollowKeyboardGestures';

export type {
  AnimationHandlers,
  AutoFollowState,
  ContentChangeReason,
  UseChatAutoFollowOptions,
  UseChatAutoFollowResult,
} from './autoFollow/autoFollowTypes';

export const useChatAutoFollow = ({
  currentSessionId,
  currentSessionKey,
  sessionMessageCount,
  sessionIsWorking,
  isMobile,
  onActiveTurnChange,
}: UseChatAutoFollowOptions): UseChatAutoFollowResult => {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [containerEl, setContainerEl] = React.useState<HTMLDivElement | null>(null);
  const lastSeenContainerRef = React.useRef<HTMLDivElement | null>(null);

  const [state, setState] = React.useState<AutoFollowState>('following');
  const [isOverflowing, setIsOverflowing] = React.useState(false);
  const [showScrollButton, setShowScrollButton] = React.useState(false);
  const [isFollowingProgrammatically, setIsFollowingProgrammatically] = React.useState(false);

  const stateRef = React.useRef<AutoFollowState>('following');
  const isMobileRef = React.useRef(isMobile);
  isMobileRef.current = isMobile;
  const sessionIsWorkingRef = React.useRef(sessionIsWorking);
  sessionIsWorkingRef.current = sessionIsWorking;

  const settlingRef = React.useRef(false);
  const settleTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentSessionKeyRef = React.useRef(currentSessionKey);
  currentSessionKeyRef.current = currentSessionKey;

  const lastSessionKeyRef = React.useRef<string | null>(null);

  const autoRef = React.useRef<{ top: number; time: number } | null>(null);
  const autoTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const animationGuardUntilRef = React.useRef(0);
  const keyboardAnimRef = React.useRef(false);
  const lastScrollTopRef = React.useRef(0);

  const entryStickRef = React.useRef(false);
  const entryStickQuietTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const entryStickCapTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const entryStickLastHeightRef = React.useRef(0);

  const pendingInitialRestoreRef = React.useRef<string | null>(null);

  // Detect container DOM element changes across mounts/remounts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useLayoutEffect(() => {
    if (scrollRef.current !== lastSeenContainerRef.current) {
      lastSeenContainerRef.current = scrollRef.current;
      setContainerEl(scrollRef.current);
    }
  });

  const isActive = React.useCallback((): boolean => {
    return sessionIsWorkingRef.current || settlingRef.current;
  }, []);

  const setStateValue = React.useCallback((next: AutoFollowState) => {
    if (stateRef.current === next) return;
    stateRef.current = next;
    setState(next);
  }, []);

  const markAuto = React.useCallback((el: HTMLElement) => {
    autoRef.current = {
      top: Math.max(0, el.scrollHeight - el.clientHeight),
      time: now(),
    };
    if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
    autoTimerRef.current = setTimeout(() => {
      autoRef.current = null;
      autoTimerRef.current = null;
    }, AUTO_MARK_TTL_MS);
  }, []);

  const isAuto = React.useCallback((el: HTMLElement): boolean => {
    const a = autoRef.current;
    if (!a) return false;
    if (now() - a.time > AUTO_MARK_TTL_MS) {
      autoRef.current = null;
      return false;
    }
    return Math.abs(el.scrollTop - a.top) < AUTO_MATCH_TOLERANCE_PX;
  }, []);

  const isAnimationGuardActive = React.useCallback((): boolean => {
    return now() < animationGuardUntilRef.current;
  }, []);

  const endEntryStick = React.useCallback(() => {
    entryStickRef.current = false;
    if (entryStickQuietTimerRef.current) {
      clearTimeout(entryStickQuietTimerRef.current);
      entryStickQuietTimerRef.current = null;
    }
    if (entryStickCapTimerRef.current) {
      clearTimeout(entryStickCapTimerRef.current);
      entryStickCapTimerRef.current = null;
    }
  }, []);

  const armEntryStickQuiet = React.useCallback(() => {
    if (entryStickQuietTimerRef.current) {
      clearTimeout(entryStickQuietTimerRef.current);
    }
    entryStickQuietTimerRef.current = setTimeout(() => {
      entryStickQuietTimerRef.current = null;
      endEntryStick();
    }, ENTRY_STICK_QUIESCENCE_MS);
  }, [endEntryStick]);

  const beginEntryStick = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    entryStickRef.current = true;
    entryStickLastHeightRef.current = el.scrollHeight;
    armEntryStickQuiet();
    if (entryStickCapTimerRef.current) {
      clearTimeout(entryStickCapTimerRef.current);
    }
    entryStickCapTimerRef.current = setTimeout(() => {
      entryStickCapTimerRef.current = null;
      endEntryStick();
    }, ENTRY_STICK_MAX_MS);
  }, [armEntryStickQuiet, endEntryStick]);

  const updateOverflowAndButton = React.useCallback(() => {
    const container = scrollRef.current;
    if (!container) {
      setIsOverflowing(false);
      setShowScrollButton(false);
      return;
    }
    const overflowing = canScroll(container);
    setIsOverflowing(overflowing);
    if (!overflowing) {
      setShowScrollButton(false);
      return;
    }
    const showButton = stateRef.current === 'released' && !isNearBottom(container, isMobileRef.current);
    setShowScrollButton(showButton);
  }, []);

  const scrollToBottomNow = React.useCallback(
    (behavior: ScrollBehavior) => {
      const el = scrollRef.current;
      if (!el) return;
      markAuto(el);
      const overshootTarget = el.scrollHeight + 4096;
      if (behavior === 'smooth') {
        el.scrollTo({ top: overshootTarget, behavior });
        return;
      }
      el.scrollTop = overshootTarget;
    },
    [markAuto],
  );

  const scrollToBottom = React.useCallback(
    (force: boolean, behavior: ScrollBehavior = 'auto') => {
      const el = scrollRef.current;

      if (!force && !isActive()) return;

      if (force && stateRef.current !== 'following') {
        setStateValue('following');
      }
      if (!el) return;
      if (!force && stateRef.current !== 'following') return;

      scrollToBottomNow(force ? behavior : 'auto');
    },
    [isActive, scrollToBottomNow, setStateValue],
  );

  const stop = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!canScroll(el)) {
      setStateValue('following');
      return;
    }
    if (stateRef.current === 'released') return;
    setStateValue('released');
    updateOverflowAndButton();
  }, [setStateValue, updateOverflowAndButton]);

  const goToBottom = React.useCallback(
    (mode: 'instant' | 'smooth' = 'instant') => {
      scrollToBottom(true, mode === 'smooth' ? 'smooth' : 'auto');
    },
    [scrollToBottom],
  );

  const scrollToBottomOnSend = React.useCallback(() => {
    scrollToBottom(true);
  }, [scrollToBottom]);

  const releaseAutoFollow = React.useCallback(() => {
    setStateValue('released');
    updateOverflowAndButton();
  }, [setStateValue, updateOverflowAndButton]);

  const releaseFromUserIntent = React.useCallback(() => {
    endEntryStick();
    stop();
  }, [endEntryStick, stop]);

  const restoreSnapshot = React.useCallback(async (): Promise<boolean> => {
    const sessionKey = currentSessionKeyRef.current;
    if (!sessionKey) return false;

    const container = scrollRef.current;
    if (!container) {
      pendingInitialRestoreRef.current = sessionKey;
      setStateValue('following');
      return false;
    }
    pendingInitialRestoreRef.current = null;

    setStateValue('following');
    scrollToBottom(true);
    beginEntryStick();
    updateOverflowAndButton();
    return false;
  }, [beginEntryStick, scrollToBottom, setStateValue, updateOverflowAndButton]);

  React.useEffect(() => {
    if (!currentSessionId || !currentSessionKey || currentSessionKey === lastSessionKeyRef.current) {
      return;
    }
    lastSessionKeyRef.current = currentSessionKey;
    MessageFreshnessDetector.getInstance().recordSessionStart(currentSessionId);
    autoRef.current = null;
    if (pendingInitialRestoreRef.current && pendingInitialRestoreRef.current !== currentSessionKey) {
      pendingInitialRestoreRef.current = null;
    }
  }, [currentSessionId, currentSessionKey]);

  React.useEffect(() => {
    settlingRef.current = false;
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }

    if (sessionIsWorking) {
      if (stateRef.current === 'following') {
        scrollToBottom(true);
      }
      return;
    }

    settlingRef.current = true;
    settleTimerRef.current = setTimeout(() => {
      settlingRef.current = false;
      settleTimerRef.current = null;
    }, SETTLE_MS);
  }, [sessionIsWorking, scrollToBottom]);

  React.useEffect(() => {
    setIsFollowingProgrammatically(state === 'following' && sessionIsWorking);
  }, [state, sessionIsWorking]);

  React.useLayoutEffect(() => {
    if (!containerEl) return;
    if (pendingInitialRestoreRef.current && pendingInitialRestoreRef.current === currentSessionKey) {
      void restoreSnapshot();
    }
  }, [containerEl, currentSessionKey, restoreSnapshot]);

  const handleScrollEvent = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const previousTop = lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    const scrollingDown = el.scrollTop > previousTop + 0.5;

    updateOverflowAndButton();

    if (!canScroll(el)) {
      setStateValue('following');
      return;
    }

    if (isNearBottom(el, isMobileRef.current)) {
      const atTrueBottom = distanceFromBottom(el) <= AUTO_MATCH_TOLERANCE_PX;
      if (scrollingDown || stateRef.current === 'following' || atTrueBottom) {
        setStateValue('following');
      }
      return;
    }

    if (stateRef.current === 'following' && (isAuto(el) || isAnimationGuardActive())) {
      scrollToBottom(false);
      return;
    }

    stop();
  }, [isAnimationGuardActive, isAuto, scrollToBottom, setStateValue, stop, updateOverflowAndButton]);

  useAutoFollowKeyboardGestures({
    containerEl,
    handleScrollEvent,
    releaseFromUserIntent,
    scrollRef,
    stateRef,
    canScroll,
    scrollToBottomNow,
    updateOverflowAndButton,
    keyboardAnimRef,
    animationGuardUntilRef,
    lastScrollTopRef,
  });

  React.useEffect(() => {
    const container = containerEl;
    if (!container || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (keyboardAnimRef.current) {
        updateOverflowAndButton();
        return;
      }
      const el = scrollRef.current;
      if (el && !canScroll(el)) {
        setStateValue('following');
        updateOverflowAndButton();
        return;
      }
      updateOverflowAndButton();
      if (entryStickRef.current && el) {
        const grew = el.scrollHeight > entryStickLastHeightRef.current + 1;
        entryStickLastHeightRef.current = el.scrollHeight;
        scrollToBottom(true);
        if (grew) armEntryStickQuiet();
        return;
      }
      if (!isActive()) return;
      if (stateRef.current !== 'following') return;
      scrollToBottom(false);
    });
    observer.observe(container);
    const inner = container.firstElementChild;
    if (inner instanceof Element) {
      observer.observe(inner);
    }
    return () => observer.disconnect();
  }, [armEntryStickQuiet, containerEl, isActive, scrollToBottom, setStateValue, updateOverflowAndButton]);

  React.useEffect(() => {
    updateOverflowAndButton();
  }, [sessionMessageCount, updateOverflowAndButton]);

  const notifyContentChange = React.useCallback(
    (reason?: ContentChangeReason) => {
      if (reason === 'animation') {
        animationGuardUntilRef.current = now() + ANIMATION_GUARD_MS;
      }
      updateOverflowAndButton();
      if (entryStickRef.current) {
        scrollToBottom(true);
        armEntryStickQuiet();
        return;
      }
      if (stateRef.current === 'following') {
        scrollToBottom(false);
      }
    },
    [armEntryStickQuiet, scrollToBottom, updateOverflowAndButton],
  );

  const animationHandlersRef = React.useRef<Map<string, AnimationHandlers>>(new Map());

  const getAnimationHandlers = React.useCallback(
    (messageId: string): AnimationHandlers => {
      const cached = animationHandlersRef.current.get(messageId);
      if (cached) return cached;

      const kick = () => {
        if (stateRef.current === 'following') {
          scrollToBottom(false);
        }
      };

      const handlers: AnimationHandlers = {
        onChunk: kick,
        onComplete: () => {
          updateOverflowAndButton();
        },
        onStreamingCandidate: () => {},
        onAnimationStart: () => {},
        onAnimatedHeightChange: kick,
        onReservationCancelled: () => {},
      };
      animationHandlersRef.current.set(messageId, handlers);
      return handlers;
    },
    [scrollToBottom, updateOverflowAndButton],
  );

  React.useEffect(() => {
    return () => {
      if (autoTimerRef.current) {
        clearTimeout(autoTimerRef.current);
        autoTimerRef.current = null;
      }
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      endEntryStick();
    };
  }, [endEntryStick]);

  useAutoFollowTurnObserver(containerEl, onActiveTurnChange);

  return {
    scrollRef,
    state,
    isPinned: state === 'following',
    isOverflowing,
    isFollowingProgrammatically,
    showScrollButton,
    notifyContentChange,
    getAnimationHandlers,
    goToBottom,
    scrollToBottomOnSend,
    releaseAutoFollow,
    restoreSnapshot,
  };
};
