type LayoutRect = { top: number; right: number; bottom: number; left: number; width: number; height: number };

const rounded = (value: number): number => Math.round(value * 100) / 100;

const readRect = (element: Element | null): LayoutRect | null => {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    top: rounded(rect.top), right: rounded(rect.right), bottom: rounded(rect.bottom),
    left: rounded(rect.left), width: rounded(rect.width), height: rounded(rect.height),
  };
};

const pixels = (value: string): number | null => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? rounded(parsed) : null;
};

/** Geometry only. Capture on user request, never from the HUD frame loop. */
export function captureViewportLayout() {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !document.body) return null;

  const root = document.documentElement;
  const composer = document.querySelector('.oc-mobile-composer');
  const shell = document.querySelector('.oc-mobile-app-shell');
  const card = composer?.querySelector('[data-composer-card]') ?? null;
  const footer = composer?.querySelector('[data-chat-input-footer]') ?? null;
  const composerStyle = composer ? window.getComputedStyle(composer) : null;
  const shellRect = readRect(shell);
  const composerRect = readRect(composer);
  const cardRect = readRect(card);
  const visual = window.visualViewport;
  const bottomOverlay = window.getComputedStyle(document.body, '::after');

  // Resolve env() and viewport units through real computed CSS. The fixed,
  // invisible probe does not participate in layout and is always removed.
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;contain:strict;box-sizing:content-box;width:0;height:0;width:100dvh;height:100lvh;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)';
  document.body.appendChild(probe);
  let resolved;
  try {
    const style = window.getComputedStyle(probe);
    resolved = {
      safeTop: pixels(style.paddingTop),
      safeBottom: pixels(style.paddingBottom),
      dynamicHeight: window.CSS.supports('height', '100dvh') ? pixels(style.width) : null,
      largeHeight: window.CSS.supports('height', '100lvh') ? pixels(style.height) : null,
    };
  } finally {
    probe.remove();
  }

  return {
    capturedAt: Date.now(),
    devicePixelRatio: window.devicePixelRatio,
    screen: { width: window.screen.width, height: window.screen.height, availableHeight: window.screen.availHeight },
    window: { width: window.innerWidth, height: window.innerHeight, scrollY: rounded(window.scrollY) },
    client: { width: root.clientWidth, height: root.clientHeight },
    visual: visual ? {
      width: rounded(visual.width), height: rounded(visual.height),
      offsetTop: rounded(visual.offsetTop), offsetLeft: rounded(visual.offsetLeft), scale: rounded(visual.scale),
    } : null,
    css: { ...resolved, viewportBottomStrip: pixels(window.getComputedStyle(root).getPropertyValue('--oc-viewport-bottom-strip')) },
    flags: {
      standalone: window.matchMedia('(display-mode: standalone)').matches,
      capacitor: root.classList.contains('oc-capacitor-app'),
      browserKeyboardOpen: root.classList.contains('oc-browser-keyboard-open'),
      browserFullscreen: root.classList.contains('oc-browser-kb-fullscreen'),
    },
    root: readRect(root),
    body: readRect(document.body),
    appRoot: readRect(document.getElementById('root')),
    shell: shellRect,
    composer: composerRect,
    card: cardRect,
    footer: readRect(footer),
    composerStyle: composerStyle ? {
      paddingTop: pixels(composerStyle.paddingTop), paddingBottom: pixels(composerStyle.paddingBottom),
      marginBottom: pixels(composerStyle.marginBottom), position: composerStyle.position,
    } : null,
    bottomOverlay: {
      present: bottomOverlay.content !== 'none' && bottomOverlay.content !== 'normal',
      height: pixels(bottomOverlay.height), bottom: pixels(bottomOverlay.bottom),
      position: bottomOverlay.position, zIndex: pixels(bottomOverlay.zIndex),
    },
    gaps: {
      // These are DOM-coordinate differences, not estimates of OS-owned space.
      cardToShellBottom: cardRect && shellRect ? rounded(shellRect.bottom - cardRect.bottom) : null,
      shellToClientBottom: shellRect ? rounded(root.clientHeight - shellRect.bottom) : null,
      composerToVisualBottom: composerRect && visual
        ? rounded(visual.offsetTop + visual.height - composerRect.bottom) : null,
    },
  };
}

export type ViewportLayoutSnapshot = NonNullable<ReturnType<typeof captureViewportLayout>>;
