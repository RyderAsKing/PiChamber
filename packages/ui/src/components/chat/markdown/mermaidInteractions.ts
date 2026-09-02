import React from 'react';
import type { Theme } from '@/types/theme';
import type { ToolPopupContent } from '../message/types';
import type { MermaidControlOptions, MermaidRender } from './decorate';
import { MERMAID_BLOCK_SELECTOR } from './mermaidViewer';

export const DEFAULT_MERMAID_CONTROLS: MermaidControlOptions = {
  download: true,
  copy: true,
  showPanZoomControls: true,
};
export const DEFAULT_MERMAID_FULLSCREEN_ENABLED = true;

export const useMermaidInlineInteractions = ({
  containerRef,
  onShowPopup,
  enableFullscreen,
  enablePanZoom,
  allowMermaidWheelEvents,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onShowPopup?: (content: ToolPopupContent) => void;
  enableFullscreen?: boolean;
  enablePanZoom?: boolean;
  allowMermaidWheelEvents?: boolean;
}) => {
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const handleMermaidClick = (event: MouseEvent) => {
      if (!enableFullscreen || !onShowPopup) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      if (target.closest('button, a, [role="button"]')) {
        return;
      }

      const block = target.closest(MERMAID_BLOCK_SELECTOR);
      if (!block) {
        return;
      }

      if (
        block instanceof HTMLElement &&
        block.hasAttribute('data-mermaid-suppress-click')
      ) {
        block.removeAttribute('data-mermaid-suppress-click');
        return;
      }

      const renderedBlocks = Array.from(
        container.querySelectorAll<HTMLElement>(MERMAID_BLOCK_SELECTOR)
      );
      const blockIndex = renderedBlocks.indexOf(block as HTMLElement);
      if (blockIndex < 0) {
        return;
      }

      const source =
        block instanceof HTMLElement ? block.getAttribute('data-md-source') : null;
      if (!source || source.trim().length === 0) {
        return;
      }

      const filename = `Diagram ${blockIndex + 1}`;
      onShowPopup({
        open: true,
        title: filename,
        content: '',
        metadata: {
          tool: 'mermaid-preview',
          filename,
        },
        mermaid: {
          url: `data:text/plain;charset=utf-8,${encodeURIComponent(source)}`,
          source,
          filename,
        },
      });
    };

    const handleInlineWheel = (event: WheelEvent) => {
      if (
        allowMermaidWheelEvents ||
        ((event.ctrlKey || event.metaKey) && enablePanZoom)
      ) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const block = target.closest(MERMAID_BLOCK_SELECTOR);
      if (!block) {
        return;
      }

      // Keep regular page scroll while preventing Streamdown inline wheel-zoom handlers.
      event.stopPropagation();
    };

    container.addEventListener('click', handleMermaidClick);
    container.addEventListener('wheel', handleInlineWheel, {
      capture: true,
      passive: true,
    });

    return () => {
      container.removeEventListener('click', handleMermaidClick);
      container.removeEventListener('wheel', handleInlineWheel, true);
    };
  }, [
    allowMermaidWheelEvents,
    containerRef,
    enableFullscreen,
    enablePanZoom,
    onShowPopup,
  ]);
};

// Mermaid layout is expensive; `decorate` would otherwise re-render every
// diagram on every streaming morph. Memoize by theme+mode+source so a
// stable diagram is laid out once and served from cache thereafter.
export const MERMAID_RENDER_CACHE = new Map<string, MermaidRender>();
export const MERMAID_RENDER_CACHE_MAX = 100;

export const cachedMermaidRender = (
  key: string,
  compute: () => MermaidRender
): MermaidRender => {
  const existing = MERMAID_RENDER_CACHE.get(key);
  if (existing) {
    MERMAID_RENDER_CACHE.delete(key);
    MERMAID_RENDER_CACHE.set(key, existing);
    return existing;
  }
  const value = compute();
  MERMAID_RENDER_CACHE.set(key, value);
  if (MERMAID_RENDER_CACHE.size > MERMAID_RENDER_CACHE_MAX) {
    const oldest = MERMAID_RENDER_CACHE.keys().next().value;
    if (oldest) MERMAID_RENDER_CACHE.delete(oldest);
  }
  return value;
};

export const mermaidColorsFromTheme = (theme: Theme) => ({
  bg: theme.colors.surface.elevated,
  fg: theme.colors.surface.foreground,
  line: theme.colors.interactive.border,
  accent: theme.colors.primary.base,
  muted: theme.colors.surface.mutedForeground,
  surface: theme.colors.surface.muted,
  border: theme.colors.interactive.border,
  transparent: true,
  font: 'system-ui, sans-serif',
});
