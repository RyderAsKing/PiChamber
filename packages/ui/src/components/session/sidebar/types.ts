import type { GitWorktree } from '@/lib/api/types';
import type { Session } from '@/lib/chat/types';

export type SessionNode = {
  session: Session;
  children: SessionNode[];
  worktree?: GitWorktree | null;
  /** Session id used to assign a stable color; null when unrelated to a fork. */
  forkColorId?: string | null;
};

export type SessionGroupFolderScope = {
  scopeKey: string;
  directory: string | null;
};

export type SessionGroup = {
  id: string;
  label: string;
  branch: string | null;
  description: string | null;
  isMain: boolean;
  isArchivedBucket?: boolean;
  worktree?: GitWorktree | null;
  directory: string | null;
  folderScopeKey?: string | null;
  folderScopes?: SessionGroupFolderScope[];
  sessions: SessionNode[];
};

export type GroupSearchData = {
  filteredNodes: SessionNode[];
  matchedSessionCount: number;
  folderNameMatchCount: number;
  groupMatches: boolean;
  hasMatch: boolean;
};
