import React from 'react';

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
const MIN_DISTANCE = 48;
const MAX_OFF_AXIS_RATIO = 1.2;
const DRAG_THRESHOLD = 6;
const VELOCITY_THRESHOLD = 0.18;
const SETTLE_PROGRESS = 0.38;
const SWIPE_EXCLUDED_SELECTOR = 'button, a, input, textarea, select, [contenteditable="true"], [data-no-drawer-swipe]';

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

const isSwipeExcludedTarget = (target: EventTarget | null, root: HTMLElement): boolean => {
  if (!(target instanceof Element)) return false;
  const interactiveTarget = target.closest(SWIPE_EXCLUDED_SELECTOR);
  if (interactiveTarget && root.contains(interactiveTarget)) return true;

  let node: Element | null = target;
  while (node && node !== root) {
    if (node instanceof HTMLElement && node.scrollWidth > node.clientWidth) {
      const overflowX = getComputedStyle(node).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') return true;
    }
    node = node.parentElement;
  }
  return false;
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

  // Re-run when `enabled` flips so a remounted `ref.current` (e.g. isMobile
  // false→true) gets listeners attached. Reading `ref.current` only on mount
  // would leave the new element without listeners.
  const enabled = options.enabled;
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (enabled === false) return;
    // Hint the browser to allow vertical pan but not horizontal — lets us
    // call preventDefault() only after we lock to horizontal.
    const prevTouchAction = element.style.touchAction;
    element.style.touchAction = 'pan-y';
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
      // Called when a gesture that was already driving the drawer is
      // aborted (multi-touch, cancel). Snap back to where it started so
      // the drawer doesn't get stranded mid-way.
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

    const onTouchStart = (event: TouchEvent) => {
      const opts = optionsRef.current;
      if (opts.enabled === false) {
        // If we were mid-drag, snap back.
        if (isDragging && side) abortDraggingWithSnap();
        else reset();
        return;
      }
      if (event.touches.length !== 1) {
        if (isDragging && side) abortDraggingWithSnap();
        else reset();
        return;
      }
      const touch = event.touches[0];
      const rect = element.getBoundingClientRect();
      const width = element.clientWidth;
      const leftOpen = !!opts.leftOpen;
      const rightOpen = !!opts.rightOpen;

      // If a drawer is open, that drawer's close gesture takes priority and
      // may start anywhere. Both should never be open simultaneously, but if
      // they are, pick the one whose edge was touched, otherwise left.
      if (leftOpen || rightOpen) {
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
            // Default to left when ambiguous; the other drawer covers the
            // opposite edge, so a central touch is more likely a close.
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
        if (isSwipeExcludedTarget(event.target, element)) {
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
        abortDraggingWithSnap();
        return;
      }
      const touch = event.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;

      if (!hasDecided) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        // Vertical scroll dominates — abort the drawer gesture and let the
        // page handle it.
        if (Math.abs(dy) > Math.abs(dx) * MAX_OFF_AXIS_RATIO) {
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
        // Direction must match the side and open state.
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

      // Lock horizontal scrolling while the drawer follows the finger.
      if (event.cancelable) event.preventDefault();

      const opts = optionsRef.current;
      let progress = 0;
      if (side === 'left') {
        if (!isOpenAtStart) {
          progress = Math.min(1, Math.max(0, dx / widthAtStart));
        } else {
          progress = Math.min(1, Math.max(0, 1 + dx / widthAtStart));
        }
        invoke(opts.onLeftProgress, progress);
      } else {
        if (!isOpenAtStart) {
          progress = Math.min(1, Math.max(0, -dx / widthAtStart));
        } else {
          progress = Math.min(1, Math.max(0, 1 - dx / widthAtStart));
        }
        invoke(opts.onRightProgress, progress);
      }
    };

    const finish = (endX: number, endY: number) => {
      if (!tracking) {
        reset();
        return;
      }
      const dx = endX - startX;
      const dy = endY - startY;
      if (!side && !isOpenAtStart && Math.abs(dx) >= MIN_DISTANCE
        && Math.abs(dy) <= Math.abs(dx) * MAX_OFF_AXIS_RATIO) {
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
      const velocity = dx / dt; // px/ms
      const opts = optionsRef.current;

      // If we never entered the dragging state, fall back to the original
      // distance-based commit for quick flings that somehow skipped touchmove.
      if (!isDragging) {
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        if (absDx >= MIN_DISTANCE && absDy <= absDx * MAX_OFF_AXIS_RATIO) {
          if (side === 'left' && !isOpenAtStart && dx > 0) {
            invoke(opts.onLeftProgress, 1);
            invoke(opts.onLeftOpen);
          } else if (side === 'right' && !isOpenAtStart && dx < 0) {
            invoke(opts.onRightProgress, 1);
            invoke(opts.onRightOpen);
          } else {
            // Wrong direction — snap back.
            invoke(
              side === 'left' ? opts.onLeftProgress : opts.onRightProgress,
              isOpenAtStart ? 1 : 0,
            );
          }
        } else {
          // Not enough movement — snap back.
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

      // Interactive settle: velocity can override progress.
      let progress = 0;
      if (side === 'left') {
        if (!isOpenAtStart) progress = Math.min(1, Math.max(0, dx / widthAtStart));
        else progress = Math.min(1, Math.max(0, 1 + dx / widthAtStart));
      } else {
        if (!isOpenAtStart) progress = Math.min(1, Math.max(0, -dx / widthAtStart));
        else progress = Math.min(1, Math.max(0, 1 - dx / widthAtStart));
      }

      let shouldOpen: boolean;
      if (side === 'left') {
        if (!isOpenAtStart) {
          if (velocity > VELOCITY_THRESHOLD) shouldOpen = true;
          else if (velocity < -VELOCITY_THRESHOLD) shouldOpen = false;
          else shouldOpen = progress > SETTLE_PROGRESS;
        } else {
          if (velocity < -VELOCITY_THRESHOLD) shouldOpen = false;
          else if (velocity > VELOCITY_THRESHOLD) shouldOpen = true;
          else shouldOpen = progress > SETTLE_PROGRESS;
        }
      } else {
        if (!isOpenAtStart) {
          if (velocity < -VELOCITY_THRESHOLD) shouldOpen = true;
          else if (velocity > VELOCITY_THRESHOLD) shouldOpen = false;
          else shouldOpen = progress > SETTLE_PROGRESS;
        } else {
          if (velocity > VELOCITY_THRESHOLD) shouldOpen = false;
          else if (velocity < -VELOCITY_THRESHOLD) shouldOpen = true;
          else shouldOpen = progress > SETTLE_PROGRESS;
        }
      }

      const finishedSide = side;
      // Don't snap progress here — leave the drawer at the finger's last
      // position (transition: none) and let the caller's settle animation
      // spring/transition it to the final state. Snapping with `none`
      // would make it jump instead of animating.
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
        && Math.abs(dy) <= Math.abs(dx) * MAX_OFF_AXIS_RATIO)) && event.cancelable) {
        event.preventDefault();
      }
      finish(touch.clientX, touch.clientY);
    };

    const onTouchCancel = () => {
      // Snap back to where we started.
      const opts = optionsRef.current;
      if (side) {
        invoke(
          side === 'left' ? opts.onLeftProgress : opts.onRightProgress,
          isOpenAtStart ? 1 : 0,
        );
        const finishedSide = side;
        reset();
        invoke(opts.onDragEnd, finishedSide);
      } else {
        reset();
      }
    };

    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: false });
    element.addEventListener('touchend', onTouchEnd, { passive: false });
    element.addEventListener('touchcancel', onTouchCancel, { passive: true });
    return () => {
      element.style.touchAction = prevTouchAction;
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [ref, enabled]);
};
