/**
 * Shared gesture math for drawer and edge swipes.
 * Extracted so behavioral tests can run without a browser and both hooks share one truth.
 */

export type DrawerSide = 'left' | 'right';

export const DRAG_THRESHOLD = 6;
export const VELOCITY_THRESHOLD = 0.18;
export const MAX_OFF_AXIS = 1.2;
export const SETTLE_PROGRESS = 0.38;
export const MIN_DISTANCE = 48;

export const isClosingDirection = (side: DrawerSide, dx: number): boolean =>
  side === 'left' ? dx < 0 : dx > 0;

export const getDrawerProgress = (side: DrawerSide, dx: number, width: number): number =>
  Math.min(1, Math.max(0, side === 'left' ? 1 + dx / width : 1 - dx / width));

export const getDrawerTransform = (side: DrawerSide, progress: number): string => {
  if (progress >= 0.999) return 'none';
  return side === 'left'
    ? `translateX(${(progress - 1) * 100}%)`
    : `translateX(${(1 - progress) * 100}%)`;
};

export const getEdgeProgress = (
  side: 'left' | 'right',
  isOpenAtStart: boolean,
  dx: number,
  width: number,
): number => {
  if (side === 'left') {
    if (!isOpenAtStart) return Math.min(1, Math.max(0, dx / width));
    return Math.min(1, Math.max(0, 1 + dx / width));
  }
  if (!isOpenAtStart) return Math.min(1, Math.max(0, -dx / width));
  return Math.min(1, Math.max(0, 1 - dx / width));
};

export const shouldCloseFromDrawerGesture = (opts: {
  side: DrawerSide;
  dx: number;
  dy: number;
  dt: number;
  progress: number;
  isDragging: boolean;
  cancelled: boolean;
}): boolean => {
  const { side, dx, dy, dt, progress, isDragging, cancelled } = opts;
  if (cancelled) return false;
  const velocity = dx / Math.max(1, dt);
  if (isDragging) {
    const closingFling = side === 'left' ? velocity < -VELOCITY_THRESHOLD : velocity > VELOCITY_THRESHOLD;
    const openingFling = side === 'left' ? velocity > VELOCITY_THRESHOLD : velocity < -VELOCITY_THRESHOLD;
    return closingFling || (!openingFling && progress < SETTLE_PROGRESS);
  }
  return (
    Math.abs(dx) >= MIN_DISTANCE &&
    Math.abs(dy) <= Math.abs(dx) * MAX_OFF_AXIS &&
    isClosingDirection(side, dx)
  );
};

export const shouldSettleOpenForEdge = (opts: {
  side: 'left' | 'right';
  isOpenAtStart: boolean;
  dx: number;
  dt: number;
  progress: number;
}): boolean => {
  const { side, isOpenAtStart, dx, dt, progress } = opts;
  const velocity = dx / Math.max(1, dt);
  if (side === 'left') {
    if (!isOpenAtStart) {
      if (velocity > VELOCITY_THRESHOLD) return true;
      if (velocity < -VELOCITY_THRESHOLD) return false;
      return progress > SETTLE_PROGRESS;
    }
    if (velocity < -VELOCITY_THRESHOLD) return false;
    if (velocity > VELOCITY_THRESHOLD) return true;
    return progress > SETTLE_PROGRESS;
  }
  if (!isOpenAtStart) {
    if (velocity < -VELOCITY_THRESHOLD) return true;
    if (velocity > VELOCITY_THRESHOLD) return false;
    return progress > SETTLE_PROGRESS;
  }
  if (velocity > VELOCITY_THRESHOLD) return false;
  if (velocity < -VELOCITY_THRESHOLD) return true;
  return progress > SETTLE_PROGRESS;
};

const SWIPE_EXCLUDED_SELECTOR =
  'button, a, input, textarea, select, [contenteditable="true"], [data-no-drawer-swipe]';

/**
 * Shared exclusion predicate: buttons/inputs/editable + any horizontal scroll container.
 * Must be used for both closed AND open drawer cases.
 */
export const isSwipeExcludedTarget = (target: EventTarget | null, root: HTMLElement): boolean => {
  if (!(target instanceof Element)) return false;
  const interactive = (target as Element).closest(SWIPE_EXCLUDED_SELECTOR);
  if (interactive && root.contains(interactive)) return true;
  let node: Element | null = target as Element;
  while (node && node !== root) {
    if (node instanceof HTMLElement && node.scrollWidth > node.clientWidth) {
      const overflowX = getComputedStyle(node).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') return true;
    }
    node = node.parentElement;
  }
  return false;
};
