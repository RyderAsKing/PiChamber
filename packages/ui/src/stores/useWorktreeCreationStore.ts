import { create } from 'zustand';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';
import type { GitAPI, GitWorktreeCreateResult } from '@/lib/api/types';
import type {
  DraftWorktreeIntent,
  DraftWorktreeCreationReceipt,
} from '@/sync/session-ui-store';
import type { AttachedFile } from '@/stores/types/sessionTypes';
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

export type WorktreeFailedSend = {
  prompt: string;
  confirmedMentions: string[];
  attachments: AttachedFile[];
};

export type WorktreeCreationEntry = {
  key: string;
  intent: DraftWorktreeIntent;
  state: WorktreeCreationState | null;
  receipt: DraftWorktreeCreationReceipt | null;
  /**
   * Task-owned prompt/mentions/attachment snapshot retained through receipt
   * until prompt dispatch settles. Pre-receipt failure exposes it as a failed
   * recovery; post-receipt prompt failure transitions the same entry to failed
   * with the snapshot intact; prompt acceptance consumes the exact generation.
   * Memory-only.
   */
  failedSend: WorktreeFailedSend | null;
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
  /**
   * Task-owned prompt recovery payload retained through receipt until prompt
   * dispatch settles. Pre-receipt failure exposes it as failed recovery;
   * post-receipt prompt failure transitions the same entry; prompt acceptance
   * consumes the exact generation.
   */
  failedSend?: {
    prompt: string;
    confirmedMentions: readonly string[] | Set<string>;
    attachments: readonly AttachedFile[];
  };
  /** Nullable: a missing runtime git still retains `failedSend` in task state. */
  git: GitAPI | null | undefined;
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
  /**
   * Guarded restore consume: delete only the same failed entry/payload that
   * was read. Refuses when the key now holds a newer in-flight, completed,
   * or re-failed generation (different `failedSend` identity).
   */
  consumeFailedSend: (key: string, expected: WorktreeFailedSend) => boolean;
  /**
   * Prompt acceptance: delete the task only when the live entry still holds
   * the exact snapshot captured at receipt. A late success never clears a
   * newer generation. Requires a receipt so in-flight entries are preserved.
   */
  markWorktreePromptSucceeded: (key: string, expected: WorktreeFailedSend) => boolean;
  /**
   * Post-receipt prompt failure: transition the same receipt entry into an
   * explicit failed-send recovery with the snapshot intact. Guarded to the
   * exact generation like `consumeFailedSend`; a late failure never
   * overwrites a newer generation.
   */
  markWorktreePromptFailed: (key: string, expected: WorktreeFailedSend, error: string) => boolean;
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

const cloneFailedSendAttachment = (file: AttachedFile): AttachedFile => ({
  ...file,
  previewUrl: undefined,
  uploadState: file.uploadState
    ? ({ ...file.uploadState } as AttachedFile["uploadState"])
    : file.uploadState,
});

const cloneFailedSend = (
  failedSend: NonNullable<WorktreeCreationRequestParams["failedSend"]>,
): WorktreeFailedSend => ({
  prompt: failedSend.prompt,
  confirmedMentions: Array.from(new Set(Array.isArray(failedSend.confirmedMentions) ? failedSend.confirmedMentions : [...failedSend.confirmedMentions])),
  attachments: failedSend.attachments.map(cloneFailedSendAttachment),
});

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
      // Structural stale-failure clear: re-entering naming/in-flight must not
      // retain a previous generation's `failedSend`, or a deferred restore
      // could read the old payload and a stale failure could linger in the UI.
      if (existing) return { ...existing, state, failedSend: null, updatedAt: now };
      return {
        key,
        intent,
        state,
        receipt: null,
        failedSend: null,
        notificationSent: false,
        startedAt: now,
        updatedAt: now,
      };
    });
  };

  const setEntryFailed = (
    key: string,
    intent: DraftWorktreeIntent,
    state: WorktreeCreationState,
    failedSend: WorktreeFailedSend | null,
  ): void => {
    patchEntry(set, key, (existing, now) => ({
      key,
      intent,
      state,
      receipt: null,
      failedSend,
      notificationSent: existing?.notificationSent ?? false,
      path: existing?.path ?? null,
      branch: existing?.branch ?? null,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
    }));
  };

  const setEntryReceipt = (
    key: string,
    intent: DraftWorktreeIntent,
    receipt: DraftWorktreeCreationReceipt,
    failedSend: WorktreeFailedSend | null,
    path?: string | null,
    branch?: string | null,
  ): void => {
    patchEntry(set, key, (existing, now) => ({
      key,
      intent,
      state: null,
      receipt,
      // Retain the task-owned snapshot through receipt while prompt
      // materialization/dispatch is pending. Prompt acceptance consumes the
      // exact generation; post-receipt failure transitions this same entry
      // to failed with the snapshot intact.
      failedSend,
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
    const failedSendSnapshot = params.failedSend ? cloneFailedSend(params.failedSend) : null;
    const pollIntervalMs = params.pollIntervalMs ?? BOOTSTRAP_POLL_MS;
    const key = params.taskId ?? intentKey(intent);
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);

    const isStale = (): boolean =>
      generations.get(key) !== generation || intent.runtimeKey !== getRuntimeKey();

    const refreshIfCurrentRuntime = (): void => {
      if (!git || intent.runtimeKey !== getRuntimeKey()) return;
      void refreshProject(intent.projectRoot, git).catch(() => undefined);
    };

    setEntryState(key, intent, { phase: 'naming', label: 'Naming worktree...' });

    if (!git?.createGitWorktree || !git.getGitWorktreeBootstrapStatus) {
      const error = 'Git worktrees are unavailable for this runtime.';
      setEntryFailed(key, intent, { phase: 'failed', label: 'Worktree creation failed', error }, failedSendSnapshot);
      throw new Error(error);
    }

    if (intent.runtimeKey !== getRuntimeKey()) {
      const error = 'The runtime changed. Select New worktree again.';
      setEntryFailed(key, intent, { phase: 'failed', label: 'Worktree creation stopped', error }, failedSendSnapshot);
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

      setEntryReceipt(key, intent, receipt, failedSendSnapshot, created.path, created.branch);
      return receipt;
    } catch (error) {
      if (isStale()) throw error;
      const message = error instanceof Error ? error.message : 'Failed to create the worktree.';
      if (message === WORKTREE_CREATION_SUPERSEDED) throw error;
      refreshIfCurrentRuntime();
      setEntryFailed(key, intent, {
        phase: 'failed',
        label: 'Worktree creation failed',
        error: message,
      }, failedSendSnapshot);
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

    consumeFailedSend: (key, expected) => {
      let consumed = false;
      set((state) => {
        const live = state.entries.get(key);
        if (!live || live.state?.phase !== 'failed' || live.failedSend !== expected) return state;
        const entries = new Map(state.entries);
        entries.delete(key);
        generations.delete(key);
        consumed = true;
        return { entries };
      });
      return consumed;
    },

    markWorktreePromptSucceeded: (key, expected) => {
      let consumed = false;
      set((state) => {
        const live = state.entries.get(key);
        if (!live || !live.receipt || live.failedSend !== expected) return state;
        const entries = new Map(state.entries);
        entries.delete(key);
        generations.delete(key);
        consumed = true;
        return { entries };
      });
      return consumed;
    },

    markWorktreePromptFailed: (key, expected, error) => {
      let transitioned = false;
      set((state) => {
        const live = state.entries.get(key);
        if (!live || !live.receipt || live.failedSend !== expected) return state;
        const entries = new Map(state.entries);
        entries.set(key, {
          ...live,
          state: { phase: 'failed', label: 'Prompt failed to send', error },
          updatedAt: Date.now(),
        });
        transitioned = true;
        return { entries };
      });
      return transitioned;
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
