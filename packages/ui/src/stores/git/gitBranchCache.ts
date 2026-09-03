import type { GitBranch } from '@/lib/api/types';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import {
  type DirectoryGitState,
  createEmptyDirectoryState,
} from './gitStoreTypes';

export const GIT_BRANCH_CACHE_KEY = 'oc.gitBranchCache';
export const GIT_BRANCH_CACHE_V2_KEY = 'oc.gitBranchCache.v2';
export const MAX_BRANCH_CACHE_RUNTIMES = 8;
export const MAX_BRANCH_CACHE_DIRECTORIES = 50;

export type BranchCacheEnvelope = {
  version: 2;
  legacyClaimed: boolean;
  runtimes: Record<
    string,
    {
      updatedAt: number;
      directories: Record<string, { branches: GitBranch; updatedAt: number }>;
    }
  >;
};

export const emptyBranchCache = (): BranchCacheEnvelope => ({
  version: 2,
  legacyClaimed: false,
  runtimes: {},
});

export const readBranchCacheEnvelope = (
  runtimeKey: string
): BranchCacheEnvelope => {
  try {
    const storage = getDeferredSafeStorage();
    const raw = storage.getItem(GIT_BRANCH_CACHE_V2_KEY);
    const parsed = raw
      ? (JSON.parse(raw) as Partial<BranchCacheEnvelope>)
      : emptyBranchCache();
    const envelope: BranchCacheEnvelope =
      parsed?.version === 2 &&
      parsed.runtimes &&
      typeof parsed.runtimes === 'object'
        ? {
            version: 2,
            legacyClaimed: Boolean(parsed.legacyClaimed),
            runtimes: parsed.runtimes,
          }
        : emptyBranchCache();
    if (!envelope.legacyClaimed) {
      const legacyRaw = storage.getItem(GIT_BRANCH_CACHE_KEY);
      if (legacyRaw) {
        const legacy = JSON.parse(legacyRaw) as Record<string, GitBranch>;
        const directories: BranchCacheEnvelope['runtimes'][string]['directories'] =
          {};
        for (const [directory, branches] of Object.entries(legacy ?? {})) {
          if (directory && branches && Array.isArray(branches.all))
            directories[directory] = { branches, updatedAt: 0 };
        }
        if (Object.keys(directories).length > 0)
          envelope.runtimes[runtimeKey] = { updatedAt: 0, directories };
      }
      envelope.legacyClaimed = true;
      const serialized = JSON.stringify(envelope);
      storage.setItem(GIT_BRANCH_CACHE_V2_KEY, serialized);
      if (storage.getItem(GIT_BRANCH_CACHE_V2_KEY) === serialized)
        storage.removeItem(GIT_BRANCH_CACHE_KEY);
    }
    return envelope;
  } catch {
    return emptyBranchCache();
  }
};

export const writeCachedBranches = (
  runtimeKey: string,
  directory: string,
  branches: GitBranch
): void => {
  if (!directory || !branches) return;
  try {
    const envelope = readBranchCacheEnvelope(runtimeKey);
    const now = Date.now();
    const current = envelope.runtimes[runtimeKey]?.directories ?? {};
    const directories = {
      ...current,
      [directory]: { branches, updatedAt: now },
    };
    const boundedDirectories = Object.fromEntries(
      Object.entries(directories)
        .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_BRANCH_CACHE_DIRECTORIES)
    );
    envelope.runtimes[runtimeKey] = {
      updatedAt: now,
      directories: boundedDirectories,
    };
    envelope.runtimes = Object.fromEntries(
      Object.entries(envelope.runtimes)
        .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_BRANCH_CACHE_RUNTIMES)
    );
    getDeferredSafeStorage().setItem(
      GIT_BRANCH_CACHE_V2_KEY,
      JSON.stringify(envelope)
    );
  } catch {
    // quota / serialization — ignore; live fetch still refreshes the store
  }
};

export const seedDirectoriesFromBranchCache = (
  runtimeKey: string
): Map<string, DirectoryGitState> => {
  const directories = new Map<string, DirectoryGitState>();
  const cache =
    readBranchCacheEnvelope(runtimeKey).runtimes[runtimeKey]?.directories ?? {};
  for (const [directory, entry] of Object.entries(cache)) {
    const branches = entry.branches;
    if (!directory || !branches || !Array.isArray(branches.all)) continue;
    // A cached branch list implies the directory was a git repo. Seed isGitRepo
    // so the selector's gate passes immediately; lastBranchesFetch stays 0 so the
    // ChatInput effect treats it as stale and refreshes in the background.
    directories.set(directory, {
      ...createEmptyDirectoryState(),
      isGitRepo: true,
      branches,
    });
  }
  return directories;
};
