import { useSyncExternalStore } from 'react';
import type { GitHubErrorBody, GitHubAPIError } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import i18n from '@/i18n';

/**
 * Generic keyed async-resource helper for GitHub list/detail entries.
 *
 * Contract (plan §7.1):
 * - last-known-first with background revalidation;
 * - request-generation stale guards (a slow response never overwrites newer state);
 * - a failed refresh keeps previous data, marked stale with the error, and
 *   never replaces it with empty;
 * - in-flight coalescing (identical concurrent loads share one request);
 * - explicit invalidate clears the entry and re-reads through the loader.
 *
 * Keys must include the runtime identity plus repo (+ filters/number) — use
 * `buildGitHubResourceKey` so colliding repo names on different runtimes
 * cannot share entries. Runtime switches reset via `reset()` (stores wire
 * this to the established runtime-switch flow).
 *
 * This helper is UI-state only; stores own the `RuntimeAPIs.github` calls
 * and pass loaders in. Server invalidation (`POST /api/github/invalidate`)
 * runs in the store's `invalidate` before re-reading, so an ordinary read
 * never bypasses the server cache.
 *
 * Memory is bounded: each resource holds at most `maxEntries` entries and
 * evicts least-recently-used entries that are neither in flight nor
 * subscribed. Remote-search resources additionally cap per-repo query
 * entries at the store layer (one entry per distinct query string).
 */

export type GitHubResourceError = GitHubErrorBody;

export type GitHubResourceEntry<TData> = {
  data: TData | null;
  fetchedAt: number | null;
  isLoading: boolean;
  /** True when `data` is last-known-good served after a failed refresh. */
  stale: boolean;
  error: GitHubResourceError | null;
  generation: number;
};

export const buildGitHubResourceKey = (parts: Array<string | number | null | undefined>): string => {
  return [getRuntimeKey(), ...parts.map((part) => (part ?? '').toString())].join('\n');
};

const toResourceError = (error: unknown): GitHubResourceError => {
  const body = (error as GitHubAPIError | null)?.body;
  if (body && typeof body.kind === 'string') return body as GitHubErrorBody;
  return { kind: 'failed', message: error instanceof Error ? error.message : i18n.t('GitHub request failed') };
};

export type KeyedAsyncResource<TData> = {
  getEntry: (key: string) => GitHubResourceEntry<TData> | null;
  snapshot: () => Record<string, GitHubResourceEntry<TData>>;
  /** Subscribe to changes of one key's entry. Listener fires only for that key. */
  subscribe: (key: string, listener: () => void) => () => void;
  ensure: (key: string, loader: () => Promise<TData>, options?: { force?: boolean }) => Promise<GitHubResourceEntry<TData>>;
  refresh: (key: string, loader: () => Promise<TData>) => Promise<GitHubResourceEntry<TData>>;
  invalidate: (keyOrPrefix: string, loader?: () => Promise<TData>, options?: { exact?: boolean }) => Promise<GitHubResourceEntry<TData> | null>;
  /** Mark an entry stale without fetching, so the next ensure revalidates. Coalesced, never a fetch. */
  markStale: (key: string) => void;
  /** Record a page-level failure on a loaded entry, keeping its items for retry. */
  setError: (key: string, error: unknown) => GitHubResourceEntry<TData> | null;
  remove: (key: string) => void;
  reset: () => void;
};

export type KeyedAsyncResourceOptions = {
  /**
   * Called after every load settles (success or failure), including the
   * background revalidation `ensure` starts for cached entries. Entries live
   * outside React state, so stores use this to notify subscribers; without
   * it a background load's `isLoading: false` never repaints.
   */
  onSettle?: (key: string) => void;
  /** Bound on cached entries. Least-recently-used non-inflight, unsubscribed entries are evicted. */
  maxEntries?: number;
};

/** Default bound: comfortably above two collections × repos in scope plus detail entries. */
const DEFAULT_RESOURCE_MAX_ENTRIES = 200;

export const createKeyedAsyncResource = <TData>(
  resourceOptions: KeyedAsyncResourceOptions = {},
): KeyedAsyncResource<TData> => {
  const maxEntries = resourceOptions.maxEntries ?? DEFAULT_RESOURCE_MAX_ENTRIES;
  const entries = new Map<string, GitHubResourceEntry<TData>>();
  const inFlight = new Map<string, Promise<GitHubResourceEntry<TData>>>();
  const generations = new Map<string, number>();
  // Monotonic recency sequence (never wall-clock: same-millisecond writes
  // must still order deterministically for LRU eviction).
  let accessSequence = 0;
  const lastAccess = new Map<string, number>();
  const listeners = new Map<string, Set<() => void>>();

  const readEntry = (key: string): GitHubResourceEntry<TData> | null => {
    const entry = entries.get(key) ?? null;
    if (entry) lastAccess.set(key, (accessSequence += 1));
    return entry;
  };

  const notifyKey = (key: string): void => {
    const keyListeners = listeners.get(key);
    if (!keyListeners) return;
    for (const listener of [...keyListeners]) {
      try {
        listener();
      } catch {
        // A throwing subscriber must not break the store for others.
      }
    }
  };

  /** Evict least-recently-used entries past the bound. Runs outside the acquisition path. */
  const evictIfNeeded = (): void => {
    if (entries.size <= maxEntries) return;
    const candidates = [...entries.keys()]
      .filter((key) => !inFlight.has(key) && (listeners.get(key)?.size ?? 0) === 0)
      .sort((a, b) => (lastAccess.get(a) ?? 0) - (lastAccess.get(b) ?? 0));
    const overflow = entries.size - maxEntries;
    for (let index = 0; index < overflow && index < candidates.length; index += 1) {
      const key = candidates[index] as string;
      entries.delete(key);
      lastAccess.delete(key);
      generations.set(key, (generations.get(key) ?? 0) + 1);
    }
  };

  // Eviction scans are deferred so a render mounting many entries scans once,
  // never once per entry on the acquisition path.
  let evictScheduled = false;
  const scheduleEvict = (): void => {
    if (evictScheduled || entries.size <= maxEntries) return;
    evictScheduled = true;
    const run = () => {
      evictScheduled = false;
      evictIfNeeded();
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(run);
    else setTimeout(run, 0);
  };

  const writeEntry = (key: string, patch: Partial<GitHubResourceEntry<TData>>): GitHubResourceEntry<TData> => {
    const prev = entries.get(key) ?? {
      data: null,
      fetchedAt: null,
      isLoading: false,
      stale: false,
      error: null,
      generation: generations.get(key) ?? 0,
    };
    const next = { ...prev, ...patch };
    entries.set(key, next);
    lastAccess.set(key, (accessSequence += 1));
    scheduleEvict();
    notifyKey(key);
    return next;
  };

  const runLoad = async (key: string, loader: () => Promise<TData>): Promise<GitHubResourceEntry<TData>> => {
    const existing = inFlight.get(key);
    if (existing) return existing;

    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);

    const prev = entries.get(key);
    writeEntry(key, { isLoading: true, generation });

    const task = (async (): Promise<GitHubResourceEntry<TData>> => {
      try {
        const data = await loader();
        if (generations.get(key) !== generation) {
          // Stale completion: a newer load or reset won the race. Keep
          // current state untouched so it cannot resurrect old data.
          return entries.get(key) ?? {
            data, fetchedAt: Date.now(), isLoading: false, stale: false, error: null, generation,
          };
        }
        return writeEntry(key, {
          data,
          fetchedAt: Date.now(),
          isLoading: false,
          stale: false,
          error: null,
          generation,
        });
      } catch (error) {
        if (generations.get(key) !== generation) {
          return entries.get(key) ?? {
            data: prev?.data ?? null,
            fetchedAt: prev?.fetchedAt ?? null,
            isLoading: false,
            stale: true,
            error: toResourceError(error),
            generation,
          };
        }
        // Failed refresh keeps previous data marked stale with the error —
        // never replaces it with empty.
        if (prev?.data != null) {
          return writeEntry(key, {
            isLoading: false,
            stale: true,
            error: toResourceError(error),
            generation,
          });
        }
        return writeEntry(key, {
          data: null,
          fetchedAt: null,
          isLoading: false,
          stale: false,
          error: toResourceError(error),
          generation,
        });
      }
    })();

    inFlight.set(key, task);
    try {
      return await task;
    } finally {
      if (inFlight.get(key) === task) inFlight.delete(key);
      resourceOptions.onSettle?.(key);
    }
  };

  return {
    getEntry: readEntry,
    snapshot: () => Object.fromEntries(entries),
    subscribe: (key, listener) => {
      let keyListeners = listeners.get(key);
      if (!keyListeners) {
        keyListeners = new Set();
        listeners.set(key, keyListeners);
      }
      keyListeners.add(listener);
      return () => {
        const current = listeners.get(key);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) listeners.delete(key);
      };
    },
    ensure: (key, loader, options) => {
      if (!options?.force && inFlight.has(key)) return inFlight.get(key) as Promise<GitHubResourceEntry<TData>>;
      if (!options?.force && entries.get(key)?.data != null && entries.get(key)?.isLoading) {
        return inFlight.get(key) ?? Promise.resolve(entries.get(key) as GitHubResourceEntry<TData>);
      }
      // Last-known-first: when cached data exists, return it immediately and
      // revalidate in the background without flipping `isLoading` for callers
      // that already hold data. runLoad still coalesces the network request.
      if (!options?.force && entries.get(key)?.data != null) {
        void runLoad(key, loader);
        return Promise.resolve(entries.get(key) as GitHubResourceEntry<TData>);
      }
      return runLoad(key, loader);
    },
    refresh: (key, loader) => runLoad(key, loader),
    invalidate: async (keyOrPrefix, loader, options) => {
      const exact = options?.exact ?? true;
      if (exact) {
        generations.set(keyOrPrefix, (generations.get(keyOrPrefix) ?? 0) + 1);
        entries.delete(keyOrPrefix);
        lastAccess.delete(keyOrPrefix);
        if (inFlight.has(keyOrPrefix)) inFlight.delete(keyOrPrefix);
        notifyKey(keyOrPrefix);
        if (!loader) return null;
        return runLoad(keyOrPrefix, loader);
      }
      for (const key of [...entries.keys()]) {
        if (key === keyOrPrefix || key.startsWith(keyOrPrefix)) {
          generations.set(key, (generations.get(key) ?? 0) + 1);
          entries.delete(key);
          lastAccess.delete(key);
          inFlight.delete(key);
          notifyKey(key);
        }
      }
      return null;
    },
    markStale: (key) => {
      const prev = entries.get(key);
      if (!prev?.data) return;
      if (prev.stale) return;
      writeEntry(key, { stale: true });
    },
    setError: (key, error) => {
      const prev = entries.get(key);
      if (!prev?.data) return prev ?? null;
      return writeEntry(key, { isLoading: false, stale: true, error: toResourceError(error) });
    },
    remove: (key) => {
      generations.set(key, (generations.get(key) ?? 0) + 1);
      entries.delete(key);
      lastAccess.delete(key);
      inFlight.delete(key);
      notifyKey(key);
    },
    reset: () => {
      const keys = [...entries.keys()];
      entries.clear();
      inFlight.clear();
      generations.clear();
      lastAccess.clear();
      for (const key of keys) notifyKey(key);
    },
  };
};

/**
 * Per-resource-key subscription: re-renders only when that key's entry
 * changes. List surfaces subscribe to their repo's collection/remote keys;
 * details subscribe to their number's keys — a load settling for PR A never
 * notifies a subscriber of PR B or another repo's list.
 */
export const useKeyedResourceEntry = <TData>(
  resource: KeyedAsyncResource<TData>,
  key: string | null,
): GitHubResourceEntry<TData> | null => {
  return useSyncExternalStore(
    (onChange) => {
      if (!key) return () => {};
      return resource.subscribe(key, onChange);
    },
    () => (key ? resource.getEntry(key) : null),
    () => (key ? resource.getEntry(key) : null),
  );
};
