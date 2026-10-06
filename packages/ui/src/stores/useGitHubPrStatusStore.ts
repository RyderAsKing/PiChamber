import React from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { GitHubAPI, GitHubChecksSummary, GitHubErrorBody, GitHubPullRequestSummary } from '@/lib/api/types';
import { GitHubAPIError } from '@/lib/api/types';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { normalizeDirectoryPathKey } from '@/lib/directoryPathKey';
import i18n from '@/i18n';

/**
 * Current-branch PR status for Git chips and sidebar badges (plan §7.2).
 *
 * - Entries keyed by `runtime + directory + branch` (worktrees share the
 *   containing checkout's branch, so they naturally share status).
 * - Last-known-first with background revalidation; failed refreshes keep
 *   previous data marked stale, never empty.
 * - Polling tiers: open + checks pending: 1 min, open + settled: 5 min,
 *   no PR: 5 min discovery. Paused while hidden; visibility resume
 *   revalidates stale entries sequentially (max 1 in flight).
 * - Bounded to `PR_STATUS_MAX_ENTRIES` branch entries; least-recently-
 *   accessed branches evict first.
 * - Keeps the existing exported API (`getGitHubPrStatusKey`, `usePrVisualSummary`, `results`,
 *   `refresh`/`load`, `resetForRuntimeSwitch`) used by SessionSidebar,
 *   SessionGroupSection, and useSessionNodeItemMetadata.
 */

export type GitHubPrStatusEntry = {
  pr: GitHubPullRequestSummary | null;
  checks: GitHubChecksSummary | null;
  checksStale?: boolean;
  defaultBranch?: string | null;
  skippedDefaultBranch?: boolean;
  fetchedAt: number | null;
  isLoading: boolean;
  stale: boolean;
  error: GitHubErrorBody | null;
};

type PrStatusStore = {
  results: Record<string, GitHubPrStatusEntry>;
  refresh: (directory: string, branch: string | null, github?: GitHubAPI | null, options?: { force?: boolean }) => Promise<GitHubPrStatusEntry | null>;
  load: (directory: string, branch: string | null, github?: GitHubAPI | null) => Promise<GitHubPrStatusEntry | null>;
  resetForRuntimeSwitch: (runtimeKey?: string) => void;
};

export const PR_STATUS_NO_PR_POLL_MS = 5 * 60_000;
export const PR_STATUS_OPEN_PENDING_POLL_MS = 60_000;
export const PR_STATUS_OPEN_SETTLED_POLL_MS = 5 * 60_000;
/** Bound on cached branch entries; least-recently-accessed entries evict first. */
export const PR_STATUS_MAX_ENTRIES = 100;

const inFlightByKey = new Map<string, Promise<GitHubPrStatusEntry | null>>();
const generationsByKey = new Map<string, number>();
const pollTimersByKey = new Map<string, ReturnType<typeof setTimeout>>();
const lastAccessByKey = new Map<string, number>();

export const getGitHubPrStatusKey = (directory?: string | null, branch?: string | null): string => {
  const normalizedDirectory = normalizeDirectoryPathKey((directory ?? '').trim());
  const normalizedBranch = (branch ?? '').trim();
  if (!normalizedDirectory || !normalizedBranch) return '';
  return `${getRuntimeKey()}\n${normalizedDirectory}\n${normalizedBranch}`;
};

const emptyEntry = (): GitHubPrStatusEntry => ({
  pr: null,
  checks: null,
  fetchedAt: null,
  isLoading: false,
  stale: false,
  error: null,
});

const toStatusError = (error: unknown): GitHubErrorBody => {
  const body = (error as GitHubAPIError | null)?.body;
  if (body && typeof body.kind === 'string') return body as GitHubErrorBody;
  return { kind: 'failed', message: error instanceof Error ? error.message : i18n.t('PR status check failed') };
};

const evictOldestBranches = (
  results: Record<string, GitHubPrStatusEntry>,
): Record<string, GitHubPrStatusEntry> => {
  const keys = Object.keys(results);
  if (keys.length <= PR_STATUS_MAX_ENTRIES) return results;
  const byAge = keys.sort((a, b) => (lastAccessByKey.get(a) ?? 0) - (lastAccessByKey.get(b) ?? 0));
  const next = { ...results };
  for (let index = 0; index < byAge.length - PR_STATUS_MAX_ENTRIES; index += 1) {
    const key = byAge[index] as string;
    delete next[key];
    lastAccessByKey.delete(key);
    generationsByKey.delete(key);
    // Clear the pending poll timer or it will fire and resurrect the key.
    const timer = pollTimersByKey.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      pollTimersByKey.delete(key);
    }
  }
  return next;
};

const nextPollDelay = (entry: GitHubPrStatusEntry): number => {
  if (!entry.pr) return PR_STATUS_NO_PR_POLL_MS;
  if (entry.pr.state !== 'open') return PR_STATUS_OPEN_SETTLED_POLL_MS;
  return entry.checks?.state === 'pending' ? PR_STATUS_OPEN_PENDING_POLL_MS : PR_STATUS_OPEN_SETTLED_POLL_MS;
};

const schedulePoll = (key: string, directory: string, branch: string, github?: GitHubAPI | null) => {
  if (typeof window === 'undefined') return;
  if (pollTimersByKey.has(key)) return;
  const entry = useGitHubPrStatusStore.getState().results[key];
  if (!entry) return;
  const delay = nextPollDelay(entry);
  const timer = setTimeout(() => {
    pollTimersByKey.delete(key);
    // Never resurrect an evicted key: a timer firing after eviction is stale.
    if (!useGitHubPrStatusStore.getState().results[key]) return;
    if (typeof document !== 'undefined' && document.hidden) {
      schedulePoll(key, directory, branch, github);
      return;
    }
    void useGitHubPrStatusStore.getState().refresh(directory, branch, github);
  }, delay);
  // Timers must never keep a test runner or background page alive on their own.
  if (typeof timer === 'object' && timer !== null && typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
  pollTimersByKey.set(key, timer);
};

export const useGitHubPrStatusStore = create<PrStatusStore>()(
  devtools(
    (set, get) => ({
      results: {},

      refresh: async (directory, branch, github, options) => {
        const normalizedDirectory = normalizeDirectoryPathKey((directory || '').trim());
        const normalizedBranch = (branch || '').trim();
        if (!normalizedDirectory || !normalizedBranch) return null;
        const key = getGitHubPrStatusKey(normalizedDirectory, normalizedBranch);
        if (!key) return null;

        const existing = inFlightByKey.get(key);
        if (existing && !options?.force) return existing;

        const api = github ?? null;
        if (!api) return get().results[key] ?? null;

        const generation = (generationsByKey.get(key) ?? 0) + 1;
        generationsByKey.set(key, generation);

        const prev = get().results[key] ?? emptyEntry();
        set((state) => ({ results: { ...state.results, [key]: { ...prev, isLoading: true } } }));

        const task = (async (): Promise<GitHubPrStatusEntry | null> => {
          try {
            const result = await api.prStatus(normalizedDirectory, normalizedBranch);
            if (generationsByKey.get(key) !== generation) return get().results[key] ?? null;
            if (getRuntimeKey() !== key.split('\n')[0]) return get().results[key] ?? null;
            const next: GitHubPrStatusEntry = {
              pr: result.pr ?? null,
              checks: result.checks ?? null,
              checksStale: result.checksStale,
              defaultBranch: result.defaultBranch ?? null,
              skippedDefaultBranch: result.skippedDefaultBranch,
              fetchedAt: result.fetchedAt ?? Date.now(),
              isLoading: false,
              stale: false,
              error: null,
            };
            lastAccessByKey.set(key, Date.now());
            set((state) => ({ results: evictOldestBranches({ ...state.results, [key]: next }) }));
            schedulePoll(key, normalizedDirectory, normalizedBranch, api);
            return next;
          } catch (error) {
            if (generationsByKey.get(key) !== generation) return get().results[key] ?? null;
            const body = toStatusError(error);
            // Failure keeps previous data marked stale — a failed section
            // never clears the badge to empty.
            const next: GitHubPrStatusEntry = prev.pr || prev.fetchedAt
              ? { ...prev, isLoading: false, stale: true, error: body }
              : { ...emptyEntry(), error: body };
            set((state) => ({ results: { ...state.results, [key]: next } }));
            schedulePoll(key, normalizedDirectory, normalizedBranch, api);
            return next;
          }
        })();

        inFlightByKey.set(key, task);
        try {
          return await task;
        } finally {
          if (inFlightByKey.get(key) === task) inFlightByKey.delete(key);
        }
      },

      load: async (directory, branch, github) => {
        const normalizedDirectory = normalizeDirectoryPathKey((directory || '').trim());
        const normalizedBranch = (branch || '').trim();
        if (!normalizedDirectory || !normalizedBranch) return null;
        const key = getGitHubPrStatusKey(normalizedDirectory, normalizedBranch);
        lastAccessByKey.set(key, Date.now());
        const cached = get().results[key];
        if (cached && (cached.pr || cached.fetchedAt)) {
          // Last-known-first: revalidate in the background.
          void get().refresh(normalizedDirectory, normalizedBranch, github);
          return cached;
        }
        return get().refresh(normalizedDirectory, normalizedBranch, github);
      },

      resetForRuntimeSwitch: () => {
        inFlightByKey.clear();
        generationsByKey.clear();
        lastAccessByKey.clear();
        checksIndexCache = null;
        for (const timer of pollTimersByKey.values()) clearTimeout(timer);
        pollTimersByKey.clear();
        set({ results: {} });
      },
    }),
    { name: 'github-pr-status-store' },
  ),
);

if (typeof window !== 'undefined') {
  subscribeRuntimeEndpointChanged(() => {
    useGitHubPrStatusStore.getState().resetForRuntimeSwitch();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // Resume polling on visible: revalidate entries whose tier elapsed while
    // hidden, sequentially (max 1 in flight) so a long-hidden window does
    // not fan out one fetch per branch at once.
    void (async () => {
      const github = await import('@/contexts/runtimeAPIRegistry')
        .then(({ getRegisteredRuntimeAPIs }) => getRegisteredRuntimeAPIs()?.github ?? null)
        .catch(() => null);
      if (!github) return;
      const now = Date.now();
      const staleKeys = Object.entries(useGitHubPrStatusStore.getState().results)
        .filter(([, entry]) => entry.fetchedAt && now - (entry.fetchedAt as number) >= nextPollDelay(entry))
        .map(([key]) => key);
      for (const key of staleKeys) {
        const [, directory, branch] = key.split('\n');
        if (!directory || !branch) continue;
        if (typeof document !== 'undefined' && document.hidden) return;
        await useGitHubPrStatusStore.getState().refresh(directory, branch, github).catch(() => null);
      }
    })();
  });
}

/**
 * Checks state by PR URL, derived once per `results` change and shared by
 * all row consumers. Keyed by `url` because PR numbers collide across
 * repositories. Row hooks do O(rows) map lookups against this index
 * instead of O(rows × status entries) nested scans per render.
 */
let checksIndexCache: { results: Record<string, GitHubPrStatusEntry>; index: Map<string, string | null> } | null = null;

export const selectPrChecksIndex = (
  results: Record<string, GitHubPrStatusEntry>,
): Map<string, string | null> => {
  if (checksIndexCache && checksIndexCache.results === results) return checksIndexCache.index;
  const index = new Map<string, string | null>();
  for (const entry of Object.values(results)) {
    const url = entry.pr?.url;
    if (!url || index.has(url)) continue;
    index.set(url, entry.checks?.state ?? null);
  }
  checksIndexCache = { results, index };
  return index;
};

export type PrVisualSummary = {
  visualState: 'merged' | 'open' | 'blocked' | 'draft' | 'closed';
  number: number;
  draft?: boolean;
  title?: string;
  canMerge?: boolean;
  mergeableState?: string;
  checks?: { state?: string; total?: number; failure?: number; pending?: number; success?: number };
};

/** Compact badge model for sidebar rows: number + checks state. */
const toPrVisualSummary = (entry: GitHubPrStatusEntry | null): PrVisualSummary | null => {
  const pr = entry?.pr;
  if (!pr) return null;
  if (pr.state === 'merged') {
    return { visualState: 'merged', number: pr.number, draft: pr.draft, title: pr.title };
  }
  if (pr.state === 'closed') {
    return { visualState: 'closed', number: pr.number, draft: pr.draft, title: pr.title };
  }
  if (pr.draft) {
    return {
      visualState: 'draft',
      number: pr.number,
      draft: true,
      title: pr.title,
      mergeableState: pr.mergeableState ?? undefined,
      checks: entry?.checks ? { state: entry.checks.state } : undefined,
    };
  }
  const checksState = entry?.checks?.state;
  const mergeableState = pr.mergeableState ?? undefined;
  if (mergeableState === 'dirty' || mergeableState === 'blocked' || checksState === 'failure') {
    return {
      visualState: 'blocked',
      number: pr.number,
      draft: false,
      title: pr.title,
      mergeableState,
      checks: entry?.checks ? { state: entry.checks.state, total: entry.checks.total, failure: entry.checks.failure, pending: entry.checks.pending, success: entry.checks.success } : undefined,
    };
  }
  return {
    visualState: 'open',
    number: pr.number,
    draft: false,
    title: pr.title,
    mergeableState,
    checks: entry?.checks ? { state: entry.checks.state, total: entry.checks.total, failure: entry.checks.failure, pending: entry.checks.pending, success: entry.checks.success } : undefined,
  };
};

export const usePrVisualSummary = (key?: string | null): PrVisualSummary | null => {
  const entry = useGitHubPrStatusStore((state) => (key ? state.results[key] ?? null : null));
  return React.useMemo(() => toPrVisualSummary(entry), [entry]);
};

/** Ensure hook for sidebar rows: loads once per directory+branch and polls per tier. */
export const useEnsureGitHubPrStatus = (
  directory: string | null,
  branch: string | null,
  github?: GitHubAPI | null,
): void => {
  const key = React.useMemo(() => getGitHubPrStatusKey(directory, branch), [directory, branch]);
  const explicitApi = github ?? null;
  React.useEffect(() => {
    if (!key || !directory?.trim() || !branch?.trim()) return;
    let cancelled = false;
    void import('@/contexts/runtimeAPIRegistry').then(({ getRegisteredRuntimeAPIs }) => {
      if (cancelled) return;
      const api = explicitApi ?? getRegisteredRuntimeAPIs()?.github ?? null;
      if (!api) return;
      void useGitHubPrStatusStore.getState().load(directory, branch, api);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [key, directory, branch, explicitApi]);
};
