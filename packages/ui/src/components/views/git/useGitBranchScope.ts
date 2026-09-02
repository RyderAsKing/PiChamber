import React from 'react';

import type { GitBranch, GitRemote, GitStatus, RuntimeAPIs } from '@/lib/api/types';
import { deriveBaseBranch, hasResolvableBaseBranch } from './baseBranch';

export const deriveLocalBranches = (allBranches: string[] | undefined): string[] => {
  if (!allBranches) return [];
  return allBranches
    .filter((branchName) => !branchName.startsWith('remotes/'))
    .sort();
};

export const deriveRemoteBranches = (allBranches: string[] | undefined): string[] => {
  if (!allBranches) return [];
  return allBranches
    .filter((branchName) => branchName.startsWith('remotes/'))
    .map((branchName) => branchName.replace(/^remotes\//, ''))
    .sort();
};

export const deriveEffectiveRemotes = (
  remotes: GitRemote[],
  remoteBranches: string[],
  tracking: string | null | undefined,
  remoteUrl: string | null | undefined
): GitRemote[] => {
  if (remotes.length > 0) {
    return remotes;
  }

  const inferredNames = new Set<string>();
  const cleanTracking = tracking?.trim();
  if (cleanTracking && cleanTracking.includes('/')) {
    inferredNames.add(cleanTracking.split('/')[0]);
  }

  for (const branchName of remoteBranches) {
    const slashIndex = branchName.indexOf('/');
    if (slashIndex > 0) {
      inferredNames.add(branchName.slice(0, slashIndex));
    }
  }

  if (inferredNames.size === 0 && remoteUrl) {
    inferredNames.add('origin');
  }

  return Array.from(inferredNames).map((name) => ({
    name,
    fetchUrl: remoteUrl ?? '',
    pushUrl: remoteUrl ?? '',
  }));
};

export const deriveDefaultBranch = (
  defaultBranches: Record<string, string> | undefined,
  tracking: string | null | undefined
): string | undefined => {
  const trackingRemote = tracking?.trim().split('/')[0];
  return (trackingRemote && defaultBranches?.[trackingRemote])
    ?? defaultBranches?.origin;
};

export const deriveUpdateTargetBranch = (
  effectiveRemotes: GitRemote[],
  remoteBranches: string[],
  baseBranch: string | null
): string | null => {
  if (!baseBranch) return null;
  const remoteNames = effectiveRemotes.map((remote) => remote.name);
  const remoteCandidates = remoteNames.map((remote) => `${remote}/${baseBranch}`);
  return remoteCandidates.find((candidate) => remoteBranches.includes(candidate)) ?? baseBranch;
};

export interface UseGitBranchScopeParams {
  branches: GitBranch | null | undefined;
  status: GitStatus | null | undefined;
  remotes: GitRemote[];
  remoteUrl: string | null | undefined;
  git: RuntimeAPIs['git'];
}

export function useGitBranchScope({
  branches,
  status,
  remotes,
  remoteUrl,
  git,
}: UseGitBranchScopeParams) {
  const localBranches = React.useMemo(() => {
    return deriveLocalBranches(branches?.all);
  }, [branches?.all]);

  const remoteBranches = React.useMemo(() => {
    return deriveRemoteBranches(branches?.all);
  }, [branches?.all]);

  const effectiveRemotes = React.useMemo<GitRemote[]>(() => {
    return deriveEffectiveRemotes(remotes, remoteBranches, status?.tracking, remoteUrl);
  }, [remotes, remoteBranches, remoteUrl, status?.tracking]);

  const currentBranch = status?.current ?? null;

  const defaultBranch = React.useMemo(() => {
    return deriveDefaultBranch(branches?.defaultBranches, status?.tracking);
  }, [branches?.defaultBranches, status?.tracking]);

  const baseBranch = React.useMemo(() => deriveBaseBranch({
    remoteNames: new Set(effectiveRemotes.map((remote) => remote.name)),
    localBranches,
    defaultBranch,
    headBranch: currentBranch,
  }), [
    currentBranch,
    defaultBranch,
    effectiveRemotes,
    localBranches,
  ]);

  const branchScopeAvailable = Boolean(
    currentBranch
    && baseBranch
    && currentBranch !== baseBranch
    && (status?.tracking || effectiveRemotes.length > 0)
    && typeof git?.getGitRangeDiff === 'function'
    && hasResolvableBaseBranch({
      baseBranch,
      localBranches,
      remoteBranches,
    }),
  );

  const updateTargetBranch = React.useMemo(() => {
    return deriveUpdateTargetBranch(effectiveRemotes, remoteBranches, baseBranch);
  }, [baseBranch, effectiveRemotes, remoteBranches]);

  return {
    localBranches,
    remoteBranches,
    effectiveRemotes,
    currentBranch,
    defaultBranch,
    baseBranch,
    branchScopeAvailable,
    updateTargetBranch,
  };
}
