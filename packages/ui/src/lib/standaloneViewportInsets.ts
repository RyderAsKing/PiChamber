/**
 * iOS standalone (Home Screen) web apps can get a web view that starts under
 * the status bar but is shorter than the screen by exactly the top inset
 * (WebKit bugs 301108 / 313800; iPhone 16 Pro: screen 874, innerHeight 812,
 * top inset 62). iOS draws the missing height as a strip below the page that
 * the DOM cannot draw into. WebKit still reports env(safe-area-inset-bottom)
 * as 34px, so padding for the home indicator would stack on top of the strip.
 *
 * mobile.css grows <html> by the top inset, which is what restores the full
 * viewport: iOS keeps the short viewport only while the page is no taller
 * than it. This module is the fallback when iOS keeps it anyway. It publishes
 * the measured strip as --oc-viewport-bottom-strip on <html>; mobile.css then
 * shrinks <body> to the visible area and subtracts the strip from the bottom
 * safe-area token. Once iOS restores the full viewport, the next resize
 * measures no strip and removes the property.
 */

const VIEWPORT_BOTTOM_STRIP_PROPERTY = '--oc-viewport-bottom-strip';

export type StandaloneViewportSample = {
  innerWidth: number;
  innerHeight: number;
  screenWidth: number;
  screenHeight: number;
  safeAreaTop: number;
};

/**
 * Returns the strip height in CSS px, 0 when there is none, or null when the
 * sample is inconclusive (for example a keyboard-shrunk viewport) and the
 * previous value should be kept.
 */
export function resolveViewportBottomStrip(sample: StandaloneViewportSample): number | null {
  const { innerWidth, innerHeight, screenWidth, screenHeight, safeAreaTop } = sample;
  if (![innerWidth, innerHeight, screenWidth, screenHeight, safeAreaTop].every(Number.isFinite)) return null;
  if (innerWidth <= 0 || innerHeight <= 0 || screenWidth <= 0 || screenHeight <= 0) return null;

  // No top inset: the web view is not under the status bar, so any missing
  // height is not a strip below the page.
  if (safeAreaTop <= 0) return 0;

  // iOS keeps screen.width/height in portrait order; match the orientation.
  const portrait = innerHeight >= innerWidth;
  const longSide = Math.max(screenWidth, screenHeight);
  const shortSide = Math.min(screenWidth, screenHeight);
  const orientedWidth = portrait ? shortSide : longSide;
  const orientedHeight = portrait ? longSide : shortSide;

  // Split view / windowed apps are not full-screen; insets mean something else.
  if (Math.abs(innerWidth - orientedWidth) > 1) return 0;

  const missing = orientedHeight - innerHeight;
  if (missing <= 1) return 0;
  // The WebKit defect removes exactly the top inset. Anything else (keyboard,
  // transient resize) is not this geometry.
  if (Math.abs(missing - safeAreaTop) <= 1) return Math.round(missing);
  return null;
}

const readSafeAreaTop = (): number => {
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top,0px)';
  document.body.appendChild(probe);
  try {
    return Number.parseFloat(window.getComputedStyle(probe).paddingTop) || 0;
  } finally {
    probe.remove();
  }
};

const isIosStandaloneWebApp = (): boolean => {
  if (document.documentElement.classList.contains('oc-capacitor-app')) return false;
  if (!window.CSS?.supports?.('-webkit-touch-callout', 'none')) return false;
  const standaloneNavigator = navigator as Navigator & { standalone?: boolean };
  return standaloneNavigator.standalone === true
    || window.matchMedia?.('(display-mode: standalone)')?.matches === true;
};

/** Hosted iOS Home Screen web apps only; a no-op everywhere else. */
export function installStandaloneViewportInsets(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  if (!isIosStandaloneWebApp()) return () => {};

  const root = document.documentElement;
  const update = () => {
    if (!document.body) return;
    const strip = resolveViewportBottomStrip({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      safeAreaTop: readSafeAreaTop(),
    });
    if (strip === null) return;
    if (strip > 0) root.style.setProperty(VIEWPORT_BOTTOM_STRIP_PROPERTY, `${strip}px`);
    else root.style.removeProperty(VIEWPORT_BOTTOM_STRIP_PROPERTY);
  };

  update();
  if (!document.body) document.addEventListener('DOMContentLoaded', update, { once: true });
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  window.addEventListener('pageshow', update);
  window.visualViewport?.addEventListener('resize', update);
  return () => {
    document.removeEventListener('DOMContentLoaded', update);
    window.removeEventListener('resize', update);
    window.removeEventListener('orientationchange', update);
    window.removeEventListener('pageshow', update);
    window.visualViewport?.removeEventListener('resize', update);
    root.style.removeProperty(VIEWPORT_BOTTOM_STRIP_PROPERTY);
  };
}
