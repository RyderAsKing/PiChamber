import type {
  GitBranch,
  GitDeleteBranchPayload,
  GitDeleteRemoteBranchPayload,
  GitRemoveRemotePayload,
  CreateGitCommitOptions,
  GitCommitResult,
  GitPushResult,
  GitPullResult,
  GitPullOptions,
  GitStashEntry,
  GitLogOptions,
  GitLogResponse,
  GitCommitFilesResponse,
  CommitFileDiffResponse,
  CheckoutBranchOptions,
  CheckoutBranchResponse,
  MergeConflictDetails,
  CheckoutCommitResponse,
  CherryPickResponse,
  RevertCommitResponse,
  ResetToCommitResponse,
} from '../api/types';
import { runtimeFetch } from '../runtime-fetch';
import i18n from '@/i18n';
import {
  API_BASE,
  invalidateGitStatusCache,
  buildUrl,
} from './gitHttpHelpers';

export async function getGitBranches(directory: string): Promise<GitBranch> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/branches`, directory));
  if (!response.ok) {
    throw new Error(i18n.t('Failed to get branches: {{status}}', { status: response.statusText }));
  }
  return response.json();
}

export async function deleteGitBranch(directory: string, payload: GitDeleteBranchPayload): Promise<{ success: boolean }> {
  if (!payload?.branch) {
    throw new Error('branch is required to delete a branch');
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/branches`, directory), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to delete branch'));
  }

  return response.json();
}

export async function deleteRemoteBranch(directory: string, payload: GitDeleteRemoteBranchPayload): Promise<{ success: boolean }> {
  if (!payload?.branch) {
    throw new Error('branch is required to delete remote branch');
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/remote-branches`, directory), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to delete remote branch'));
  }

  return response.json();
}

export async function removeRemote(directory: string, payload: GitRemoveRemotePayload): Promise<{ success: boolean }> {
  const remote = payload?.remote?.trim();
  if (!remote) {
    throw new Error('remote is required to remove a remote');
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/remotes`, directory), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remote }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to remove remote'));
  }

  return response.json();
}

export async function createGitCommit(
  directory: string,
  message: string,
  options: CreateGitCommitOptions = {}
): Promise<GitCommitResult> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/commit`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      addAll: options.addAll ?? false,
      files: options.files,
      stageFiles: options.stageFiles,
    }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to create commit'));
  }
  const result = await response.json();
  invalidateGitStatusCache(directory);
  return result;
}

export async function gitPush(
  directory: string,
  options: { remote?: string; branch?: string; options?: string[] | Record<string, unknown> } = {}
): Promise<GitPushResult> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/push`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to push'));
  }
  const result = await response.json();
  invalidateGitStatusCache(directory);
  return result;
}

export async function gitPull(
  directory: string,
  options: GitPullOptions = {}
): Promise<GitPullResult> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/pull`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to pull'));
  }
  const result = await response.json();
  invalidateGitStatusCache(directory);
  return result;
}

export async function gitFetch(
  directory: string,
  options: { remote?: string; branch?: string } = {}
): Promise<{ success: boolean }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/fetch`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to fetch'));
  }
  const result = await response.json();
  invalidateGitStatusCache(directory);
  return result;
}

export async function listGitStashes(directory: string): Promise<{ stashes: GitStashEntry[] }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/stashes`, directory));
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to list stashes'));
  }
  return response.json();
}

export async function countGitStashFiles(directory: string, refs: string[]): Promise<{ counts: Record<string, number> }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/stashes/file-counts`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refs }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to count stash files'));
  }
  return response.json();
}

export async function stashGitChanges(directory: string, options: { message?: string } = {}): Promise<{ success: boolean; created: boolean; message: string; output: string }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/stash`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to stash changes'));
  }
  return response.json();
}

const postStashRef = async (directory: string, path: string, options: { ref: string }): Promise<{ success: boolean; ref: string }> => {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/${path}`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to {{operation}}', { operation: path }));
  }
  return response.json();
};

export const applyGitStash = (directory: string, options: { ref: string }) => postStashRef(directory, 'stash/apply', options);
export const popGitStash = (directory: string, options: { ref: string }) => postStashRef(directory, 'stash/pop', options);
export const dropGitStash = (directory: string, options: { ref: string }) => postStashRef(directory, 'stash/drop', options);

export async function checkoutBranch(
  directory: string,
  branch: string,
  options?: CheckoutBranchOptions,
): Promise<CheckoutBranchResponse> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/checkout`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch, ...options }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    const error = new Error(payload.error || i18n.t('Failed to checkout branch')) as Error & {
      code?: string;
      currentBranch?: string | null;
    };
    if (typeof payload.code === 'string') error.code = payload.code;
    if (typeof payload.currentBranch === 'string' || payload.currentBranch === null) {
      error.currentBranch = payload.currentBranch;
    }
    throw error;
  }
  return response.json();
}

export async function createBranch(
  directory: string,
  name: string,
  startPoint?: string
): Promise<{ success: boolean; branch: string }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/branches`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, startPoint }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to create branch'));
  }
  return response.json();
}

export async function renameBranch(
  directory: string,
  oldName: string,
  newName: string
): Promise<{ success: boolean; branch: string }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/branches/rename`, directory), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldName, newName }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to rename branch'));
  }
  return response.json();
}

export async function getGitLog(
  directory: string,
  options: GitLogOptions = {}
): Promise<GitLogResponse> {
  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/log`, directory, {
      maxCount: options.maxCount,
      from: options.from,
      to: options.to,
      file: options.file,
      all: options.all ? 'true' : undefined,
    })
  );
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(i18n.t('Failed to get git log: {{status}}', { status: errorBody.error || response.statusText }));
  }
  return response.json();
}

export async function getCommitFiles(
  directory: string,
  hash: string
): Promise<GitCommitFilesResponse> {
  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/commit-files`, directory, { hash })
  );
  if (!response.ok) {
    throw new Error(i18n.t('Failed to get commit files: {{status}}', { status: response.statusText }));
  }
  return response.json();
}

export async function getCommitFileDiff(
  directory: string,
  hash: string,
  filePath: string,
  isBinary: boolean
): Promise<CommitFileDiffResponse> {
  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/commit-file-diff`, directory, {
      hash,
      path: filePath,
      binary: isBinary ? 'true' : undefined,
    })
  );
  if (!response.ok) {
    throw new Error(i18n.t('Failed to get commit file diff: {{status}}', { status: response.statusText }));
  }
  return response.json();
}

export async function stash(
  directory: string,
  options?: { message?: string; includeUntracked?: boolean }
): Promise<{ success: boolean }> {
  await stashGitChanges(directory, { message: options?.message });
  return { success: true };
}

export async function stashPop(directory: string): Promise<{ success: boolean }> {
  await popGitStash(directory, { ref: 'stash@{0}' });
  return { success: true };
}

export async function getRemoteUrl(directory: string, remote?: string): Promise<string | null> {
  if (!directory) {
    return null;
  }
  const response = await runtimeFetch(buildUrl(`${API_BASE}/remote-url`, directory, { remote }));
  if (!response.ok) {
    return null;
  }
  const data = await response.json();
  return data.url ?? null;
}

export async function getRemotes(directory: string): Promise<Array<{ name: string; fetchUrl: string; pushUrl: string }>> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/remotes`, directory));
  if (!response.ok) {
    throw new Error(i18n.t('Failed to get remotes: {{status}}', { status: response.statusText }));
  }
  return response.json();
}

export async function rebase(
  directory: string,
  options: { onto: string }
): Promise<{ success: boolean; conflict?: boolean; conflictFiles?: string[] }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/rebase`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to rebase'));
  }
  return response.json();
}

export async function abortRebase(directory: string): Promise<{ success: boolean }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/rebase/abort`, directory), {
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to abort rebase'));
  }
  return response.json();
}

export async function merge(
  directory: string,
  options: { branch: string }
): Promise<{ success: boolean; conflict?: boolean; conflictFiles?: string[] }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/merge`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to merge'));
  }
  return response.json();
}

export async function checkoutCommit(
  directory: string,
  hash: string
): Promise<CheckoutCommitResponse> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/checkout-commit`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to checkout commit'));
  }
  return response.json();
}

export async function cherryPick(
  directory: string,
  hash: string
): Promise<CherryPickResponse> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/cherry-pick`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to cherry-pick'));
  }
  return response.json();
}

export async function revertCommit(
  directory: string,
  hash: string
): Promise<RevertCommitResponse> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/revert-commit`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to revert commit'));
  }
  return response.json();
}

export async function resetToCommit(
  directory: string,
  hash: string,
  mode: 'soft' | 'mixed' | 'hard',
  force?: boolean
): Promise<ResetToCommitResponse> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/reset-to-commit`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash, mode, force }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to reset'));
  }
  return response.json();
}

export async function abortMerge(directory: string): Promise<{ success: boolean }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/merge/abort`, directory), {
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to abort merge'));
  }
  return response.json();
}

export async function continueRebase(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/rebase/continue`, directory), {
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to continue rebase'));
  }
  return response.json();
}

export async function continueMerge(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/merge/continue`, directory), {
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || i18n.t('Failed to continue merge'));
  }
  return response.json();
}

export async function getConflictDetails(directory: string): Promise<MergeConflictDetails> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/conflict-details`, directory));
  if (!response.ok) {
    throw new Error(i18n.t('Failed to get conflict details: {{status}}', { status: response.statusText }));
  }
  return response.json();
}
