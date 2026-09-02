import type {
  GitStatus,
  GitBranch,
  GitLogResponse,
  GitIdentitySummary,
} from '@/lib/api/types';

export const LOG_STALE_THRESHOLD = 10000;
export const REPO_CHECK_STALE_THRESHOLD = 60_000;
export const STATUS_STALE_THRESHOLD = 5_000;
export const BRANCHES_STALE_THRESHOLD = 30_000;
export const IDENTITY_STALE_THRESHOLD = 60_000;
export const DIFF_PREFETCH_MAX_FILES = 25;
export const DIFF_PREFETCH_FOCUS_MAX_FILES = 40;
export const DIFF_PREFETCH_CONCURRENCY = 2;
export const DIFF_PREFETCH_TIMEOUT_MS = 15000;
export const DIFF_PREFETCH_LARGE_FILE_THRESHOLD = 500; // skip prefetch for files with >500 changed lines

// Diff cache limits to prevent memory bloat with many modified files
export const DIFF_CACHE_MAX_ENTRIES = 30;
export const DIFF_CACHE_MAX_TOTAL_SIZE_BYTES = 20 * 1024 * 1024; // 20MB
export const DIFF_CACHE_MAX_GLOBAL_ENTRIES = 200;
export type GitStatusFetchMode = 'full' | 'light';

export interface DirectoryGitState {
  isGitRepo: boolean | null;
  status: GitStatus | null;
  branches: GitBranch | null;
  log: GitLogResponse | null;
  identity: GitIdentitySummary | null;
  diffCache: Map<
    string,
    { original: string; modified: string; fetchedAt: number; isBinary?: boolean }
  >;
  indexRevision: number;
  lastRepoCheckAt: number;
  lastStatusFetch: number;
  lastStatusChange: number;
  lastLogFetch: number;
  lastBranchesFetch: number;
  lastIdentityFetch: number;
  logMaxCount: number;
  isLoadingStatus: boolean;
  isLoadingLog: boolean;
  isLoadingBranches: boolean;
  isLoadingIdentity: boolean;
}

export interface GitStore {
  runtimeKey: string;
  directories: Map<string, DirectoryGitState>;

  activeDirectory: string | null;

  setActiveDirectory: (directory: string | null) => void;
  getDirectoryState: (directory: string) => DirectoryGitState | null;

  fetchStatus: (
    directory: string,
    git: GitAPI,
    options?: { silent?: boolean; mode?: 'light' }
  ) => Promise<boolean>;
  fetchBranches: (directory: string, git: GitAPI) => Promise<void>;
  fetchLog: (
    directory: string,
    git: GitAPI,
    maxCount?: number
  ) => Promise<void>;
  fetchIdentity: (directory: string, git: GitAPI) => Promise<void>;
  fetchAll: (
    directory: string,
    git: GitAPI,
    options?: { force?: boolean; silentIfCached?: boolean }
  ) => Promise<void>;

  ensureStatus: (directory: string, git: GitAPI) => Promise<void>;
  ensureAll: (directory: string, git: GitAPI) => Promise<void>;
  moveStatusPathsOptimistically: (
    directory: string,
    paths: string[],
    direction: 'stage' | 'unstage'
  ) => GitStatus | null;
  restoreStatus: (directory: string, status: GitStatus | null) => void;
  bumpIndexRevision: (directory: string) => void;

  getDiff: (
    directory: string,
    filePath: string
  ) => {
    original: string;
    modified: string;
    fetchedAt: number;
    isBinary?: boolean;
  } | null;
  setDiff: (
    directory: string,
    filePath: string,
    diff: { original: string; modified: string; isBinary?: boolean },
    expectedRuntimeKey?: string
  ) => void;
  clearDiffCache: (directory: string, filePaths?: string[]) => void;
  fetchAllDiffs: (directory: string, git: GitAPI) => Promise<void>;
  prefetchDiffs: (
    directory: string,
    git: GitAPI,
    filePaths: string[],
    options?: { maxFiles?: number }
  ) => Promise<void>;

  setLogMaxCount: (directory: string, maxCount: number) => void;

  refresh: (git: GitAPI, options?: { force?: boolean }) => Promise<void>;
  resetForRuntimeSwitch: (runtimeKey: string) => void;
}

export interface GitFileDiffResponse {
  original: string;
  modified: string;
  path: string;
  isBinary?: boolean;
}

export interface GitAPI {
  checkIsGitRepository: (directory: string) => Promise<boolean>;
  getGitStatus: (
    directory: string,
    options?: { mode?: 'light' }
  ) => Promise<GitStatus>;
  getGitBranches: (directory: string) => Promise<GitBranch>;
  getGitLog: (
    directory: string,
    options?: { maxCount?: number }
  ) => Promise<GitLogResponse>;
  getCurrentGitIdentity: (
    directory: string
  ) => Promise<GitIdentitySummary | null>;
  getGitFileDiff: (
    directory: string,
    options: { path: string }
  ) => Promise<GitFileDiffResponse>;
}

export type GitRequestToken = {
  runtimeKey: string;
  runtimeGeneration: number;
  channelKey: string;
  requestGeneration: number;
  statusMutationRevision?: number;
};

export const createEmptyDirectoryState = (): DirectoryGitState => ({
  isGitRepo: null,
  status: null,
  branches: null,
  log: null,
  identity: null,
  diffCache: new Map(),
  indexRevision: 0,
  lastRepoCheckAt: 0,
  lastStatusFetch: 0,
  lastStatusChange: 0,
  lastLogFetch: 0,
  lastBranchesFetch: 0,
  lastIdentityFetch: 0,
  logMaxCount: 25,
  isLoadingStatus: false,
  isLoadingLog: false,
  isLoadingBranches: false,
  isLoadingIdentity: false,
});
