import {
  type DirectoryGitState,
  DIFF_CACHE_MAX_ENTRIES,
  DIFF_CACHE_MAX_TOTAL_SIZE_BYTES,
  DIFF_CACHE_MAX_GLOBAL_ENTRIES,
} from './gitStoreTypes';

export const diffEntrySize = (entry: {
  original: string;
  modified: string;
}): number => {
  const encoder = new TextEncoder();
  return (
    encoder.encode(entry.original ?? '').byteLength +
    encoder.encode(entry.modified ?? '').byteLength
  );
};

// LRU eviction helper for diff cache
export const evictDiffCacheIfNeeded = (
  diffCache: Map<
    string,
    { original: string; modified: string; fetchedAt: number; isBinary?: boolean }
  >,
  maxEntries: number = DIFF_CACHE_MAX_ENTRIES,
  maxTotalSize: number = DIFF_CACHE_MAX_TOTAL_SIZE_BYTES
): Map<
  string,
  { original: string; modified: string; fetchedAt: number; isBinary?: boolean }
> => {
  // Calculate total size
  let totalSize = 0;
  for (const entry of diffCache.values()) {
    totalSize +=
      new TextEncoder().encode(entry.original ?? '').byteLength +
      new TextEncoder().encode(entry.modified ?? '').byteLength;
  }

  // If within limits, return as-is
  if (diffCache.size <= maxEntries && totalSize <= maxTotalSize) {
    return diffCache;
  }

  // Sort entries by fetchedAt (oldest first) for LRU eviction
  const entries = Array.from(diffCache.entries()).sort(
    (a, b) => a[1].fetchedAt - b[1].fetchedAt
  );

  const newCache = new Map<
    string,
    { original: string; modified: string; fetchedAt: number; isBinary?: boolean }
  >();
  let newTotalSize = 0;

  // Keep entries from newest to oldest until limits are reached
  for (let i = entries.length - 1; i >= 0; i--) {
    const [path, entry] = entries[i];
    const entrySize =
      new TextEncoder().encode(entry.original ?? '').byteLength +
      new TextEncoder().encode(entry.modified ?? '').byteLength;

    if (newCache.size >= maxEntries) break;
    if (newTotalSize + entrySize > maxTotalSize) continue;

    newCache.set(path, entry);
    newTotalSize += entrySize;
  }

  return newCache;
};

export const evictGlobalDiffCachesIfNeeded = (
  directories: Map<string, DirectoryGitState>
): Map<string, DirectoryGitState> => {
  const entries: Array<{
    directory: string;
    path: string;
    fetchedAt: number;
    size: number;
  }> = [];
  let totalSize = 0;
  for (const [directory, state] of directories) {
    for (const [path, entry] of state.diffCache) {
      const size = diffEntrySize(entry);
      entries.push({ directory, path, fetchedAt: entry.fetchedAt, size });
      totalSize += size;
    }
  }
  if (
    entries.length <= DIFF_CACHE_MAX_GLOBAL_ENTRIES &&
    totalSize <= DIFF_CACHE_MAX_TOTAL_SIZE_BYTES
  )
    return directories;

  const next = new Map(directories);
  entries.sort((left, right) => left.fetchedAt - right.fetchedAt);
  let count = entries.length;
  for (const entry of entries) {
    if (
      count <= DIFF_CACHE_MAX_GLOBAL_ENTRIES &&
      totalSize <= DIFF_CACHE_MAX_TOTAL_SIZE_BYTES
    )
      break;
    const state = next.get(entry.directory);
    if (!state?.diffCache.has(entry.path)) continue;
    const diffCache = new Map(state.diffCache);
    diffCache.delete(entry.path);
    next.set(entry.directory, { ...state, diffCache });
    count -= 1;
    totalSize -= entry.size;
  }
  return next;
};
