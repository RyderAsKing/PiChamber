import React from 'react';

const PANEL_SLIDE_MS = 200;
const PANEL_SLIDE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** Slide a side panel’s content with transform. Layout width follows `isOpen`
 * in the same frame (and the same 200ms easing) as the header title spacers. */
export const usePanelSlide = (isOpen: boolean) => {
  const prefersReducedMotion = React.useMemo(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);
  const [slidIn, setSlidIn] = React.useState(isOpen);

  React.useLayoutEffect(() => {
    if (prefersReducedMotion) {
      setSlidIn(isOpen);
      return;
    }
    if (isOpen) {
      setSlidIn(false);
      let innerFrame = 0;
      const outerFrame = window.requestAnimationFrame(() => {
        innerFrame = window.requestAnimationFrame(() => setSlidIn(true));
      });
      return () => {
        window.cancelAnimationFrame(outerFrame);
        window.cancelAnimationFrame(innerFrame);
      };
    }
    setSlidIn(false);
    return undefined;
  }, [isOpen, prefersReducedMotion]);

  return {
    slidIn,
    prefersReducedMotion,
    transition: prefersReducedMotion
      ? 'none'
      : `transform ${PANEL_SLIDE_MS}ms ${PANEL_SLIDE_EASING}, width ${PANEL_SLIDE_MS}ms ${PANEL_SLIDE_EASING}, min-width ${PANEL_SLIDE_MS}ms ${PANEL_SLIDE_EASING}, max-width ${PANEL_SLIDE_MS}ms ${PANEL_SLIDE_EASING}`,
  };
};
