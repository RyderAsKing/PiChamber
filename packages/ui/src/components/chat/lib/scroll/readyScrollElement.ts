/**
 * True when a forwarded chat scroller can drive TanStack Virtual.
 *
 * `getScrollElement()` may return a node before layout has given it a
 * non-zero rectangle. Enabling the virtualizer against that 0×0 rect
 * produces an empty `getVirtualItems()` range while the estimated spacer
 * still occupies the history height, so older turns vanish and only the
 * non-virtualized live tail remains visible.
 */
export const isMeasurableScrollElement = (
  element: HTMLElement | null | undefined,
): element is HTMLElement => Boolean(element && element.clientHeight > 0);
