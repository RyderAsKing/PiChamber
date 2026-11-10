import React from 'react';

import { cn } from '@/lib/utils';

import { GIT_CHANGES, isGitChange, type FileStatus } from './fileChange';

/**
 * The letter git tools use for a change (M, A, D), colored by kind, so a
 * change reads without a legend. Files open in a tab with no change keep a
 * small dot; unsaved drafts a warning dot.
 */
export const FileChangeMark: React.FC<{ status: FileStatus; className?: string }> = ({ status, className }) => {
  if (isGitChange(status)) {
    const change = GIT_CHANGES[status];
    return (
      <span
        className={cn('w-3 shrink-0 text-center font-mono typography-micro font-semibold', change.textClass, className)}
        title={change.label}
        aria-label={change.label}
      >
        {change.letter}
      </span>
    );
  }
  const label = status === 'open' ? 'Open in a tab' : 'Unsaved changes';
  return (
    <span className={cn('flex w-3 shrink-0 justify-center', className)} title={label} aria-label={label}>
      <span
        className={cn(
          'size-1.5 rounded-full',
          status === 'open' ? 'bg-[var(--status-info)]' : 'bg-[var(--status-warning)]',
        )}
      />
    </span>
  );
};

/** A dot on folders that hold changed files; the tooltip gives the counts. */
export const FolderChangeMark: React.FC<{ badge: { modified: number; added: number }; className?: string }> = ({
  badge,
  className,
}) => {
  const parts = [
    badge.modified > 0 ? `${badge.modified} modified` : null,
    badge.added > 0 ? (badge.added === 1 ? '1 new file' : `${badge.added} new files`) : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  const label = parts.join(', ');
  return (
    <span className={cn('flex w-3 shrink-0 justify-center', className)} title={label} aria-label={label}>
      <span
        className={cn(
          'size-1.5 rounded-full',
          badge.modified > 0 ? 'bg-[var(--status-warning)]' : 'bg-[var(--status-success)]',
        )}
      />
    </span>
  );
};
