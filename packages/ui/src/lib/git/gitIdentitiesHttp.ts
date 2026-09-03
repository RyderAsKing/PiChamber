import type {
  GitIdentityProfile,
  GitIdentitySummary,
  DiscoveredGitCredential,
  MergeConflictDetails,
  CheckoutCommitResponse,
  CherryPickResponse,
  RevertCommitResponse,
  ResetToCommitResponse,
} from '../api/types';
import { runtimeFetch } from '../runtime-fetch';
import {
  API_BASE,
  buildUrl,
} from './gitHttpHelpers';

export async function getGitIdentities(): Promise<GitIdentityProfile[]> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/identities`, undefined));
  if (!response.ok) {
    throw new Error(`Failed to get git identities: ${response.statusText}`);
  }
  return response.json();
}

export async function createGitIdentity(profile: GitIdentityProfile): Promise<GitIdentityProfile> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/identities`, undefined), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to create git identity');
  }
  return response.json();
}

export async function updateGitIdentity(id: string, updates: GitIdentityProfile): Promise<GitIdentityProfile> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/identities/${id}`, undefined), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to update git identity');
  }
  return response.json();
}

export async function deleteGitIdentity(id: string): Promise<void> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/identities/${id}`, undefined), {
    method: 'DELETE',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to delete git identity');
  }
}

export async function getCurrentGitIdentity(directory: string): Promise<GitIdentitySummary | null> {
  if (!directory) {
    return null;
  }
  const response = await runtimeFetch(buildUrl(`${API_BASE}/current-identity`, directory));
  if (!response.ok) {
    throw new Error(`Failed to get current git identity: ${response.statusText}`);
  }
  const data = await response.json();
  if (!data) {
    return null;
  }
  return {
    userName: data.userName ?? null,
    userEmail: data.userEmail ?? null,
    sshCommand: data.sshCommand ?? null,
  };
}

export async function hasLocalIdentity(directory: string): Promise<boolean> {
  if (!directory) {
    return false;
  }
  const response = await runtimeFetch(buildUrl(`${API_BASE}/has-local-identity`, directory));
  if (!response.ok) {
    throw new Error(`Failed to check local identity: ${response.statusText}`);
  }
  const data = await response.json().catch(() => null);
  return data?.hasLocalIdentity === true;
}

export async function getGlobalGitIdentity(): Promise<GitIdentitySummary | null> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/global-identity`, undefined));
  if (!response.ok) {
    throw new Error(`Failed to get global git identity: ${response.statusText}`);
  }
  const data = await response.json();
  if (!data || (!data.userName && !data.userEmail)) {
    return null;
  }
  return {
    userName: data.userName ?? null,
    userEmail: data.userEmail ?? null,
    sshCommand: data.sshCommand ?? null,
  };
}

export async function setGitIdentity(
  directory: string,
  profileId: string
): Promise<{ success: boolean; profile: GitIdentityProfile }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/set-identity`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to set git identity');
  }
  return response.json();
}

export async function discoverGitCredentials(): Promise<DiscoveredGitCredential[]> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/discover-credentials`, undefined));
  if (!response.ok) {
    throw new Error(`Failed to discover git credentials: ${response.statusText}`);
  }
  return response.json();
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
    throw new Error(`Failed to get remotes: ${response.statusText}`);
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
    throw new Error(error.error || 'Failed to rebase');
  }
  return response.json();
}

export async function abortRebase(directory: string): Promise<{ success: boolean }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/rebase/abort`, directory), {
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to abort rebase');
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
    throw new Error(error.error || 'Failed to merge');
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
    throw new Error(error.error || 'Failed to checkout commit');
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
    throw new Error(error.error || 'Failed to cherry-pick');
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
    throw new Error(error.error || 'Failed to revert commit');
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
    throw new Error(error.error || 'Failed to reset');
  }
  return response.json();
}

export async function abortMerge(directory: string): Promise<{ success: boolean }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/merge/abort`, directory), {
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to abort merge');
  }
  return response.json();
}

export async function continueRebase(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/rebase/continue`, directory), {
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to continue rebase');
  }
  return response.json();
}

export async function continueMerge(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/merge/continue`, directory), {
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to continue merge');
  }
  return response.json();
}

export async function getConflictDetails(directory: string): Promise<MergeConflictDetails> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/conflict-details`, directory));
  if (!response.ok) {
    throw new Error(`Failed to get conflict details: ${response.statusText}`);
  }
  return response.json();
}
