import type { GitStatusFile } from './gitStatusPredicates';

export type GitChangeDescriptor = {
  code: string;
  color: string;
  description: string;
};

const CHANGE_DESCRIPTORS: Record<string, GitChangeDescriptor> = {
  '?': { code: '?', color: 'var(--status-info)', description: 'Untracked file' },
  A: { code: 'A', color: 'var(--status-success)', description: 'New file' },
  D: { code: 'D', color: 'var(--status-error)', description: 'Deleted file' },
  R: { code: 'R', color: 'var(--status-info)', description: 'Renamed file' },
  C: { code: 'C', color: 'var(--status-info)', description: 'Copied file' },
  M: { code: 'M', color: 'var(--status-warning)', description: 'Modified file' },
};

export function describeGitChange(file: GitStatusFile): GitChangeDescriptor {
  const index = file.index?.trim();
  const working = file.working_dir?.trim();
  const symbol = index && index !== '?'
    ? index.charAt(0)
    : working?.charAt(0) || index?.charAt(0) || 'M';
  return CHANGE_DESCRIPTORS[symbol] ?? CHANGE_DESCRIPTORS.M;
}
