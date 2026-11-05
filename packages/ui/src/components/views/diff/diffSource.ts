import type { GitDiffSource } from '@/lib/api/types';
import { isStagedOnlyStatusFile, type GitStatusFile } from '../git/gitStatusPredicates';
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
