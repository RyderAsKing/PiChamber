import { streamPerfCount } from '@/stores/utils/streamDebug';

// Shared row geometry: the gutter edge matches the zone-header band padding
// (px-1.5 = 6px), the marker slot is icon-wide (14px) with a 6px gap, so row
// text starts exactly where the zone-header label starts. Nested children
// shift by one gutter step per depth level.
export const ROW_GUTTER_LEFT_PX = 6;
export const ROW_DEPTH_STEP_PX = 14;
export const ROW_TEXT_LEFT_PX = ROW_GUTTER_LEFT_PX + 14 + 6;

const cancelScrollAnchorByContainer = new WeakMap<HTMLElement, () => void>();

export const holdSessionRowPosition = (target: HTMLElement): void => {
  if (typeof window === 'undefined') return;
  const row = target.closest<HTMLElement>('[data-session-row]');
  const container = row?.closest<HTMLElement>('.overlay-scrollbar-container');
  if (!row || !container) return;

  cancelScrollAnchorByContainer.get(container)?.();

  const initialTop = row.getBoundingClientRect().top;
  let remainingFrames = 3;
  let cancelled = false;
  let frameId: number | null = null;
  const cancel = () => {
    cancelled = true;
    if (frameId !== null) window.cancelAnimationFrame(frameId);
    frameId = null;
    cancelScrollAnchorByContainer.delete(container);
    container.removeEventListener('wheel', cancel);
    container.removeEventListener('touchstart', cancel);
  };
  const restore = () => {
    if (cancelled || !row.isConnected || !container.isConnected) {
      cancel();
      return;
    }
    const delta = row.getBoundingClientRect().top - initialTop;
    if (Math.abs(delta) > 0.5) {
      container.scrollTop += delta;
      streamPerfCount('ui.sidebar.selection_scroll_anchor_adjustment');
    }
    remainingFrames -= 1;
    if (remainingFrames <= 0) {
      cancel();
      return;
    }
    frameId = window.requestAnimationFrame(restore);
  };

  container.addEventListener('wheel', cancel, { passive: true });
  container.addEventListener('touchstart', cancel, { passive: true });
  cancelScrollAnchorByContainer.set(container, cancel);
  frameId = window.requestAnimationFrame(restore);
};
