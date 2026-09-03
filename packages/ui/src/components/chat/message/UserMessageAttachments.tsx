import React, { memo, useState, useRef, useMemo, useCallback } from 'react';
import { Popover } from '@base-ui/react/popover';
import { AttachmentPreviewTooltipContent, attachmentPreviewTooltipContentClassName } from '../AttachmentPreviewTooltip';
import { Icon } from '@/components/icon/Icon';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { changedFilesPopoverClassName, changedFilesPopoverStyle } from '../changedFilesPopover';
import { cn } from '@/lib/utils';
import { openExternalUrl } from '@/lib/url';
import { isDrawioFile } from '@/lib/toolHelpers';
import { useUIStore } from '@/stores/useUIStore';
import type { ToolPopupContent } from './types';

export interface MessageFilePart {
  [key: string]: unknown;
  id: string;
  type: string;
  mime?: string;
  url?: string;
  filename?: string;
  size?: number;
  source?: Record<string, unknown>;
}

const GITHUB_ISSUE_LINK_MIME = 'application/vnd.github.issue-link';
const GITHUB_PR_LINK_MIME = 'application/vnd.github.pull-request-link';

const getGitHubLinkKind = (file: MessageFilePart): 'issue' | 'pr' | null => {
  if (file.mime === GITHUB_ISSUE_LINK_MIME) return 'issue';
  if (file.mime === GITHUB_PR_LINK_MIME) return 'pr';
  return null;
};

const formatFileSize = (bytes?: number): string => {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const getFileExtension = (filename: string): string => {
  const parts = filename.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
};

const extractFilename = (path?: string): string => {
  if (!path) return 'Unnamed file';
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || path;
};

const resolveDisplayName = (file: MessageFilePart): string => {
  const isGitHubLink = getGitHubLinkKind(file) !== null;
  if (isGitHubLink && typeof file.filename === 'string' && file.filename.trim().length > 0) {
    return file.filename.trim();
  }
  return extractFilename(file.filename || file.url);
};

interface UserMessageAttachmentsProps {
  files: MessageFilePart[];
  onShowPopup?: (content: ToolPopupContent) => void;
  className?: string;
}

export const UserMessageAttachments = memo(({
  files,
  onShowPopup,
  className,
}: UserMessageAttachmentsProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const fileItems = useMemo(
    () => files.filter((f) => f.type === 'file' && (f.filename || f.mime || f.url)),
    [files],
  );

  const count = fileItems.length;

  const syncPortalContainer = useCallback(() => {
    const container = triggerRef.current?.closest(
      '[data-slot="dialog-content"], [role="dialog"]',
    ) as HTMLElement | null;
    setPortalContainer(container || null);
  }, []);

  const handleNavigateToDiagram = useCallback((path: string) => {
    useUIStore.getState().navigateToDiagram(path);
    setIsOpen(false);
  }, []);

  if (count === 0) return null;

  const firstFile = fileItems[0];
  const firstFileName = resolveDisplayName(firstFile);
  const firstFileSize = formatFileSize(firstFile.size);
  const triggerLabel = count === 1
    ? `${firstFileName}${firstFileSize ? ` (${firstFileSize})` : ''}`
    : `${count} attachments`;

  return (
    <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Popover.Trigger
            render={
              <button
                ref={triggerRef}
                type="button"
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium',
                  'text-muted-foreground/80 hover:text-foreground transition-colors cursor-pointer select-none',
                  className,
                )}
                aria-label={`View ${count} attachment${count !== 1 ? 's' : ''}`}
                onPointerDownCapture={syncPortalContainer}
                onFocusCapture={syncPortalContainer}
              >
                <Icon name="attachment-2" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate max-w-[200px]">{triggerLabel}</span>
                <Icon
                  name={isOpen ? 'arrow-up-s' : 'arrow-down-s'}
                  className="h-3.5 w-3.5 shrink-0 opacity-60"
                />
              </button>
            }
          />
        </TooltipTrigger>
        <TooltipContent side="top">
          {count === 1 ? `Attachment: ${firstFileName}` : `View ${count} attachments`}
        </TooltipContent>
      </Tooltip>

      <Popover.Portal container={portalContainer || undefined}>
        <Popover.Positioner side="top" align="end" sideOffset={6} collisionPadding={8}>
          <Popover.Popup
            style={changedFilesPopoverStyle}
            className={cn(
              changedFilesPopoverClassName,
              'w-84 max-h-96 overflow-y-auto p-3 space-y-3 transition-all duration-150 ease-out scrollbar-thin',
              'data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95',
            )}
          >
            <div className="flex items-center justify-between border-b border-border/30 pb-2">
              <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                <Icon name="attachment-2" className="h-3.5 w-3.5 text-muted-foreground" />
                Attachments ({count})
              </span>
            </div>

            <div className="space-y-3 divide-y divide-border/20">
              {fileItems.map((file, index) => {
                const listKey = file.url || `${resolveDisplayName(file)}-${index}`;
                return (
                  <AttachmentRow
                    key={listKey}
                    file={file}
                    onShowPopup={onShowPopup}
                    onNavigateToDiagram={handleNavigateToDiagram}
                  />
                );
              })}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
});

const AttachmentRow = memo(function AttachmentRow({
  file,
  onShowPopup,
  onNavigateToDiagram,
}: {
  file: MessageFilePart;
  onShowPopup?: UserMessageAttachmentsProps['onShowPopup'];
  onNavigateToDiagram: (path: string) => void;
}) {
  // The preview image mounts only while the shared tooltip is open, so
  // opening the list never decodes attachment bytes. The tooltip is
  // uncontrolled: previewing one file re-renders nothing in React.
  const fileName = resolveDisplayName(file);
  const ext = getFileExtension(fileName);
  const sizeText = formatFileSize(file.size);
  const isImage = file.mime?.startsWith('image/');
  const canPreview = Boolean(isImage && file.url);
  const githubLinkKind = getGitHubLinkKind(file);

  const source = file.source;
  const sourceType = typeof source?.type === 'string' ? source.type : undefined;
  const sourcePath = source && typeof (source as Record<string, unknown>).path === 'string'
    ? (source as Record<string, unknown>).path as string
    : undefined;
  const filePath = sourceType === 'file' && sourcePath ? sourcePath : (file.url || '');
  const isDrawio = filePath && isDrawioFile(filePath);

  const openPreviewDialog = useCallback(() => {
    if (onShowPopup && file.url) {
      onShowPopup({
        open: true,
        title: fileName,
        content: '',
        image: {
          url: file.url,
          mimeType: file.mime,
          filename: fileName,
          size: file.size,
        },
      });
    }
  }, [onShowPopup, file.url, file.mime, file.size, fileName]);
  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPreviewDialog();
    }
  }, [openPreviewDialog]);

  const rowBody = (
    <div className="flex items-start gap-2.5">
      <FileTypeIcon
        filePath={fileName}
        extension={ext}
        className="size-5 shrink-0 mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground truncate" title={fileName}>
          {fileName}
        </p>
        <p className="text-[11px] text-muted-foreground truncate">
          {[ext.toUpperCase() || 'FILE', file.mime, sizeText].filter(Boolean).join(' · ')}
        </p>
      </div>

      {githubLinkKind && file.url ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void openExternalUrl(file.url || '');
          }}
          className="shrink-0 p-1 text-muted-foreground hover:text-foreground rounded hover:bg-muted/40 transition-colors"
          title="Open on GitHub"
          aria-label="Open on GitHub"
        >
          <Icon name="github" className="h-4 w-4" />
        </button>
      ) : isDrawio ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onNavigateToDiagram(filePath);
          }}
          className="shrink-0 p-1 text-muted-foreground hover:text-foreground rounded hover:bg-muted/40 transition-colors"
          title="Open in diagram view"
          aria-label="Open in diagram view"
        >
          <Icon name="external-link" className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );

  if (!canPreview || !file.url) {
    return (
      <div className="pt-3 first:pt-0 space-y-2">
        {rowBody}
      </div>
    );
  }

  const previewUrl = file.url;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          aria-label={`Preview ${fileName}`}
          onClick={openPreviewDialog}
          onKeyDown={handleKeyDown}
          className="pt-3 first:pt-0 space-y-2 cursor-pointer rounded-lg"
        >
          {rowBody}
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="left"
        className={cn(attachmentPreviewTooltipContentClassName)}
      >
        <AttachmentPreviewTooltipContent
          imageUrl={previewUrl}
          filename={fileName}
          metaLine={[ext.toUpperCase(), sizeText].filter(Boolean).join(' · ')}
        />
      </TooltipContent>
    </Tooltip>
  );
});

UserMessageAttachments.displayName = 'UserMessageAttachments';
