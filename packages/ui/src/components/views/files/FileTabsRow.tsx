import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { ScrollingFileName } from './FilesViewChrome';
import { getDisplayPath, type FileNode } from './filesViewModel';

export interface FileTabsRowProps {
  showEditorTabsRow: boolean;
  isMobile: boolean;
  showMobilePageContent: boolean;
  onBackMobile: () => void;
  selectedFile: FileNode | null;
  openFiles: FileNode[];
  root: string;
  alwaysShowActions: boolean;
  editorTabsOverflow: { left: boolean; right: boolean };
  editorTabsScrollRef: React.RefObject<HTMLDivElement | null>;
  onSelectFile: (file: FileNode) => void;
  onCloseFile: (path: string) => void;
}

export const FileTabsRow: React.FC<FileTabsRowProps> = ({
  showEditorTabsRow,
  isMobile,
  showMobilePageContent,
  onBackMobile,
  selectedFile,
  openFiles,
  root,
  alwaysShowActions,
  editorTabsOverflow,
  editorTabsScrollRef,
  onSelectFile,
  onCloseFile,
}) => {
  if (!showEditorTabsRow) return null;

  return (
    <div className="flex min-w-0 items-center px-3 py-1.5">
      {isMobile && showMobilePageContent && (
        <button
          type="button"
          onClick={onBackMobile}
          aria-label="Back"
          className="inline-flex size-7 flex-shrink-0 items-center justify-center mr-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Icon name="arrow-left-s" className="size-5" />
        </button>
      )}

      {isMobile ? (
        selectedFile ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex min-w-0 max-w-full items-center gap-1 text-left typography-ui-label font-medium"
                aria-label="Open files"
              >
                <FileTypeIcon
                  filePath={selectedFile.path}
                  extension={selectedFile.extension}
                  className="size-3.5 flex-shrink-0"
                />
                <ScrollingFileName name={selectedFile.name} />
                <Icon name="arrow-down-s" className="size-4 flex-shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-[min(24rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)]"
            >
              {openFiles.map((file) => {
                const isActive = selectedFile?.path === file.path;
                return (
                  <DropdownMenuItem
                    key={file.path}
                    onSelect={(event) => {
                      const target = event.target as HTMLElement;
                      if (target.closest('[data-close-open-file]')) {
                        event.preventDefault();
                        return;
                      }
                      if (!isActive) {
                        void onSelectFile(file);
                      }
                    }}
                    className={cn(
                      'flex min-w-0 items-center justify-between gap-2 overflow-hidden',
                      isActive &&
                        'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]',
                    )}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                      <FileTypeIcon
                        filePath={file.path}
                        extension={file.extension}
                        className="size-3.5 flex-shrink-0"
                      />
                      <ScrollingFileName name={file.name} />
                    </span>
                    <button
                      type="button"
                      data-close-open-file
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onCloseFile(file.path);
                      }}
                      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--surface-muted-foreground)] hover:text-[var(--surface-foreground)]"
                      aria-label={`Close ${file.name}`}
                    >
                      <Icon name="close" className="size-3.5" />
                    </button>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <div className="typography-ui-label font-medium truncate">Select a file</div>
        )
      ) : openFiles.length > 0 ? (
        <div className="relative min-w-0 flex-1">
          {editorTabsOverflow.left && (
            <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-6 z-10 bg-gradient-to-r from-background to-transparent" />
          )}
          {editorTabsOverflow.right && (
            <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-6 z-10 bg-gradient-to-l from-background to-transparent" />
          )}
          <div
            ref={editorTabsScrollRef}
            className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-none"
            style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
            data-no-drawer-swipe="true"
          >
            {openFiles.map((file) => {
              const isActive = selectedFile?.path === file.path;
              return (
                <div
                  key={file.path}
                  title={getDisplayPath(root, file.path)}
                  className={cn(
                    'group inline-flex items-center gap-1 rounded-md border px-2 py-1 typography-ui-label transition-colors whitespace-nowrap',
                    isActive
                      ? 'bg-[var(--interactive-selection)] border-[var(--primary-muted)] text-[var(--interactive-selection-foreground)]'
                      : 'bg-transparent border-[var(--interactive-border)] text-[var(--surface-muted-foreground)] hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]',
                  )}
                >
                  <FileTypeIcon
                    filePath={file.path}
                    extension={file.extension}
                    className="size-3.5 flex-shrink-0"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (!isActive) {
                        void onSelectFile(file);
                      }
                    }}
                    className="max-w-[12rem] truncate text-left"
                  >
                    {file.name}
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onCloseFile(file.path);
                    }}
                    className={cn(
                      'rounded-sm p-0.5 text-[var(--surface-muted-foreground)] hover:text-[var(--surface-foreground)]',
                      !isActive && !alwaysShowActions && 'opacity-0 group-hover:opacity-100',
                    )}
                    aria-label={`Close ${file.name}`}
                  >
                    <Icon name="close" className="size-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="typography-ui-label font-medium truncate">Select a file</div>
      )}
    </div>
  );
};
