import React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import type { ToolPopupContent } from './types';
import { usePreviewOverlayState, usePreviewViewport } from './previewDialogHelpers';

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
            item,
          ): item is {
            url: string;
            mimeType?: string;
            filename?: string;
            size?: number;
          } => Boolean(item?.url),
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
  const { isRendered, isVisible, isTransitioning } = usePreviewOverlayState(popup.open);
  const viewport = usePreviewViewport(popup.open);

  React.useEffect(() => {
    if (!popup.open || gallery.length === 0) {
      return;
    }

    const requestedIndex = typeof popup.image?.index === 'number' ? popup.image.index : -1;
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

      <div className="absolute inset-0 flex items-center justify-center p-4 pointer-events-none">
        <div
          className={cn(
            'pointer-events-auto flex flex-col gap-2',
            isTransitioning && 'transition-opacity duration-150 ease-out',
            isVisible ? 'opacity-100' : 'opacity-0',
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
                  if (previous && previous.width === width && previous.height === height) {
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
