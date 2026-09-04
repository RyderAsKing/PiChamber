import { create } from 'zustand';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';
import type { GitAPI, GitWorktreeCreateResult } from '@/lib/api/types';
import type {
  DraftWorktreeIntent,
  DraftWorktreeCreationReceipt,
} from '@/sync/session-ui-store';
import { deriveWorktreeName } from '@/components/chat/composer/state/worktreeName';

const BOOTSTRAP_POLL_MS = 500;

export const WORKTREE_CREATION_SUPERSEDED = 'Worktree creation superseded.';

export type WorktreeCreationPhase =
  | 'naming'
  | 'creating'
  | 'checking-out'
  | 'setting-up'
  | 'failed';

export type WorktreeCreationState = {
  phase: WorktreeCreationPhase;
  label: string;
  error?: string;
};

export type WorktreeCreationEntry = {
  key: string;
  intent: DraftWorktreeIntent;
  state: WorktreeCreationState | null;
  receipt: DraftWorktreeCreationReceipt | null;
  notificationSent: boolean;
  path?: string | null;
  branch?: string | null;
  startedAt: number;
  updatedAt: number;
};

type WorktreeCreationRequestParams = {
  taskId?: string;
  intent: DraftWorktreeIntent;
  prompt: string;
  git: GitAPI;
  refreshProject: (projectRoot: string, git: GitAPI) => Promise<unknown>;
  pollIntervalMs?: number;
};

type WorktreeCreationStore = {
  runtimeKey: string;
  entries: Map<string, WorktreeCreationEntry>;
  getEntry: (intent: DraftWorktreeIntent | null | undefined) => WorktreeCreationEntry | null;
  getEntryByKey: (key: string) => WorktreeCreationEntry | null;
  getActiveEntries: () => WorktreeCreationEntry[];
  clearEntry: (key: string) => void;
  markNotificationSent: (key: string) => void;
  dismissFailed: (key: string) => void;
  resetForRuntimeSwitch: (runtimeKey: string) => void;
  request: (params: WorktreeCreationRequestParams) => Promise<DraftWorktreeCreationReceipt>;
};

const intentKey = (intent: DraftWorktreeIntent): string => {
  const projectRoot = normalizePath(intent.projectRoot) ?? intent.projectRoot;
  const sourceDirectory = normalizePath(intent.sourceDirectory) ?? intent.sourceDirectory;
  return JSON.stringify([intent.runtimeKey, projectRoot, sourceDirectory, intent.startRef]);
};

const getEntryKey = (intent: DraftWorktreeIntent | null | undefined): string | null => {
  if (!intent) return null;
  return intentKey(intent);
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const intentMatches = (
  left: DraftWorktreeIntent | null | undefined,
  right: DraftWorktreeIntent | null | undefined,
): boolean =>
  Boolean(
    left
      && right
      && left.runtimeKey === right.runtimeKey
      && normalizePath(left.projectRoot) === normalizePath(right.projectRoot)
      && normalizePath(left.sourceDirectory) === normalizePath(right.sourceDirectory)
      && left.startRef === right.startRef,
  );

const toReceipt = (
  intent: DraftWorktreeIntent,
  created: Pick<GitWorktreeCreateResult, 'path' | 'branch'>,
): DraftWorktreeCreationReceipt => ({
  ...intent,
  path: created.path,
  branch: created.branch,
});

const generations = new Map<string, number>();
const inFlight = new Map<string, Promise<DraftWorktreeCreationReceipt>>();

const patchEntry = (
  set: (partial: Partial<Pick<WorktreeCreationStore, 'entries'>> | ((state: WorktreeCreationStore) => Partial<Pick<WorktreeCreationStore, 'entries'>>)) => void,
  key: string,
  patch: (existing: WorktreeCreationEntry | undefined, now: number) => WorktreeCreationEntry | null,
): void => {
  set((state) => {
    const existing = state.entries.get(key);
    const nextEntry = patch(existing, Date.now());
    if (!nextEntry && !existing) return state;
    const entries = new Map(state.entries);
    if (!nextEntry) entries.delete(key);
    else entries.set(key, nextEntry);
    return { entries };
  });
};

export const useWorktreeCreationStore = create<WorktreeCreationStore>()((set, get) => {
  const setEntryState = (key: string, intent: DraftWorktreeIntent, state: WorktreeCreationState | null): void => {
    patchEntry(set, key, (existing, now) => {
      if (existing) return { ...existing, state, updatedAt: now };
      return {
        key,
        intent,
        state,
        receipt: null,
        notificationSent: false,
        startedAt: now,
        updatedAt: now,
      };
    });
  };

  const setEntryReceipt = (
    key: string,
    intent: DraftWorktreeIntent,
    receipt: DraftWorktreeCreationReceipt,
    path?: string | null,
    branch?: string | null,
  ): void => {
    patchEntry(set, key, (existing, now) => ({
      key,
      intent,
      state: null,
      receipt,
      notificationSent: existing?.notificationSent ?? false,
      path: path ?? receipt.path,
      branch: branch ?? receipt.branch,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
    }));
  };

  const setEntryPath = (key: string, path: string, branch: string): void => {
    patchEntry(set, key, (existing, now) => {
      if (!existing) return null;
      return { ...existing, path, branch, updatedAt: now };
    });
  };

  const runRequest = async (params: WorktreeCreationRequestParams): Promise<DraftWorktreeCreationReceipt> => {
    const { intent, prompt, git, refreshProject } = params;
    const pollIntervalMs = params.pollIntervalMs ?? BOOTSTRAP_POLL_MS;
    const key = params.taskId ?? intentKey(intent);
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);

    const isStale = (): boolean =>
      generations.get(key) !== generation || intent.runtimeKey !== getRuntimeKey();

    const refreshIfCurrentRuntime = (): void => {
      if (intent.runtimeKey !== getRuntimeKey()) return;
      void refreshProject(intent.projectRoot, git).catch(() => undefined);
    };

    setEntryState(key, intent, { phase: 'naming', label: 'Naming worktree...' });

    if (!git?.createGitWorktree || !git.getGitWorktreeBootstrapStatus) {
      const error = 'Git worktrees are unavailable for this runtime.';
      setEntryState(key, intent, { phase: 'failed', label: 'Worktree creation failed', error });
      throw new Error(error);
    }

    if (intent.runtimeKey !== getRuntimeKey()) {
      const error = 'The runtime changed. Select New worktree again.';
      setEntryState(key, intent, { phase: 'failed', label: 'Worktree creation stopped', error });
      throw new Error(error);
    }

    try {
      const worktreeName = await deriveWorktreeName(prompt, intent.sourceDirectory);
      if (isStale()) throw new Error(WORKTREE_CREATION_SUPERSEDED);

      const createInput = {
        mode: 'new' as const,
        startRef: intent.startRef,
        ...(worktreeName ? { worktreeName } : {}),
        returnAfterDirectoryCreated: true,
      };

      if (git.validateGitWorktree) {
        const validation = await git.validateGitWorktree(intent.sourceDirectory, createInput);
        if (!validation.ok) {
          throw new Error(
            validation.errors.map((error) => error.message).filter(Boolean).join('\n') || 'The worktree request is invalid.',
          );
        }
      }
      if (isStale()) throw new Error(WORKTREE_CREATION_SUPERSEDED);

      setEntryState(key, intent, { phase: 'creating', label: 'Creating worktree...' });
      const created = await git.createGitWorktree(intent.sourceDirectory, createInput);
      const receipt = toReceipt(intent, created);
      if (isStale()) return receipt;

      setEntryPath(key, created.path, created.branch);

      let bootstrap = created.bootstrapStatus;
      while (bootstrap.status === 'pending') {
        if (isStale()) return receipt;
        setEntryState(
          key,
          intent,
          bootstrap.phase === 'directory-created'
            ? { phase: 'checking-out', label: 'Checking out files...' }
            : { phase: 'setting-up', label: 'Setting up project...' },
        );
        await delay(pollIntervalMs);
        if (isStale()) return receipt;
        bootstrap = await git.getGitWorktreeBootstrapStatus(created.path);
      }
      if (bootstrap.status === 'failed' || bootstrap.phase !== 'setup-ready') {
        throw new Error(bootstrap.error || 'Worktree setup failed.');
      }

      try {
        await refreshProject(intent.projectRoot, git);
      } catch {
        // The worktree is already setup-ready; discovery refresh is best-effort.
      }
      if (isStale()) return receipt;

      setEntryReceipt(key, intent, receipt, created.path, created.branch);
      return receipt;
    } catch (error) {
      if (isStale()) throw error;
      const message = error instanceof Error ? error.message : 'Failed to create the worktree.';
      if (message === WORKTREE_CREATION_SUPERSEDED) throw error;
      refreshIfCurrentRuntime();
      setEntryState(key, intent, {
        phase: 'failed',
        label: 'Worktree creation failed',
        error: message,
      });
      throw error;
    }
  };

  return {
    runtimeKey: getRuntimeKey(),
    entries: new Map(),

    getEntry: (intent) => {
      const key = getEntryKey(intent);
      if (!key) return null;
      return get().entries.get(key) ?? null;
    },

    getEntryByKey: (key) => get().entries.get(key) ?? null,

    getActiveEntries: () => {
      const result: WorktreeCreationEntry[] = [];
      for (const entry of get().entries.values()) {
        if (entry.state && entry.state.phase !== 'failed') result.push(entry);
      }
      return result;
    },

    clearEntry: (key) => {
      set((state) => {
        if (!state.entries.has(key)) return state;
        const entries = new Map(state.entries);
        entries.delete(key);
        generations.delete(key);
        return { entries };
      });
    },

    markNotificationSent: (key) => {
      patchEntry(set, key, (existing, now) => {
        if (!existing || existing.notificationSent) return existing ?? null;
        return { ...existing, notificationSent: true, updatedAt: now };
      });
    },

    dismissFailed: (key) => {
      set((state) => {
        const entry = state.entries.get(key);
        if (entry?.state?.phase !== 'failed') return state;
        const entries = new Map(state.entries);
        entries.delete(key);
        generations.delete(key);
        return { entries };
      });
    },

    resetForRuntimeSwitch: (runtimeKey) => {
      generations.clear();
      inFlight.clear();
      set({ runtimeKey, entries: new Map() });
    },

    request: (params) => {
      const key = params.taskId ?? intentKey(params.intent);
      const existing = inFlight.get(key);
      if (existing) return existing;

      const run = runRequest(params).finally(() => {
        if (inFlight.get(key) === run) inFlight.delete(key);
      });
      inFlight.set(key, run);
      return run;
    },
  };
});

export const getWorktreeCreationKey = (intent: DraftWorktreeIntent | null | undefined): string | null =>
  getEntryKey(intent);

export const worktreeCreationIntentMatches = intentMatches;
