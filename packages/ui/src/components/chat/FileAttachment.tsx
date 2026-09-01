import React, { useRef, memo } from 'react';
import { useInputStore } from '@/sync/input-store';
import type { AttachedFile } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { openExternalUrl } from '@/lib/url';
import { isDrawioFile } from '@/lib/toolHelpers';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from "@/components/icon/Icon";
import { Button } from '@/components/ui/button';
import { useDeviceInfo } from '@/lib/device';

import type { ToolPopupContent } from './message/types';

const FileAttachmentButton = memo(() => {
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addAttachedFile = useInputStore((state) => state.addAttachedFile);
  const isMobile = useUIStore((state) => state.isMobile);
  const buttonSizeClass = isMobile ? 'h-9 w-9' : 'h-7 w-7';
  const iconSizeClass = isMobile ? 'h-5 w-5' : 'h-[18px] w-[18px]';

  const attachFiles = async (files: FileList | File[]) => {
    await Promise.all(Array.from(files).map(async (file) => {
      try {
        await addAttachedFile(file);
      } catch (error) {
        console.error('File attach failed', error);
        toast.error(error instanceof Error ? error.message : "Failed to attach file");
      }
    }));
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    await attachFiles(files);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileSelect}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              'flex items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              'hover:bg-muted text-muted-foreground',
              buttonSizeClass
            )}
            aria-label={"Attach files"}
          >
            <Icon name="attachment-2" className={iconSizeClass} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{"Attach files"}</p>
        </TooltipContent>
      </Tooltip>
    </>
  );
});

FileAttachmentButton.displayName = 'FileAttachmentButton';

const formatFileSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const getFileExtension = (filename: string): string => {
  const parts = filename.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
};

interface DraftAttachmentCardProps {
  file: AttachedFile;
  onRemove: () => void;
  onRetry: () => void;
  onShowPopup?: (content: ToolPopupContent) => void;
  gallery: NonNullable<ToolPopupContent['image']>['gallery'];
  galleryIndex: number;
}

const DraftAttachmentCard = memo(({
  file,
  onRemove,
  onRetry,
  onShowPopup,
  gallery,
  galleryIndex,
}: DraftAttachmentCardProps) => {
  const { isMobile, isTablet } = useDeviceInfo();
  const alwaysShowActions = isMobile || isTablet;
  const state = file.uploadState;
  const isExpired = state?.status === 'ready' && state.expiresAt <= Date.now();
  const isImage = file.mimeType.startsWith('image/');
  const imageUrl = isImage && file.previewUrl
    ? file.previewUrl
    : isImage && file.dataUrl.startsWith('data:image/')
      ? file.dataUrl
      : isImage ? file.serverPath || '' : '';
  const extension = getFileExtension(file.filename);
  const size = formatFileSize(file.size);
  const stateLabel = state?.status === 'preparing'
    ? 'Preparing attachment'
    : state?.status === 'uploading'
      ? 'Uploading attachment'
      : state?.status === 'failed' || isExpired
        ? 'Attachment upload failed'
        : state?.status === 'ready'
          ? 'Attachment ready'
          : 'Server attachment ready';
  const progress = state?.status === 'uploading' ? state.progress : null;
  const openPreview = () => {
    if (!onShowPopup || !imageUrl) return;
    onShowPopup({
      open: true,
      title: file.filename || 'Image',
      content: '',
      metadata: { tool: 'image-preview', filename: file.filename, mime: file.mimeType, size: file.size },
      image: {
        url: imageUrl,
        mimeType: file.mimeType,
        filename: file.filename,
        size: file.size,
        gallery,
        index: galleryIndex,
      },
    });
  };

  return (
    <article className={cn(
      'group relative flex-none overflow-hidden rounded-xl border bg-[var(--surface-elevated)]',
      isImage ? 'w-40' : 'w-56',
      state?.status === 'failed' || isExpired ? 'border-[var(--status-error)]' : 'border-border/60',
    )}>
      <span className="sr-only" aria-live="polite">{stateLabel}</span>
      {isImage ? (
        <div
          role={imageUrl && onShowPopup ? 'button' : undefined}
          tabIndex={imageUrl && onShowPopup ? 0 : undefined}
          onClick={openPreview}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              openPreview();
            }
          }}
          className="relative aspect-[8/5] bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-label={imageUrl ? `Preview ${file.filename}` : undefined}
        >
          {imageUrl ? (
            <img src={imageUrl} alt={file.filename} className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Icon name="file-image" className="size-7" />
            </div>
          )}
          {state?.status === 'uploading' || state?.status === 'preparing' ? (
            <div className="absolute inset-0 flex items-center justify-center bg-background/70 typography-meta text-foreground">
              {state.status === 'preparing' ? 'Preparing…' : progress === null ? 'Uploading…' : `${progress}%`}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex min-h-16 items-center gap-2 px-3 py-2 pr-8">
          <FileTypeIcon filePath={file.filename} extension={extension} className="size-6 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="truncate typography-ui-label text-foreground" title={file.filename}>{file.filename}</p>
            <p className="typography-meta text-muted-foreground">
              {[extension.toUpperCase(), size].filter(Boolean).join(' · ')}
            </p>
            {state?.status === 'preparing' ? <p className="typography-meta text-muted-foreground">Preparing…</p> : null}
            {state?.status === 'uploading' ? <p className="typography-meta text-muted-foreground">{progress === null ? 'Uploading…' : `Uploading ${progress}%`}</p> : null}
          </div>
        </div>
      )}

      {state?.status === 'uploading' && progress !== null ? (
        <div
          role="progressbar"
          aria-label={`Uploading ${file.filename}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          className="absolute inset-x-0 bottom-0 h-1 bg-muted"
        >
          <div className="h-full bg-primary" style={{ width: `${progress}%` }} />
        </div>
      ) : null}

      <Button
        variant="ghost"
        size="xs"
        onClick={onRemove}
        className={cn(
          'absolute right-1 top-1 size-6 px-0 bg-[var(--surface-elevated)]/90',
          alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
        )}
        aria-label={`Remove ${file.filename}`}
        title={`Remove ${file.filename}`}
      >
        <Icon name="close" className="size-3.5" />
      </Button>

      {state?.status === 'failed' || isExpired ? (
        <div className="flex items-start justify-between gap-2 border-t border-[var(--status-error)]/30 bg-[var(--status-error-background)] px-2 py-1.5">
          <p className="min-w-0 flex-1 typography-meta text-[var(--status-error-foreground)]" title={state?.status === 'failed' ? state.error : 'Upload expired.'}>{state?.status === 'failed' ? state.error : 'Upload expired.'}</p>
          <Button variant="outline" size="xs" onClick={onRetry}>Retry</Button>
        </div>
      ) : isImage ? (
        <div className="px-2 py-1.5">
          <p className="truncate typography-meta text-foreground" title={file.filename}>{file.filename}</p>
          {size ? <p className="typography-micro text-muted-foreground">{size}</p> : null}
        </div>
      ) : null}
    </article>
  );
});

DraftAttachmentCard.displayName = 'DraftAttachmentCard';

interface AttachedFilesListProps {
  onShowPopup?: (content: ToolPopupContent) => void;
}

export const AttachedFilesList = memo(({ onShowPopup }: AttachedFilesListProps) => {
  const attachedFiles = useInputStore((state) => state.attachedFiles);
  const removeAttachedFile = useInputStore((state) => state.removeAttachedFile);
  const retryAttachmentUpload = useInputStore((state) => state.retryAttachmentUpload);
  const [, setExpiryTick] = React.useState(0);

  React.useEffect(() => {
    const nextExpiry = attachedFiles.reduce<number | null>((nearest, file) => {
      if (file.uploadState?.status !== 'ready' || file.uploadState.expiresAt <= Date.now()) return nearest;
      return nearest === null ? file.uploadState.expiresAt : Math.min(nearest, file.uploadState.expiresAt);
    }, null);
    if (nextExpiry === null) return;
    const timer = setTimeout(() => setExpiryTick((value) => value + 1), Math.max(0, nextExpiry - Date.now() + 1));
    return () => clearTimeout(timer);
  }, [attachedFiles]);

  if (attachedFiles.length === 0) return null;

  const images = attachedFiles.filter((file) => file.mimeType.startsWith('image/'));
  const galleryEntries = images.flatMap((file) => {
    const url = file.previewUrl || file.dataUrl || file.serverPath || '';
    return url ? [{ file, image: { url, mimeType: file.mimeType, filename: file.filename, size: file.size } }] : [];
  });
  const imageGallery = galleryEntries.map((entry) => entry.image);
  const imageIndexById = new Map(galleryEntries.map((entry, index) => [entry.file.id, index]));

  return (
    <div className="w-full overflow-x-auto px-3 pb-2 pt-2 scrollbar-thin" data-no-drawer-swipe="true">
      <div className="flex w-max gap-2 sm:w-full sm:flex-wrap">
        {attachedFiles.map((file) => (
          <DraftAttachmentCard
            key={file.id}
            file={file}
            onRemove={() => removeAttachedFile(file.id)}
            onRetry={() => retryAttachmentUpload(file.id)}
            onShowPopup={onShowPopup}
            gallery={imageGallery}
            galleryIndex={imageIndexById.get(file.id) ?? 0}
          />
        ))}
      </div>
    </div>
  );
});

AttachedFilesList.displayName = 'AttachedFilesList';

interface FilePart {
  type: string;
  mime?: string;
  url?: string;
  filename?: string;
  size?: number;
  source?: Record<string, unknown>;
}

const GITHUB_ISSUE_LINK_MIME = 'application/vnd.github.issue-link';
const GITHUB_PR_LINK_MIME = 'application/vnd.github.pull-request-link';

const getGitHubLinkKind = (file: FilePart): 'issue' | 'pr' | null => {
  if (file.mime === GITHUB_ISSUE_LINK_MIME) {
    return 'issue';
  }
  if (file.mime === GITHUB_PR_LINK_MIME) {
    return 'pr';
  }
  return null;
};

interface MessageFilesDisplayProps {
  files: FilePart[];
  onShowPopup?: (content: ToolPopupContent) => void;
  compact?: boolean;
}

export const MessageFilesDisplay = memo(({ files, onShowPopup, compact = false }: MessageFilesDisplayProps) => {
  

  const fileItems = files.filter(f => f.type === 'file' && (f.mime || f.url));

  const extractFilename = (path?: string): string => {
    if (!path) return 'Unnamed file';

    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/');
    const filename = parts[parts.length - 1];

    return filename || path;
  };

  const resolveDisplayName = React.useCallback((file: FilePart): string => {
    const isGitHubLink = getGitHubLinkKind(file) !== null;
    if (isGitHubLink && typeof file.filename === 'string' && file.filename.trim().length > 0) {
      return file.filename.trim();
    }
    return extractFilename(file.filename || file.url);
  }, []);

  const formatFileSize = (bytes?: number) => {
    if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const imageFiles = fileItems.filter(f => f.mime?.startsWith('image/') && f.url);
  const otherFiles = fileItems.filter(f => !f.mime?.startsWith('image/'));

  const imageGallery = React.useMemo(
    () =>
      imageFiles.flatMap((file) => {
        if (!file.url) return [];
        const filename = resolveDisplayName(file) || 'Image';
        return [{
          url: file.url,
          mimeType: file.mime,
          filename,
          size: file.size,
        }];
      }),
    [imageFiles, resolveDisplayName]
  );

  const handleImageClick = React.useCallback((index: number) => {
    if (!onShowPopup) {
      return;
    }

    const file = imageGallery[index];
    if (!file?.url) return;

    const filename = file.filename || 'Image';

    onShowPopup({
      open: true,
      title: filename,
      content: '',
      metadata: {
        tool: 'image-preview',
        filename,
        mime: file.mimeType,
        size: file.size,
      },
      image: {
        url: file.url,
        mimeType: file.mimeType,
        filename,
        size: file.size,
        gallery: imageGallery,
        index,
      },
    });
  }, [imageGallery, onShowPopup]);

  if (fileItems.length === 0) return null;

  if (compact) {
    return (
      <div className="space-y-1.5 mt-1.5">
        {otherFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {otherFiles.map((file, index) => {
              const fileName = resolveDisplayName(file);
              const ext = fileName.split('.').pop() || '';
              const sizeText = formatFileSize(file.size);
              const githubLinkKind = getGitHubLinkKind(file);
              return (
                <Tooltip key={`file-${file.url || file.filename || index}`}>
                  <TooltipTrigger asChild>
                    {githubLinkKind && file.url ? (
                      <button
                        type="button"
                        onClick={() => {
                          void openExternalUrl(file.url || '');
                        }}
                        className="inline-flex items-center bg-muted/30 border border-border/30 typography-meta gap-1 px-2 py-0.5 rounded-lg text-foreground hover:text-primary transition-colors"
                      >
                        {githubLinkKind === 'pr' ? (
                          <Icon name="git-pull-request" className="text-muted-foreground h-3.5 w-3.5" />
                        ) : (
                          <Icon name="github" className="text-muted-foreground h-3.5 w-3.5" />
                        )}
                        <div className="overflow-hidden max-w-[220px]">
                          <span className="truncate block" title={fileName}>{fileName}</span>
                        </div>
                      </button>
                    ) : (
                      <div className="inline-flex items-center bg-muted/30 border border-border/30 typography-meta gap-1 px-2 py-0.5 rounded-lg">
                        {file.mime?.includes('pdf') ? (
                          <Icon name="file-pdf" className="text-muted-foreground h-3.5 w-3.5" />
                        ) : (
                          <FileTypeIcon filePath={fileName} extension={ext} className="text-muted-foreground h-3.5 w-3.5" />
                        )}
                        <div className="overflow-hidden max-w-[140px]">
                          <span className="truncate block" title={fileName}>{fileName}</span>
                        </div>
                      </div>
                    )}
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{fileName}{sizeText ? ` (${sizeText})` : ''}</p>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        )}

        {imageFiles.length > 0 && (
          <div className="overflow-x-auto -mx-1 px-1 py-0.5 scrollbar-thin" data-no-drawer-swipe="true">
            <div className="flex snap-x snap-mandatory gap-2">
              {imageFiles.map((file, index) => {
                const filename = resolveDisplayName(file) || 'Image';

                return (
                  <Tooltip key={`img-${file.url || file.filename || index}`}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => handleImageClick(index)}
                        className="relative flex-none border border-border/40 bg-muted/10 overflow-hidden snap-start h-12 w-12 sm:h-14 sm:w-14 md:h-16 md:w-16 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-primary"
                        aria-label={filename}
                      >
                        {file.url ? (
                          <img
                            src={file.url}
                            alt={filename}
                            className="h-full w-full object-cover"
                            loading="lazy"
                            onError={(e) => {
                              const target = e.target as HTMLImageElement;
                              target.style.visibility = 'hidden';
                            }}
                          />
                        ) : (
                          <div className="h-full w-full flex items-center justify-center bg-muted/30 text-muted-foreground">
                            <Icon name="file-image" className="h-6 w-6" />
                          </div>
                        )}
                        <span className="sr-only">{filename}</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6} className="typography-meta px-2 py-1">
                      {filename}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={cn(
      "grid gap-2",
      compact ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"
    )}>
      {fileItems.map((file, index) => {
        const fileName = resolveDisplayName(file);
        const isImage = file.mime?.startsWith('image/');
        const sizeText = formatFileSize(file.size);
        const githubLinkKind = getGitHubLinkKind(file);

        if (isImage && file.url) {
          return (
            <div
              key={file.url || `${fileName}-${index}`}
              className="relative aspect-video rounded-lg border border-border/40 bg-muted/10 overflow-hidden group"
            >
              <img
                src={file.url}
                alt={fileName}
                className="h-full w-full object-cover"
                loading="lazy"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="absolute bottom-0 left-0 right-0 p-2 text-white opacity-0 group-hover:opacity-100 transition-opacity">
                <p className="text-xs font-medium truncate">{fileName}</p>
                {sizeText && <p className="text-xs opacity-80">{sizeText}</p>}
              </div>
            </div>
          );
        }

        if (githubLinkKind && file.url) {
          return (
            <Tooltip key={file.url || `${fileName}-${index}`}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => {
                    void openExternalUrl(file.url || '');
                  }}
                  className={cn(
                    "flex items-center gap-2 p-2 rounded-lg border border-border/40 bg-muted/10 hover:bg-muted/20 transition-colors text-left",
                    compact ? "text-xs" : "text-sm"
                  )}
                >
                  <div className="flex-shrink-0">
                    {githubLinkKind === 'pr' ? (
                      <Icon name="git-pull-request" className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                    ) : (
                      <Icon name="github" className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{fileName}</p>
                    {sizeText && <p className="text-xs text-muted-foreground">{sizeText}</p>}
                  </div>
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{fileName}{sizeText ? ` (${sizeText})` : ''}</p>
              </TooltipContent>
            </Tooltip>
          );
        }

        const source = file.source;
        const sourceType = typeof source?.type === 'string' ? source.type : undefined;
        const sourcePath = source && typeof (source as Record<string, unknown>).path === 'string' ? (source as Record<string, unknown>).path as string : undefined;
        const filePath = sourceType === 'file' && sourcePath ? sourcePath : (file.url || '');
        const isDrawio = filePath && isDrawioFile(filePath);

        if (isDrawio) {
          return (
            <Tooltip key={file.url || `${fileName}-${index}`}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => {
                    useUIStore.getState().navigateToDiagram(filePath);
                  }}
                  className={cn(
                    "flex items-center gap-2 p-2 rounded-lg border border-border/40 bg-muted/10 hover:bg-muted/20 transition-colors text-left cursor-pointer",
                    compact ? "text-xs" : "text-sm"
                  )}
                >
                  <Icon name="file" className={cn("text-muted-foreground shrink-0", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{fileName}</p>
                    <p className="text-xs text-status-info">{"Open in diagram view"}</p>
                  </div>
                  <Icon name="external-link" className={cn("text-muted-foreground shrink-0", compact ? "h-3 w-3" : "h-3.5 w-3.5")} />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{"Open in diagram view"}</p>
              </TooltipContent>
            </Tooltip>
          );
        }

        return (
          <Tooltip key={file.url || `${fileName}-${index}`}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  if (onShowPopup && file.url) {
                    onShowPopup({
                      open: true,
                      title: fileName,
                      content: '',
                      image: {
                        url: file.url,
                        mimeType: file.mime,
                        filename: fileName,
                      },
                    });
                  }
                }}
                className={cn(
                  "flex items-center gap-2 p-2 rounded-lg border border-border/40 bg-muted/10 hover:bg-muted/20 transition-colors text-left",
                  compact ? "text-xs" : "text-sm"
                )}
              >
                <div className="flex-shrink-0">
                  {file.mime?.startsWith('image/') ? (
                    <Icon name="file-image" className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                  ) : file.mime?.includes('pdf') ? (
                    <Icon name="file-pdf" className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                  ) : (
                    <Icon name="file" className={cn("text-muted-foreground", compact ? "h-3.5 w-3.5" : "h-4 w-4")} />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{fileName}</p>
                  {sizeText && <p className="text-xs text-muted-foreground">{sizeText}</p>}
                </div>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{fileName}{sizeText ? ` (${sizeText})` : ''}</p>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
});

MessageFilesDisplay.displayName = 'MessageFilesDisplay';

interface ImageGalleryProps {
  urls: string[];
  caption?: string;
  onShowPopup?: (content: ToolPopupContent) => void;
}

const ImageGallery = memo(({ urls, caption, onShowPopup }: ImageGalleryProps) => {
  if (urls.length === 0) return null;

  const getGridCols = () => {
    if (urls.length === 1) return 'grid-cols-1';
    if (urls.length === 2) return 'grid-cols-2';
    if (urls.length <= 4) return 'grid-cols-2';
    return 'grid-cols-3';
  };

  return (
    <div className="space-y-2">
      <div className={cn("grid gap-2", getGridCols())}>
        {urls.map((url, index) => (
          <button
            key={url}
            type="button"
            onClick={() => onShowPopup?.({
              open: true,
              title: caption || `Image ${index + 1} of ${urls.length}`,
              content: '',
              image: {
                url,
                gallery: urls.map(u => ({ url: u })),
                index,
              },
            })}
            className="relative aspect-square rounded-lg border border-border/40 bg-muted/10 overflow-hidden group"
          >
            <img
              src={url}
              alt={caption || `Image ${index + 1}`}
              className="h-full w-full object-cover transition-transform group-hover:scale-105"
              loading="lazy"
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors" />
          </button>
        ))}
      </div>
      {caption && (
        <p className="text-sm text-muted-foreground italic">{caption}</p>
      )}
    </div>
  );
});

ImageGallery.displayName = 'ImageGallery';
