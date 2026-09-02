import type { GitStatus } from '../api/types';
import { getRuntimeUrlResolver } from '../runtime-url';
import { getRuntimeKey } from '../runtime-switch';

export const API_BASE = '/api/git';
export const GIT_STATUS_CACHE_TTL_MS = 1200;
export const GIT_REPO_CHECK_CACHE_TTL_MS = 5000;
export const gitStatusCache = new Map<string, { value: GitStatus; expiresAt: number }>();
export const gitStatusInFlight = new Map<string, Promise<GitStatus>>();
export const gitStatusCacheVersions = new Map<string, number>();
export const gitRepoCache = new Map<string, { value: boolean; expiresAt: number }>();
export const gitRepoInFlight = new Map<string, Promise<boolean>>();

export const normalizeDirectoryKey = (directory: string): string => directory.trim();
export const getDirectoryCacheKey = (runtimeKey: string, directory: string): string =>
  JSON.stringify([runtimeKey, normalizeDirectoryKey(directory)]);
export const getStatusCacheKey = (runtimeKey: string, directory: string, mode?: 'light'): string =>
  JSON.stringify([runtimeKey, normalizeDirectoryKey(directory), mode ?? 'full']);

export const getStatusCacheVersion = (runtimeKey: string, directory: string): number =>
  gitStatusCacheVersions.get(getDirectoryCacheKey(runtimeKey, directory)) ?? 0;

export const invalidateGitStatusCache = (directory: string): void => {
  const runtimeKey = getRuntimeKey();
  const key = getDirectoryCacheKey(runtimeKey, directory);
  gitStatusCacheVersions.set(key, getStatusCacheVersion(runtimeKey, directory) + 1);
  for (const mode of [undefined, 'light'] as const) {
    const statusKey = getStatusCacheKey(runtimeKey, directory, mode);
    gitStatusCache.delete(statusKey);
    gitStatusInFlight.delete(statusKey);
  }
};

export function buildUrl(
  path: string,
  directory: string | null | undefined,
  params?: Record<string, string | number | boolean | undefined>
): string {
  const query: Record<string, string | number | boolean | undefined> = { ...params };
  if (directory) query.directory = directory;

  return getRuntimeUrlResolver().api(path, query);
}
