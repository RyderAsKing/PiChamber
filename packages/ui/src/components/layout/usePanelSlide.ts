import React from 'react';

const PANEL_SLIDE_MS = 200;
const PANEL_SLIDE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** Slide a side panel's content with a compositor-only transform. Layout width
 * changes once at the visibility edge instead of forcing layout on every frame. */
export const usePanelSlide = (isOpen: boolean) => {
  const prefersReducedMotion = React.useMemo(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);
  const [slidIn, setSlidIn] = React.useState(isOpen);
  const [layoutVisible, setLayoutVisible] = React.useState(isOpen);

  React.useLayoutEffect(() => {
    if (prefersReducedMotion) {
      setLayoutVisible(isOpen);
      setSlidIn(isOpen);
      return;
    }
    if (isOpen) {
      setLayoutVisible(true);
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
    const closeTimer = window.setTimeout(() => setLayoutVisible(false), PANEL_SLIDE_MS);
    return () => window.clearTimeout(closeTimer);
  }, [isOpen, prefersReducedMotion]);

  return {
    slidIn,
    layoutVisible,
    prefersReducedMotion,
    transition: prefersReducedMotion
      ? 'none'
      : `transform ${PANEL_SLIDE_MS}ms ${PANEL_SLIDE_EASING}`,
  };
};
