import React from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { FileChangeMark } from './FileChangeMark';
import type { FileStatus } from './fileChange';

interface FilePathBarProps {
  /** Workspace-relative path of the open file. */
  path: string;
  /** The file's git change, if any. */
  status?: FileStatus | null;
  className?: string;
  /** Name of the workspace folder, shown as the first step of the path. */
  rootLabel?: string;
  /**
   * Shows a folder of the path in the tree; called with its workspace-relative
   * path ('' for the workspace itself). Without it the path is plain text.
   */
  onRevealFolder?: (relativeFolder: string) => void;
  /** Opens the file's diff; offered only when it has a git change. */
  onShowChanges?: () => void;
  /** Editor controls, right-aligned. */
  children?: React.ReactNode;
}

const crumbClassName =
  'min-w-0 truncate rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50';

/**
 * The row above an open file: where it lives, its name, and its git change,
 * with the editor controls on the right. With `onRevealFolder` each folder in
 * the path is a step back to that folder in the tree. A long path gives way
 * from its middle folders first, so the workspace and file names stay readable.
 */
export const FilePathBar: React.FC<FilePathBarProps> = ({
  path,
  status,
  className,
  rootLabel,
  onRevealFolder,
  onShowChanges,
  children,
}) => {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop() ?? path;

  const separator = <span aria-hidden="true" className="shrink-0 text-subtle-foreground">/</span>;

  return (
    <div className={cn('flex h-9 min-w-0 shrink-0 items-center gap-2 pl-2 pr-1', className)}>
      <nav aria-label={'File path'} className="flex min-w-0 flex-1 items-center gap-1.5 typography-meta" title={path}>
        <span className="flex min-w-0 items-center">
          {onRevealFolder ? (
            <>
              {rootLabel ? (
                <>
                  <button type="button" className={cn(crumbClassName, 'max-w-[10rem] shrink')} onClick={() => onRevealFolder('')} title={`Show ${rootLabel} in the tree`}>
                    {rootLabel}
                  </button>
                  {separator}
                </>
              ) : null}
              {parts.map((part, index) => {
                const folder = parts.slice(0, index + 1).join('/');
                return (
                  <React.Fragment key={folder}>
                    <button
                      type="button"
                      className={cn(crumbClassName, 'shrink-[100]')}
                      onClick={() => onRevealFolder(folder)}
                      title={`Show ${folder} in the tree`}
                    >
                      {part}
                    </button>
                    {separator}
                  </React.Fragment>
                );
              })}
            </>
          ) : parts.length > 0 ? (
            // rtl clips the start of the folder path instead of its end; bdi
            // keeps the slashes in order.
            <span className="min-w-0 shrink-[100] truncate pl-1 text-muted-foreground [direction:rtl] [text-align:left]">
              <bdi>{`${parts.join('/')}/`}</bdi>
            </span>
          ) : null}
          <span aria-current="page" className={cn('min-w-0 truncate font-medium text-foreground', onRevealFolder ? 'px-1' : parts.length === 0 && 'pl-1')}>
            {name}
          </span>
        </span>
        {status && status !== 'open' ? <FileChangeMark status={status} /> : null}
      </nav>
      {onShowChanges && status && status !== 'open' ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={onShowChanges}
          className="shrink-0"
          title={"Show this file's changes"}
        >
          {"Changes"}
        </Button>
      ) : null}
      {children ? <div className="flex shrink-0 items-center gap-0.5">{children}</div> : null}
    </div>
  );
};
