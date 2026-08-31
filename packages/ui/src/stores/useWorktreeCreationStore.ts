import { create } from 'zustand';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';
import type { GitAPI } from '@/lib/api/types';
import type {
  DraftWorktreeIntent,
  DraftWorktreeCreationReceipt,
} from '@/sync/session-ui-store';
import { deriveWorktreeName } from '@/components/chat/composer/state/worktreeName';

const BOOTSTRAP_POLL_MS = 500;

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

export type DraftWorktreeCreationState = WorktreeCreationState;

export type WorktreeCreationEntry = {
  key: string;
  intent: DraftWorktreeIntent;
  state: WorktreeCreationState | null;
  receipt: DraftWorktreeCreationReceipt | null;
  path?: string | null;
  branch?: string | null;
  startedAt: number;
  updatedAt: number;
};

type WorktreeCreationStore = {
  entries: Map<string, WorktreeCreationEntry>;
  /** Get entry for an intent (or null). */
  getEntry: (intent: DraftWorktreeIntent | null | undefined) => WorktreeCreationEntry | null;
  getEntryByKey: (key: string) => WorktreeCreationEntry | null;
  /** Active entries with in-flight state (not null, not failed is also considered active for UI). */
  getActiveEntries: () => WorktreeCreationEntry[];
  /** All entries that have a receipt (completed). */
  getCompletedEntries: () => WorktreeCreationEntry[];
  clearEntry: (key: string) => void;
  clearReceipt: (key: string) => void;
  dismissFailed: (key: string) => void;
  resetForRuntimeSwitch: (runtimeKey: string) => void;
  /** Start or resume a creation. Returns receipt on success. Throws on failure. */
  request: (params: {
    intent: DraftWorktreeIntent;
    prompt: string;
    git: GitAPI;
    refreshProject: (projectRoot: string, git: GitAPI) => Promise<unknown>;
  }) => Promise<DraftWorktreeCreationReceipt>;
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
    const schedule = typeof window !== 'undefined' && typeof window.setTimeout === 'function'
      ? window.setTimeout.bind(window)
      : setTimeout;
    schedule(resolve, milliseconds);
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

// Generation map lives outside zustand state so polling loops can check staleness
// without reading stale closure state.
const generations = new Map<string, number>();

export const useWorktreeCreationStore = create<WorktreeCreationStore>()((set, get) => ({
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
      if (entry.state && entry.state.phase !== 'failed') {
        result.push(entry);
      }
    }
    return result;
  },

  getCompletedEntries: () => {
    const result: WorktreeCreationEntry[] = [];
    for (const entry of get().entries.values()) {
      if (entry.receipt) result.push(entry);
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

  clearReceipt: (key) => {
    set((state) => {
      const entry = state.entries.get(key);
      if (!entry || !entry.receipt) return state;
      const entries = new Map(state.entries);
      entries.set(key, { ...entry, receipt: null, updatedAt: Date.now() });
      // If no active state either, remove the entry entirely to keep the map clean
      const updated = entries.get(key)!;
      if (!updated.state && !updated.receipt) {
        entries.delete(key);
      }
      return { entries };
    });
  },

  dismissFailed: (key) => {
    set((state) => {
      const entry = state.entries.get(key);
      if (!entry) return state;
      if (entry.state?.phase !== 'failed') return state;
      const entries = new Map(state.entries);
      // Keep receipt if any? Failed entries have no receipt.
      entries.delete(key);
      generations.delete(key);
      return { entries };
    });
  },

  resetForRuntimeSwitch: (_runtimeKey) => {
    generations.clear();
    set({ entries: new Map() });
  },

  request: async ({ intent, prompt, git, refreshProject }) => {
    const key = intentKey(intent);
    const previousGeneration = generations.get(key) ?? 0;
    const generation = previousGeneration + 1;
    generations.set(key, generation);

    const isStale = (): boolean =>
      generations.get(key) !== generation || intent.runtimeKey !== getRuntimeKey();

    const setEntryState = (state: WorktreeCreationState | null): void => {
      set((s) => {
        const entries = new Map(s.entries);
        const existing = entries.get(key);
        const now = Date.now();
        if (existing) {
          entries.set(key, { ...existing, state, updatedAt: now });
        } else {
          entries.set(key, {
            key,
            intent,
            state,
            receipt: null,
            startedAt: now,
            updatedAt: now,
          });
        }
        return { entries };
      });
    };

    const setEntryReceipt = (receipt: DraftWorktreeCreationReceipt, path?: string | null, branch?: string | null): void => {
      set((s) => {
        const entries = new Map(s.entries);
        const existing = entries.get(key);
        const now = Date.now();
        entries.set(key, {
          key,
          intent,
          state: null,
          receipt,
          path: path ?? receipt.path,
          branch: branch ?? receipt.branch,
          startedAt: existing?.startedAt ?? now,
          updatedAt: now,
        });
        return { entries };
      });
    };

    const setEntryPath = (path: string, branch: string): void => {
      set((s) => {
        const entries = new Map(s.entries);
        const existing = entries.get(key);
        if (!existing) return s;
        entries.set(key, { ...existing, path, branch, updatedAt: Date.now() });
        return { entries };
      });
    };

    // If there's already an active creation for this key, don't start a second one.
    const existing = get().entries.get(key);
    if (existing?.state && existing.state.phase !== 'failed') {
      // Already in flight — return its eventual receipt by waiting for it?
      // For simplicity, return early and let caller observe state via store.
      // But if caller expects a receipt promise, we need to wait.
      // Instead we throw to indicate busy, caller will observe via store.
      // However ChatInput's guard expects request to be no-op when busy.
      // We mimic that: return a promise that resolves when current generation completes,
      // by polling the entry.
      // Simplest: if already active, return existing receipt if any or wait.
      // We'll just return early with no receipt; caller will see state via store.
      // To keep the promise contract, we wait for the active entry to settle.
      // Avoid infinite loop: poll entry until state null or failed.
      // Let's just throw a sentinel that caller treats as no-op.
      // The caller checks `if (state && state.phase !== 'failed') return;` before calling,
      // so this branch shouldn't be hit via that guard. If it is hit via global banner restart,
      // we want to reuse the in-flight promise — so we wait.
      let attempts = 0;
      while (attempts < 600) {
        const current = get().entries.get(key);
        if (!current) break;
        if (current.receipt) return current.receipt;
        if (current.state?.phase === 'failed') throw new Error(current.state.error ?? 'Failed to create the worktree.');
        if (!current.state) break;
        await delay(200);
        attempts += 1;
      }
      // If still active after wait, just return without receipt.
      // Callers that poll will see state.
      const cur = get().entries.get(key);
      if (cur?.receipt) return cur.receipt;
      throw new Error('Worktree creation is already in progress.');
    }

    // Clear any previous receipt for this intent to start fresh
    set((s) => {
      const entries = new Map(s.entries);
      const now = Date.now();
      entries.set(key, {
        key,
        intent,
        state: { phase: 'naming', label: 'Naming worktree...' },
        receipt: null,
        startedAt: now,
        updatedAt: now,
      });
      return { entries };
    });

    if (!git?.createGitWorktree || !git.getGitWorktreeBootstrapStatus) {
      const errorState: WorktreeCreationState = {
        phase: 'failed',
        label: 'Worktree creation failed',
        error: 'Git worktrees are unavailable for this runtime.',
      };
      setEntryState(errorState);
      throw new Error(errorState.error);
    }

    if (intent.runtimeKey !== getRuntimeKey()) {
      const errorState: WorktreeCreationState = {
        phase: 'failed',
        label: 'Worktree creation stopped',
        error: 'The runtime changed. Select New worktree again.',
      };
      setEntryState(errorState);
      throw new Error(errorState.error);
    }

    try {
      // Naming phase already set
      const worktreeName = await deriveWorktreeName(prompt, intent.sourceDirectory);
      if (isStale()) {
        // Abandon but keep entry for background continuation? If stale due to generation bump,
        // a newer request is already in flight, so discard this one.
        // The newer generation's state will overwrite.
        throw new Error('Worktree creation superseded.');
      }

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
      if (isStale()) throw new Error('Worktree creation superseded.');

      setEntryState({ phase: 'creating', label: 'Creating worktree...' });
      const created = await git.createGitWorktree(intent.sourceDirectory, createInput);
      if (isStale()) return created as unknown as DraftWorktreeCreationReceipt; // still need to allow background to complete? But we are stale - another generation took over, so abandon.
      // Persist path early so global UI can show it
      setEntryPath(created.path, created.branch);

      let bootstrap = created.bootstrapStatus;
      while (bootstrap.status === 'pending') {
        setEntryState(
          bootstrap.phase === 'directory-created'
            ? { phase: 'checking-out', label: 'Checking out files...' }
            : { phase: 'setting-up', label: 'Setting up project...' },
        );
        await delay(BOOTSTRAP_POLL_MS);
        if (isStale()) return created as unknown as DraftWorktreeCreationReceipt;
        bootstrap = await git.getGitWorktreeBootstrapStatus(created.path);
      }
      if (bootstrap.status === 'failed' || bootstrap.phase !== 'setup-ready') {
        throw new Error(bootstrap.error || 'Worktree setup failed.');
      }

      await refreshProject(intent.projectRoot, git);
      if (isStale()) {
        // Still store receipt but don't treat as current generation's success
        const receipt: DraftWorktreeCreationReceipt = {
          ...intent,
          path: created.path,
          branch: created.branch,
        };
        // Store under this generation's key but generation already bumped -> newer request will handle
        // So we don't overwrite newer state.
        return receipt;
      }

      const receipt: DraftWorktreeCreationReceipt = {
        ...intent,
        path: created.path,
        branch: created.branch,
      };
      setEntryReceipt(receipt, created.path, created.branch);
      return receipt;
    } catch (error) {
      if (isStale()) {
        // If stale due to superseded, don't overwrite newer entry's state
        throw error;
      }
      // Runtime changed during await? Check again
      if (intent.runtimeKey !== getRuntimeKey()) {
        // Don't treat as failure of this intent, just clear?
      }
      const message = error instanceof Error ? error.message : 'Failed to create the worktree.';
      // Don't clobber if message is superseded sentinel
      if (message === 'Worktree creation superseded.') {
        throw error;
      }
      try {
        if (intent.runtimeKey === getRuntimeKey()) {
          void refreshProject(intent.projectRoot, git);
        }
      } catch {
        // ignore refresh failure
      }
      setEntryState({
        phase: 'failed',
        label: 'Worktree creation failed',
        error: message,
      });
      throw error;
    }
  },
}));

export const getWorktreeCreationKey = (intent: DraftWorktreeIntent | null | undefined): string | null =>
  getEntryKey(intent);

export const worktreeCreationIntentMatches = intentMatches;
