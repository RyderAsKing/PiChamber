/** Tree and path-bar status: a git change, or (for files without one) open in a tab. */
export type FileStatus = 'open' | 'modified' | 'git-modified' | 'git-added' | 'git-deleted';

type GitChange = Extract<FileStatus, 'git-modified' | 'git-added' | 'git-deleted'>;

export const GIT_CHANGES: Record<GitChange, { letter: string; label: string; textClass: string }> = {
  'git-modified': { letter: 'M', label: 'Modified', textClass: 'text-[var(--status-warning)]' },
  'git-added': { letter: 'A', label: 'New file', textClass: 'text-[var(--status-success)]' },
  'git-deleted': { letter: 'D', label: 'Deleted', textClass: 'text-[var(--status-error)]' },
};

export const isGitChange = (status: FileStatus): status is GitChange => status in GIT_CHANGES;

