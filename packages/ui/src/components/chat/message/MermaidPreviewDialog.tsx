import React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { SimpleMarkdownRenderer } from '../MarkdownRenderer';
import type { ToolPopupContent } from './types';
import {
  getMermaidDataUrlSourcePromise,
  isCurrentMermaidLoadRequest,
  isMermaidLoadFailure,
  nextMermaidLoadRequestId,
} from './toolOutputDialogMermaid';
import {
  MERMAID_ASPECT_MAX_RETRIES,
  MERMAID_ASPECT_RETRY_DELAY_MS,
  MERMAID_CONTROLS,
  MERMAID_DIALOG_HEADER_HEIGHT,
  getPreviewViewportBounds,
  getSvgAspectRatio,
  mermaidLoadFailure,
  usePreviewOverlayState,
  usePreviewViewport,
} from './previewDialogHelpers';

export const MermaidPreviewDialog: React.FC<{
  popup: ToolPopupContent;
  onOpenChange: (open: boolean) => void;
  isMobile: boolean;
}> = ({ popup, onOpenChange, isMobile }) => {
  const [source, setSource] = React.useState<string>(popup.mermaid?.source || '');
  const [status, setStatus] = React.useState<'idle' | 'loading' | 'ready' | 'error'>(
    popup.mermaid?.source ? 'ready' : 'idle',
  );
  const [errorMessage, setErrorMessage] = React.useState<string>('');
  const { isRendered, isVisible, isTransitioning } = usePreviewOverlayState(popup.open);
  const [diagramAspectRatio, setDiagramAspectRatio] = React.useState<number | null>(null);
  const viewport = usePreviewViewport(popup.open);
  const requestIdRef = React.useRef(0);
  const mermaidPreviewRef = React.useRef<HTMLDivElement | null>(null);

  const normalizeFilePath = React.useCallback((rawPath: string): string | null => {
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
        return Number.isFinite(codePoint) ? String.fromCharCode(codePoint) : `%${hex}`;
      });
    };

    const canParse = typeof URL.canParse === 'function' ? URL.canParse(input) : false;

    if (canParse) {
      let pathname = decodeLoose(new URL(input).pathname || '');
      if (/^\/[A-Za-z]:\//.test(pathname)) {
        pathname = pathname.slice(1);
      }
      return isSafeLocalPath(pathname) ? pathname : null;
    }

    const stripped = input.replace(/^file:\/\//i, '');
    const decoded = decodeLoose(stripped);
    return isSafeLocalPath(decoded) ? decoded : isSafeLocalPath(stripped) ? stripped : null;
  }, []);

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
        sourcePromise = Promise.reject(mermaidLoadFailure('The local Mermaid file path is invalid.'));
      } else {
        sourcePromise = runtimeFetch('/api/fs/raw', {
          query: { path: normalizedPath },
        }).then((response) => {
          if (!response.ok) {
            return Promise.reject(
              mermaidLoadFailure(`Unable to read Mermaid file. Status: ${response.status}.`),
            );
          }
          return response.text();
        });
      }
    } else {
      const canParse =
        typeof URL.canParse === 'function' ? URL.canParse(target.url, window.location.origin) : false;
      const resolvedUrl = canParse ? new URL(target.url, window.location.origin) : null;

      if (!resolvedUrl || (resolvedUrl.protocol !== 'http:' && resolvedUrl.protocol !== 'https:')) {
        sourcePromise = Promise.reject(mermaidLoadFailure('The Mermaid URL protocol is unsupported.'));
      } else {
        sourcePromise = fetch(resolvedUrl.toString()).then((response) => {
          if (!response.ok) {
            return Promise.reject(
              mermaidLoadFailure(`Unable to load Mermaid diagram. Status: ${response.status}.`),
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
          isMermaidLoadFailure(error) ? error.message : 'Unable to load Mermaid diagram.',
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
    const availableDiagramHeight = Math.max(160, maxHeight - MERMAID_DIALOG_HEADER_HEIGHT);

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
        popup.open ? 'pointer-events-auto' : 'pointer-events-none',
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          'absolute inset-0',
          isTransitioning && 'transition-opacity duration-150 ease-out',
          isVisible ? 'opacity-100' : 'opacity-0',
        )}
        style={{
          backgroundColor: 'color-mix(in srgb, var(--surface-background) 70%, transparent)',
        }}
        onMouseDown={() => onOpenChange(false)}
      />

      <div
        className={cn(
          'absolute inset-0 flex items-center justify-center pointer-events-none',
          isMobile ? 'p-2.5' : 'p-4',
        )}
      >
        <div
          className={cn(
            'pointer-events-auto flex flex-col gap-2',
            isTransitioning && 'transition-opacity duration-150 ease-out',
            isVisible ? 'opacity-100' : 'opacity-0',
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
          <div className="relative overflow-hidden" style={{ height: `${dialogSize.height}px` }}>
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
                  <p className="typography-markdown" style={{ color: 'var(--status-error)' }}>
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
