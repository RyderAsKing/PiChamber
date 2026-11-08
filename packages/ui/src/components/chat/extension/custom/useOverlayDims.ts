import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { isShownOverlay } from './overlayStacks';

/**
 * A capturing custom() overlay is dimming this session's pane. The chat
 * layout then drops the composer's own stacking order, so a dialog in the
 * extension prompt dock (z-40) can sit above the overlay layer (z-30): the
 * overlay's own code can be waiting on that dialog.
 */
export const useExtensionOverlayDims = (sessionId: string | null | undefined): boolean => usePiSessionSnapshot(
  (state) => {
    const surfaces = sessionId ? state.reducer.bySession.get(sessionId)?.extensionSurfaces : undefined;
    if (!surfaces) return false;
    for (const surface of surfaces.values()) {
      if (surface.capturing && isShownOverlay(surface)) return true;
    }
    return false;
  },
  Object.is,
  sessionId ? `session:${sessionId}` : '*',
  sessionId ?? '',
);
