import React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { SimpleMarkdownRenderer } from '../MarkdownRenderer';
import type { ToolPopupContent } from './types';
import {
  MermaidLoadFailure,
  getMermaidDataUrlSourcePromise,
  isCurrentMermaidLoadRequest,
  isMermaidLoadFailure,
  nextMermaidLoadRequestId,
} from './toolOutputDialogMermaid';

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
  isMobile: boolean
) => {
  const limits = isMobile
    ? PREVIEW_VIEWPORT_LIMITS.mobile
    : PREVIEW_VIEWPORT_LIMITS.desktop;
  const paddedWidth = Math.max(160, viewport.width - limits.padding * 2);
  const paddedHeight = Math.max(160, viewport.height - limits.padding * 2);

  return {
    maxWidth: Math.max(
      160,
      Math.min(paddedWidth, viewport.width * limits.widthRatio)
    ),
    maxHeight: Math.max(
      160,
      Math.min(paddedHeight, viewport.height * limits.heightRatio)
    ),
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
      if (
        Number.isFinite(width) &&
        Number.isFinite(height) &&
        width > 0 &&
        height > 0
      ) {
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

export const ImagePreviewDialog: React.FC<{
  popup: ToolPopupContent;
  onOpenChange: (open: boolean) => void;
  isMobile: boolean;
}> = ({ popup, onOpenChange, isMobile }) => {
  const gallery = React.useMemo(() => {
    const baseImage = popup.image;
    if (!baseImage)
      return [] as Array<{
        url: string;
        mimeType?: string;
        filename?: string;
        size?: number;
      }>;
    const fromPopup = Array.isArray(baseImage.gallery)
      ? baseImage.gallery.filter(
          (
            item
          ): item is {
            url: string;
            mimeType?: string;
            filename?: string;
            size?: number;
          } => Boolean(item?.url)
        )
      : [];

    if (fromPopup.length > 0) {
      return fromPopup;
    }

    return [
      {
        url: baseImage.url,
        mimeType: baseImage.mimeType,
        filename: baseImage.filename,
        size: baseImage.size,
      },
    ];
  }, [popup.image]);

  const [currentIndex, setCurrentIndex] = React.useState(0);
  const [imageNaturalSize, setImageNaturalSize] = React.useState<{
    width: number;
    height: number;
  } | null>(null);
  const { isRendered, isVisible, isTransitioning } = usePreviewOverlayState(
    popup.open
  );
  const viewport = usePreviewViewport(popup.open);

  React.useEffect(() => {
    if (!popup.open || gallery.length === 0) {
      return;
    }

    const requestedIndex =
      typeof popup.image?.index === 'number' ? popup.image.index : -1;
    if (requestedIndex >= 0 && requestedIndex < gallery.length) {
      setCurrentIndex(requestedIndex);
      return;
    }

    const matchingIndex = popup.image?.url
      ? gallery.findIndex((item) => item.url === popup.image?.url)
      : -1;
    setCurrentIndex(matchingIndex >= 0 ? matchingIndex : 0);
  }, [gallery, popup.image?.index, popup.image?.url, popup.open]);

  const currentImage = gallery[currentIndex] ?? gallery[0] ?? popup.image;
  const imageTitle = currentImage?.filename || popup.title || 'Image preview';
  const hasMultipleImages = gallery.length > 1;

  const showPrevious = React.useCallback(() => {
    if (gallery.length <= 1) return;
    setCurrentIndex((prev) => (prev - 1 + gallery.length) % gallery.length);
  }, [gallery.length]);

  const showNext = React.useCallback(() => {
    if (gallery.length <= 1) return;
    setCurrentIndex((prev) => (prev + 1) % gallery.length);
  }, [gallery.length]);

  React.useEffect(() => {
    if (!popup.open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onOpenChange(false);
        return;
      }

      if (event.key === 'ArrowLeft' && hasMultipleImages) {
        event.preventDefault();
        showPrevious();
        return;
      }

      if (event.key === 'ArrowRight' && hasMultipleImages) {
        event.preventDefault();
        showNext();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [hasMultipleImages, onOpenChange, popup.open, showNext, showPrevious]);

  React.useEffect(() => {
    setImageNaturalSize(null);
  }, [currentImage?.url]);

  const imageDisplaySize = React.useMemo(() => {
    const maxWidth = Math.max(160, viewport.width * (isMobile ? 0.86 : 0.75));
    const maxHeight = Math.max(160, viewport.height * (isMobile ? 0.72 : 0.75));

    if (!imageNaturalSize) {
      return {
        width: Math.round(maxWidth),
        height: Math.round(maxHeight),
      };
    }

    const widthScale = maxWidth / imageNaturalSize.width;
    const heightScale = maxHeight / imageNaturalSize.height;
    const scale = Math.min(widthScale, heightScale);

    return {
      width: Math.max(1, Math.round(imageNaturalSize.width * scale)),
      height: Math.max(1, Math.round(imageNaturalSize.height * scale)),
    };
  }, [imageNaturalSize, isMobile, viewport]);

  if (!isRendered || typeof document === 'undefined' || !currentImage?.url) {
    return null;
  }

  const content = (
    <div
      className={cn(
        'fixed inset-0 z-50',
        popup.open ? 'pointer-events-auto' : 'pointer-events-none'
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          'absolute inset-0',
          isTransitioning && 'transition-opacity duration-150 ease-out',
          isVisible ? 'opacity-100' : 'opacity-0'
        )}
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--surface-background) 70%, transparent)',
        }}
        onMouseDown={() => onOpenChange(false)}
      />

      <div className="absolute inset-0 flex items-center justify-center p-4 pointer-events-none">
        <div
          className={cn(
            'pointer-events-auto flex flex-col gap-2',
            isTransitioning && 'transition-opacity duration-150 ease-out',
            isVisible ? 'opacity-100' : 'opacity-0'
          )}
          style={{ width: `${imageDisplaySize.width}px` }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between text-xs text-muted-foreground typography-meta">
            <span className="truncate pr-2">{imageTitle}</span>
            {hasMultipleImages && (
              <span className="flex items-center gap-1 flex-shrink-0">
                <button
                  type="button"
                  className="p-1 rounded hover:bg-[var(--interactive-hover)]"
                  onClick={showPrevious}
                  aria-label="Previous image"
                >
                  <Icon name="arrow-left-s" className="h-3.5 w-3.5" />
                </button>
                <span>
                  {currentIndex + 1} / {gallery.length}
                </span>
                <button
                  type="button"
                  className="p-1 rounded hover:bg-[var(--interactive-hover)]"
                  onClick={showNext}
                  aria-label="Next image"
                >
                  <Icon name="arrow-right-s" className="h-3.5 w-3.5" />
                </button>
              </span>
            )}
            <button
              type="button"
              className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground/80 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/60"
              onClick={() => onOpenChange(false)}
              aria-label={'Close image preview'}
            >
              <Icon name="close" className="h-4 w-4" />
            </button>
          </div>

          <img
            src={currentImage.url}
            alt={imageTitle}
            className="block object-contain"
            style={{
              width: `${imageDisplaySize.width}px`,
              height: `${imageDisplaySize.height}px`,
            }}
            loading="lazy"
            onLoad={(event) => {
              const element = event.currentTarget;
              const width = element.naturalWidth;
              const height = element.naturalHeight;
              if (width > 0 && height > 0) {
                setImageNaturalSize((previous) => {
                  if (
                    previous &&
                    previous.width === width &&
                    previous.height === height
                  ) {
                    return previous;
                  }
                  return { width, height };
                });
              }
            }}
          />
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
};

export const MermaidPreviewDialog: React.FC<{
  popup: ToolPopupContent;
  onOpenChange: (open: boolean) => void;
  isMobile: boolean;
}> = ({ popup, onOpenChange, isMobile }) => {
  const [source, setSource] = React.useState<string>(popup.mermaid?.source || '');
  const [status, setStatus] = React.useState<
    'idle' | 'loading' | 'ready' | 'error'
  >(popup.mermaid?.source ? 'ready' : 'idle');
  const [errorMessage, setErrorMessage] = React.useState<string>('');
  const { isRendered, isVisible, isTransitioning } = usePreviewOverlayState(
    popup.open
  );
  const [diagramAspectRatio, setDiagramAspectRatio] = React.useState<
    number | null
  >(null);
  const viewport = usePreviewViewport(popup.open);
  const requestIdRef = React.useRef(0);
  const mermaidPreviewRef = React.useRef<HTMLDivElement | null>(null);

  const normalizeFilePath = React.useCallback(
    (rawPath: string): string | null => {
      const input = rawPath.trim();
      if (!input.toLowerCase().startsWith('file://')) {
        return null;
      }

      const isSafeLocalPath = (path: string): boolean => {
        if (!path || /[\0\r\n]/.test(path)) {
          return false;
        }

        const normalized = path.replace(/\\/g, '/');
        const segments = normalized.split('/').filter(Boolean);
        if (segments.includes('..')) {
          return false;
        }

        if (normalized.startsWith('/')) {
          return true;
        }

        return /^[A-Za-z]:\//.test(normalized);
      };

      const decodeLoose = (value: string): string => {
        return value.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) => {
          const codePoint = Number.parseInt(hex, 16);
          return Number.isFinite(codePoint)
            ? String.fromCharCode(codePoint)
            : `%${hex}`;
        });
      };

      const canParse =
        typeof URL.canParse === 'function' ? URL.canParse(input) : false;

      if (canParse) {
        let pathname = decodeLoose(new URL(input).pathname || '');
        if (/^\/[A-Za-z]:\//.test(pathname)) {
          pathname = pathname.slice(1);
        }
        return isSafeLocalPath(pathname) ? pathname : null;
      }

      const stripped = input.replace(/^file:\/\//i, '');
      const decoded = decodeLoose(stripped);
      return isSafeLocalPath(decoded)
        ? decoded
        : isSafeLocalPath(stripped)
        ? stripped
        : null;
    },
    []
  );

  const loadMermaidSource = React.useCallback(async () => {
    const target = popup.mermaid;
    const requestId = nextMermaidLoadRequestId(requestIdRef.current);
    requestIdRef.current = requestId;

    if (!target?.url) {
      setStatus('error');
      setErrorMessage('Missing Mermaid source URL.');
      return;
    }

    if (target.source) {
      setSource(target.source);
      setStatus('ready');
      setErrorMessage('');
      return;
    }

    setStatus('loading');
    setErrorMessage('');

    let sourcePromise: Promise<string>;
    if (target.url.startsWith('data:')) {
      sourcePromise = getMermaidDataUrlSourcePromise(target.url);
    } else if (target.url.toLowerCase().startsWith('file://')) {
      const normalizedPath = normalizeFilePath(target.url);
      if (!normalizedPath) {
        sourcePromise = Promise.reject(
          mermaidLoadFailure('The local Mermaid file path is invalid.')
        );
      } else {
        sourcePromise = runtimeFetch('/api/fs/raw', {
          query: { path: normalizedPath },
        }).then((response) => {
          if (!response.ok) {
            return Promise.reject(
              mermaidLoadFailure(
                `Unable to read Mermaid file. Status: ${response.status}.`
              )
            );
          }
          return response.text();
        });
      }
    } else {
      const canParse =
        typeof URL.canParse === 'function'
          ? URL.canParse(target.url, window.location.origin)
          : false;
      const resolvedUrl = canParse
        ? new URL(target.url, window.location.origin)
        : null;

      if (
        !resolvedUrl ||
        (resolvedUrl.protocol !== 'http:' && resolvedUrl.protocol !== 'https:')
      ) {
        sourcePromise = Promise.reject(
          mermaidLoadFailure('The Mermaid URL protocol is unsupported.')
        );
      } else {
        sourcePromise = fetch(resolvedUrl.toString()).then((response) => {
          if (!response.ok) {
            return Promise.reject(
              mermaidLoadFailure(
                `Unable to load Mermaid diagram. Status: ${response.status}.`
              )
            );
          }
          return response.text();
        });
      }
    }

    await sourcePromise
      .then((resolvedSource) => {
        if (!isCurrentMermaidLoadRequest(requestIdRef.current, requestId)) {
          return;
        }

        setSource(resolvedSource);
        setStatus('ready');
      })
      .catch((error) => {
        if (!isCurrentMermaidLoadRequest(requestIdRef.current, requestId)) {
          return;
        }
        setStatus('error');
        setErrorMessage(
          isMermaidLoadFailure(error)
            ? error.message
            : 'Unable to load Mermaid diagram.'
        );
      });
  }, [normalizeFilePath, popup.mermaid]);

  React.useEffect(() => {
    if (!popup.open || !popup.mermaid) {
      return;
    }
    void loadMermaidSource();
  }, [loadMermaidSource, popup.mermaid, popup.open]);

  React.useEffect(() => {
    if (!popup.open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onOpenChange(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onOpenChange, popup.open]);

  React.useEffect(() => {
    if (!popup.open || status !== 'ready') {
      setDiagramAspectRatio(null);
      return;
    }

    const measureAspectRatio = () => {
      const svg = mermaidPreviewRef.current?.querySelector('svg');
      if (!svg) {
        return false;
      }

      const aspectRatio = getSvgAspectRatio(svg as SVGElement);
      if (!aspectRatio || !Number.isFinite(aspectRatio) || aspectRatio <= 0) {
        return false;
      }

      setDiagramAspectRatio((previous) => {
        if (previous && Math.abs(previous - aspectRatio) < 0.001) {
          return previous;
        }
        return aspectRatio;
      });
      return true;
    };

    let rafId = window.requestAnimationFrame(() => {
      if (!measureAspectRatio()) {
        rafId = window.requestAnimationFrame(() => {
          measureAspectRatio();
        });
      }
    });

    let retryCount = 0;
    let timeoutId: number | undefined;
    const scheduleRetry = () => {
      if (retryCount >= MERMAID_ASPECT_MAX_RETRIES) {
        return;
      }

      timeoutId = window.setTimeout(() => {
        retryCount += 1;
        if (!measureAspectRatio()) {
          scheduleRetry();
        }
      }, MERMAID_ASPECT_RETRY_DELAY_MS);
    };
    scheduleRetry();

    const observer = new MutationObserver(() => {
      measureAspectRatio();
    });

    if (mermaidPreviewRef.current) {
      observer.observe(mermaidPreviewRef.current, {
        childList: true,
        subtree: true,
        attributes: true,
      });
    }

    return () => {
      window.cancelAnimationFrame(rafId);
      if (typeof timeoutId === 'number') {
        window.clearTimeout(timeoutId);
      }
      observer.disconnect();
    };
  }, [popup.open, source, status]);

  const mermaidMarkdown = `\`\`\`mermaid\n${source}\n\`\`\``;

  const dialogSize = React.useMemo(() => {
    const { maxWidth, maxHeight } = getPreviewViewportBounds(viewport, isMobile);
    const availableDiagramHeight = Math.max(
      160,
      maxHeight - MERMAID_DIALOG_HEADER_HEIGHT
    );

    if (diagramAspectRatio && diagramAspectRatio < 1) {
      const squareSide = Math.min(maxWidth, availableDiagramHeight);
      return { width: Math.round(squareSide), height: Math.round(squareSide) };
    }

    return {
      width: Math.round(maxWidth),
      height: Math.round(availableDiagramHeight),
    };
  }, [diagramAspectRatio, isMobile, viewport]);

  if (!isRendered || typeof document === 'undefined') {
    return null;
  }

  const content = (
    <div
      className={cn(
        'fixed inset-0 z-50',
        popup.open ? 'pointer-events-auto' : 'pointer-events-none'
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          'absolute inset-0',
          isTransitioning && 'transition-opacity duration-150 ease-out',
          isVisible ? 'opacity-100' : 'opacity-0'
        )}
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--surface-background) 70%, transparent)',
        }}
        onMouseDown={() => onOpenChange(false)}
      />

      <div
        className={cn(
          'absolute inset-0 flex items-center justify-center pointer-events-none',
          isMobile ? 'p-2.5' : 'p-4'
        )}
      >
        <div
          className={cn(
            'pointer-events-auto flex flex-col gap-2',
            isTransitioning && 'transition-opacity duration-150 ease-out',
            isVisible ? 'opacity-100' : 'opacity-0'
          )}
          style={{ width: `${dialogSize.width}px` }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-end">
            <button
              type="button"
              className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground/80 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary/60"
              onClick={() => onOpenChange(false)}
              aria-label={'Close diagram preview'}
            >
              <Icon name="close" className="h-4 w-4" />
            </button>
          </div>
          <div
            className="relative overflow-hidden"
            style={{ height: `${dialogSize.height}px` }}
          >
            <div className="h-full overflow-hidden">
              {status === 'loading' && (
                <div className="h-full min-h-28 flex items-center justify-center gap-2 text-muted-foreground typography-meta">
                  <Icon name="loader-4" className="h-4 w-4 animate-spin" />
                  <span>{'Loading diagram...'}</span>
                </div>
              )}

              {status === 'error' && (
                <div
                  className="rounded-xl border p-3 space-y-3"
                  style={{
                    backgroundColor: 'var(--status-error-background)',
                    borderColor: 'var(--status-error-border)',
                  }}
                >
                  <p
                    className="typography-markdown"
                    style={{ color: 'var(--status-error)' }}
                  >
                    {errorMessage || 'Unable to render Mermaid diagram.'}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      void loadMermaidSource();
                    }}
                    className="px-3 py-1.5 rounded-lg typography-meta border transition-colors hover:bg-[var(--interactive-hover)]"
                    style={{
                      borderColor: 'var(--interactive-border)',
                      color: 'var(--surface-foreground)',
                    }}
                  >
                    {'Retry'}
                  </button>
                </div>
              )}

              {status === 'ready' && (
                <div ref={mermaidPreviewRef} className="h-full">
                  <SimpleMarkdownRenderer
                    content={mermaidMarkdown}
                    variant="tool"
                    allowMermaidWheelEvents
                    className="markdown-mermaid-fullscreen h-full"
                    mermaidControls={MERMAID_CONTROLS}
                    enableFileReferences={false}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
};
