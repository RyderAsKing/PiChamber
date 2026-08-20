import React from 'react';

import {
  DRAG_THRESHOLD,
  getEdgeProgress,
  isSwipeExcludedTarget,
  MAX_OFF_AXIS,
  MIN_DISTANCE,
  shouldSettleOpenForEdge,
} from './gestureMath';

/**
 * Native-feeling drawer swipes on the mobile chat: start a horizontal swipe
 * anywhere in the content area and drag toward the other side.
 *
 * - Drag right = open the sessions drawer
 * - Drag left = open the workspace drawer
 *
 * Interactive: while the finger moves the drawer follows it (progress 0..1 is
 * reported on every frame). Releasing settles with velocity + 50% threshold.
 * When a drawer is already open the same gesture in reverse drags it closed.
 *
 * Implementation is touch-based and never interferes with vertical chat
 * scrolling or horizontal code-block scroll — the gesture is only locked
 * after the horizontal component clearly dominates, and `preventDefault` is
 * only called then.
 */

const EDGE_ZONE = 48; // Used only to disambiguate two open drawers.
// Android reserves the physical screen edge for system navigation. Keep the
// wider zone for the rare case where both drawers are open at once.
const ANDROID_EDGE_ZONE = 96;

export interface EdgeSwipeOptions {
  /** Interactive open/close — called on settle (velocity + 50%). */
  onLeftOpen?: () => void;
  onRightOpen?: () => void;
  onLeftClose?: () => void;
  onRightClose?: () => void;

  /** Called every frame while dragging. Progress 0 = closed, 1 = fully open. */
  onLeftProgress?: (progress: number) => void;
  onRightProgress?: (progress: number) => void;

  /** Whether the drawers are currently open. Closed drawers open from any
   * non-interactive content point; an open drawer closes toward its edge. */
  leftOpen?: boolean;
  rightOpen?: boolean;

  /** Drawer width for progress mapping. Defaults to the container width. */
  leftWidth?: number | (() => number);
  rightWidth?: number | (() => number);

  /** Lifecycle for callers that need to disable transitions / stop springs. */
  onDragStart?: (side: 'left' | 'right') => void;
  onDragEnd?: (side: 'left' | 'right', didSettleOpen?: boolean) => void;

  /** When false, the gesture is ignored (e.g. desktop layout). */
  enabled?: boolean;
}

const invoke = <Args extends unknown[]>(
  callback: ((...args: Args) => void) | undefined,
  ...args: Args
): void => {
  try {
    callback?.(...args);
  } catch {
    // Gesture cleanup must continue when a caller callback fails.
  }
};

const getWidth = (value: number | (() => number) | undefined, fallback: number): number => {
  if (typeof value === 'function') {
    const v = value();
    return v > 0 ? v : fallback;
  }
  if (typeof value === 'number' && value > 0) return value;
  return fallback;
};

export const useEdgeSwipe = (
  ref: React.RefObject<HTMLElement | null>,
  options: EdgeSwipeOptions,
): void => {
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  const enabled = options.enabled;
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (enabled === false) return;
    // Permit horizontal descendants to scroll while still allowing us to
    // preventDefault after horizontal intent is confirmed. pan-y alone would
    // block horizontal scrolling inside code blocks/terminal/composer.
    const prevTouchAction = element.style.touchAction;
    element.style.touchAction = 'pan-x pan-y';
    const platform = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
    const edgeZone = platform === 'android' ? ANDROID_EDGE_ZONE : EDGE_ZONE;

    let tracking = false;
    let isDragging = false;
    let hasDecided = false;
    let side: 'left' | 'right' | null = null;
    let isOpenAtStart = false;
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let widthAtStart = 0;

    const reset = () => {
      tracking = false;
      isDragging = false;
      hasDecided = false;
      side = null;
    };

    const abortDraggingWithSnap = () => {
      const opts = optionsRef.current;
      const abortedSide = side;
      const wasOpen = isOpenAtStart;
      if (isDragging && abortedSide) {
        invoke(
          abortedSide === 'left' ? opts.onLeftProgress : opts.onRightProgress,
          wasOpen ? 1 : 0,
        );
        invoke(opts.onDragEnd, abortedSide, wasOpen);
      }
      reset();
    };

    /**
     * Single cancellation path for multi-touch / touchcancel: restores drawer to
     * starting state and clears transient drag state. Used for both mid-drag
     * and pre-drag cancellations.
     */
    const cancelGesture = () => {
      abortDraggingWithSnap();
      // If we never entered dragging but were tracking, just reset without snap.
      if (!isDragging) reset();
    };

    const onTouchStart = (event: TouchEvent) => {
      const opts = optionsRef.current;
      if (opts.enabled === false) {
        if (isDragging && side) abortDraggingWithSnap();
        else reset();
        return;
      }
      if (event.touches.length !== 1) {
        if (isDragging && side) abortDraggingWithSnap();
        else reset();
        return;
      }
      // If a second drag starts before the first settle animation finishes, the
      // previous settle's transition is still running on the drawer surface.
      // Let the next hasDecided -> onDragStart clear it (MobileApp clears timeouts/transitions there).
      const touch = event.touches[0];
      const rect = element.getBoundingClientRect();
      const width = element.clientWidth;
      const leftOpen = !!opts.leftOpen;
      const rightOpen = !!opts.rightOpen;

      const shouldExclude = (target: EventTarget | null) => isSwipeExcludedTarget(target, element);

      if (leftOpen || rightOpen) {
        // Apply exclusion even when a drawer is open — horizontal scrolling
        // inside code blocks, terminal, composer controls, tab lists must not
        // be hijacked as a close gesture.
        if (shouldExclude(event.target)) {
          reset();
          return;
        }
        if (leftOpen && rightOpen) {
          const nearLeft = touch.clientX <= rect.left + edgeZone;
          const nearRight = touch.clientX >= rect.right - edgeZone;
          if (nearRight) {
            side = 'right';
            isOpenAtStart = true;
          } else if (nearLeft) {
            side = 'left';
            isOpenAtStart = true;
          } else {
            side = leftOpen ? 'left' : 'right';
            isOpenAtStart = true;
          }
        } else if (leftOpen) {
          side = 'left';
          isOpenAtStart = true;
        } else {
          side = 'right';
          isOpenAtStart = true;
        }
        widthAtStart = getWidth(
          side === 'left' ? opts.leftWidth : opts.rightWidth,
          width,
        );
        if (widthAtStart < 10) widthAtStart = width || window.innerWidth || 320;
        if (widthAtStart < 10) widthAtStart = 320;
        tracking = true;
      } else {
        if (shouldExclude(event.target)) {
          reset();
          return;
        }
        side = null;
        isOpenAtStart = false;
        widthAtStart = 0;
        tracking = true;
      }

      startX = touch.clientX;
      startY = touch.clientY;
      startTime = Date.now();
      isDragging = false;
      hasDecided = false;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!tracking) return;
      if (event.touches.length !== 1) {
        // Two-finger interruption during active drag: cancel and restore
        cancelGesture();
        return;
      }
      const touch = event.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;

      if (!hasDecided) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        if (Math.abs(dy) > Math.abs(dx) * MAX_OFF_AXIS) {
          reset();
          return;
        }
        if (!side) {
          const opts = optionsRef.current;
          side = dx > 0 ? 'left' : 'right';
          widthAtStart = getWidth(
            side === 'left' ? opts.leftWidth : opts.rightWidth,
            element.clientWidth,
          );
          if (widthAtStart < 10) widthAtStart = window.innerWidth || 320;
        }
        // Wrong-direction and vertical gestures: reset rather than track
        if (side === 'left') {
          if (!isOpenAtStart && dx <= 0) { reset(); return; }
          if (isOpenAtStart && dx >= 0) { reset(); return; }
        } else {
          if (!isOpenAtStart && dx >= 0) { reset(); return; }
          if (isOpenAtStart && dx <= 0) { reset(); return; }
        }
        hasDecided = true;
        isDragging = true;
        invoke(optionsRef.current.onDragStart, side);
      }

      if (!isDragging) return;

      if (event.cancelable) event.preventDefault();

      const opts = optionsRef.current;
      const progress = getEdgeProgress(side!, isOpenAtStart, dx, widthAtStart);
      invoke(side === 'left' ? opts.onLeftProgress : opts.onRightProgress, progress);
    };

    const finish = (endX: number, endY: number) => {
      if (!tracking) {
        reset();
        return;
      }
      const dx = endX - startX;
      const dy = endY - startY;
      if (!side && !isOpenAtStart && Math.abs(dx) >= MIN_DISTANCE
        && Math.abs(dy) <= Math.abs(dx) * MAX_OFF_AXIS) {
        const opts = optionsRef.current;
        side = dx > 0 ? 'left' : 'right';
        widthAtStart = getWidth(
          side === 'left' ? opts.leftWidth : opts.rightWidth,
          element.clientWidth,
        );
        if (widthAtStart < 10) widthAtStart = window.innerWidth || 320;
      }
      if (!side) {
        reset();
        return;
      }
      const dt = Math.max(1, Date.now() - startTime);
      const opts = optionsRef.current;

      if (!isDragging) {
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        if (absDx >= MIN_DISTANCE && absDy <= absDx * MAX_OFF_AXIS) {
          if (side === 'left' && !isOpenAtStart && dx > 0) {
            invoke(opts.onLeftProgress, 1);
            invoke(opts.onLeftOpen);
          } else if (side === 'right' && !isOpenAtStart && dx < 0) {
            invoke(opts.onRightProgress, 1);
            invoke(opts.onRightOpen);
          } else {
            invoke(
              side === 'left' ? opts.onLeftProgress : opts.onRightProgress,
              isOpenAtStart ? 1 : 0,
            );
          }
        } else {
          invoke(
            side === 'left' ? opts.onLeftProgress : opts.onRightProgress,
            isOpenAtStart ? 1 : 0,
          );
        }
        const finishedSide = side;
        reset();
        invoke(opts.onDragEnd, finishedSide);
        return;
      }

      const progress = getEdgeProgress(side, isOpenAtStart, dx, widthAtStart);
      const shouldOpen = shouldSettleOpenForEdge({
        side,
        isOpenAtStart,
        dx,
        dt,
        progress,
      });

      const finishedSide = side;
      if (finishedSide === 'left') {
        invoke(shouldOpen ? opts.onLeftOpen : opts.onLeftClose);
      } else {
        invoke(shouldOpen ? opts.onRightOpen : opts.onRightClose);
      }

      reset();
      invoke(opts.onDragEnd, finishedSide, shouldOpen);
    };

    const onTouchEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (!touch) { reset(); return; }
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (tracking && (isDragging || (Math.abs(dx) >= MIN_DISTANCE
        && Math.abs(dy) <= Math.abs(dx) * MAX_OFF_AXIS)) && event.cancelable) {
        event.preventDefault();
      }
      finish(touch.clientX, touch.clientY);
    };

    const onTouchCancel = () => {
      // touchcancel during open and close gestures: restore to starting state
      cancelGesture();
    };

    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: false });
    element.addEventListener('touchend', onTouchEnd, { passive: false });
    element.addEventListener('touchcancel', onTouchCancel, { passive: true });
    return () => {
      // Hook cleanup/unmount: ensure any in-flight drag is cancelled and restored
      try {
        if (isDragging && side) abortDraggingWithSnap();
      } catch {
        // never throw during cleanup
      }
      element.style.touchAction = prevTouchAction;
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [ref, enabled]);
};
