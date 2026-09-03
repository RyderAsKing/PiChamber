import { toAbsoluteFilePath } from '@/lib/path-utils';
import type { TurnSnapshotDiff } from './diffTypes';

export const SIDE_BY_SIDE_MIN_WIDTH = 1100;
export const STACKED_DIFF_MOUNT_MARGIN = 300;

export const getStackedViewDefaultExpandedCount = (fileCount: number): number => {
  if (fileCount <= 6) return fileCount;
  if (fileCount <= 12) return 6;
  if (fileCount <= 25) return 4;
  return 2;
};

export const toAbsolutePath = (directory: string, filePath: string): string => {
  return toAbsoluteFilePath(directory, filePath);
};

export const getFirstChangedModifiedLine = (original: string, modified: string): number => {
  const originalLines = original.split('\n');
  const modifiedLines = modified.split('\n');
  const sharedLength = Math.min(originalLines.length, modifiedLines.length);

  for (let index = 0; index < sharedLength; index += 1) {
    if (originalLines[index] !== modifiedLines[index]) {
      return index + 1;
    }
  }

  if (modifiedLines.length > originalLines.length) {
    return originalLines.length + 1;
  }

  if (originalLines.length > modifiedLines.length) {
    return Math.max(1, modifiedLines.length);
  }

  return 1;
};

export const listTurnDiffs = (value: unknown): TurnSnapshotDiff[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((diff): diff is TurnSnapshotDiff => {
    if (!diff || typeof diff !== 'object') return false;
    return typeof (diff as TurnSnapshotDiff).file === 'string';
  });
};

export const parseRangeDiff = (value: string): TurnSnapshotDiff[] => {
  const chunks = value.split(/^diff --git /m).slice(1);
  return chunks.flatMap((chunk) => {
    const [header = ''] = chunk.split('\n', 1);
    const separator = header.lastIndexOf(' b/');
    if (separator <= 2) return [];

    const fromPath = header.slice(2, separator);
    const toPath = header.slice(separator + 3).trim();
    const body = `diff --git ${chunk}`;
    const status = body.includes('\nnew file mode ')
      ? 'added'
      : body.includes('\ndeleted file mode ')
      ? 'deleted'
      : body.includes('\nrename from ')
      ? 'renamed'
      : 'modified';
    let additions = 0;
    let deletions = 0;
    for (const line of body.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
      if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
    }

    return [
      {
        file: status === 'deleted' ? fromPath : toPath,
        status,
        additions,
        deletions,
        patch: body,
      },
    ];
  });
};

export const statusToGitCode = (status?: string): string => {
  if (status === 'added') return 'A';
  if (status === 'deleted') return 'D';
  return 'M';
};
