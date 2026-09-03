import React from 'react';

import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { cn } from '@/lib/utils';
import { describeGitChange } from '../git/gitChangeDescriptors';
import { formatDiffTotals } from './diffFormatters';
import type { FileEntry } from './diffTypes';

export interface FileListProps {
  changedFiles: FileEntry[];
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
}

export const FileList = React.memo<FileListProps>(function FileList({
  changedFiles,
  selectedFile,
  onSelectFile,
}) {
  if (changedFiles.length === 0) return null;

  return (
    <ScrollableOverlay outerClassName="flex-1 min-h-0" className="px-2 py-2">
      <ul className="flex flex-col gap-1">
        {changedFiles.map((file) => {
          const descriptor = describeGitChange(file);
          const isActive = selectedFile === file.path;

          return (
            <li key={file.path}>
              <button
                type="button"
                onClick={() => onSelectFile(file.path)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                  isActive
                    ? 'bg-interactive-selection text-interactive-selection-foreground'
                    : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground'
                )}
              >
                <FileTypeIcon filePath={file.path} className="h-3.5 w-3.5 flex-shrink-0" />
                <span
                  className="typography-micro font-semibold w-4 text-center uppercase"
                  style={{ color: descriptor.color }}
                  title={descriptor.description}
                  aria-label={descriptor.description}
                >
                  {descriptor.code}
                </span>
                <span
                  className="min-w-0 flex-1 truncate typography-meta"
                  style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}
                  title={file.path}
                >
                  {file.path}
                </span>
                {formatDiffTotals(file.insertions, file.deletions)}
              </button>
            </li>
          );
        })}
      </ul>
    </ScrollableOverlay>
  );
});
