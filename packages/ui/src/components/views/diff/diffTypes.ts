import type { GitStatus } from '@/lib/api/types';
import type { FileDiffMetadata } from '@pierre/diffs';

export type FileEntry = GitStatus['files'][number] & {
  insertions: number;
  deletions: number;
  isNew: boolean;
};

export type DiffContextMode = 'patch' | 'full';

export type DiffData = {
  original: string;
  modified: string;
  isBinary?: boolean;
  patch?: string;
  fileDiff?: FileDiffMetadata;
  contextMode?: DiffContextMode;
};

export type DiffScope = 'all' | 'staged' | 'working' | 'turn' | 'branch';

export type TurnSnapshotDiff = {
  file?: string;
  status?: string;
  before?: string;
  after?: string;
  patch?: string;
  additions?: number;
  deletions?: number;
};

export type FileDiffAction = 'stage' | 'unstage' | 'discard';
