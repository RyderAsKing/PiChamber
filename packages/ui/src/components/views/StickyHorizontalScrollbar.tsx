import React from 'react';

import { createStickyScrollbarController } from './pierreScrollSync';

export interface StickyHorizontalScrollbarProps {
  /** Ancestor containing the `diffs-container` host(s). */
  hostRef: React.RefObject<HTMLElement | null>;
  /** False in wrap mode (`overflow: wrap` / `data-overflow="wrap"`): no proxy. */
  enabled: boolean;
}

/**
 * Thin proxy horizontal scrollbar pinned to the bottom of the visible
 * vertical pane. Renders `position: sticky; bottom: 0` in-flow directly
 * after the diff content, so it sticks to the pane bottom while its file's
 * diff is on screen and scrolls away with the file otherwise.
 *
 * Requirements on the surrounding DOM: every ancestor between this bar and
 * the outer vertical scroller must NOT create a scroll container, or sticky
 * resolves against that ancestor instead of the pane. In practice that
 * means `overflow: visible` (default) or `overflow: clip` — never `auto`,
 * `scroll`, `hidden`, or `overlay` — on the inline diff wrapper, the file
 * entry body, and any image-viewer wrappers in between. Where the proxy
 * cannot pin (e.g. review surfaces with clipping wrappers it does not own),
 * it degrades to a plain scrollbar at the bottom of the file diff: still
 * synced, no worse than the native bar it replaces.
 */
export const StickyHorizontalScrollbar: React.FC<StickyHorizontalScrollbarProps> = ({
  hostRef,
  enabled,
}) => {
  const proxyRef = React.useRef<HTMLDivElement | null>(null);
  const spacerRef = React.useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    if (!enabled) {
      setVisible(false);
      return;
    }
    const proxy = proxyRef.current;
    const spacer = spacerRef.current;
    if (!proxy || !spacer) return;
    const controller = createStickyScrollbarController({
      proxy,
      spacer,
      getHost: () => hostRef.current,
      onVisibilityChange: setVisible,
    });
    return () => controller.dispose();
  }, [enabled, hostRef]);

  if (!enabled) return null;

  return (
    <div
      ref={proxyRef}
      tabIndex={0}
      aria-label="Scroll code horizontally"
      className="sticky bottom-0 z-10 overflow-x-auto overflow-y-hidden bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
      style={{ display: visible ? undefined : 'none' }}
    >
      <div ref={spacerRef} aria-hidden="true" style={{ width: 0, height: 1 }} />
    </div>
  );
};
