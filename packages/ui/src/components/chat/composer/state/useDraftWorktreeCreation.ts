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

export function useDraftWorktreeCreation<T>(input: {
  activeRuntimeKey: string;
  intent: DraftWorktreeIntent | null | undefined;
  onReady: (continuation: T, receipt: DraftWorktreeCreationReceipt) => void;
}) {
  const { activeRuntimeKey, intent, onReady } = input;
  const { git } = useRuntimeAPIs();
  const refreshProject = useWorktreeStore((state) => state.refreshProject);
  const onReadyRef = React.useRef(onReady);
  onReadyRef.current = onReady;

  const entryKey = getWorktreeCreationKey(intent);
  const storeEntry = useWorktreeCreationStore(
    React.useCallback((state) => (entryKey ? state.entries.get(entryKey) ?? null : null), [entryKey]),
  );

  const state = storeEntry?.state ?? null;

  const operationRef = React.useRef(0);
  React.useEffect(() => {
    operationRef.current += 1;
  }, [activeRuntimeKey, intent?.projectRoot, intent?.runtimeKey, intent?.sourceDirectory, intent?.startRef]);

  const request = React.useCallback(async (params: {
    intent: DraftWorktreeIntent;
    prompt: string;
    continuation: T;
  }): Promise<void> => {
    if (!git) return;
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    try {
      const receipt = await useWorktreeCreationStore.getState().request({
        intent: params.intent,
        prompt: params.prompt,
        git,
        refreshProject,
      });
      if (operationRef.current !== operation) return;
      if (params.intent.runtimeKey !== getRuntimeKey()) return;
      onReadyRef.current(params.continuation, receipt);
    } catch (error) {
      if (operationRef.current !== operation) return;
      if (error instanceof Error && error.message === WORKTREE_CREATION_SUPERSEDED) return;
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
