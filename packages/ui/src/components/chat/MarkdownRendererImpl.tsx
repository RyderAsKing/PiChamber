import React from 'react';
import morphdom from 'morphdom';
import { renderMermaidASCII, renderMermaidSVG } from 'beautiful-mermaid';
import type { Part } from '@/lib/chat/types';
import { cn } from '@/lib/utils';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { Theme } from '@/types/theme';
import type { ToolPopupContent } from './message/types';
import { FadeInOnReveal } from './message/FadeInOnReveal';
import { useUIStore } from '@/stores/useUIStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { renderMarkdownBlocks, renderMarkdownSync, type RenderedBlock } from './markdown/markdownCore';
import { isLiveMarkdownTailAppend, isPreformattedLiveMarkdown, streamParserFor } from './markdown/markdownStreamBlocks';
import { ensureMarkdownShikiTheme } from './markdown/markdownTheme';
import { getMarkdownSyntaxVars } from './markdown/markdownSyntaxVars';
import {
  attachMarkdownInteractions,
  applyMarkdownCodeBlockWrapState,
  decorateMarkdown,
  type DecorateContext,
  type DecorateLabels,
  type MermaidControlOptions,
  type MermaidRender,
} from './markdown/decorate';
import { createMermaidViewerRegistry, shouldRefreshMermaidViewers } from './markdown/mermaidViewer';
import { streamPerfCount, streamPerfObserve } from '@/stores/utils/streamDebug';
import {
  useExternalLinkInteractions,
  useFileReferenceInteractions,
} from './markdown/fileReferenceInteractions';
import {
  DEFAULT_MERMAID_CONTROLS,
  DEFAULT_MERMAID_FULLSCREEN_ENABLED,
  useMermaidInlineInteractions,
  cachedMermaidRender,
  mermaidColorsFromTheme,
} from './markdown/mermaidInteractions';

const useCurrentMermaidTheme = () => {
  const themeSystem = useOptionalThemeSystem();
  const fallbackLight = getDefaultTheme(false);
  const fallbackDark = getDefaultTheme(true);

  return themeSystem?.currentTheme
    ?? (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? fallbackDark
      : fallbackLight);
};

const stripLeadingFrontmatter = (markdown: string): string => {
  const frontmatterMatch = markdown.match(
    /^(?:\uFEFF)?(---|\+\+\+)[^\S\r\n]*\r?\n[\s\S]*?\r?\n\1[^\S\r\n]*(?:\r?\n|$)/,
  );

  if (!frontmatterMatch) {
    return markdown;
  }

  return markdown.slice(frontmatterMatch[0].length);
};

export type MarkdownVariant = 'assistant' | 'tool' | 'reasoning';

interface MarkdownRendererProps {
  content: string;
  part?: Part;
  messageId: string;
  isAnimated?: boolean;
  skipFadeIn?: boolean;
  className?: string;
  isStreaming?: boolean;
  disableStreamAnimation?: boolean;
  variant?: MarkdownVariant;
  onShowPopup?: (content: ToolPopupContent) => void;
  enableFileReferences?: boolean;
}


// ---------------------------------------------------------------------------
// Rendering core: marked -> math -> shiki -> sanitize -> decorate -> morphdom
// ---------------------------------------------------------------------------



const useDecorateContext = (
  currentTheme: Theme,
  deferCodeLineNumberSync: boolean,
  onPreviewLoopback?: (url: string) => void,
  mermaidControls: MermaidControlOptions = DEFAULT_MERMAID_CONTROLS,
): DecorateContext => {
  const labels: DecorateLabels = React.useMemo(() => ({
    copy: "Copy code",
    copied: "Copied",
    enableCodeWrap: "Enable line wrap",
    disableCodeWrap: "Disable line wrap",
    copyTable: "Copy table",
    downloadTable: "Download table",
    copyDiagram: "Copy source",
    downloadDiagram: "Download SVG",
    zoomInDiagram: "Zoom in",
    zoomOutDiagram: "Zoom out",
    resetDiagramView: "Reset view",
    previewLabel: "Preview",
    previewTitle: "Open preview pane",
  }), []);

  const codeBlockLineWrap = useUIStore((state) => state.codeBlockLineWrap);
  const setCodeBlockLineWrap = useUIStore((state) => state.setCodeBlockLineWrap);
  const toggleCodeBlockLineWrap = React.useCallback(() => {
    setCodeBlockLineWrap(!useUIStore.getState().codeBlockLineWrap);
  }, [setCodeBlockLineWrap]);

  return React.useMemo<DecorateContext>(() => {
    const colors = mermaidColorsFromTheme(currentTheme);
    const mode = useUIStore.getState().mermaidRenderingMode;
    const themeId = currentTheme.metadata?.id ?? 'theme';
    const renderMermaid = (source: string): MermaidRender =>
      cachedMermaidRender(`${themeId}:${mode}:${source}`, () => {
        try {
          if (mode === 'ascii') return { ascii: renderMermaidASCII(source) };
          return { svg: renderMermaidSVG(source, colors) };
        } catch {
          return {};
        }
      });
    return { labels, mermaidControls, codeBlockLineWrap, deferCodeLineNumberSync, onToggleCodeBlockLineWrap: toggleCodeBlockLineWrap, renderMermaid, onPreviewLoopback };
  }, [currentTheme, labels, mermaidControls, codeBlockLineWrap, deferCodeLineNumberSync, toggleCodeBlockLineWrap, onPreviewLoopback]);
};

const resetMarkdownBlockLayout = (el: HTMLElement): void => {
  el.style.display = 'contents';
  el.style.width = '';
  el.style.minWidth = '';
  el.style.maxWidth = '';
};

const applyLiveMarkdownTail = (el: HTMLElement, raw: string): void => {
  // Stay `display:contents` so the live host is a normal markdown child.
  // A paragraph host (not pre-wrap) matches CommonMark `breaks: false`:
  // single newlines collapse and wrap at the chat column, instead of
  // painting a narrow poem-shaped column until HTML mounts.
  resetMarkdownBlockLayout(el);
  const preformatted = isPreformattedLiveMarkdown(raw);
  let host = el.querySelector<HTMLElement>(':scope > [data-md-live]');
  const hostIsPreformatted = host?.hasAttribute('data-md-live-pre') === true;
  if (!host || hostIsPreformatted !== preformatted) {
    el.replaceChildren();
    host = document.createElement(preformatted ? 'div' : 'p');
    host.setAttribute('data-md-live', '');
    if (preformatted) {
      host.setAttribute('data-md-live-pre', '');
    }
    host.className = preformatted
      ? 'w-full min-w-0 whitespace-pre-wrap break-words'
      : 'w-full min-w-0 break-words';
    host.appendChild(document.createTextNode(''));
    el.appendChild(host);
  }
  const textNode = host.firstChild;
  if (!(textNode instanceof globalThis.Text)) {
    host.replaceChildren(document.createTextNode(raw));
    return;
  }
  if (raw.startsWith(textNode.data)) {
    const append = raw.slice(textNode.data.length);
    if (append.length > 0) {
      textNode.appendData(append);
    }
    return;
  }
  textNode.data = raw;
};

// Runs the async render pipeline into the container and keeps a stable
// delegated interaction listener attached.
const useMorphdomMarkdown = ({
  containerRef,
  text,
  streaming,
  cacheKey,
  syntaxVars,
  ctx,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  text: string;
  streaming: boolean;
  cacheKey: string;
  syntaxVars: Record<string, string>;
  ctx: DecorateContext;
}) => {
  React.useEffect(() => {
    ensureMarkdownShikiTheme();
  }, []);

  const mermaidViewerRef = React.useRef<ReturnType<typeof createMermaidViewerRegistry> | null>(null);
  const previousBlocksRef = React.useRef<RenderedBlock[] | null>(null);
  const previousCacheKeyRef = React.useRef(cacheKey);
  if (previousCacheKeyRef.current !== cacheKey) {
    previousCacheKeyRef.current = cacheKey;
    previousBlocksRef.current = null;
  }
  const refreshMermaidViewers = React.useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    if (!mermaidViewerRef.current) {
      if (!shouldRefreshMermaidViewers(container)) {
        return;
      }
      mermaidViewerRef.current = createMermaidViewerRegistry(container);
      return;
    }
    mermaidViewerRef.current.refresh();
  }, [containerRef]);

  // Synchronous first paint: while the async parse is in-flight, show escaped
  // plain text immediately so there is no blank frame on initial mount. Only
  // runs when the target is empty — subsequent updates keep the prior rich DOM
  // until the next async render morphs in (no flash). Uses PiChamber's
  // `initialValue: fallback(text)` resource pattern.
  React.useLayoutEffect(() => {
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target) return;
    if (text && target.childNodes.length === 0) {
      const block = document.createElement('div');
      block.setAttribute('data-md-block', '');
      // `display:contents` keeps margin-collapsing/spacing identical to a flat
      // HTML body — the wrapper exists only for per-block reconciliation.
      block.style.display = 'contents';
      if (streaming) {
        applyLiveMarkdownTail(block, text);
        target.appendChild(block);
        return;
      }
      block.innerHTML = renderMarkdownSync(text);
      // Decorate synchronously too: wrap code blocks in their framed card,
      // mark inline code, build table controls, etc. The async pass re-decorates
      // its own DOM before morphing, so without this the first paint shows bare
      // <pre>/tables that "snap" into their decorated form a tick later. Matching
      // the structure here keeps the async morph to syntax colors only.
      decorateMarkdown(block, ctx);
      target.appendChild(block);
      if (shouldRefreshMermaidViewers(block)) {
        refreshMermaidViewers();
      }
    }
  }, [containerRef, text, streaming, ctx, refreshMermaidViewers]);

  React.useEffect(() => () => {
    mermaidViewerRef.current?.cleanup();
    mermaidViewerRef.current = null;
  }, []);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    let active = true;

    if (streaming && previousBlocksRef.current) {
      const streamBlocks = streamParserFor(cacheKey).update(text);
      if (isLiveMarkdownTailAppend(previousBlocksRef.current, streamBlocks)) {
        const lastBlock = streamBlocks[streamBlocks.length - 1];
        const liveEl = target.querySelectorAll<HTMLElement>(':scope > [data-md-block]')[streamBlocks.length - 1];
        if (lastBlock && liveEl) {
          applyLiveMarkdownTail(liveEl, lastBlock.raw);
          liveEl.setAttribute('data-md-id', `live:${streamBlocks.length - 1}`);
          previousBlocksRef.current = previousBlocksRef.current.map((block, index) => (
            index === streamBlocks.length - 1
              ? { ...block, raw: lastBlock.raw, id: `live:${index}`, mode: 'live' as const }
              : block
          ));
          return;
        }
      }
    }

    void renderMarkdownBlocks(text, streaming, cacheKey).then((blocks) => {
      if (!active) return;
      const existing = Array.from(target.querySelectorAll<HTMLElement>(':scope > [data-md-block]'));

      // Reconcile per block: only re-morph blocks whose content changed, leaving
      // stable leading blocks untouched. Keeps per-stream-step DOM work bounded
      // to the trailing (growing) block instead of the whole message.
      blocks.forEach((block, index) => {
        let el = existing[index];
        if (!el) {
          el = document.createElement('div');
          el.setAttribute('data-md-block', '');
          el.style.display = 'contents';
          target.appendChild(el);
        }
        if (block.mode === 'live') {
          applyLiveMarkdownTail(el, block.raw);
          el.setAttribute('data-md-id', block.id);
          return;
        }
        resetMarkdownBlockLayout(el);
        if (el.getAttribute('data-md-id') === block.id) return;

        const temp = document.createElement('div');
        temp.innerHTML = block.html;
        decorateMarkdown(temp, ctx);
        const hadMermaidBlock = shouldRefreshMermaidViewers(el);
        const tempHasMermaidBlock = shouldRefreshMermaidViewers(temp);
        morphdom(el, temp, {
          childrenOnly: true,
          onBeforeElUpdated: (fromEl, toEl) => {
            if (fromEl.isEqualNode(toEl)) return false;
            return true;
          },
        });
        el.setAttribute('data-md-id', block.id);
        if (hadMermaidBlock || tempHasMermaidBlock || shouldRefreshMermaidViewers(el)) {
          refreshMermaidViewers();
        }
      });

      // Remove any trailing block elements no longer present.
      const hadMermaidBeforeTrailingCleanup = shouldRefreshMermaidViewers(target);
      let removedMermaidBlock = false;
      for (let i = existing.length - 1; i >= blocks.length; i -= 1) {
        const removed = existing[i];
        if (removed && shouldRefreshMermaidViewers(removed)) {
          removedMermaidBlock = true;
        }
        removed?.remove();
      }
      if (removedMermaidBlock || (existing.length > blocks.length && hadMermaidBeforeTrailingCleanup)) {
        refreshMermaidViewers();
      }

      previousBlocksRef.current = blocks;
    });

    return () => {
      active = false;
    };
  }, [containerRef, text, streaming, cacheKey, ctx, refreshMermaidViewers]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return attachMarkdownInteractions(container, ctx);
  }, [containerRef, ctx]);

  // Apply syntax CSS variables imperatively so they survive morphdom updates.
  React.useEffect(() => {
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target) return;
    for (const [key, value] of Object.entries(syntaxVars)) {
      target.style.setProperty(key, value);
    }
  }, [containerRef, syntaxVars]);

  React.useEffect(() => {
    const container = containerRef.current;
    const target = container?.querySelector<HTMLElement>('[data-markdown-content]') ?? container;
    if (!target) return;
    if (ctx.deferCodeLineNumberSync) return;
    applyMarkdownCodeBlockWrapState(target, ctx.codeBlockLineWrap, ctx.labels);
  }, [containerRef, ctx.codeBlockLineWrap, ctx.deferCodeLineNumberSync, ctx.labels]);

};

const markdownContentClassName = (variant: MarkdownVariant, isStreaming?: boolean): string =>
  cn(
    'w-full min-w-0',
    variant === 'tool'
      ? 'markdown-content markdown-tool'
      : variant === 'reasoning'
        ? 'markdown-content markdown-reasoning'
        : 'markdown-content leading-relaxed',
    isStreaming && 'markdown-streaming',
  );

const MarkdownRendererImpl: React.FC<MarkdownRendererProps> = ({
  content,
  part,
  messageId,
  isAnimated = true,
  skipFadeIn = false,
  className,
  isStreaming = false,
  disableStreamAnimation = false,
  variant = 'assistant',
  onShowPopup,
  enableFileReferences = true,
}) => {
  streamPerfCount('ui.markdown_renderer.render');
  if (isStreaming) streamPerfCount('ui.markdown_renderer.render.streaming');
  streamPerfObserve('ui.markdown_renderer.content_len', content.length);
  const currentTheme = useCurrentMermaidTheme();
  const { editor } = useRuntimeAPIs();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const openContextPreview = useUIStore((state) => state.openContextPreview);

  const handlePreviewLoopback = React.useCallback((url: string) => {
    if (!effectiveDirectory) return;
    openContextPreview(effectiveDirectory, url);
  }, [effectiveDirectory, openContextPreview]);

  const live = isStreaming && !disableStreamAnimation;

  useMermaidInlineInteractions({
    containerRef,
    onShowPopup,
    enableFullscreen: DEFAULT_MERMAID_FULLSCREEN_ENABLED,
    enablePanZoom: DEFAULT_MERMAID_CONTROLS.showPanZoomControls,
  });
  useFileReferenceInteractions({
    containerRef,
    effectiveDirectory,
    editor,
    preferRuntimeEditor: false,
    enabled: enableFileReferences && !isStreaming,
  });
  useExternalLinkInteractions({ containerRef });

  const syntaxVars = React.useMemo(() => getMarkdownSyntaxVars(currentTheme), [currentTheme]);
  const ctx = useDecorateContext(currentTheme, live, effectiveDirectory ? handlePreviewLoopback : undefined, DEFAULT_MERMAID_CONTROLS);
  const cacheKey = `markdown-${part?.id ? `part-${part.id}` : `message-${messageId}`}`;

  useMorphdomMarkdown({ containerRef, text: content, streaming: live, cacheKey, syntaxVars, ctx });

  const markdownContent = (
    <div className={cn('break-words w-full min-w-0', className)} ref={containerRef}>
      <div className={markdownContentClassName(variant, live)} data-markdown-content />
    </div>
  );

  if (isAnimated) {
    return (
      <FadeInOnReveal key={cacheKey} skipAnimation={skipFadeIn}>
        {markdownContent}
      </FadeInOnReveal>
    );
  }

  return markdownContent;
};

export const MarkdownRenderer = React.memo(MarkdownRendererImpl, (prev, next) => {
  return prev.content === next.content
    && prev.isStreaming === next.isStreaming
    && prev.disableStreamAnimation === next.disableStreamAnimation
    && prev.variant === next.variant
    && prev.isAnimated === next.isAnimated
    && prev.skipFadeIn === next.skipFadeIn
    && prev.className === next.className
    && prev.messageId === next.messageId
    && prev.onShowPopup === next.onShowPopup
    && prev.enableFileReferences === next.enableFileReferences
    && prev.part?.id === next.part?.id;
});

const SimpleMarkdownRendererImpl: React.FC<{
  content: string;
  className?: string;
  variant?: MarkdownVariant;
  disableLinkSafety?: boolean;
  stripFrontmatter?: boolean;
  onShowPopup?: (content: ToolPopupContent) => void;
  mermaidControls?: MermaidControlOptions;
  allowMermaidWheelEvents?: boolean;
  enableFileReferences?: boolean;
}> = ({
  content,
  className,
  variant = 'assistant',
  disableLinkSafety,
  stripFrontmatter = false,
  onShowPopup,
  mermaidControls = DEFAULT_MERMAID_CONTROLS,
  allowMermaidWheelEvents = false,
  enableFileReferences = true,
}) => {
  const { editor } = useRuntimeAPIs();
  const currentTheme = useCurrentMermaidTheme();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const effectiveDirectory = useEffectiveDirectory() ?? '';

  const renderedContent = React.useMemo(
    () => (stripFrontmatter ? stripLeadingFrontmatter(content) : content),
    [content, stripFrontmatter],
  );

  useMermaidInlineInteractions({
    containerRef,
    onShowPopup,
    enableFullscreen: DEFAULT_MERMAID_FULLSCREEN_ENABLED,
    enablePanZoom: mermaidControls.showPanZoomControls,
    allowMermaidWheelEvents,
  });
  useFileReferenceInteractions({
    containerRef,
    effectiveDirectory,
    editor,
    preferRuntimeEditor: false,
    enabled: enableFileReferences,
  });
  useExternalLinkInteractions({ containerRef, enabled: !disableLinkSafety });

  const syntaxVars = React.useMemo(() => getMarkdownSyntaxVars(currentTheme), [currentTheme]);
  const ctx = useDecorateContext(currentTheme, false, undefined, mermaidControls);

  useMorphdomMarkdown({
    containerRef,
    text: renderedContent,
    streaming: false,
    cacheKey: `simple:${variant}`,
    syntaxVars,
    ctx,
  });

  return (
    <div className={cn('break-words w-full min-w-0', className)} ref={containerRef}>
      <div className={markdownContentClassName(variant)} data-markdown-content />
    </div>
  );
};

export const SimpleMarkdownRenderer = React.memo(SimpleMarkdownRendererImpl, (prev, next) => {
  const prevMermaidControls = prev.mermaidControls ?? DEFAULT_MERMAID_CONTROLS;
  const nextMermaidControls = next.mermaidControls ?? DEFAULT_MERMAID_CONTROLS;

  return prev.content === next.content
    && prev.variant === next.variant
    && prev.className === next.className
    && prev.disableLinkSafety === next.disableLinkSafety
    && prev.stripFrontmatter === next.stripFrontmatter
    && prev.onShowPopup === next.onShowPopup
    && prevMermaidControls.download === nextMermaidControls.download
    && prevMermaidControls.copy === nextMermaidControls.copy
    && prevMermaidControls.showPanZoomControls === nextMermaidControls.showPanZoomControls
    && prev.allowMermaidWheelEvents === next.allowMermaidWheelEvents
    && prev.enableFileReferences === next.enableFileReferences;
});
