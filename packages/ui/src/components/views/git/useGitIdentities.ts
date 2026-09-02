import React from 'react';

import type { GitIdentityProfile, GitIdentitySummary } from '@/lib/api/types';

export const normalizeRepoHostPath = (remoteUrl: string | null | undefined): string | null => {
  if (!remoteUrl) return null;
  try {
    let normalized = remoteUrl.trim();
    if (normalized.startsWith('git@')) {
      normalized = `https://${normalized.slice(4).replace(':', '/')}`;
    }
    if (normalized.endsWith('.git')) {
      normalized = normalized.slice(0, -4);
    }
    const url = new URL(normalized);
    return url.hostname + url.pathname;
  } catch {
    return null;
  }
};

export const deriveAvailableIdentities = (
  profiles: GitIdentityProfile[],
  globalIdentity: GitIdentityProfile | null | undefined,
  remoteUrl: string | null | undefined
): GitIdentityProfile[] => {
  const unique = new Map<string, GitIdentityProfile>();
  if (globalIdentity) {
    unique.set(globalIdentity.id, globalIdentity);
  }

  const repoHostPath = normalizeRepoHostPath(remoteUrl);

  for (const profile of profiles) {
    if (profile.authType !== 'token') {
      unique.set(profile.id, profile);
      continue;
    }

    const profileHost = profile.host;
    if (!profileHost) {
      unique.set(profile.id, profile);
      continue;
    }

    if (!profileHost.includes('/')) {
      unique.set(profile.id, profile);
      continue;
    }

    if (repoHostPath && repoHostPath === profileHost) {
      unique.set(profile.id, profile);
    }
  }

  return Array.from(unique.values());
};

export const deriveActiveIdentityProfile = (
  currentIdentity: GitIdentitySummary | null | undefined,
  profiles: GitIdentityProfile[],
  globalIdentity: GitIdentityProfile | null | undefined
): GitIdentityProfile | null => {
  if (currentIdentity?.userName && currentIdentity?.userEmail) {
    const match = profiles.find(
      (profile) =>
        profile.userName === currentIdentity.userName &&
        profile.userEmail === currentIdentity.userEmail
    );

    if (match) {
      return match;
    }

    if (
      globalIdentity &&
      globalIdentity.userName === currentIdentity.userName &&
      globalIdentity.userEmail === currentIdentity.userEmail
    ) {
      return globalIdentity;
    }

    return {
      id: 'local-config',
      name: currentIdentity.userName,
      userName: currentIdentity.userName,
      userEmail: currentIdentity.userEmail,
      sshKey: currentIdentity.sshCommand?.replace('ssh -i ', '') ?? null,
      color: 'info',
      icon: 'user',
    };
  }

  return globalIdentity ?? null;
};

export interface UseGitIdentitiesParams {
  profiles: GitIdentityProfile[];
  globalIdentity: GitIdentityProfile | null | undefined;
  currentIdentity: GitIdentitySummary | null | undefined;
  remoteUrl: string | null | undefined;
}

export function useGitIdentities({
  profiles,
  globalIdentity,
  currentIdentity,
  remoteUrl,
}: UseGitIdentitiesParams) {
  const availableIdentities = React.useMemo(() => {
    return deriveAvailableIdentities(profiles, globalIdentity, remoteUrl);
  }, [profiles, globalIdentity, remoteUrl]);

  const activeIdentityProfile = React.useMemo((): GitIdentityProfile | null => {
    return deriveActiveIdentityProfile(currentIdentity, profiles, globalIdentity);
  }, [currentIdentity, profiles, globalIdentity]);

  return {
    availableIdentities,
    activeIdentityProfile,
  };
}
