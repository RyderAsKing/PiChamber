import React from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { GitHubAPI, GitHubErrorBody, GitHubScope } from '@/lib/api/types';
import { GitHubAPIError } from '@/lib/api/types';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { normalizeDirectoryPathKey } from '@/lib/directoryPathKey';
import { useUIStore } from '@/stores/useUIStore';
import { normalizeGitHubRepoRef } from '@/stores/ui/githubSelection';
import i18n from '@/i18n';

export const GITHUB_SCOPE_STALE_MS = 30_000;

export type GitHubScopeEntry = {
  scope: GitHubScope | null;
  fetchedAt: number | null;
  isLoading: boolean;
  stale: boolean;
  error: GitHubErrorBody | null;
};

type ScopeStoreState = {
  runtimeKey: string;
  entriesByDirectory: Record<string, GitHubScopeEntry>;
  resetForRuntimeSwitch: (runtimeKey?: string) => void;
  ensureScope: (directory: string, github?: GitHubAPI | null) => Promise<GitHubScopeEntry>;
  refreshScope: (directory: string, github?: GitHubAPI | null, options?: { force?: boolean }) => Promise<GitHubScopeEntry>;
  setSelectedRepo: (directory: string, repoRef: string | null) => void;
  invalidate: (directory: string, github?: GitHubAPI | null) => Promise<GitHubScopeEntry | null>;
};

const emptyEntry = (): GitHubScopeEntry => ({
  scope: null,
  fetchedAt: null,
  isLoading: false,
  stale: false,
  error: null,
});

const inFlightByKey = new Map<string, Promise<GitHubScopeEntry>>();

const scopeKeyFor = (runtimeKey: string, directory: string): string => `${runtimeKey}\n${directory}`;

const toScopeError = (error: unknown): GitHubErrorBody => {
  const body = (error as GitHubAPIError | null)?.body;
  if (body && typeof body.kind === 'string') return body as GitHubErrorBody;
  return { kind: 'failed', message: error instanceof Error ? error.message : i18n.t('GitHub scope check failed') };
};

const repoRefOf = (entry: { host: string | null; owner: string | null; repo: string | null }): string | null => {
  if (!entry.host || !entry.owner || !entry.repo) return null;
  return normalizeGitHubRepoRef(`${entry.host}/${entry.owner}/${entry.repo}`);
};

const isSelectable = (entry: { host: string | null; owner: string | null; repo: string | null; disabledReason?: string | null }): boolean => {
  return Boolean(entry.host && entry.owner && entry.repo && !entry.disabledReason);
};

/** Resolve the effective selection: persisted pick when still valid, else scope default. */
export const resolveGitHubSelectedRepo = (scope: GitHubScope | null, persistedRef: string | null): string | null => {
  if (!scope) return persistedRef;
  const selectable = new Set(
    scope.repositories.filter(isSelectable).map((entry) => repoRefOf(entry)).filter((ref): ref is string => Boolean(ref)),
  );
  if (persistedRef && selectable.has(persistedRef)) return persistedRef;
  if (scope.defaultSelection && selectable.has(scope.defaultSelection)) return scope.defaultSelection;
  const containing = scope.repositories.find((entry) => entry.kind === 'containing' && isSelectable(entry));
  const containingRef = containing ? repoRefOf(containing) : null;
  if (containingRef && selectable.has(containingRef)) return containingRef;
  const first = scope.repositories.find(isSelectable);
  return first ? repoRefOf(first) : null;
};

export const useGitHubScopeStore = create<ScopeStoreState>()(
  devtools(
    (set, get) => ({
      runtimeKey: getRuntimeKey(),
      entriesByDirectory: {},

      resetForRuntimeSwitch: (runtimeKey) => {
        const next = runtimeKey ?? getRuntimeKey();
        inFlightByKey.clear();
        set({ runtimeKey: next, entriesByDirectory: {} });
      },

      ensureScope: async (directory, github) => {
        const normalized = normalizeDirectoryPathKey(directory.trim());
        if (!normalized) return emptyEntry();
        const runtimeKey = getRuntimeKey();
        if (get().runtimeKey !== runtimeKey) get().resetForRuntimeSwitch(runtimeKey);
        const entry = get().entriesByDirectory[normalized];
        const now = Date.now();
        if (entry?.scope && entry.fetchedAt && now - entry.fetchedAt < GITHUB_SCOPE_STALE_MS && !entry.isLoading) {
          return entry;
        }
        return get().refreshScope(normalized, github);
      },

      refreshScope: async (directory, github, options) => {
        const normalized = normalizeDirectoryPathKey(directory.trim());
        if (!normalized) return emptyEntry();
        const runtimeKey = getRuntimeKey();
        if (get().runtimeKey !== runtimeKey) get().resetForRuntimeSwitch(runtimeKey);

        const key = scopeKeyFor(runtimeKey, normalized);
        const existing = inFlightByKey.get(key);
        if (existing && !options?.force) return existing;

        const api = github ?? null;
        if (!api) return get().entriesByDirectory[normalized] ?? emptyEntry();

        const prev = get().entriesByDirectory[normalized] ?? emptyEntry();
        if (!prev.isLoading) {
          set((state) => ({
            entriesByDirectory: {
              ...state.entriesByDirectory,
              [normalized]: { ...prev, isLoading: true },
            },
          }));
        }

        const task = (async (): Promise<GitHubScopeEntry> => {
          try {
            const scope = await api.scope(normalized);
            if (getRuntimeKey() !== runtimeKey) return get().entriesByDirectory[normalized] ?? emptyEntry();
            const next: GitHubScopeEntry = { scope, fetchedAt: Date.now(), isLoading: false, stale: false, error: null };
            set((state) => ({ entriesByDirectory: { ...state.entriesByDirectory, [normalized]: next } }));
            // Clamp a stale persisted pick: when the saved repo is no longer
            // selectable, fall back now so the shell never renders a dead repo.
            const persisted = useUIStore.getState().githubSelectedRepoByDirectory[normalized] ?? null;
            const resolved = resolveGitHubSelectedRepo(scope, persisted);
            if (resolved !== persisted) {
              useUIStore.getState().setGitHubSelectedRepo(normalized, resolved);
            }
            return next;
          } catch (error) {
            if (getRuntimeKey() !== runtimeKey) return get().entriesByDirectory[normalized] ?? emptyEntry();
            const body = toScopeError(error);
            // Failed refresh keeps previous scope marked stale — never empty.
            const next: GitHubScopeEntry = prev.scope
              ? { ...prev, isLoading: false, stale: true, error: body }
              : { scope: null, fetchedAt: null, isLoading: false, stale: false, error: body };
            set((state) => ({ entriesByDirectory: { ...state.entriesByDirectory, [normalized]: next } }));
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

      setSelectedRepo: (directory, repoRef) => {
        const normalized = normalizeDirectoryPathKey(directory.trim());
        if (!normalized) return;
        const entry = get().entriesByDirectory[normalized]?.scope ?? null;
        if (repoRef != null) {
          const ref = normalizeGitHubRepoRef(repoRef);
          if (!ref) return;
          // Only persist repos in scope; unknown refs are rejected so the
          // server allow-list can never be probed with an arbitrary value.
          if (entry) {
            const allowed = new Set(
              entry.repositories.filter(isSelectable).map((candidate) => repoRefOf(candidate)).filter((value): value is string => Boolean(value)),
            );
            if (!allowed.has(ref)) return;
          }
          useUIStore.getState().setGitHubSelectedRepo(normalized, ref);
          return;
        }
        useUIStore.getState().setGitHubSelectedRepo(normalized, null);
      },

      invalidate: async (directory, github) => {
        const normalized = normalizeDirectoryPathKey(directory.trim());
        if (!normalized) return null;
        const api = github ?? null;
        if (api) {
          try {
            await api.invalidate({ directory: normalized });
          } catch {
            // Server invalidation is best-effort; the re-read below still
            // refreshes through the server cache TTL.
          }
        }
        return get().refreshScope(normalized, api ?? undefined, { force: true });
      },
    }),
    { name: 'github-scope-store' },
  ),
);

if (typeof window !== 'undefined') {
  subscribeRuntimeEndpointChanged((detail) => {
    useGitHubScopeStore.getState().resetForRuntimeSwitch(detail.runtimeKey);
  });
}

// Stable selector fallback; a fresh object per call loops zustand's snapshot.
const EMPTY_SCOPE_ENTRY: GitHubScopeEntry = Object.freeze(emptyEntry());

/** Scope entry for a directory (null scope + error distinguishes failure from empty). */
export const useGitHubScope = (directory: string | null): GitHubScopeEntry => {
  return useGitHubScopeStore((state) => {
    if (!directory) return EMPTY_SCOPE_ENTRY;
    return state.entriesByDirectory[normalizeDirectoryPathKey(directory)] ?? EMPTY_SCOPE_ENTRY;
  });
};

/** Effective `host/owner/repo` selection for a directory (persisted pick or scope default). */
export const useGitHubSelectedRepo = (directory: string | null): string | null => {
  const scope = useGitHubScopeStore((state) => {
    if (!directory) return null;
    return state.entriesByDirectory[normalizeDirectoryPathKey(directory)]?.scope ?? null;
  });
  const persisted = useUIStore((state) => {
    if (!directory) return null;
    return state.githubSelectedRepoByDirectory[normalizeDirectoryPathKey(directory)] ?? null;
  });
  // Memoized: resolution builds a throwaway allow-list set per call, so it
  // must not run during render on every unrelated store update.
  return React.useMemo(
    () => (directory ? resolveGitHubSelectedRepo(scope, persisted) : null),
    [directory, scope, persisted],
  );
};
