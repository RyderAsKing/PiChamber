import React from 'react';

import { cn } from '@/lib/utils';
import { FileChangeMark } from './FileChangeMark';
import { fileChangeTextClass, type FileStatus } from './fileChange';

interface FilePathBarProps {
  /** Workspace-relative path of the open file. */
  path: string;
  /** The file's git change, if any. */
  status?: FileStatus | null;
  className?: string;
  /** Opens the file's diff; offered only when it has a git change. */
  onShowChanges?: () => void;
  /** Editor controls, right-aligned. */
  children?: React.ReactNode;
}

/**
 * The row above an open file: its folder, name, and git change, with the
 * editor controls on the right. A long folder path gives way first, from the
 * left, so the file name stays readable.
 */
export const FilePathBar: React.FC<FilePathBarProps> = ({ path, status, className, onShowChanges, children }) => {
  const slash = path.lastIndexOf('/');
  const folder = slash >= 0 ? path.slice(0, slash + 1) : '';
  const name = slash >= 0 ? path.slice(slash + 1) : path;

  return (
    <div className={cn('flex h-9 min-w-0 shrink-0 items-center gap-2 pl-3 pr-1', className)}>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 typography-meta" title={path}>
        <span className="flex min-w-0 items-baseline">
          {folder ? (
            // rtl clips the start of the folder path instead of its end; bdi
            // keeps the slashes in order.
            <span className="min-w-0 shrink-[100] truncate text-muted-foreground [direction:rtl] [text-align:left]">
              <bdi>{folder}</bdi>
            </span>
          ) : null}
          <span className={cn('min-w-0 truncate font-medium text-foreground', fileChangeTextClass(status))}>{name}</span>
        </span>
        {status && status !== 'open' ? <FileChangeMark status={status} /> : null}
      </div>
      {onShowChanges && status && status !== 'open' ? (
        <button
          type="button"
          onClick={onShowChanges}
          className="shrink-0 rounded-md px-1.5 py-0.5 typography-meta text-muted-foreground transition-colors hover:bg-interactive-hover/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--interactive-focus-ring)]"
          title={"Show this file's changes"}
        >
          {"Changes"}
        </button>
      ) : null}
      {children ? <div className="flex shrink-0 items-center gap-0.5">{children}</div> : null}
    </div>
  );
};
