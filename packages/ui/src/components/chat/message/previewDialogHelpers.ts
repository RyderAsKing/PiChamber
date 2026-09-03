import React from 'react';
import { MermaidLoadFailure } from './toolOutputDialogMermaid';

export const PREVIEW_ANIMATION_MS = 150;
export const MERMAID_DIALOG_HEADER_HEIGHT = 40;
export const MERMAID_ASPECT_RETRY_DELAY_MS = 120;
export const MERMAID_ASPECT_MAX_RETRIES = 3;
export const MERMAID_CONTROLS = {
  download: false,
  copy: false,
  showPanZoomControls: true,
};

export const mermaidLoadFailure = (message: string): MermaidLoadFailure =>
  new MermaidLoadFailure(message);

export type ViewportSize = { width: number; height: number };

export const getWindowViewport = (): ViewportSize => ({
  width: typeof window !== 'undefined' ? window.innerWidth : 0,
  height: typeof window !== 'undefined' ? window.innerHeight : 0,
});

export const PREVIEW_VIEWPORT_LIMITS = {
  mobile: { widthRatio: 0.94, heightRatio: 0.86, padding: 10 },
  desktop: { widthRatio: 0.8, heightRatio: 0.8, padding: 16 },
} as const;

export const getPreviewViewportBounds = (
  viewport: { width: number; height: number },
  isMobile: boolean,
) => {
  const limits = isMobile ? PREVIEW_VIEWPORT_LIMITS.mobile : PREVIEW_VIEWPORT_LIMITS.desktop;
  const paddedWidth = Math.max(160, viewport.width - limits.padding * 2);
  const paddedHeight = Math.max(160, viewport.height - limits.padding * 2);

  return {
    maxWidth: Math.max(160, Math.min(paddedWidth, viewport.width * limits.widthRatio)),
    maxHeight: Math.max(160, Math.min(paddedHeight, viewport.height * limits.heightRatio)),
  };
};

export const getSvgAspectRatio = (svg: SVGElement): number | null => {
  try {
    const groups = Array.from(svg.querySelectorAll('g'));
    let bestArea = 0;
    let bestRatio: number | null = null;

    for (const group of groups) {
      if (!(group instanceof SVGGraphicsElement)) {
        continue;
      }
      const box = group.getBBox();
      if (!(box.width > 0 && box.height > 0)) {
        continue;
      }
      const area = box.width * box.height;
      if (area > bestArea) {
        bestArea = area;
        bestRatio = box.width / box.height;
      }
    }

    if (bestRatio && Number.isFinite(bestRatio) && bestRatio > 0) {
      return bestRatio;
    }
  } catch {
    // Ignore getBBox failures and fall back to SVG attrs/viewBox.
  }

  const viewBox = svg.getAttribute('viewBox');
  if (viewBox) {
    const parts = viewBox.trim().split(/\s+/).map(Number);
    if (parts.length === 4) {
      const width = parts[2];
      const height = parts[3];
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        return width / height;
      }
    }
  }

  const attrWidth = Number(svg.getAttribute('width'));
  const attrHeight = Number(svg.getAttribute('height'));
  if (
    Number.isFinite(attrWidth) &&
    Number.isFinite(attrHeight) &&
    attrWidth > 0 &&
    attrHeight > 0
  ) {
    return attrWidth / attrHeight;
  }

  const rect = svg.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    return rect.width / rect.height;
  }

  return null;
};

export const usePreviewOverlayState = (open: boolean) => {
  const [isRendered, setIsRendered] = React.useState(open);
  const [isVisible, setIsVisible] = React.useState(open);
  const [isTransitioning, setIsTransitioning] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setIsRendered(true);
      setIsTransitioning(true);
      if (typeof window === 'undefined') {
        setIsVisible(true);
        return;
      }

      const raf = window.requestAnimationFrame(() => {
        setIsVisible(true);
      });

      const doneId = window.setTimeout(() => {
        setIsTransitioning(false);
      }, PREVIEW_ANIMATION_MS);

      return () => {
        window.cancelAnimationFrame(raf);
        window.clearTimeout(doneId);
      };
    }

    setIsVisible(false);
    setIsTransitioning(true);
    if (typeof window === 'undefined') {
      setIsRendered(false);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setIsRendered(false);
      setIsTransitioning(false);
    }, PREVIEW_ANIMATION_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [open]);

  return { isRendered, isVisible, isTransitioning };
};

export const usePreviewViewport = (open: boolean) => {
  const [viewport, setViewport] = React.useState<ViewportSize>(getWindowViewport);

  React.useEffect(() => {
    if (!open || typeof window === 'undefined') {
      return;
    }

    const onResize = () => {
      setViewport(getWindowViewport());
    };

    onResize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  return viewport;
};
