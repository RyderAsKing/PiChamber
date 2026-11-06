import React from 'react';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

// Icons a project ships itself (favicon, app icon, logo), fetched once per
// runtime and directory and held as object URLs so every row that shows the
// project shares one download.

const FOUND_TTL_MS = 10 * 60 * 1000;
const RETRY_TTL_MS = 60 * 1000;
// Automatic retries after a failed request, for example while the server is
// still starting. Later failures wait for the next mount after RETRY_TTL_MS.
const FAILURE_RETRY_DELAYS_MS = [2_000, 5_000, 15_000];
const CACHE_CAPACITY = 200;

type ProjectIconEntry = {
  /** Object URL of the icon, or null while unknown or when the project has none. */
  url: string | null;
  expiresAt: number;
  loading: boolean;
  /** Consecutive failed requests; reset by any answer from the server. */
  failures: number;
};

const entries = new Map<string, ProjectIconEntry>();
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

// A runtime switch changes every cache key; re-render subscribers so they read
// (and load) entries for the new runtime.
subscribeRuntimeEndpointChanged(emit);

const normalizeDirectory = (directory: string | null | undefined): string | null => {
  const trimmed = directory?.trim();
  if (!trimmed) return null;
  return trimmed.length > 1 ? trimmed.replace(/[\\/]+$/, '') : trimmed;
};

const cacheKey = (directory: string) => `${getRuntimeKey()}\u0000${directory}`;

const store = (key: string, entry: ProjectIconEntry) => {
  const previous = entries.get(key);
  if (previous?.url && previous.url !== entry.url) URL.revokeObjectURL(previous.url);
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > CACHE_CAPACITY) {
    const [oldestKey, oldest] = entries.entries().next().value as [string, ProjectIconEntry];
    if (oldest.url) URL.revokeObjectURL(oldest.url);
    entries.delete(oldestKey);
  }
  emit();
};

const fetchIcon = async (directory: string): Promise<string | null> => {
  const response = await runtimeFetch('/api/fs/project-icon', { query: { directory } });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`Project icon request failed (${response.status})`);
  const blob = await response.blob();
  if (blob.size === 0 || !blob.type.startsWith('image/')) return null;
  return URL.createObjectURL(blob);
};

const load = (key: string, directory: string, force = false) => {
  const current = entries.get(key);
  if (current && (current.loading || (!force && current.expiresAt > Date.now()))) return;

  // Keep showing the previous icon while it is refreshed.
  const failures = current?.failures ?? 0;
  store(key, { url: current?.url ?? null, expiresAt: 0, loading: true, failures });
  void fetchIcon(directory).then(
    (url) => {
      if (entries.get(key)?.loading !== true) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      store(key, { url, expiresAt: Date.now() + (url ? FOUND_TTL_MS : RETRY_TTL_MS), loading: false, failures: 0 });
    },
    () => {
      // A failed request is not proof the project has no icon: keep any icon
      // already shown and try again later.
      const latest = entries.get(key);
      if (latest?.loading !== true) return;
      const retryDelay = FAILURE_RETRY_DELAYS_MS[failures];
      store(key, {
        url: latest.url,
        expiresAt: Date.now() + (retryDelay ?? RETRY_TTL_MS),
        loading: false,
        failures: failures + 1,
      });
      if (retryDelay === undefined) return;
      setTimeout(() => {
        // Only retry while something is still showing project icons.
        if (listeners.size > 0) load(key, directory, true);
      }, retryDelay);
    },
  );
};

/** Cached icon URL for `directory` on the active runtime, without loading it. */
export const readProjectIconUrl = (directory: string | null | undefined): string | null => {
  const normalized = normalizeDirectory(directory);
  return normalized ? entries.get(cacheKey(normalized))?.url ?? null : null;
};

/** Starts loading the icon unless a fresh or in-flight entry exists. */
export const ensureProjectIcon = (directory: string | null | undefined): void => {
  const normalized = normalizeDirectory(directory);
  if (normalized) load(cacheKey(normalized), normalized);
};

export const subscribeProjectIcons = subscribe;

/**
 * Object URL of the icon the project at `directory` ships, or null while it
 * loads, when it has none, or when the lookup failed.
 */
export const useProjectIconUrl = (directory: string | null | undefined): string | null => {
  const url = React.useSyncExternalStore(subscribe, () => readProjectIconUrl(directory), () => null);
  // Re-run after a runtime switch too: the key, not just the directory, changed.
  const normalized = normalizeDirectory(directory);
  const key = normalized ? cacheKey(normalized) : null;

  React.useEffect(() => {
    if (key) ensureProjectIcon(directory);
  }, [key, directory]);

  return url;
};

/** Test-only reset of the shared icon cache. */
export const resetProjectIconCacheForTests = () => {
  for (const entry of entries.values()) {
    if (entry.url) URL.revokeObjectURL(entry.url);
  }
  entries.clear();
  emit();
};
