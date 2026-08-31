import React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useWorktreeStore } from '@/stores/useWorktreeStore';
import {
  getWorktreeCreationKey,
  useWorktreeCreationStore,
  type DraftWorktreeCreationState,
} from '@/stores/useWorktreeCreationStore';
import type {
  DraftWorktreeCreationReceipt,
  DraftWorktreeIntent,
} from '@/sync/session-ui-store';

export type { DraftWorktreeCreationState } from '@/stores/useWorktreeCreationStore';

const intentMatches = (
  left: DraftWorktreeIntent | null | undefined,
  right: DraftWorktreeIntent | null | undefined,
): boolean => Boolean(
  left
  && right
  && left.runtimeKey === right.runtimeKey
  && left.projectRoot === right.projectRoot
  && left.sourceDirectory === right.sourceDirectory
  && left.startRef === right.startRef,
);

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

  // Read state/receipt from the global store so it survives navigation and
  // remains visible in the global banner.
  const entryKey = React.useMemo(() => getWorktreeCreationKey(intent), [intent?.projectRoot, intent?.runtimeKey, intent?.sourceDirectory, intent?.startRef]);
  const storeEntry = useWorktreeCreationStore(
    React.useCallback((state) => (entryKey ? state.entries.get(entryKey) ?? null : null), [entryKey]),
  );

  const state = storeEntry?.state ?? null;

  // When the intent changes, do NOT clear the global entry — the creation
  // continues in the background. The composer will see `state === null` for
  // the new intent, while the global banner still shows the previous entry.
  // We only need to ensure failed state can be dismissed per intent.
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
    const currentEntry = useWorktreeCreationStore.getState().entries.get(getWorktreeCreationKey(params.intent) ?? '');
    if (currentEntry?.state && currentEntry.state.phase !== 'failed') return;
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    try {
      const receipt = await useWorktreeCreationStore.getState().request({
        intent: params.intent,
        prompt: params.prompt,
        git,
        refreshProject,
      });
      if (operationRef.current !== operation) {
        // User navigated away — creation still completed in the background and
        // is visible via the global banner. Don't auto-materialize.
        return;
      }
      if (params.intent.runtimeKey !== getRuntimeKey()) return;
      onReadyRef.current(params.continuation, receipt);
    } catch (error) {
      if (operationRef.current !== operation) return;
      // Error state is already stored globally; no local setState needed.
      if (error instanceof Error && error.message === 'Worktree creation superseded.') return;
    }
  }, [git, refreshProject]);

  const getReceipt = React.useCallback(
    (candidate: DraftWorktreeIntent | null | undefined): DraftWorktreeCreationReceipt | null => {
      if (!candidate) return null;
      const key = getWorktreeCreationKey(candidate);
      if (!key) return null;
      const entry = useWorktreeCreationStore.getState().entries.get(key);
      if (!entry?.receipt) return null;
      return intentMatches(candidate, entry.receipt) ? entry.receipt : null;
    },
    [],
  );

  const clearReceipt = React.useCallback((): void => {
    if (!intent) return;
    const key = getWorktreeCreationKey(intent);
    if (!key) return;
    useWorktreeCreationStore.getState().clearReceipt(key);
  }, [intent?.projectRoot, intent?.runtimeKey, intent?.sourceDirectory, intent?.startRef]);

  const dismissFailed = React.useCallback((): void => {
    if (!intent) return;
    const key = getWorktreeCreationKey(intent);
    if (!key) return;
    useWorktreeCreationStore.getState().dismissFailed(key);
  }, [intent?.projectRoot, intent?.runtimeKey, intent?.sourceDirectory, intent?.startRef]);

  return {
    state,
    request,
    getReceipt,
    clearReceipt,
    dismissFailed,
  };
}
