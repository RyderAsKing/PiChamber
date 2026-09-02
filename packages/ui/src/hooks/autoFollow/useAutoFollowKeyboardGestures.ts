import React from 'react';
import {
  ANIMATION_GUARD_MS,
  TOUCH_FINGER_DOWN_THRESHOLD,
  isReleaseKey,
  nestedScrollableCanConsumeUp,
  now,
} from './autoFollowHelpers';

export function useAutoFollowKeyboardGestures({
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
}: {
  containerEl: HTMLDivElement | null;
  handleScrollEvent: () => void;
  releaseFromUserIntent: () => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  stateRef: React.MutableRefObject<'following' | 'released'>;
  canScroll: (el: HTMLElement) => boolean;
  scrollToBottomNow: (behavior: ScrollBehavior) => void;
  updateOverflowAndButton: () => void;
  keyboardAnimRef: React.MutableRefObject<boolean>;
  animationGuardUntilRef: React.MutableRefObject<number>;
  lastScrollTopRef: React.MutableRefObject<number>;
}) {
  React.useEffect(() => {
    const container = containerEl;
    if (!container) return;

    lastScrollTopRef.current = container.scrollTop;

    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY >= 0) return;
      if (nestedScrollableCanConsumeUp(container, event.target)) return;
      releaseFromUserIntent();
    };

    let touchLastY: number | null = null;
    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches.item(0);
      touchLastY = touch ? touch.clientY : null;
    };
    const handleTouchMove = (event: TouchEvent) => {
      const touch = event.touches.item(0);
      if (!touch) {
        touchLastY = null;
        return;
      }
      const previousY = touchLastY;
      touchLastY = touch.clientY;
      if (previousY === null) return;
      const fingerDelta = touch.clientY - previousY;
      if (fingerDelta <= TOUCH_FINGER_DOWN_THRESHOLD) return;
      if (nestedScrollableCanConsumeUp(container, event.target)) return;
      releaseFromUserIntent();
    };
    const handleTouchEnd = () => {
      touchLastY = null;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isReleaseKey(event)) return;
      releaseFromUserIntent();
    };

    const handlePointerDownIntent = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest('[data-overlay-scrollbar-thumb]')) return;
      releaseFromUserIntent();
    };

    container.addEventListener('scroll', handleScrollEvent, { passive: true });
    container.addEventListener('wheel', handleWheel, { passive: true });
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: true });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });
    container.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    container.addEventListener('keydown', handleKeyDown);
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', handlePointerDownIntent, true);
    }

    return () => {
      container.removeEventListener('scroll', handleScrollEvent);
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
      container.removeEventListener('touchcancel', handleTouchEnd);
      container.removeEventListener('keydown', handleKeyDown);
      if (typeof window !== 'undefined') {
        window.removeEventListener('pointerdown', handlePointerDownIntent, true);
      }
    };
  }, [containerEl, handleScrollEvent, lastScrollTopRef, releaseFromUserIntent]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleKeyboardAnim = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          phase: 'show' | 'hide';
          slide: number;
          durationMs: number;
          easing: string;
        }>
      ).detail;
      if (!detail) return;
      keyboardAnimRef.current = true;
      animationGuardUntilRef.current = now() + detail.durationMs + ANIMATION_GUARD_MS;
    };

    const handleKeyboardSettled = () => {
      keyboardAnimRef.current = false;
      const el = scrollRef.current;
      if (!el) {
        updateOverflowAndButton();
        return;
      }
      if (stateRef.current === 'following' && canScroll(el)) {
        scrollToBottomNow('auto');
      }
      updateOverflowAndButton();
    };

    window.addEventListener('oc:keyboard-anim', handleKeyboardAnim);
    window.addEventListener('oc:keyboard-settled', handleKeyboardSettled);
    return () => {
      window.removeEventListener('oc:keyboard-anim', handleKeyboardAnim);
      window.removeEventListener('oc:keyboard-settled', handleKeyboardSettled);
      keyboardAnimRef.current = false;
    };
  }, [
    animationGuardUntilRef,
    canScroll,
    keyboardAnimRef,
    scrollRef,
    scrollToBottomNow,
    stateRef,
    updateOverflowAndButton,
  ]);
}
