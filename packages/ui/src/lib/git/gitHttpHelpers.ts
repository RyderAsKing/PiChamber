import type { GitStatus, GitWorktree } from '../api/types';
import { getRuntimeUrlResolver } from '../runtime-url';
import { getRuntimeKey } from '../runtime-switch';
import { sandboxReasonText } from '../pi/sandboxText';

export const API_BASE = '/api/git';
export const GIT_STATUS_CACHE_TTL_MS = 1200;
// `/check` spawns `git rev-parse` per call and its answer is stable at idle:
// positive results cache for 5 minutes, negatives for 30 s (a `git init`
// becomes visible quickly). Fetch failures are never cached.
export const GIT_REPO_CHECK_POSITIVE_TTL_MS = 5 * 60_000;
export const GIT_REPO_CHECK_NEGATIVE_TTL_MS = 30_000;
// Worktree topology changes only through explicit mutations (create/remove),
// so a short TTL plus explicit invalidation keeps idle discovery cheap.
export const GIT_WORKTREES_CACHE_TTL_MS = 10_000;
export const gitStatusCache = new Map<string, { value: GitStatus; expiresAt: number }>();
export const gitStatusInFlight = new Map<string, Promise<GitStatus>>();
export const gitStatusCacheVersions = new Map<string, number>();
export const gitRepoCache = new Map<string, { value: boolean; expiresAt: number }>();
export const gitRepoInFlight = new Map<string, Promise<boolean>>();
export const gitRepoCacheVersions = new Map<string, number>();
export const gitWorktreesCache = new Map<string, { value: GitWorktree[]; expiresAt: number }>();
export const gitWorktreesInFlight = new Map<string, Promise<GitWorktree[]>>();
export const gitWorktreesCacheVersions = new Map<string, number>();

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

// Invalidation cannot cancel a running request, so each directory carries a
// version: a request that started before an invalidation must not write its
// pre-mutation answer back into the cache when it resolves.
export const getRepoCheckCacheVersion = (key: string): number => gitRepoCacheVersions.get(key) ?? 0;
export const getWorktreesCacheVersion = (key: string): number => gitWorktreesCacheVersions.get(key) ?? 0;

export const invalidateGitRepoCheckCache = (directory: string): void => {
  const key = getDirectoryCacheKey(getRuntimeKey(), directory);
  gitRepoCacheVersions.set(key, getRepoCheckCacheVersion(key) + 1);
  gitRepoCache.delete(key);
  gitRepoInFlight.delete(key);
};

export const invalidateGitWorktreesCache = (directory: string): void => {
  const key = getDirectoryCacheKey(getRuntimeKey(), directory);
  gitWorktreesCacheVersions.set(key, getWorktreesCacheVersion(key) + 1);
  gitWorktreesCache.delete(key);
  gitWorktreesInFlight.delete(key);
};

/** Drop every git HTTP cache and in-flight marker (runtime switch). Keys are
 *  already runtime-scoped, so this is a memory bound, not a correctness fix. */
export const resetGitHttpCachesForRuntimeSwitch = (): void => {
  gitStatusCache.clear();
  gitStatusInFlight.clear();
  gitStatusCacheVersions.clear();
  gitRepoCache.clear();
  gitRepoInFlight.clear();
  gitRepoCacheVersions.clear();
  gitWorktreesCache.clear();
  gitWorktreesInFlight.clear();
  gitWorktreesCacheVersions.clear();
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

/** Why Git did not run in a sandboxed project whose sandbox cannot start. */
export const gitSandboxErrorText = (reason: string | undefined): string =>
  `This project is sandboxed, so Git does not run without the sandbox. ${sandboxReasonText(reason)}`;

/**
 * The error for a failed Git request. A sandboxed project whose sandbox
 * cannot start answers every Git route with 503 `SANDBOX_UNAVAILABLE` and a
 * reason code; that always becomes a readable sentence, with `code` and
 * `reason` kept on the error. Otherwise the server's `error` text is used
 * when `serverMessage` is set (the default), else `fallback`.
 */
export const readGitError = async (
  response: Response,
  fallback: string,
  options: { serverMessage?: boolean } = {},
): Promise<Error> => {
  const payload = await response.json().catch(() => null) as { error?: unknown; code?: unknown; reason?: unknown } | null;
  if (payload?.code === 'SANDBOX_UNAVAILABLE') {
    const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
    return Object.assign(
      new Error(gitSandboxErrorText(reason)),
      { code: 'SANDBOX_UNAVAILABLE', reason },
    );
  }
  const useServer = options.serverMessage !== false;
  return new Error(useServer && typeof payload?.error === 'string' && payload.error ? payload.error : fallback);
};
