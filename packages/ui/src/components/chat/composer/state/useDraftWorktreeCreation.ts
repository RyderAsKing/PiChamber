import React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useWorktreeStore } from '@/stores/useWorktreeStore';
import {
  WORKTREE_CREATION_SUPERSEDED,
  getWorktreeCreationKey,
  useWorktreeCreationStore,
  worktreeCreationIntentMatches,
} from '@/stores/useWorktreeCreationStore';
import type {
  DraftWorktreeCreationReceipt,
  DraftWorktreeIntent,
} from '@/sync/session-ui-store';
import type { AttachedFile } from '@/stores/types/sessionTypes';

export function useDraftWorktreeCreation(input: {
  taskId: string | null | undefined;
  intent: DraftWorktreeIntent | null | undefined;
}) {
  const { taskId, intent } = input;
  const { git } = useRuntimeAPIs();
  const refreshProject = useWorktreeStore((state) => state.refreshProject);

  const entryKey = taskId ?? getWorktreeCreationKey(intent);
  const storeEntry = useWorktreeCreationStore(
    React.useCallback((state) => (entryKey ? state.entries.get(entryKey) ?? null : null), [entryKey]),
  );

  const state = storeEntry?.state ?? null;

  const request = React.useCallback(async (params: {
    intent: DraftWorktreeIntent;
    prompt: string;
    failedSend?: {
      prompt: string;
      confirmedMentions: readonly string[] | Set<string>;
      attachments: readonly AttachedFile[];
    };
  }): Promise<DraftWorktreeCreationReceipt | null> => {
    // No early return when git is unavailable: the store owns the failure
    // entry (including `failedSend`) so Background tasks can Restore draft
    // after ChatInput has already rotated the draft. A missing git still
    // records a failed task instead of dropping the submitted prompt.
    try {
      const receipt = await useWorktreeCreationStore.getState().request({
        taskId: taskId ?? undefined,
        intent: params.intent,
        prompt: params.prompt,
        ...(params.failedSend ? { failedSend: params.failedSend } : {}),
        git: git ?? undefined,
        refreshProject,
      });
      if (params.intent.runtimeKey !== getRuntimeKey()) return null;
      return receipt;
    } catch (error) {
      if (error instanceof Error && error.message === WORKTREE_CREATION_SUPERSEDED) return null;
      return null;
    }
  }, [git, refreshProject, taskId]);

  const getReceipt = React.useCallback(
    (candidate: DraftWorktreeIntent | null | undefined): DraftWorktreeCreationReceipt | null => {
      const entry = entryKey
        ? useWorktreeCreationStore.getState().getEntryByKey(entryKey)
        : useWorktreeCreationStore.getState().getEntry(candidate);
      if (!entry?.receipt || !candidate) return null;
      return worktreeCreationIntentMatches(candidate, entry.receipt) ? entry.receipt : null;
    },
    [entryKey],
  );

  return {
    state,
    request,
    getReceipt,
  };
}
