import React from 'react';

import { cn } from '@/lib/utils';
import { fileDiffFromPatch } from '@/lib/diff/patchFileDiff';
import type { DiffContextMode, DiffData } from './diffTypes';

export const isBinaryPatch = (patch: string): boolean =>
  /^Binary files .+ differ$/m.test(patch) || /^GIT binary patch$/m.test(patch);

export const createTextDiffDataFromPatch = (
  filePath: string,
  patch: string,
  contextMode: DiffContextMode
): DiffData => {
  if (isBinaryPatch(patch)) {
    return { original: '', modified: '', isBinary: true, patch, contextMode };
  }

  return {
    original: '',
    modified: '',
    patch,
    fileDiff: fileDiffFromPatch(filePath, patch),
    contextMode,
  };
};

export const formatDiffTotals = (
  insertions?: number,
  deletions?: number,
  options?: { shrink?: boolean; className?: string }
): React.ReactNode => {
  const added = insertions ?? 0;
  const removed = deletions ?? 0;
  if (!added && !removed) return null;
  return (
    <span
      className={cn(
        'typography-meta flex items-center gap-1 text-xs whitespace-nowrap',
        options?.shrink ? 'min-w-0 overflow-hidden' : 'flex-shrink-0',
        options?.className
      )}
    >
      {added ? <span style={{ color: 'var(--status-success)' }}>+{added}</span> : null}
      {removed ? <span style={{ color: 'var(--status-error)' }}>-{removed}</span> : null}
    </span>
  );
};
