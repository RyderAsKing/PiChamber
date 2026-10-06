import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { GitHubAPI, GitHubStatus } from '@/lib/api/types';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import i18n from '@/i18n';

export const GITHUB_STATUS_STALE_MS = 60_000;
const FOCUS_REFRESH_THROTTLE_MS = 30_000;

type StatusState = {
  status: GitHubStatus | null;
  fetchedAt: number | null;
  isLoading: boolean;
  error: string | null;
  runtimeKey: string;
  resetForRuntimeSwitch: (runtimeKey?: string) => void;
  refresh: (github?: GitHubAPI | null, options?: { force?: boolean }) => Promise<GitHubStatus | null>;
};

const inFlightByRuntime = new Map<string, Promise<GitHubStatus | null>>();
let lastFocusRefreshAt = 0;
let focusSubscribed = false;

const ensureFocusSubscription = () => {
  if (focusSubscribed || typeof window === 'undefined') return;
  focusSubscribed = true;
  const onFocus = () => {
    const now = Date.now();
    if (now - lastFocusRefreshAt < FOCUS_REFRESH_THROTTLE_MS) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    lastFocusRefreshAt = now;
    // Throttled refresh on window focus. The store reads the registered
    // runtime API lazily so focus handling never captures a stale endpoint.
    void import('@/contexts/runtimeAPIRegistry').then(({ getRegisteredRuntimeAPIs }) => {
      const github = getRegisteredRuntimeAPIs()?.github;
      if (!github) return;
      void useGitHubStatusStore.getState().refresh(github);
    }).catch(() => {});
  };
  window.addEventListener('focus', onFocus);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) onFocus();
    });
  }
};

export const useGitHubStatusStore = create<StatusState>()(
  devtools(
    (set, get) => ({
      status: null,
      fetchedAt: null,
      isLoading: false,
      error: null,
      runtimeKey: getRuntimeKey(),

      resetForRuntimeSwitch: (runtimeKey) => {
        const next = runtimeKey ?? getRuntimeKey();
        inFlightByRuntime.clear();
        set({ status: null, fetchedAt: null, isLoading: false, error: null, runtimeKey: next });
      },

      refresh: async (github, options) => {
        ensureFocusSubscription();
        const runtimeKey = getRuntimeKey();
        if (get().runtimeKey !== runtimeKey) {
          get().resetForRuntimeSwitch(runtimeKey);
        }
        const state = get();
        const now = Date.now();
        if (!options?.force && state.status && state.fetchedAt && now - state.fetchedAt < GITHUB_STATUS_STALE_MS) {
          return state.status;
        }
        const existing = inFlightByRuntime.get(runtimeKey);
        if (existing) return existing;

        const api = github ?? null;
        if (!api) return get().status;

        const task = (async (): Promise<GitHubStatus | null> => {
          set({ isLoading: true });
          try {
            const status = await api.status();
            if (getRuntimeKey() !== runtimeKey) return null;
            set({ status, fetchedAt: Date.now(), isLoading: false, error: null, runtimeKey });
            return status;
          } catch (error) {
            if (getRuntimeKey() !== runtimeKey) return null;
            // Failure preserves last-known status; it never clears to empty.
            set({
              isLoading: false,
              error: error instanceof Error ? error.message : i18n.t('GitHub status check failed'),
            });
            return get().status;
          }
        })();

        inFlightByRuntime.set(runtimeKey, task);
        try {
          return await task;
        } finally {
          if (inFlightByRuntime.get(runtimeKey) === task) inFlightByRuntime.delete(runtimeKey);
        }
      },
    }),
    { name: 'github-status-store' },
  ),
);

// Keep runtime-scoped status from leaking across endpoint switches when a
// consumer never calls reset explicitly (mirrors useGitStore guards).
if (typeof window !== 'undefined') {
  subscribeRuntimeEndpointChanged((detail) => {
    useGitHubStatusStore.getState().resetForRuntimeSwitch(detail.runtimeKey);
  });
}

/** Primary signed-in login across hosts, or null when unauthenticated. */
export const useGitHubLogin = (): string | null => {
  return useGitHubStatusStore((state) => {
    const hosts = state.status?.hosts ?? [];
    return hosts.find((host) => host.authenticated)?.login ?? null;
  });
};

