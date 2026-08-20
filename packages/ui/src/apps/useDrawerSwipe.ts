import React from 'react';

import {
  DRAG_THRESHOLD,
  getDrawerProgress,
  getDrawerTransform,
  isClosingDirection,
  isSwipeExcludedTarget,
  MAX_OFF_AXIS,
  MIN_DISTANCE,
  shouldCloseFromDrawerGesture,
  type DrawerSide,
} from './gestureMath';

export const MOBILE_DRAWER_DURATION_MS = 320;
export const MOBILE_DRAWER_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

type DrawerSwipeOptions = {
  side: DrawerSide;
  enabled: boolean;
  open: boolean;
  drawerRef: React.RefObject<HTMLElement | null>;
  scrimRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  widthRatio: number;
  prefersReducedMotion: boolean;
};

export const useDrawerSwipe = ({
  side,
  enabled,
  open,
  drawerRef,
  scrimRef,
  onClose,
  widthRatio,
  prefersReducedMotion,
}: DrawerSwipeOptions): void => {
  React.useEffect(() => {
    if (!enabled || !open) return;
    const drawer = drawerRef.current;
    const scrim = scrimRef.current;
    if (!drawer || !scrim) return;

    let tracking = false;
    let isDragging = false;
    let hasDecided = false;
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let width = 0;

    const durationMs = prefersReducedMotion ? 0 : MOBILE_DRAWER_DURATION_MS;
    const closeTransform = side === 'left' ? 'translateX(-100%)' : 'translateX(100%)';

    const getDurationStyles = () => ({
      drawer: durationMs ? `transform ${durationMs}ms ${MOBILE_DRAWER_EASING}` : 'none',
      scrim: durationMs ? `opacity ${durationMs}ms ${MOBILE_DRAWER_EASING}` : 'none',
    });

    const restoreToOpen = () => {
      const styles = getDurationStyles();
      drawer.style.transition = styles.drawer;
      scrim.style.transition = styles.scrim;
      drawer.style.transform = 'none';
      scrim.style.opacity = '1';
      // Ensure scrim stays interactive when open; MobileApp manages pointerEvents for phone drawers,
      // but drawer swipe owns the same scrim when enabled, so restore it.
      (scrim as HTMLElement).style.pointerEvents = 'auto';
    };

    const clearTransientState = () => {
      tracking = false;
      isDragging = false;
      hasDecided = false;
    };

    /**
     * One cancellation path that always restores to known starting state,
     * restores scrim opacity/pointer, restores transitions, and clears drag state.
     * Used for multi-touch, touchcancel, and hook cleanup.
     */
    const cancelGesture = () => {
      const gestureWasActive = tracking || isDragging;
      if (!gestureWasActive) {
        // A committed close also tears down this effect when `open` changes.
        // Do not overwrite React's closed styles during that cleanup.
        clearTransientState();
        return;
      }
      restoreToOpen();
      clearTransientState();
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        // Multi-touch at start: cancel any in-flight gesture and don't start a new one.
        if (tracking || isDragging) cancelGesture();
        return;
      }
      if (isSwipeExcludedTarget(event.target, drawer)) return;
      // If a second drag starts before the previous settle animation finishes,
      // interrupt that animation so the new gesture starts from the current visual state.
      // Clear any running transition so the drawer tracks the new finger immediately.
      if (drawer.style.transition && drawer.style.transition !== 'none') {
        // Keep current visual position but make it draggable: remove transition, keep transform.
        // The new startX will base dx from the new finger origin; progress will jump slightly
        // but that's the correct interruption behavior rather than snapping.
        drawer.style.transition = 'none';
        scrim.style.transition = 'none';
      }
      const touch = event.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      startTime = Date.now();
      width = drawer.offsetWidth || window.innerWidth * widthRatio;
      if (width < 10) width = window.innerWidth * widthRatio;
      tracking = true;
      isDragging = false;
      hasDecided = false;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!tracking) return;
      if (event.touches.length !== 1) {
        cancelGesture();
        return;
      }
      const touch = event.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (!hasDecided) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        if (Math.abs(dy) > Math.abs(dx) * MAX_OFF_AXIS || !isClosingDirection(side, dx)) {
          tracking = false;
          return;
        }
        hasDecided = true;
        isDragging = true;
        drawer.style.transition = 'none';
        scrim.style.transition = 'none';
      }
      if (!isDragging) return;
      if (event.cancelable) event.preventDefault();
      const progress = getDrawerProgress(side, dx, width);
      drawer.style.transform = getDrawerTransform(side, progress);
      scrim.style.opacity = String(progress);
    };

    const settle = (endX: number, endY: number, cancelled: boolean) => {
      if (!tracking) return;
      const dx = endX - startX;
      const dy = endY - startY;
      const dt = Math.max(1, Date.now() - startTime);
      const progress = getDrawerProgress(side, dx, width);
      const shouldClose = shouldCloseFromDrawerGesture({
        side,
        dx,
        dy,
        dt,
        progress,
        isDragging,
        cancelled,
      });

      const styles = getDurationStyles();
      drawer.style.transition = styles.drawer;
      scrim.style.transition = styles.scrim;
      drawer.style.transform = shouldClose ? closeTransform : 'none';
      scrim.style.opacity = shouldClose ? '0' : '1';
      (scrim as HTMLElement).style.pointerEvents = shouldClose ? 'none' : 'auto';
      // Mark the gesture settled before notifying React. The open=false effect
      // cleanup must not interpret a committed close as an active cancellation.
      clearTransientState();
      if (shouldClose) onClose();
    };

    const onTouchEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (!touch) {
        cancelGesture();
        return;
      }
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      const isHorizontalClose =
        Math.abs(dx) >= MIN_DISTANCE &&
        Math.abs(dy) <= Math.abs(dx) * MAX_OFF_AXIS &&
        isClosingDirection(side, dx);
      if (tracking && (isDragging || isHorizontalClose) && event.cancelable) {
        event.preventDefault();
      }
      settle(touch.clientX, touch.clientY, false);
    };

    const onTouchCancel = () => {
      cancelGesture();
    };

    drawer.addEventListener('touchstart', onTouchStart, { passive: true });
    drawer.addEventListener('touchmove', onTouchMove, { passive: false });
    drawer.addEventListener('touchend', onTouchEnd, { passive: false });
    drawer.addEventListener('touchcancel', onTouchCancel, { passive: true });
    return () => {
      // Hook cleanup/unmount must restore to known state so no stale transform remains
      try {
        cancelGesture();
      } catch {
        // Ensure cleanup never throws
      }
      drawer.removeEventListener('touchstart', onTouchStart);
      drawer.removeEventListener('touchmove', onTouchMove);
      drawer.removeEventListener('touchend', onTouchEnd);
      drawer.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [drawerRef, enabled, onClose, open, prefersReducedMotion, scrimRef, side, widthRatio]);
};
