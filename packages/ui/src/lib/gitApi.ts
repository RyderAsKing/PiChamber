/* eslint-disable */
// @ts-nocheck

import * as gitHttp from './gitApiHttp';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';

export type {
  GitStatus,
  GitDiffResponse,
  GetGitDiffOptions,
  GitBranchDetails,
  GitBranch,
  GitCommitResult,
  GitPushResult,
  GitPullResult,
  GitIdentityProfile,
  GitIdentityAuthType,
  GitIdentitySummary,
  GitLogEntry,
  GitLogResponse,
  GitDeleteBranchPayload,
  GitDeleteRemoteBranchPayload,
  GitRemoveRemotePayload,
  DiscoveredGitCredential,
  GitRemote,
  GitMergeResult,
  GitRebaseResult,
  MergeConflictDetails,
  CommitFileDiffResponse,
} from './api/types';

const getRuntimeGit = () => {
  return getRegisteredRuntimeAPIs()?.git ?? null;
};

export async function checkIsGitRepository(directory: string): Promise<boolean> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.checkIsGitRepository(directory);
  return gitHttp.checkIsGitRepository(directory);
}

export async function getGitStatus(directory: string, options?: { mode?: 'light' }): Promise<import('./api/types').GitStatus> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitStatus(directory, options);
  return gitHttp.getGitStatus(directory, options);
}

export async function resolveGitPrimaryRoot(directory: string): Promise<string> {
  const result = await gitHttp.resolveGitPrimaryRoot(directory);
  return result.root;
}

export async function resolveGitTopLevel(directory: string): Promise<string> {
  const result = await gitHttp.resolveGitTopLevel(directory);
  return result.root;
}

export async function getGitCommitSummaries(
  directory: string,
  shas: string[]
): Promise<Array<{ sha: string; short: string; subject: string }>> {
  const result = await gitHttp.getGitCommitSummaries(directory, shas);
  return result.commits;
}

export async function getGitDiff(directory: string, options: import('./api/types').GetGitDiffOptions): Promise<import('./api/types').GitDiffResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitDiff(directory, options);
  return gitHttp.getGitDiff(directory, options);
}

export async function getGitFileDiff(
  directory: string,
  options: import('./api/types').GetGitFileDiffOptions
): Promise<import('./api/types').GitFileDiffResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitFileDiff(directory, options);
  return gitHttp.getGitFileDiff(directory, options);
}

export async function getGitRangeDiff(
  directory: string,
  options: import('./api/types').GetGitRangeDiffOptions
): Promise<import('./api/types').GitDiffResponse> {
  const runtime = getRuntimeGit();
  if (runtime?.getGitRangeDiff) return runtime.getGitRangeDiff(directory, options);
  return gitHttp.getGitRangeDiff(directory, options);
}

export async function revertGitFile(
  directory: string,
  filePath: string,
  options?: { scope?: 'all' | 'working' }
): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.revertGitFile(directory, filePath, options);
  return gitHttp.revertGitFile(directory, filePath, options);
}

export async function stageGitFile(directory: string, filePath: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.stageGitFile) return runtime.stageGitFile(directory, filePath);
  return gitHttp.stageGitFile(directory, filePath);
}

export async function stageGitFiles(directory: string, filePaths: string[]): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.stageGitFiles) return runtime.stageGitFiles(directory, filePaths);
  return gitHttp.stageGitFiles(directory, filePaths);
}

export async function unstageGitFile(directory: string, filePath: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.unstageGitFile) return runtime.unstageGitFile(directory, filePath);
  return gitHttp.unstageGitFile(directory, filePath);
}

export async function unstageGitFiles(directory: string, filePaths: string[]): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.unstageGitFiles) return runtime.unstageGitFiles(directory, filePaths);
  return gitHttp.unstageGitFiles(directory, filePaths);
}

export async function stageGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.stageGitHunk) return runtime.stageGitHunk(directory, filePath, patch);
  return gitHttp.stageGitHunk(directory, filePath, patch);
}

export async function unstageGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.unstageGitHunk) return runtime.unstageGitHunk(directory, filePath, patch);
  return gitHttp.unstageGitHunk(directory, filePath, patch);
}

export async function revertGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime?.revertGitHunk) return runtime.revertGitHunk(directory, filePath, patch);
  return gitHttp.revertGitHunk(directory, filePath, patch);
}


export async function getGitBranches(directory: string): Promise<import('./api/types').GitBranch> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitBranches(directory);
  return gitHttp.getGitBranches(directory);
}

export async function deleteGitBranch(directory: string, payload: import('./api/types').GitDeleteBranchPayload): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.deleteGitBranch(directory, payload);
  return gitHttp.deleteGitBranch(directory, payload);
}

export async function deleteRemoteBranch(directory: string, payload: import('./api/types').GitDeleteRemoteBranchPayload): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.deleteRemoteBranch(directory, payload);
  return gitHttp.deleteRemoteBranch(directory, payload);
}

export async function createGitCommit(
  directory: string,
  message: string,
  options: import('./api/types').CreateGitCommitOptions = {}
): Promise<import('./api/types').GitCommitResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.createGitCommit(directory, message, options);
  return gitHttp.createGitCommit(directory, message, options);
}

export async function gitPush(
  directory: string,
  options: { remote?: string; branch?: string; options?: string[] | Record<string, unknown> } = {}
): Promise<import('./api/types').GitPushResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.gitPush(directory, options);
  return gitHttp.gitPush(directory, options);
}

export async function gitPull(
  directory: string,
  options: import('./api/types').GitPullOptions = {}
): Promise<import('./api/types').GitPullResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.gitPull(directory, options);
  return gitHttp.gitPull(directory, options);
}

export async function gitFetch(
  directory: string,
  options: { remote?: string; branch?: string } = {}
): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.gitFetch(directory, options);
  return gitHttp.gitFetch(directory, options);
}

export async function listGitStashes(directory: string): Promise<{ stashes: import('./api/types').GitStashEntry[] }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.listGitStashes(directory);
  return gitHttp.listGitStashes(directory);
}

export async function countGitStashFiles(directory: string, refs: string[]): Promise<{ counts: Record<string, number> }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.countGitStashFiles(directory, refs);
  return gitHttp.countGitStashFiles(directory, refs);
}

export async function stashGitChanges(directory: string, options: { message?: string } = {}): Promise<{ success: boolean; created: boolean; message: string; output: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.stashGitChanges(directory, options);
  return gitHttp.stashGitChanges(directory, options);
}

export async function applyGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.applyGitStash(directory, options);
  return gitHttp.applyGitStash(directory, options);
}

export async function popGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.popGitStash(directory, options);
  return gitHttp.popGitStash(directory, options);
}

export async function dropGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.dropGitStash(directory, options);
  return gitHttp.dropGitStash(directory, options);
}

export async function checkoutBranch(
  directory: string,
  branch: string,
  options?: import('./api/types').CheckoutBranchOptions,
): Promise<import('./api/types').CheckoutBranchResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.checkoutBranch(directory, branch, options);
  return gitHttp.checkoutBranch(directory, branch, options);
}

export async function createBranch(
  directory: string,
  name: string,
  startPoint?: string
): Promise<{ success: boolean; branch: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.createBranch(directory, name, startPoint);
  return gitHttp.createBranch(directory, name, startPoint);
}

export async function renameBranch(
  directory: string,
  oldName: string,
  newName: string
): Promise<{ success: boolean; branch: string }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.renameBranch(directory, oldName, newName);
  return gitHttp.renameBranch(directory, oldName, newName);
}

export async function getGitLog(
  directory: string,
  options: import('./api/types').GitLogOptions = {}
): Promise<import('./api/types').GitLogResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitLog(directory, options);
  return gitHttp.getGitLog(directory, options);
}

export async function getCommitFiles(
  directory: string,
  hash: string
): Promise<import('./api/types').GitCommitFilesResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getCommitFiles(directory, hash);
  return gitHttp.getCommitFiles(directory, hash);
}

export async function getCommitFileDiff(
  directory: string,
  hash: string,
  filePath: string,
  isBinary: boolean
): Promise<import('./api/types').CommitFileDiffResponse> {
  const runtime = getRuntimeGit();
  if (runtime?.getCommitFileDiff) return runtime.getCommitFileDiff(directory, hash, filePath, isBinary);
  return gitHttp.getCommitFileDiff(directory, hash, filePath, isBinary);
}

export async function getGitIdentities(): Promise<import('./api/types').GitIdentityProfile[]> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getGitIdentities();
  return gitHttp.getGitIdentities();
}

export async function createGitIdentity(profile: import('./api/types').GitIdentityProfile): Promise<import('./api/types').GitIdentityProfile> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.createGitIdentity(profile);
  return gitHttp.createGitIdentity(profile);
}

export async function updateGitIdentity(id: string, updates: import('./api/types').GitIdentityProfile): Promise<import('./api/types').GitIdentityProfile> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.updateGitIdentity(id, updates);
  return gitHttp.updateGitIdentity(id, updates);
}

export async function deleteGitIdentity(id: string): Promise<void> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.deleteGitIdentity(id);
  return gitHttp.deleteGitIdentity(id);
}

export async function getCurrentGitIdentity(directory: string): Promise<import('./api/types').GitIdentitySummary | null> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getCurrentGitIdentity(directory);
  return gitHttp.getCurrentGitIdentity(directory);
}

export async function hasLocalIdentity(directory: string): Promise<boolean> {
  const runtime = getRuntimeGit();
  if (runtime?.hasLocalIdentity) return runtime.hasLocalIdentity(directory);
  return gitHttp.hasLocalIdentity(directory);
}

export async function setGitIdentity(
  directory: string,
  profileId: string
): Promise<{ success: boolean; profile: import('./api/types').GitIdentityProfile }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.setGitIdentity(directory, profileId);
  return gitHttp.setGitIdentity(directory, profileId);
}

export async function discoverGitCredentials(): Promise<import('./api/types').DiscoveredGitCredential[]> {
  const runtime = getRuntimeGit();
  if (runtime?.discoverGitCredentials) return runtime.discoverGitCredentials();
  return gitHttp.discoverGitCredentials();
}

export async function getGlobalGitIdentity(): Promise<import('./api/types').GitIdentitySummary | null> {
  const runtime = getRuntimeGit();
  if (runtime?.getGlobalGitIdentity) return runtime.getGlobalGitIdentity();
  return gitHttp.getGlobalGitIdentity();
}

export async function getRemoteUrl(directory: string, remote?: string): Promise<string | null> {
  const runtime = getRuntimeGit();
  if (runtime?.getRemoteUrl) return runtime.getRemoteUrl(directory, remote);
  return gitHttp.getRemoteUrl(directory, remote);
}

export async function getRemotes(directory: string): Promise<import('./api/types').GitRemote[]> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.getRemotes(directory);
  return gitHttp.getRemotes(directory);
}

export async function removeRemote(
  directory: string,
  payload: import('./api/types').GitRemoveRemotePayload
): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.removeRemote(directory, payload);
  return gitHttp.removeRemote(directory, payload);
}

export async function rebase(
  directory: string,
  options: { onto: string }
): Promise<import('./api/types').GitRebaseResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.rebase(directory, options);
  return gitHttp.rebase(directory, options);
}

export async function abortRebase(directory: string): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.abortRebase(directory);
  return gitHttp.abortRebase(directory);
}

export async function merge(
  directory: string,
  options: { branch: string }
): Promise<import('./api/types').GitMergeResult> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.merge(directory, options);
  return gitHttp.merge(directory, options);
}

export async function checkoutCommit(
  directory: string,
  hash: string
): Promise<import('./api/types').CheckoutCommitResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.checkoutCommit(directory, hash);
  return gitHttp.checkoutCommit(directory, hash);
}

export async function cherryPick(
  directory: string,
  hash: string
): Promise<import('./api/types').CherryPickResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.cherryPick(directory, hash);
  return gitHttp.cherryPick(directory, hash);
}

export async function revertCommit(
  directory: string,
  hash: string
): Promise<import('./api/types').RevertCommitResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.revertCommit(directory, hash);
  return gitHttp.revertCommit(directory, hash);
}

export async function resetToCommit(
  directory: string,
  hash: string,
  mode: 'soft' | 'mixed' | 'hard',
  force?: boolean
): Promise<import('./api/types').ResetToCommitResponse> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.resetToCommit(directory, hash, mode, force);
  return gitHttp.resetToCommit(directory, hash, mode, force);
}

export async function abortMerge(directory: string): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.abortMerge(directory);
  return gitHttp.abortMerge(directory);
}

export async function continueRebase(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.continueRebase(directory);
  return gitHttp.continueRebase(directory);
}

export async function continueMerge(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.continueMerge(directory);
  return gitHttp.continueMerge(directory);
}

export async function stash(
  directory: string,
  options?: { message?: string; includeUntracked?: boolean }
): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.stash(directory, options);
  return gitHttp.stash(directory, options);
}

export async function stashPop(directory: string): Promise<{ success: boolean }> {
  const runtime = getRuntimeGit();
  if (runtime) return runtime.stashPop(directory);
  return gitHttp.stashPop(directory);
}

export async function getConflictDetails(directory: string): Promise<import('./api/types').MergeConflictDetails> {
  const runtime = getRuntimeGit();
  if (runtime?.getConflictDetails) return runtime.getConflictDetails(directory);
  return gitHttp.getConflictDetails(directory);
}


