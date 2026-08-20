import React from 'react';

export const MOBILE_DRAWER_DURATION_MS = 320;
export const MOBILE_DRAWER_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

const DRAG_THRESHOLD = 6;
const VELOCITY_THRESHOLD = 0.18;
const MAX_OFF_AXIS = 1.2;
const SETTLE_PROGRESS = 0.38;
const MIN_DISTANCE = 48;

type DrawerSide = 'left' | 'right';

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

const isClosingDirection = (side: DrawerSide, dx: number): boolean => (
  side === 'left' ? dx < 0 : dx > 0
);

const getProgress = (side: DrawerSide, dx: number, width: number): number => (
  Math.min(1, Math.max(0, side === 'left' ? 1 + dx / width : 1 - dx / width))
);

const getTransform = (side: DrawerSide, progress: number): string => {
  if (progress >= 0.999) return 'none';
  return side === 'left'
    ? `translateX(${(progress - 1) * 100}%)`
    : `translateX(${(1 - progress) * 100}%)`;
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

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
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
        tracking = false;
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
      const progress = getProgress(side, dx, width);
      drawer.style.transform = getTransform(side, progress);
      scrim.style.opacity = String(progress);
    };

    const settle = (endX: number, endY: number, cancelled: boolean) => {
      if (!tracking) return;
      const dx = endX - startX;
      const dy = endY - startY;
      const dt = Math.max(1, Date.now() - startTime);
      const velocity = dx / dt;
      const progress = getProgress(side, dx, width);
      let shouldClose = false;
      if (!cancelled && isDragging) {
        const closingFling = side === 'left'
          ? velocity < -VELOCITY_THRESHOLD
          : velocity > VELOCITY_THRESHOLD;
        const openingFling = side === 'left'
          ? velocity > VELOCITY_THRESHOLD
          : velocity < -VELOCITY_THRESHOLD;
        shouldClose = closingFling || (!openingFling && progress < SETTLE_PROGRESS);
      } else if (!cancelled) {
        shouldClose = Math.abs(dx) >= MIN_DISTANCE
          && Math.abs(dy) <= Math.abs(dx) * MAX_OFF_AXIS
          && isClosingDirection(side, dx);
      }

      const durationStyle = durationMs ? `transform ${durationMs}ms ${MOBILE_DRAWER_EASING}` : 'none';
      const scrimDurationStyle = durationMs ? `opacity ${durationMs}ms ${MOBILE_DRAWER_EASING}` : 'none';
      drawer.style.transition = durationStyle;
      scrim.style.transition = scrimDurationStyle;
      drawer.style.transform = shouldClose ? closeTransform : 'none';
      scrim.style.opacity = shouldClose ? '0' : '1';
      if (shouldClose) onClose();

      tracking = false;
      isDragging = false;
      hasDecided = false;
    };

    const onTouchEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (!touch) {
        tracking = false;
        return;
      }
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      const isHorizontalClose = Math.abs(dx) >= MIN_DISTANCE
        && Math.abs(dy) <= Math.abs(dx) * MAX_OFF_AXIS
        && isClosingDirection(side, dx);
      if (tracking && (isDragging || isHorizontalClose) && event.cancelable) {
        event.preventDefault();
      }
      settle(touch.clientX, touch.clientY, false);
    };

    const onTouchCancel = () => settle(startX, startY, true);

    drawer.addEventListener('touchstart', onTouchStart, { passive: true });
    drawer.addEventListener('touchmove', onTouchMove, { passive: false });
    drawer.addEventListener('touchend', onTouchEnd, { passive: false });
    drawer.addEventListener('touchcancel', onTouchCancel, { passive: true });
    return () => {
      drawer.removeEventListener('touchstart', onTouchStart);
      drawer.removeEventListener('touchmove', onTouchMove);
      drawer.removeEventListener('touchend', onTouchEnd);
      drawer.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [drawerRef, enabled, onClose, open, prefersReducedMotion, scrimRef, side, widthRatio]);
};
