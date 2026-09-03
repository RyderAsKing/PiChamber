import type {
  GitStatus,
  GitDiffResponse,
  GetGitDiffOptions,
  GetGitRangeDiffOptions,
  GitFileDiffResponse,
  GetGitFileDiffOptions,
  GitWorktree,
  GitWorktreeCreateInput,
  GitWorktreeCreateResult,
  GitWorktreeValidationResult,
  GitWorktreeBootstrapStatus,
  RemoveGitWorktreePayload,
} from '../api/types';
import { runtimeFetch } from '../runtime-fetch';
import { getRuntimeKey } from '../runtime-switch';
import {
  API_BASE,
  GIT_STATUS_CACHE_TTL_MS,
  GIT_REPO_CHECK_CACHE_TTL_MS,
  gitStatusCache,
  gitStatusInFlight,
  gitRepoCache,
  gitRepoInFlight,
  getDirectoryCacheKey,
  getStatusCacheKey,
  getStatusCacheVersion,
  invalidateGitStatusCache,
  buildUrl,
} from './gitHttpHelpers';

export async function checkIsGitRepository(directory: string): Promise<boolean> {
  const key = getDirectoryCacheKey(getRuntimeKey(), directory);
  const now = Date.now();
  const cached = gitRepoCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inFlight = gitRepoInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const task = (async () => {
    const response = await runtimeFetch(buildUrl(`${API_BASE}/check`, directory));
    if (!response.ok) {
      throw new Error(`Failed to check git repository: ${response.statusText}`);
    }
    const data = await response.json();
    const isGitRepository = Boolean(data.isGitRepository);
    gitRepoCache.set(key, {
      value: isGitRepository,
      expiresAt: Date.now() + GIT_REPO_CHECK_CACHE_TTL_MS,
    });
    return isGitRepository;
  })();

  gitRepoInFlight.set(key, task);
  try {
    return await task;
  } finally {
    if (gitRepoInFlight.get(key) === task) {
      gitRepoInFlight.delete(key);
    }
  }
}

export async function getGitStatus(directory: string, options?: { mode?: 'light' }): Promise<GitStatus> {
  const mode = options?.mode;
  const runtimeKey = getRuntimeKey();
  const key = getStatusCacheKey(runtimeKey, directory, mode);
  const now = Date.now();
  const cached = gitStatusCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inFlight = gitStatusInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const task = (async () => {
    const cacheVersion = getStatusCacheVersion(runtimeKey, directory);
    const response = await runtimeFetch(buildUrl(`${API_BASE}/status`, directory, mode ? { mode } : undefined));
    if (!response.ok) {
      throw new Error(`Failed to get git status: ${response.statusText}`);
    }
    const payload = await response.json() as GitStatus;
    if (getStatusCacheVersion(runtimeKey, directory) === cacheVersion) {
      gitStatusCache.set(key, {
        value: payload,
        expiresAt: Date.now() + GIT_STATUS_CACHE_TTL_MS,
      });
    }
    return payload;
  })();

  gitStatusInFlight.set(key, task);
  try {
    return await task;
  } finally {
    if (gitStatusInFlight.get(key) === task) {
      gitStatusInFlight.delete(key);
    }
  }
}

const readGitError = async (response: Response, fallback: string): Promise<Error> => {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  return new Error(typeof payload?.error === 'string' && payload.error ? payload.error : fallback);
};

export async function listGitWorktrees(directory: string): Promise<GitWorktree[]> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees`, directory));
  if (!response.ok) throw await readGitError(response, 'Failed to list git worktrees');
  const payload = await response.json() as { worktrees?: GitWorktree[] };
  if (!Array.isArray(payload.worktrees)) throw new Error('Git worktree response is invalid');
  return payload.worktrees;
}

export async function validateGitWorktree(
  directory: string,
  input: GitWorktreeCreateInput,
): Promise<GitWorktreeValidationResult> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees/validate`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await readGitError(response, 'Failed to validate git worktree');
  return response.json();
}

export async function createGitWorktree(
  directory: string,
  input: GitWorktreeCreateInput,
): Promise<GitWorktreeCreateResult> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await readGitError(response, 'Failed to create git worktree');
  invalidateGitStatusCache(directory);
  return response.json();
}

export async function deleteGitWorktree(
  directory: string,
  input: RemoveGitWorktreePayload,
): Promise<{ success: boolean }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees`, directory), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await readGitError(response, 'Failed to close git worktree');
  invalidateGitStatusCache(directory);
  invalidateGitStatusCache(input.directory);
  return response.json();
}

export async function getGitWorktreeBootstrapStatus(directory: string): Promise<GitWorktreeBootstrapStatus> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees/bootstrap-status`, directory));
  if (!response.ok) throw await readGitError(response, 'Failed to get git worktree bootstrap status');
  return response.json();
}

export async function resolveGitPrimaryRoot(directory: string): Promise<{ root: string }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/primary-root`, directory));
  if (!response.ok) {
    throw new Error(`Failed to resolve git primary root: ${response.statusText}`);
  }
  const payload = await response.json().catch(() => ({})) as { root?: string };
  return { root: typeof payload.root === 'string' && payload.root ? payload.root : directory };
}

export async function resolveGitTopLevel(directory: string): Promise<{ root: string }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/toplevel`, directory));
  if (!response.ok) {
    throw new Error(`Failed to resolve git toplevel: ${response.statusText}`);
  }
  const payload = await response.json().catch(() => ({})) as { root?: string };
  return { root: typeof payload.root === 'string' && payload.root ? payload.root : directory };
}

export async function getGitCommitSummaries(
  directory: string,
  shas: string[]
): Promise<{ commits: Array<{ sha: string; short: string; subject: string }> }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/commit-summaries`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shas }),
  });
  if (!response.ok) {
    throw new Error(`Failed to get git commit summaries: ${response.statusText}`);
  }
  const payload = await response.json().catch(() => ({})) as {
    commits?: Array<{ sha?: string; short?: string; subject?: string }>;
  };
  return {
    commits: Array.isArray(payload.commits)
      ? payload.commits
          .map((entry) => ({
            sha: typeof entry.sha === 'string' ? entry.sha : '',
            short: typeof entry.short === 'string' ? entry.short : '',
            subject: typeof entry.subject === 'string' ? entry.subject : '',
          }))
          .filter((entry) => entry.sha && entry.short)
      : [],
  };
}

export async function getGitDiff(directory: string, options: GetGitDiffOptions): Promise<GitDiffResponse> {
  const { path, staged, contextLines } = options;
  if (!path) {
    throw new Error('path is required to fetch git diff');
  }

  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/diff`, directory, {
      path,
      staged: staged ? 'true' : undefined,
      context: contextLines,
    })
  );

  if (!response.ok) {
    throw new Error(`Failed to get git diff: ${response.statusText}`);
  }

  return response.json();
}

export async function getGitRangeDiff(
  directory: string,
  options: GetGitRangeDiffOptions
): Promise<GitDiffResponse> {
  const { base, head, path, contextLines } = options;
  if (!base || !head) {
    throw new Error('base and head are required to fetch git range diff');
  }

  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/range-diff`, directory, {
      base,
      head,
      path: path || undefined,
      context: contextLines,
    })
  );

  if (!response.ok) {
    throw new Error(`Failed to get git range diff: ${response.statusText}`);
  }

  return response.json();
}

export async function getGitFileDiff(directory: string, options: GetGitFileDiffOptions): Promise<GitFileDiffResponse> {
  const { path, staged } = options;
  if (!path) {
    throw new Error('path is required to fetch git file diff');
  }

  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/file-diff`, directory, {
      path,
      staged: staged ? 'true' : undefined,
    })
  );

  if (!response.ok) {
    throw new Error(`Failed to get git file diff: ${response.statusText}`);
  }

  return response.json();
}

export async function revertGitFile(
  directory: string,
  filePath: string,
  options?: { scope?: 'all' | 'working' }
): Promise<void> {
  if (!filePath) {
    throw new Error('path is required to revert git changes');
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/revert`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, scope: options?.scope }),
  });

  if (!response.ok) {
    const message = await response
      .json()
      .catch(() => ({ error: response.statusText }));
    throw new Error(message.error || 'Failed to revert git changes');
  }

  invalidateGitStatusCache(directory);
}

export async function stageGitFile(directory: string, filePath: string): Promise<void> {
  await stageGitFiles(directory, [filePath]);
}

export async function stageGitFiles(directory: string, filePaths: string[]): Promise<void> {
  const paths = filePaths.map((path) => path.trim()).filter(Boolean);

  if (paths.length === 0) {
    throw new Error('path is required to stage git changes');
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/stage`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  });

  if (!response.ok) {
    const message = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(message.error || 'Failed to stage git changes');
  }

  invalidateGitStatusCache(directory);
}

export async function unstageGitFile(directory: string, filePath: string): Promise<void> {
  await unstageGitFiles(directory, [filePath]);
}

export async function unstageGitFiles(directory: string, filePaths: string[]): Promise<void> {
  const paths = filePaths.map((path) => path.trim()).filter(Boolean);

  if (paths.length === 0) {
    throw new Error('path is required to unstage git changes');
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/unstage`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  });

  if (!response.ok) {
    const message = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(message.error || 'Failed to unstage git changes');
  }

  invalidateGitStatusCache(directory);
}

export async function stageGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  await applyGitHunk(directory, filePath, patch, 'stage');
}

export async function unstageGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  await applyGitHunk(directory, filePath, patch, 'unstage');
}

export async function revertGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  await applyGitHunk(directory, filePath, patch, 'discard');
}

async function applyGitHunk(
  directory: string,
  filePath: string,
  patch: string,
  action: 'stage' | 'unstage' | 'discard',
): Promise<void> {
  if (!filePath) {
    throw new Error('path is required to apply a git hunk');
  }
  if (typeof patch !== 'string' || !patch.trim()) {
    throw new Error('patch is required to apply a git hunk');
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/apply-hunk`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, patch, action }),
  });

  if (!response.ok) {
    const message = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(message.error || 'Failed to apply git hunk');
  }

  invalidateGitStatusCache(directory);
}
