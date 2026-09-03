import type { GitStatus } from '@/lib/api/types';

export type GitStatusFile = GitStatus['files'][number];

export function isStagedStatusFile(file: GitStatusFile): boolean {
  const index = file.index?.trim();
  return Boolean(index && index !== '?');
}

export function isWorkingStatusFile(file: GitStatusFile): boolean {
  return Boolean(file.working_dir?.trim()) || file.index?.trim() === '?';
}

export function isNewStatusFile(file: GitStatusFile): boolean {
  const index = file.index?.trim();
  const working = file.working_dir?.trim();
  return index === 'A' || working === 'A' || index === '?' || working === '?';
}
