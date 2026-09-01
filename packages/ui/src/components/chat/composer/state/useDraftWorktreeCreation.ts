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

export type { DraftWorktreeCreationState } from '@/stores/useWorktreeCreationStore';

export function useDraftWorktreeCreation(input: {
  intent: DraftWorktreeIntent | null | undefined;
}) {
  const { intent } = input;
  const { git } = useRuntimeAPIs();
  const refreshProject = useWorktreeStore((state) => state.refreshProject);

  const entryKey = getWorktreeCreationKey(intent);
  const storeEntry = useWorktreeCreationStore(
    React.useCallback((state) => (entryKey ? state.entries.get(entryKey) ?? null : null), [entryKey]),
  );

  const state = storeEntry?.state ?? null;

  const request = React.useCallback(async (params: {
    intent: DraftWorktreeIntent;
    prompt: string;
  }): Promise<DraftWorktreeCreationReceipt | null> => {
    if (!git) return null;
    try {
      const receipt = await useWorktreeCreationStore.getState().request({
        intent: params.intent,
        prompt: params.prompt,
        git,
        refreshProject,
      });
      if (params.intent.runtimeKey !== getRuntimeKey()) return null;
      return receipt;
    } catch (error) {
      if (error instanceof Error && error.message === WORKTREE_CREATION_SUPERSEDED) return null;
      return null;
    }
  }, [git, refreshProject]);

  const getReceipt = React.useCallback(
    (candidate: DraftWorktreeIntent | null | undefined): DraftWorktreeCreationReceipt | null => {
      const entry = useWorktreeCreationStore.getState().getEntry(candidate);
      if (!entry?.receipt || !candidate) return null;
      return worktreeCreationIntentMatches(candidate, entry.receipt) ? entry.receipt : null;
    },
    [],
  );

  const clearReceipt = React.useCallback((): void => {
    const key = getWorktreeCreationKey(intent);
    if (!key) return;
    useWorktreeCreationStore.getState().clearReceipt(key);
  }, [intent]);

  const dismissFailed = React.useCallback((): void => {
    const key = getWorktreeCreationKey(intent);
    if (!key) return;
    useWorktreeCreationStore.getState().dismissFailed(key);
  }, [intent]);

  return {
    state,
    request,
    getReceipt,
    clearReceipt,
    dismissFailed,
  };
}
