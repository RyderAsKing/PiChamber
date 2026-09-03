import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  getCachedProxyTarget,
  previewProxyTargetCache,
  type CachedProxyTarget,
} from './previewTypes';

export const TRANSPARENT_IMAGE_PLACEHOLDER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

const previewProxyTargetRequests = new Map<string, Promise<CachedProxyTarget | null>>();

export function getCaptureBackgroundColor(document: Document): string {
  const fallback = '#ffffff';
  const view = document.defaultView ?? window;
  try {
    const bodyColor = document.body ? view.getComputedStyle(document.body).backgroundColor : '';
    if (bodyColor && bodyColor !== 'rgba(0, 0, 0, 0)' && bodyColor !== 'transparent') return bodyColor;

    const rootColor = view.getComputedStyle(document.documentElement).backgroundColor;
    if (rootColor && rootColor !== 'rgba(0, 0, 0, 0)' && rootColor !== 'transparent') return rootColor;
  } catch {
    // Ignore style access failures and use a stable background.
  }
  return fallback;
}

export const blobToDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : TRANSPARENT_IMAGE_PLACEHOLDER);
  reader.onerror = () => reject(reader.error ?? new Error('Failed to read image blob'));
  reader.readAsDataURL(blob);
});

export const canvasToJpegBase64 = async (canvas: HTMLCanvasElement, quality = 0.82): Promise<string> => {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) return '';
  return (await blobToDataUrl(blob)).split(',', 2)[1] || '';
};

export const fetchUrlAsDataUrl = async (url: string, credentials: RequestCredentials): Promise<string | null> => {
  try {
    const response = await fetch(url, { credentials });
    if (!response.ok) return null;
    return await blobToDataUrl(await response.blob());
  } catch {
    return null;
  }
};

export const getExternalResourceProxyUrl = async (url: URL): Promise<string> => {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';

  const targetKey = url.origin;
  const cached = getCachedProxyTarget(targetKey);
  if (cached) {
    return `${cached.proxyBasePath}${url.pathname}${url.search}${url.hash}`;
  }

  const existingRequest = previewProxyTargetRequests.get(targetKey);
  const request = existingRequest ?? (async () => {
    try {
      const response = await runtimeFetch('/api/preview/targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ url: url.toString(), allowExternal: true }),
      });

      if (!response.ok) {
        previewProxyTargetCache.delete(targetKey);
        return null;
      }

      const body = await response.json() as { proxyBasePath?: unknown; expiresAt?: unknown };
      const proxyBasePath = typeof body.proxyBasePath === 'string' ? body.proxyBasePath : '';
      const expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : 0;
      if (!proxyBasePath) {
        previewProxyTargetCache.delete(targetKey);
        return null;
      }

      const target = { proxyBasePath, expiresAt };
      previewProxyTargetCache.set(targetKey, target);
      return target;
    } catch {
      previewProxyTargetCache.delete(targetKey);
      return null;
    } finally {
      previewProxyTargetRequests.delete(targetKey);
    }
  })();

  if (!existingRequest) {
    previewProxyTargetRequests.set(targetKey, request);
  }

  const target = await request;
  return target ? `${target.proxyBasePath}${url.pathname}${url.search}${url.hash}` : '';
};

export const fetchFrameResourceAsDataUrl = async (rawUrl: string, document: Document): Promise<string> => {
  if (!rawUrl || rawUrl.startsWith('data:')) return rawUrl;

  try {
    const url = new URL(rawUrl, document.baseURI);
    if (url.origin === window.location.origin || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      return await fetchUrlAsDataUrl(url.toString(), 'include') ?? TRANSPARENT_IMAGE_PLACEHOLDER;
    }

    const proxyUrl = await getExternalResourceProxyUrl(url);
    const proxied = proxyUrl ? await fetchUrlAsDataUrl(proxyUrl, 'include') : null;
    if (proxied) return proxied;

    return await fetchUrlAsDataUrl(url.toString(), 'omit') ?? TRANSPARENT_IMAGE_PLACEHOLDER;
  } catch {
    return TRANSPARENT_IMAGE_PLACEHOLDER;
  }
};

export const inlineCssImageUrls = async (value: string, document: Document): Promise<string> => {
  if (!value || value === 'none' || !value.includes('url(')) return value;

  const matches = Array.from(value.matchAll(/url\((['"]?)(.*?)\1\)/g));
  let nextValue = value;
  for (const match of matches) {
    const rawUrl = match[2] || '';
    if (!rawUrl || rawUrl.startsWith('data:')) continue;
    const dataUrl = await fetchFrameResourceAsDataUrl(rawUrl, document);
    nextValue = nextValue.replace(match[0], `url("${dataUrl}")`);
  }
  return nextValue;
};

export const waitForImage = (image: HTMLImageElement): Promise<void> => {
  if (image.complete) return Promise.resolve();
  return new Promise((resolve) => {
    image.addEventListener('load', () => resolve(), { once: true });
    image.addEventListener('error', () => resolve(), { once: true });
  });
};

export const getElementStyleRestore = (element: HTMLElement): (() => void) => {
  const cssText = element.style.cssText;
  return () => { element.style.cssText = cssText; };
};

export const getLineHeight = (style: CSSStyleDeclaration): number => {
  const lineHeight = Number.parseFloat(style.lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight;
  const fontSize = Number.parseFloat(style.fontSize);
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.2 : 16;
};

export const preserveSingleLineTextElements = (
  document: Document,
  viewportWidth: number,
  viewportHeight: number,
): (() => void) => {
  const restoreCallbacks: Array<() => void> = [];
  const view = document.defaultView ?? window;
  const controlsSelector = 'button, a, summary, label, [role="button"], [role="link"], [role="menuitem"], [role="tab"], nav *, header *';
  const elements = Array.from(document.querySelectorAll<HTMLElement>(controlsSelector));

  for (const element of elements) {
    const text = element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    if (!text || !text.includes(' ')) continue;

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.right < 0 || rect.bottom < 0 || rect.left > viewportWidth || rect.top > viewportHeight) continue;

    const style = view.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;

    const textWrap = style.getPropertyValue('text-wrap');
    const textWrapMode = style.getPropertyValue('text-wrap-mode');
    const alreadyNoWrap = style.whiteSpace.includes('nowrap') || textWrap === 'nowrap' || textWrapMode === 'nowrap';
    const isSingleLine = rect.height <= getLineHeight(style) * 1.7;
    if (!alreadyNoWrap && (!isSingleLine || rect.width > viewportWidth * 0.72)) continue;

    restoreCallbacks.push(getElementStyleRestore(element));
    element.style.whiteSpace = 'nowrap';
    element.style.overflowWrap = 'normal';
    element.style.wordBreak = 'normal';
    element.style.setProperty('text-wrap', 'nowrap');
    element.style.setProperty('text-wrap-mode', 'nowrap');
  }

  return () => {
    for (let index = restoreCallbacks.length - 1; index >= 0; index -= 1) {
      restoreCallbacks[index]?.();
    }
  };
};

export const freezeViewportPositionedElements = (
  document: Document,
  viewportWidth: number,
  viewportHeight: number,
  frozenElements?: WeakSet<HTMLElement>,
): (() => void) => {
  const restoreCallbacks: Array<() => void> = [];
  const view = document.defaultView ?? window;
  const scrollX = view.scrollX || document.documentElement.scrollLeft || document.body?.scrollLeft || 0;
  const scrollY = view.scrollY || document.documentElement.scrollTop || document.body?.scrollTop || 0;
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('*'))
    .filter((element) => {
      const style = view.getComputedStyle(element);
      if (style.position !== 'fixed') return false;
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0
        && rect.height > 0
        && rect.right >= 0
        && rect.bottom >= 0
        && rect.left <= viewportWidth
        && rect.top <= viewportHeight;
    })
    .filter((element, index, elements) => {
      return !elements.some((candidate, candidateIndex) => candidateIndex < index && candidate.contains(element));
    });

  for (const element of candidates) {
    const rect = element.getBoundingClientRect();
    const computed = view.getComputedStyle(element);
    const borderBoxWidth = Math.ceil(rect.width) + 8;
    const borderBoxHeight = Math.ceil(rect.height) + 2;
    frozenElements?.add(element);
    restoreCallbacks.push(getElementStyleRestore(element));
    element.style.position = 'absolute';
    element.style.top = `${rect.top + scrollY}px`;
    element.style.left = `${rect.left + scrollX}px`;
    element.style.right = 'auto';
    element.style.bottom = 'auto';
    element.style.width = `${borderBoxWidth}px`;
    element.style.minWidth = `${borderBoxWidth}px`;
    element.style.height = `${borderBoxHeight}px`;
    element.style.minHeight = `${borderBoxHeight}px`;
    element.style.margin = '0';
    element.style.boxSizing = 'border-box';
    element.style.transform = 'none';
    if (computed.zIndex !== 'auto') element.style.zIndex = computed.zIndex;
  }

  return () => {
    for (let index = restoreCallbacks.length - 1; index >= 0; index -= 1) {
      restoreCallbacks[index]?.();
    }
  };
};

export const inlineIframeCaptureAssets = async (
  document: Document,
  viewportWidth: number,
  viewportHeight: number,
  options: { applyLayoutWorkarounds?: boolean } = {},
): Promise<() => void> => {
  const restoreCallbacks: Array<() => void> = [];
  const view = document.defaultView ?? window;
  const isVisibleInViewport = (element: Element): boolean => {
    if (element === document.documentElement || element === document.body) return true;
    try {
      const rect = element.getBoundingClientRect();
      return rect.width > 0
        && rect.height > 0
        && rect.right >= 0
        && rect.bottom >= 0
        && rect.left <= viewportWidth
        && rect.top <= viewportHeight;
    } catch {
      return false;
    }
  };

  if (options.applyLayoutWorkarounds) {
    const frozenElements = new WeakSet<HTMLElement>();
    restoreCallbacks.push(freezeViewportPositionedElements(document, viewportWidth, viewportHeight, frozenElements));
    restoreCallbacks.push(preserveSingleLineTextElements(document, viewportWidth, viewportHeight));
  }

  const imageSourceUrls = new Map<HTMLImageElement, string>();
  for (const image of Array.from(document.images)) {
    imageSourceUrls.set(image, image.currentSrc || image.src || image.getAttribute('src') || '');
  }

  const pictures = Array.from(document.querySelectorAll('picture'));
  for (const picture of pictures) {
    const sources = Array.from(picture.querySelectorAll('source'));
    if (sources.length === 0) continue;
    const previous = sources.map((source) => ({ source, srcset: source.getAttribute('srcset'), sizes: source.getAttribute('sizes') }));
    restoreCallbacks.push(() => {
      for (const item of previous) {
        if (item.srcset === null) item.source.removeAttribute('srcset');
        else item.source.setAttribute('srcset', item.srcset);
        if (item.sizes === null) item.source.removeAttribute('sizes');
        else item.source.setAttribute('sizes', item.sizes);
      }
    });
    for (const source of sources) {
      source.removeAttribute('srcset');
      source.removeAttribute('sizes');
    }
  }

  const images = Array.from(document.images).filter((image) => isVisibleInViewport(image));
  await Promise.all(images.map(async (image) => {
    const sourceUrl = imageSourceUrls.get(image) || image.currentSrc || image.src || image.getAttribute('src') || '';
    if (!sourceUrl) return;
    await waitForImage(image);
    const dataUrl = await fetchFrameResourceAsDataUrl(sourceUrl, document);
    const previous = {
      src: image.getAttribute('src'),
      srcset: image.getAttribute('srcset'),
      sizes: image.getAttribute('sizes'),
    };
    restoreCallbacks.push(() => {
      if (previous.src === null) image.removeAttribute('src');
      else image.setAttribute('src', previous.src);
      if (previous.srcset === null) image.removeAttribute('srcset');
      else image.setAttribute('srcset', previous.srcset);
      if (previous.sizes === null) image.removeAttribute('sizes');
      else image.setAttribute('sizes', previous.sizes);
    });
    image.removeAttribute('srcset');
    image.removeAttribute('sizes');
    image.setAttribute('src', dataUrl || TRANSPARENT_IMAGE_PLACEHOLDER);
    await waitForImage(image);
  }));

  const elements = Array.from(document.querySelectorAll<HTMLElement>('*')).filter(isVisibleInViewport);
  await Promise.all(elements.map(async (element) => {
    const backgroundImage = view.getComputedStyle(element).backgroundImage;
    if (!backgroundImage || backgroundImage === 'none' || !backgroundImage.includes('url(')) return;
    const nextBackgroundImage = await inlineCssImageUrls(backgroundImage, document);
    if (nextBackgroundImage === backgroundImage) return;
    const previous = element.style.backgroundImage;
    restoreCallbacks.push(() => { element.style.backgroundImage = previous; });
    element.style.backgroundImage = nextBackgroundImage;
  }));

  return () => {
    for (let index = restoreCallbacks.length - 1; index >= 0; index -= 1) {
      try { restoreCallbacks[index]?.(); } catch { /* best-effort restore */ }
    }
  };
};
