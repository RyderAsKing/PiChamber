import { invokeDesktop } from '@/lib/desktop';
import {
  formatPreviewAnnotationMarkdown,
  getBrowserProxyTargetKey,
  getCachedProxyTarget,
  isPreviewElementMetadata,
  previewProxyTargetCache,
  type CachedProxyTarget,
  type PreviewElementMetadata,
} from './previewTypes';
import {
  canvasToJpegBase64,
  getCaptureBackgroundColor,
  inlineIframeCaptureAssets,
  TRANSPARENT_IMAGE_PLACEHOLDER,
} from './domAssetInlining';
import {
  captureNestedScrollState,
  describeScrolledElements,
  previewCaptureDebug,
  snapdomFixedPinPlugin,
  snapdomNestedScrollPlugin,
  tagFixedElementsForClonePinning,
} from './snapdomPlugins';

export type {
  CachedProxyTarget,
  PreviewElementMetadata,
};

export {
  formatPreviewAnnotationMarkdown,
  getBrowserProxyTargetKey,
  getCachedProxyTarget,
  isPreviewElementMetadata,
  previewProxyTargetCache,
};

export const renderPreviewScreenshot = async (
  iframe: HTMLIFrameElement,
  target: PreviewElementMetadata,
): Promise<File | null> => {
  if (typeof window !== 'undefined') {
    try {
      const rect = iframe.getBoundingClientRect();
      const capture = await invokeDesktop<{ mime: string; base64: string; width: number; height: number }>('desktop_capture_page_rect', {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
      if (!capture) throw new Error('Desktop screenshot capture is not available');
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('Failed to load desktop preview screenshot'));
        image.src = `data:${capture.mime};base64,${capture.base64}`;
      });

      const width = Math.max(1, image.naturalWidth || capture.width || Math.floor(rect.width));
      const height = Math.max(1, image.naturalHeight || capture.height || Math.floor(rect.height));
      const maxOutputWidth = 1200;
      const outputScale = Math.min(1, maxOutputWidth / width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(width * outputScale);
      canvas.height = Math.floor(height * outputScale);
      const context = canvas.getContext('2d');
      if (!context) return null;

      context.scale(outputScale, outputScale);
      context.drawImage(image, 0, 0, width, height);
      const xScale = width / Math.max(1, rect.width);
      const yScale = height / Math.max(1, rect.height);
      context.fillStyle = 'rgba(37, 99, 235, 0.28)';
      context.strokeStyle = 'rgb(37, 99, 235)';
      context.lineWidth = Math.max(2, 2 * xScale);
      context.fillRect(target.bounds.x * xScale, target.bounds.y * yScale, target.bounds.width * xScale, target.bounds.height * yScale);
      context.strokeRect(target.bounds.x * xScale, target.bounds.y * yScale, target.bounds.width * xScale, target.bounds.height * yScale);

      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
      if (!blob) return null;
      return new File([blob], `preview-annotation-${Date.now()}.jpg`, { type: 'image/jpeg' });
    } catch (error) {
      console.warn('[preview] failed to capture annotation screenshot:', error);
      return null;
    }
  }
  return await captureIframeDomScreenshot(iframe, target);
};

export const desktopAnnotationToFile = async (
  base64: string,
  screenshotWidth: number,
  screenshotHeight: number,
  cssWidth: number,
  cssHeight: number,
  target: PreviewElementMetadata,
): Promise<File | null> => {
  if (!base64) return null;
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Failed to load desktop browser screenshot'));
      image.src = `data:image/jpeg;base64,${base64}`;
    });

    const width = Math.max(1, image.naturalWidth || screenshotWidth);
    const height = Math.max(1, image.naturalHeight || screenshotHeight);
    const maxOutputWidth = 1200;
    const outputScale = Math.min(1, maxOutputWidth / width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(width * outputScale);
    canvas.height = Math.floor(height * outputScale);
    const context = canvas.getContext('2d');
    if (!context) return null;

    context.scale(outputScale, outputScale);
    context.drawImage(image, 0, 0, width, height);
    const xScale = width / Math.max(1, cssWidth || width);
    const yScale = height / Math.max(1, cssHeight || height);
    context.fillStyle = 'rgba(37, 99, 235, 0.14)';
    context.strokeStyle = 'rgb(37, 99, 235)';
    context.lineWidth = Math.max(2, 2 * xScale);
    context.fillRect(target.bounds.x * xScale, target.bounds.y * yScale, target.bounds.width * xScale, target.bounds.height * yScale);
    context.strokeRect(target.bounds.x * xScale, target.bounds.y * yScale, target.bounds.width * xScale, target.bounds.height * yScale);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob) return null;
    return new File([blob], `browser-annotation-${Date.now()}.jpg`, { type: 'image/jpeg' });
  } catch {
    return null;
  }
};

async function captureIframeSnapdomScreenshot(
  iframe: HTMLIFrameElement,
  target: PreviewElementMetadata,
): Promise<File | null> {
  try {
    const frameWindow = iframe.contentWindow;
    const document = iframe.contentDocument ?? frameWindow?.document;
    const root = document?.documentElement;
    if (!frameWindow || !document || !root) return null;

    const iframeRect = iframe.getBoundingClientRect();
    const viewportWidth = Math.max(1, Math.ceil(frameWindow.innerWidth || iframe.clientWidth || iframeRect.width));
    const viewportHeight = Math.max(1, Math.ceil(frameWindow.innerHeight || iframe.clientHeight || iframeRect.height));
    const body = document.body;
    const scrollingElement = document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
    const windowScrollX = frameWindow.scrollX || 0;
    const windowScrollY = frameWindow.scrollY || 0;
    const pageScrollX = frameWindow.pageXOffset || 0;
    const pageScrollY = frameWindow.pageYOffset || 0;
    const visualViewportScrollX = frameWindow.visualViewport?.pageLeft || frameWindow.visualViewport?.offsetLeft || 0;
    const visualViewportScrollY = frameWindow.visualViewport?.pageTop || frameWindow.visualViewport?.offsetTop || 0;
    const rootScrollX = root.scrollLeft || 0;
    const rootScrollY = root.scrollTop || 0;
    const bodyScrollX = body?.scrollLeft || 0;
    const bodyScrollY = body?.scrollTop || 0;
    const scrollingElementScrollX = scrollingElement?.scrollLeft || 0;
    const scrollingElementScrollY = scrollingElement?.scrollTop || 0;
    const scrollX = Math.max(windowScrollX, pageScrollX, visualViewportScrollX, rootScrollX, bodyScrollX, scrollingElementScrollX);
    const scrollY = Math.max(windowScrollY, pageScrollY, visualViewportScrollY, rootScrollY, bodyScrollY, scrollingElementScrollY);
    previewCaptureDebug('scroll sources', {
      windowScrollX, windowScrollY,
      pageScrollX, pageScrollY,
      visualViewportScrollX, visualViewportScrollY,
      rootScrollX, rootScrollY,
      bodyScrollX, bodyScrollY,
      scrollingElementScrollX, scrollingElementScrollY,
      scrollingElementTag: scrollingElement?.tagName?.toLowerCase() ?? null,
      resolvedScrollX: scrollX, resolvedScrollY: scrollY,
      nestedScrolledElements: describeScrolledElements(document),
    });
    const captureWidth = Math.max(viewportWidth, root.scrollWidth || 0, body?.scrollWidth || 0, Math.ceil(root.getBoundingClientRect().width || 0));
    const captureHeight = Math.max(viewportHeight, root.scrollHeight || 0, body?.scrollHeight || 0, Math.ceil(root.getBoundingClientRect().height || 0));
    const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const previousRootScrollBehavior = root.style.scrollBehavior;
    const previousBodyScrollBehavior = body?.style.scrollBehavior ?? '';
    root.style.scrollBehavior = 'auto';
    if (body) body.style.scrollBehavior = 'auto';

    const nestedScroll = captureNestedScrollState(document);
    previewCaptureDebug('nested scroll snapshot', nestedScroll.snapshot);

    let restoreAssets = () => { /* no-op until capture preparation mutates DOM */ };
    let restoreFixedElements = () => { /* no-op until fixed elements are tagged */ };
    try {
      await document.fonts?.ready.catch(() => undefined);
      restoreAssets = await inlineIframeCaptureAssets(document, viewportWidth, viewportHeight, { applyLayoutWorkarounds: false });
      frameWindow.scrollTo(scrollX, scrollY);
      restoreFixedElements = tagFixedElementsForClonePinning(document, scrollX, scrollY);
      nestedScroll.reapply();

      const { snapdom } = await import('@zumer/snapdom');
      const snapdomOptions = {
        backgroundColor: getCaptureBackgroundColor(document),
        cache: 'disabled' as const,
        dpr: pixelRatio,
        embedFonts: true,
        fast: false,
        height: captureHeight,
        outerShadows: true,
        outerTransforms: true,
        placeholders: true,
        plugins: [snapdomFixedPinPlugin, snapdomNestedScrollPlugin],
        quality: 0.82,
        width: captureWidth,
      };
      const capture = await snapdom(root, snapdomOptions);
      const fullCanvas = await capture.toCanvas();
      if (!fullCanvas.width || !fullCanvas.height) return null;

      const xScale = fullCanvas.width / Math.max(1, captureWidth);
      const yScale = fullCanvas.height / Math.max(1, captureHeight);
      const sourceWidth = Math.min(fullCanvas.width, Math.max(1, Math.round(viewportWidth * xScale)));
      const sourceHeight = Math.min(fullCanvas.height, Math.max(1, Math.round(viewportHeight * yScale)));
      const maxSourceX = Math.max(0, fullCanvas.width - sourceWidth);
      const maxSourceY = Math.max(0, fullCanvas.height - sourceHeight);
      const sourceX = Math.min(maxSourceX, Math.max(0, Math.round(scrollX * xScale)));
      const sourceY = Math.min(maxSourceY, Math.max(0, Math.round(scrollY * yScale)));
      previewCaptureDebug('capture geometry', {
        viewportWidth, viewportHeight,
        captureWidth, captureHeight,
        canvasWidth: fullCanvas.width, canvasHeight: fullCanvas.height,
        xScale, yScale,
        sourceX, sourceY, sourceWidth, sourceHeight,
      });

      const viewportCanvas = document.createElement('canvas');
      viewportCanvas.width = sourceWidth;
      viewportCanvas.height = sourceHeight;
      const context = viewportCanvas.getContext('2d');
      if (!context) return null;

      context.drawImage(fullCanvas, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
      const base64 = await canvasToJpegBase64(viewportCanvas, 0.82);
      if (!base64) return null;

      return await desktopAnnotationToFile(base64, viewportWidth, viewportHeight, viewportWidth, viewportHeight, target);
    } finally {
      restoreFixedElements();
      nestedScroll.cleanup();
      restoreAssets();
      frameWindow.scrollTo(scrollX, scrollY);
      nestedScroll.reapply();
      root.style.scrollBehavior = previousRootScrollBehavior;
      if (body) body.style.scrollBehavior = previousBodyScrollBehavior;
    }
  } catch (error) {
    console.warn('[preview] failed to capture iframe DOM screenshot with snapDOM:', error);
    return null;
  }
}

async function captureIframeDomScreenshot(
  iframe: HTMLIFrameElement,
  target: PreviewElementMetadata,
): Promise<File | null> {
  const snapdomScreenshot = await captureIframeSnapdomScreenshot(iframe, target);
  if (snapdomScreenshot) return snapdomScreenshot;

  try {
    const frameWindow = iframe.contentWindow;
    const document = iframe.contentDocument ?? frameWindow?.document;
    const root = document?.documentElement;
    if (!frameWindow || !document || !root) return null;

    const iframeRect = iframe.getBoundingClientRect();
    const viewportWidth = Math.max(1, Math.ceil(frameWindow.innerWidth || iframe.clientWidth || iframeRect.width));
    const viewportHeight = Math.max(1, Math.ceil(frameWindow.innerHeight || iframe.clientHeight || iframeRect.height));
    const scrollX = frameWindow.scrollX || document.documentElement.scrollLeft || document.body?.scrollLeft || 0;
    const scrollY = frameWindow.scrollY || document.documentElement.scrollTop || document.body?.scrollTop || 0;
    const body = document.body;
    const captureHeight = Math.max(viewportHeight, root.scrollHeight || 0, body?.scrollHeight || 0);
    const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const previousRootScrollBehavior = root.style.scrollBehavior;
    const previousBodyScrollBehavior = body?.style.scrollBehavior ?? '';
    root.style.scrollBehavior = 'auto';
    if (body) body.style.scrollBehavior = 'auto';

    let dataUrl = '';
    let restoreAssets = () => { /* no-op until capture preparation mutates DOM */ };
    try {
      await document.fonts?.ready.catch(() => undefined);
      restoreAssets = await inlineIframeCaptureAssets(document, viewportWidth, viewportHeight, { applyLayoutWorkarounds: true });
      frameWindow.scrollTo(scrollX, scrollY);
      const { getFontEmbedCSS, toJpeg } = await import('html-to-image');
      const fontEmbedCSS = await getFontEmbedCSS(root).catch(() => '');

      dataUrl = await toJpeg(root, {
        quality: 0.82,
        pixelRatio,
        width: viewportWidth,
        height: viewportHeight,
        backgroundColor: getCaptureBackgroundColor(document),
        imagePlaceholder: TRANSPARENT_IMAGE_PLACEHOLDER,
        fontEmbedCSS: fontEmbedCSS || undefined,
        style: {
          transform: `translate(${-scrollX}px, ${-scrollY}px)`,
          transformOrigin: 'top left',
          minWidth: `${viewportWidth}px`,
          minHeight: `${captureHeight}px`,
        },
        cacheBust: true,
      });
    } finally {
      restoreAssets();
      frameWindow.scrollTo(scrollX, scrollY);
      root.style.scrollBehavior = previousRootScrollBehavior;
      if (body) body.style.scrollBehavior = previousBodyScrollBehavior;
    }

    const base64 = dataUrl.split(',', 2)[1] || '';
    if (!base64) return null;

    return await desktopAnnotationToFile(base64, viewportWidth, viewportHeight, viewportWidth, viewportHeight, target);
  } catch (error) {
    console.warn('[preview] failed to capture iframe DOM screenshot:', error);
    return null;
  }
}
