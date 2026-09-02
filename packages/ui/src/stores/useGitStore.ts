import React from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { GitStatus } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
  LOG_STALE_THRESHOLD,
  REPO_CHECK_STALE_THRESHOLD,
  STATUS_STALE_THRESHOLD,
  BRANCHES_STALE_THRESHOLD,
  IDENTITY_STALE_THRESHOLD,
  DIFF_PREFETCH_MAX_FILES,
  DIFF_PREFETCH_FOCUS_MAX_FILES,
  DIFF_PREFETCH_CONCURRENCY,
  DIFF_PREFETCH_TIMEOUT_MS,
  DIFF_PREFETCH_LARGE_FILE_THRESHOLD,
  DIFF_CACHE_MAX_TOTAL_SIZE_BYTES,
  type GitStatusFetchMode,
  type DirectoryGitState,
  type GitStore,
  type GitFileDiffResponse,
  type GitAPI,
  createEmptyDirectoryState,
} from './git/gitStoreTypes';
import {
  seedDirectoriesFromBranchCache,
  writeCachedBranches,
} from './git/gitBranchCache';
import {
  diffEntrySize,
  evictDiffCacheIfNeeded,
  evictGlobalDiffCachesIfNeeded,
} from './git/gitDiffCache';
import {
  hasStatusChanged,
  getChangedFilePaths,
  hasIndexStatusChanged,
  toStagedStatusFile,
  toUnstagedStatusFile,
  isCleanStatusFile,
} from './git/gitStatusAnalysis';
import {
  inFlightStatusFetches,
  inFlightBranchFetches,
  inFlightEnsureAllByDirectory,
  getActiveGitRuntimeKey,
  resetGitRuntimeGuards,
  runtimeDirectoryKey,
  getStatusFetchKey,
  startRequest,
  isRequestCurrent,
  bumpStatusMutationRevision,
  getDiffFetchGeneration,
  bumpDiffFetchGeneration,
  getInFlightDiffs,
} from './git/gitRequestGuards';

export type {
  DirectoryGitState,
  GitStore,
  GitFileDiffResponse,
  GitAPI,
  GitStatusFetchMode,
};

const initialGitRuntimeKey = getActiveGitRuntimeKey();

export const useGitStore = create<GitStore>()(
  devtools(
    (set, get) => ({
      runtimeKey: initialGitRuntimeKey,
      directories: seedDirectoriesFromBranchCache(initialGitRuntimeKey),
      activeDirectory: null,

      resetForRuntimeSwitch: (runtimeKey) => {
        resetGitRuntimeGuards(runtimeKey);
        set({ runtimeKey, directories: seedDirectoriesFromBranchCache(runtimeKey), activeDirectory: null });
      },

      setActiveDirectory: (directory) => {
        const { activeDirectory, directories } = get();
        if (activeDirectory === directory) return;

        if (activeDirectory) {
          bumpDiffFetchGeneration(activeDirectory);
        }
        if (directory) {
          bumpDiffFetchGeneration(directory);
        }

        if (directory && !directories.has(directory)) {
          const newDirectories = new Map(directories);
          newDirectories.set(directory, createEmptyDirectoryState());
          set({ activeDirectory: directory, directories: newDirectories });
        } else {
          set({ activeDirectory: directory });
        }
      },

      getDirectoryState: (directory) => {
        return get().directories.get(directory) ?? null;
      },

      fetchStatus: async (directory, git, options = {}) => {
        const statusFetchMode: GitStatusFetchMode = options.mode ?? 'full';
        const runtimeKey = getRuntimeKey();
        const statusFetchKey = getStatusFetchKey(runtimeKey, directory, statusFetchMode);
        const existing = inFlightStatusFetches.get(statusFetchKey)
          ?? (statusFetchMode === 'light' ? inFlightStatusFetches.get(getStatusFetchKey(runtimeKey, directory, 'full')) : undefined);
        if (existing) {
          return existing;
        }

        const token = startRequest(directory, 'status', true);
        const fetchPromise = (async () => {
          const { silent = false } = options;
          const { directories } = get();
          let dirState = directories.get(directory);

          if (!dirState) {
            dirState = createEmptyDirectoryState();
          }

          if (!silent) {
            const newDirectories = new Map(get().directories);
            const d = newDirectories.get(directory) ?? createEmptyDirectoryState();
            newDirectories.set(directory, { ...d, isLoadingStatus: true });
            set({ directories: newDirectories });
          }

          let statusChanged = false;

          try {
            const now = Date.now();
            const shouldProbeRepository =
              dirState.isGitRepo !== true ||
              now - (dirState.lastRepoCheckAt || 0) > REPO_CHECK_STALE_THRESHOLD;

            let isRepo = dirState.isGitRepo === true;
            if (shouldProbeRepository) {
              isRepo = await git.checkIsGitRepository(directory);
              if (!isRequestCurrent(token, directory)) return false;
            }

            if (!isRepo) {
              const newDirectories = new Map(get().directories);
              const currentDirState = newDirectories.get(directory) ?? dirState;
              newDirectories.set(directory, {
                ...currentDirState,
                isGitRepo: false,
                status: null,
                isLoadingStatus: false,
                lastRepoCheckAt: now,
                lastStatusFetch: now,
              });
              set({ directories: newDirectories });
              return false;
            }

            const newStatus = await git.getGitStatus(directory, options.mode ? { mode: options.mode } : undefined);
            if (!isRequestCurrent(token, directory)) return false;

            const latestState = get().directories.get(directory) ?? createEmptyDirectoryState();
            if (hasStatusChanged(latestState.status, newStatus)) {
              statusChanged = true;
              const newDirectories = new Map(get().directories);
              const currentDirState = newDirectories.get(directory) ?? createEmptyDirectoryState();

              const changedPaths = getChangedFilePaths(currentDirState.status, newStatus);
              const indexStatusChanged = hasIndexStatusChanged(currentDirState.status, newStatus);

              const oldPaths = new Set((currentDirState.status?.files ?? []).map((f) => f.path));
              const newPaths = new Set((newStatus.files ?? []).map((f) => f.path));

              const nextDiffCache = new Map(currentDirState.diffCache);

              // Drop cache for removed files
              for (const oldPath of oldPaths) {
                if (!newPaths.has(oldPath)) {
                  nextDiffCache.delete(oldPath);
                }
              }

              // Drop cache for files whose state/content changed
              for (const filePath of changedPaths) {
                nextDiffCache.delete(filePath);
              }

              const hasFileContentChange = changedPaths.size > 0;
              if (hasFileContentChange) {
                bumpDiffFetchGeneration(directory);
              }

              // Preserve diffStats from previous status when light mode returns none
              const mergedStatus = {
                ...newStatus,
                diffStats:
                  newStatus.diffStats === undefined && currentDirState.status?.diffStats !== undefined
                    ? currentDirState.status.diffStats
                    : newStatus.diffStats,
                upstreamComparison:
                  newStatus.upstreamComparison === undefined
                    ? currentDirState.status?.upstreamComparison
                    : newStatus.upstreamComparison,
              };

              newDirectories.set(directory, {
                ...currentDirState,
                isGitRepo: true,
                status: mergedStatus,
                diffCache: nextDiffCache,
                indexRevision: indexStatusChanged ? currentDirState.indexRevision + 1 : currentDirState.indexRevision,
                lastRepoCheckAt: shouldProbeRepository ? now : currentDirState.lastRepoCheckAt,
                lastStatusFetch: Date.now(),
                lastStatusChange: hasFileContentChange ? Date.now() : currentDirState.lastStatusChange,
              });
              set({ directories: newDirectories });
            } else {

              const newDirectories = new Map(get().directories);
              const currentDirState = newDirectories.get(directory) ?? createEmptyDirectoryState();
              newDirectories.set(directory, {
                ...currentDirState,
                isGitRepo: true,
                lastRepoCheckAt: shouldProbeRepository ? now : currentDirState.lastRepoCheckAt,
                lastStatusFetch: Date.now(),
                lastStatusChange: currentDirState.lastStatusChange,
              });
              set({ directories: newDirectories });
            }
          } catch (error) {
            console.error('Failed to fetch git status:', error);
          } finally {
            if (!silent && isRequestCurrent(token, directory)) {
              const newDirectories = new Map(get().directories);
              const d = newDirectories.get(directory) ?? createEmptyDirectoryState();
              newDirectories.set(directory, { ...d, isLoadingStatus: false });
              set({ directories: newDirectories });
            }
          }

          return statusChanged;
        })();

        inFlightStatusFetches.set(statusFetchKey, fetchPromise);

        try {
          return await fetchPromise;
        } finally {
          if (inFlightStatusFetches.get(statusFetchKey) === fetchPromise) {
            inFlightStatusFetches.delete(statusFetchKey);
          }
        }
      },

      moveStatusPathsOptimistically: (directory, paths, direction) => {
        const normalizedPaths = new Set(paths.map((path) => path.trim()).filter(Boolean));
        if (normalizedPaths.size === 0) {
          return null;
        }

        const { directories } = get();
        const dirState = directories.get(directory);
        const previousStatus = dirState?.status ?? null;
        if (!dirState || !previousStatus) {
          return previousStatus;
        }

        let didChange = false;
        const nextFiles: GitStatus['files'] = [];

        for (const file of previousStatus.files) {
          if (!normalizedPaths.has(file.path)) {
            nextFiles.push(file);
            continue;
          }

          const nextFile = direction === 'stage'
            ? toStagedStatusFile(file)
            : toUnstagedStatusFile(file);

          if (nextFile !== file) {
            didChange = true;
          }

          if (!isCleanStatusFile(nextFile)) {
            nextFiles.push(nextFile);
          } else {
            didChange = true;
          }
        }

        if (!didChange) {
          return previousStatus;
        }

        bumpStatusMutationRevision(get().runtimeKey, directory);

        const nextDirectories = new Map(directories);
        nextDirectories.set(directory, {
          ...dirState,
          status: {
            ...previousStatus,
            files: nextFiles,
            isClean: nextFiles.length === 0,
          },
          indexRevision: dirState.indexRevision + 1,
          lastStatusChange: Date.now(),
        });
        set({ directories: nextDirectories });

        return previousStatus;
      },

      restoreStatus: (directory, status) => {
        const { directories } = get();
        const dirState = directories.get(directory);
        if (!dirState) {
          return;
        }

        bumpStatusMutationRevision(get().runtimeKey, directory);

        const nextDirectories = new Map(directories);
        nextDirectories.set(directory, {
          ...dirState,
          status,
          indexRevision: dirState.indexRevision + 1,
          lastStatusChange: Date.now(),
        });
        set({ directories: nextDirectories });
      },

      bumpIndexRevision: (directory) => {
        const { directories } = get();
        const dirState = directories.get(directory);
        if (!dirState) {
          return;
        }

        bumpStatusMutationRevision(get().runtimeKey, directory);

        const nextDirectories = new Map(directories);
        nextDirectories.set(directory, {
          ...dirState,
          indexRevision: dirState.indexRevision + 1,
        });
        set({ directories: nextDirectories });
      },

      fetchBranches: async (directory, git) => {
        const runtimeKey = getRuntimeKey();
        const requestKey = runtimeDirectoryKey(runtimeKey, directory);
        const existing = inFlightBranchFetches.get(requestKey);
        if (existing) return existing;

        const token = startRequest(directory, 'branches');
        const pending: Promise<void> = (async () => {
          {
            const newDirectories = new Map(get().directories);
            const d = newDirectories.get(directory) ?? createEmptyDirectoryState();
            newDirectories.set(directory, { ...d, isLoadingBranches: true });
            set({ directories: newDirectories });
          }

          try {
            const branches = await git.getGitBranches(directory);
            if (!isRequestCurrent(token, directory)) return;
            const newDirectories = new Map(get().directories);
            const dirState = newDirectories.get(directory) ?? createEmptyDirectoryState();
            newDirectories.set(directory, { ...dirState, branches, isLoadingBranches: false, lastBranchesFetch: Date.now() });
            set({ directories: newDirectories });
            writeCachedBranches(token.runtimeKey, directory, branches);
          } catch (error) {
            console.error('Failed to fetch git branches:', error);
            if (!isRequestCurrent(token, directory)) return;
            const newDirectories = new Map(get().directories);
            const d = newDirectories.get(directory) ?? createEmptyDirectoryState();
            newDirectories.set(directory, { ...d, isLoadingBranches: false });
            set({ directories: newDirectories });
          }
        })().finally(() => {
          if (inFlightBranchFetches.get(requestKey) === pending) {
            inFlightBranchFetches.delete(requestKey);
          }
        });
        inFlightBranchFetches.set(requestKey, pending);
        return pending;
      },

      fetchLog: async (directory, git, maxCount) => {
        const token = startRequest(directory, 'log');
        const { directories } = get();
        const dirState = directories.get(directory);
        const effectiveMaxCount = maxCount ?? dirState?.logMaxCount ?? 25;

        {
          const newDirectories = new Map(get().directories);
          const d = newDirectories.get(directory) ?? createEmptyDirectoryState();
          newDirectories.set(directory, { ...d, isLoadingLog: true });
          set({ directories: newDirectories });
        }

        try {
          const log = await git.getGitLog(directory, { maxCount: effectiveMaxCount });
          if (!isRequestCurrent(token, directory)) return;
          const newDirectories = new Map(get().directories);
          const currentDirState = newDirectories.get(directory) ?? createEmptyDirectoryState();
          newDirectories.set(directory, {
            ...currentDirState,
            log,
            isLoadingLog: false,
            lastLogFetch: Date.now(),
            logMaxCount: effectiveMaxCount,
          });
          set({ directories: newDirectories });
        } catch (error) {
          console.error('Failed to fetch git log:', error);
          if (!isRequestCurrent(token, directory)) return;
          const newDirectories = new Map(get().directories);
          const d = newDirectories.get(directory) ?? createEmptyDirectoryState();
          newDirectories.set(directory, { ...d, isLoadingLog: false });
          set({ directories: newDirectories });
        }
      },

      fetchIdentity: async (directory, git) => {
        const token = startRequest(directory, 'identity');
        {
          const newDirectories = new Map(get().directories);
          const d = newDirectories.get(directory) ?? createEmptyDirectoryState();
          newDirectories.set(directory, { ...d, isLoadingIdentity: true });
          set({ directories: newDirectories });
        }

        try {
          const identity = await git.getCurrentGitIdentity(directory);
          if (!isRequestCurrent(token, directory)) return;
          const newDirectories = new Map(get().directories);
          const dirState = newDirectories.get(directory) ?? createEmptyDirectoryState();
          newDirectories.set(directory, { ...dirState, identity, isLoadingIdentity: false, lastIdentityFetch: Date.now() });
          set({ directories: newDirectories });
        } catch (error) {
          console.error('Failed to fetch git identity:', error);
          if (!isRequestCurrent(token, directory)) return;
          const newDirectories = new Map(get().directories);
          const d = newDirectories.get(directory) ?? createEmptyDirectoryState();
          newDirectories.set(directory, { ...d, isLoadingIdentity: false });
          set({ directories: newDirectories });
        }
      },

      fetchAll: async (directory, git, options = {}) => {
        const { directories } = get();
        let dirState = directories.get(directory);

        if (!dirState) {
          dirState = createEmptyDirectoryState();
          const newDirectories = new Map(directories);
          newDirectories.set(directory, dirState);
          set({ directories: newDirectories });
        }

        const { force = false, silentIfCached = false } = options;
        const now = Date.now();

        await get().fetchStatus(directory, git, {
          silent: silentIfCached && Boolean(dirState?.status),
        });

        const updatedDirState = get().directories.get(directory);
        if (!updatedDirState?.isGitRepo) return;

        await get().fetchBranches(directory, git);

        const logAge = now - (updatedDirState.lastLogFetch || 0);
        if (force || logAge > LOG_STALE_THRESHOLD || !updatedDirState.log) {
          await get().fetchLog(directory, git);
        }

        await get().fetchIdentity(directory, git);

        // Diff prefetch deferred — triggered on-demand when Git tab opens (GitView reactive prefetch)

      },

      getDiff: (directory, filePath) => {
        const dirState = get().directories.get(directory);
        return dirState?.diffCache.get(filePath) ?? null;
      },

      setDiff: (directory, filePath, diff, expectedRuntimeKey) => {
        if (expectedRuntimeKey && expectedRuntimeKey !== get().runtimeKey) return;
        if (diffEntrySize(diff) > DIFF_CACHE_MAX_TOTAL_SIZE_BYTES) return;
        const newDirectories = new Map(get().directories);
        const dirState = newDirectories.get(directory) ?? createEmptyDirectoryState();
        const newDiffCache = new Map(dirState.diffCache);
        newDiffCache.set(filePath, { ...diff, fetchedAt: Date.now() });
        // Apply LRU eviction to prevent memory bloat
        const evictedCache = evictDiffCacheIfNeeded(newDiffCache);
        newDirectories.set(directory, { ...dirState, diffCache: evictedCache });
        set({ directories: evictGlobalDiffCachesIfNeeded(newDirectories) });
      },

      clearDiffCache: (directory, filePaths) => {
        bumpDiffFetchGeneration(directory);
        startRequest(directory, 'diff');
        const newDirectories = new Map(get().directories);
        const dirState = newDirectories.get(directory);
        if (!dirState || dirState.diffCache.size === 0) return;

        const nextDiffCache = new Map(dirState.diffCache);
        if (filePaths) {
          for (const filePath of filePaths) {
            nextDiffCache.delete(filePath);
          }
        } else {
          nextDiffCache.clear();
        }
        if (nextDiffCache.size === dirState.diffCache.size) return;

        newDirectories.set(directory, { ...dirState, diffCache: nextDiffCache });
        set({ directories: newDirectories });
      },

      fetchAllDiffs: async (directory, git) => {
        const dirState = get().directories.get(directory);
        if (!dirState?.status?.files || dirState.status.files.length === 0) return;

        const limitedFilesToFetch = dirState.status.files
          .map((file) => file.path)
          .slice(0, DIFF_PREFETCH_MAX_FILES);
        await get().prefetchDiffs(directory, git, limitedFilesToFetch, { maxFiles: DIFF_PREFETCH_MAX_FILES });
      },

      prefetchDiffs: async (directory, git, filePaths, options = {}) => {
        const token = startRequest(directory, 'diff');
        const dirState = get().directories.get(directory);
        if (!dirState?.status?.files || dirState.status.files.length === 0 || filePaths.length === 0) return;

        const { maxFiles = DIFF_PREFETCH_FOCUS_MAX_FILES } = options;
        const availablePaths = new Set(dirState.status.files.map((file) => file.path));
        const diffStats = dirState.status.diffStats;
        const inFlight = getInFlightDiffs(directory);

        const dedupedPaths: string[] = [];
        const seen = new Set<string>();
        for (const filePath of filePaths) {
          if (!filePath || seen.has(filePath)) {
            continue;
          }
          seen.add(filePath);
          if (!availablePaths.has(filePath)) {
            continue;
          }
          if (dirState.diffCache.has(filePath)) {
            continue;
          }
          if (inFlight.has(filePath)) {
            continue;
          }
          // Skip large files during prefetch — they'll be fetched on-demand when user clicks
          const stats = diffStats?.[filePath];
          if (stats && (stats.insertions + stats.deletions) > DIFF_PREFETCH_LARGE_FILE_THRESHOLD) {
            continue;
          }
          dedupedPaths.push(filePath);
        }

        const limitedFilePaths = dedupedPaths.slice(0, Math.max(1, maxFiles));
        if (limitedFilePaths.length === 0) return;

        const generation = getDiffFetchGeneration(directory);

        if (typeof document !== 'undefined' && document.hidden) {
          return;
        }

        limitedFilePaths.forEach((path) => inFlight.add(path));

        let nextIndex = 0;
        const results: Array<{ path: string; diff: { original: string; modified: string; isBinary?: boolean } }> = [];

        const takeNext = () => {
          const current = nextIndex;
          nextIndex += 1;
          return current < limitedFilePaths.length ? limitedFilePaths[current] : null;
        };

        const fetchWithTimeout = async (filePath: string) => {
          const fetchPromise = git.getGitFileDiff(directory, { path: filePath });
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`Timed out after ${DIFF_PREFETCH_TIMEOUT_MS}ms`)), DIFF_PREFETCH_TIMEOUT_MS);
          });
          const response = await Promise.race([fetchPromise, timeoutPromise]);
          return {
            path: filePath,
            diff: { original: response.original ?? '', modified: response.modified ?? '', isBinary: response.isBinary },
          };
        };

        const worker = async () => {
          for (;;) {
            if (generation !== getDiffFetchGeneration(directory) || !isRequestCurrent(token, directory)) {
              return;
            }
            const next = takeNext();
            if (!next) return;
            try {
              results.push(await fetchWithTimeout(next));
            } catch {
              // Ignore individual failures/timeouts during prefetch.
            } finally {
              inFlight.delete(next);
            }
          }
        };

        const workerCount = Math.min(DIFF_PREFETCH_CONCURRENCY, limitedFilePaths.length);
        await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));

        limitedFilePaths.forEach((path) => inFlight.delete(path));

        if (generation !== getDiffFetchGeneration(directory) || !isRequestCurrent(token, directory)) {
          return;
        }

        // Update diff cache with results
        const newDirectories = new Map(get().directories);
        const currentDirState = newDirectories.get(directory);
        if (!currentDirState) return;

        const newDiffCache = new Map(currentDirState.diffCache);
        const now = Date.now();

        results.forEach((result) => {
          newDiffCache.set(result.path, {
            ...result.diff,
            fetchedAt: now
          });
        });

        // Apply LRU eviction to prevent memory bloat
        const evictedCache = evictDiffCacheIfNeeded(newDiffCache);
        newDirectories.set(directory, { ...currentDirState, diffCache: evictedCache });
        set({ directories: evictGlobalDiffCachesIfNeeded(newDirectories) });
      },

      setLogMaxCount: (directory, maxCount) => {
        const newDirectories = new Map(get().directories);
        const dirState = newDirectories.get(directory) ?? createEmptyDirectoryState();
        newDirectories.set(directory, { ...dirState, logMaxCount: maxCount });
        set({ directories: newDirectories });
      },

      ensureStatus: async (directory, git) => {
        const dirState = get().directories.get(directory);
        const now = Date.now();
        if (dirState?.status && now - dirState.lastStatusFetch < STATUS_STALE_THRESHOLD) {
          return;
        }
        await get().fetchStatus(directory, git, { silent: Boolean(dirState?.status) });
      },

      ensureAll: (directory, git) => {
        const ensureKey = runtimeDirectoryKey(getRuntimeKey(), directory);
        const existing = inFlightEnsureAllByDirectory.get(ensureKey);
        if (existing) return existing;

        const promise = (async () => {
          const dirState = get().directories.get(directory);
          const now = Date.now();
          const needsFullStatus = !dirState?.status || dirState.status.diffStats === undefined;

          if (needsFullStatus || now - (dirState?.lastStatusFetch ?? 0) >= STATUS_STALE_THRESHOLD) {
            await get().fetchStatus(directory, git, { silent: Boolean(dirState?.status) });
          }

          const updatedState = get().directories.get(directory);
          if (!updatedState?.isGitRepo) return;

          const fetches: Promise<void>[] = [];

          if (!updatedState.branches || now - updatedState.lastBranchesFetch >= BRANCHES_STALE_THRESHOLD) {
            fetches.push(get().fetchBranches(directory, git));
          }
          if (!updatedState.log || now - updatedState.lastLogFetch >= LOG_STALE_THRESHOLD) {
            fetches.push(get().fetchLog(directory, git));
          }
          if (!updatedState.identity || now - updatedState.lastIdentityFetch >= IDENTITY_STALE_THRESHOLD) {
            fetches.push(get().fetchIdentity(directory, git));
          }

          if (fetches.length > 0) await Promise.all(fetches);
        })();

        inFlightEnsureAllByDirectory.set(ensureKey, promise);
        promise.finally(() => {
          if (inFlightEnsureAllByDirectory.get(ensureKey) === promise) {
            inFlightEnsureAllByDirectory.delete(ensureKey);
          }
        });

        return promise;
      },

      refresh: async (git, options = {}) => {
        const { activeDirectory } = get();
        if (!activeDirectory) return;
        await get().fetchAll(activeDirectory, git, options);
      },
    }),
    { name: 'git-store' }
  )
);

export const useGitStatus = (directory: string | null) => {
  return useGitStore((state) => {
    if (!directory) return null;
    return state.directories.get(directory)?.status ?? null;
  });
};

export const useGitBranches = (directory: string | null) => {
  return useGitStore((state) => {
    if (!directory) return null;
    return state.directories.get(directory)?.branches ?? null;
  });
};

export const useGitLog = (directory: string | null) => {
  return useGitStore((state) => {
    if (!directory) return null;
    return state.directories.get(directory)?.log ?? null;
  });
};

export const useGitIdentity = (directory: string | null) => {
  return useGitStore((state) => {
    if (!directory) return null;
    return state.directories.get(directory)?.identity ?? null;
  });
};

export const useIsGitRepo = (directory: string | null) => {
  return useGitStore((state) => {
    if (!directory) return null;
    return state.directories.get(directory)?.isGitRepo ?? null;
  });
};

export const useGitBranchLabel = (directory: string | null) => {
  return useGitStore((state) => {
    if (!directory) return null;
    return state.directories.get(directory)?.status?.current?.trim() ?? null;
  });
};

const allBranchesCacheRef = { current: new Map<string, string | null>() };
const EMPTY_BRANCHES = new Map<string, string | null>();

export const useGitAllBranches = (enabled = true) => {
  return useGitStore((state) => {
    if (!enabled) return EMPTY_BRANCHES;
    const prev = allBranchesCacheRef.current;
    let same = prev.size === state.directories.size;
    if (same) {
      for (const [dir, dirState] of state.directories) {
        if (prev.get(dir) !== (dirState.status?.current ?? null)) { same = false; break; }
      }
    }
    if (same) return prev;
    const result = new Map<string, string | null>();
    for (const [dir, dirState] of state.directories) {
      result.set(dir, dirState.status?.current ?? null);
    }
    allBranchesCacheRef.current = result;
    return result;
  });
};

export const useGitRepoStatusMap = (directories: string[]) => {
  const cacheRef = React.useRef<Map<string, { isGitRepo: boolean | null; branch: string | null }>>(new Map());
  return useGitStore((state) => {
    const prev = cacheRef.current;
    let same = prev.size === directories.length;
    if (same) {
      for (const dir of directories) {
        const d = state.directories.get(dir);
        const pv = prev.get(dir);
        if (!pv || (d?.isGitRepo ?? null) !== pv.isGitRepo || (d?.status?.current ?? null) !== pv.branch) { same = false; break; }
      }
    }
    if (same) return prev;
    const result = new Map<string, { isGitRepo: boolean | null; branch: string | null }>();
    for (const dir of directories) {
      const d = state.directories.get(dir);
      result.set(dir, { isGitRepo: d?.isGitRepo ?? null, branch: d?.status?.current ?? null });
    }
    cacheRef.current = result;
    return result;
  });
};

export const useGitLoadingStatus = (directory: string | null) => {
  return useGitStore((state) => {
    if (!directory) return false;
    return state.directories.get(directory)?.isLoadingStatus ?? false;
  });
};

export const useGitLoadingLog = (directory: string | null) => {
  return useGitStore((state) => {
    if (!directory) return false;
    return state.directories.get(directory)?.isLoadingLog ?? false;
  });
};

export const useGitLoadingBranches = (directory: string | null) => {
  return useGitStore((state) => {
    if (!directory) return false;
    return state.directories.get(directory)?.isLoadingBranches ?? false;
  });
};
