import type { GitDiffSource } from '@/lib/api/types';
import { isStagedOnlyStatusFile, isStagedStatusFile, isWorkingStatusFile, type GitStatusFile } from '../git/gitStatusPredicates';
import type { DiffScope } from './diffTypes';

export interface FileDiffSelection {
  /** Which change set to load for the file. */
  source: GitDiffSource;
  /** Whether the file actions act on the index (unstage) instead of the working tree. */
  staged: boolean;
}

export interface FocusedDiffFile {
  path: string | null;
  staged: boolean;
}

export function getFileDiffSelection(
  scope: DiffScope,
  file: GitStatusFile,
  focused: FocusedDiffFile,
): FileDiffSelection {
  if (scope === 'staged') {
    return { source: 'staged', staged: true };
  }
  if (scope === 'working') {
    return { source: 'unstaged', staged: false };
  }
  const focusedStaged = focused.staged && file.path === focused.path;
  return { source: 'head', staged: focusedStaged || isStagedOnlyStatusFile(file) };
}

/**
 * In the All scope a file's diff mixes staged and unstaged edits, so its
 * actions name which it is. The single-change-set scopes already say so.
 */
export function getFileStageLabel(scope: DiffScope, file: GitStatusFile): string | null {
  if (scope !== 'all') return null;
  if (isStagedOnlyStatusFile(file)) return 'Staged';
  if (isStagedStatusFile(file) && isWorkingStatusFile(file)) return 'Partly staged';
  return 'Not staged';
}
