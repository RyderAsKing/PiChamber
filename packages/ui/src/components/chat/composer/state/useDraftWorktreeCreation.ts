import React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useWorktreeStore } from '@/stores/useWorktreeStore';
import type {
  DraftWorktreeCreationReceipt,
  DraftWorktreeIntent,
} from '@/sync/session-ui-store';
import { deriveWorktreeName } from './worktreeName';

const BOOTSTRAP_POLL_MS = 500;

export type DraftWorktreeCreationState = {
  phase: 'naming' | 'creating' | 'checking-out' | 'setting-up' | 'failed';
  label: string;
  error?: string;
};

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

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => {
  window.setTimeout(resolve, milliseconds);
});

export function useDraftWorktreeCreation<T>(input: {
  activeRuntimeKey: string;
  intent: DraftWorktreeIntent | null | undefined;
  onReady: (continuation: T, receipt: DraftWorktreeCreationReceipt) => void;
}) {
  const { activeRuntimeKey, intent, onReady } = input;
  const { git } = useRuntimeAPIs();
  const refreshProject = useWorktreeStore((state) => state.refreshProject);
  const [state, setState] = React.useState<DraftWorktreeCreationState | null>(null);
  const operationRef = React.useRef(0);
  const receiptRef = React.useRef<DraftWorktreeCreationReceipt | null>(null);
  const onReadyRef = React.useRef(onReady);
  onReadyRef.current = onReady;

  React.useEffect(() => {
    operationRef.current += 1;
    receiptRef.current = null;
    setState(null);
  }, [activeRuntimeKey, intent?.projectRoot, intent?.runtimeKey, intent?.sourceDirectory, intent?.startRef]);

  const request = React.useCallback(async (params: {
    intent: DraftWorktreeIntent;
    prompt: string;
    continuation: T;
  }): Promise<void> => {
    if (state && state.phase !== 'failed') return;
    if (!git?.createGitWorktree || !git.getGitWorktreeBootstrapStatus) {
      setState({ phase: 'failed', label: 'Worktree creation failed', error: 'Git worktrees are unavailable for this runtime.' });
      return;
    }
    if (params.intent.runtimeKey !== getRuntimeKey()) {
      setState({ phase: 'failed', label: 'Worktree creation stopped', error: 'The runtime changed. Select New worktree again.' });
      return;
    }

    const operation = operationRef.current + 1;
    operationRef.current = operation;
    receiptRef.current = null;
    try {
      setState({ phase: 'naming', label: 'Naming worktree...' });
      const worktreeName = await deriveWorktreeName(params.prompt, params.intent.sourceDirectory);
      if (operationRef.current !== operation || params.intent.runtimeKey !== getRuntimeKey()) return;

      const createInput = {
        mode: 'new' as const,
        startRef: params.intent.startRef,
        ...(worktreeName ? { worktreeName } : {}),
        returnAfterDirectoryCreated: true,
      };
      if (git.validateGitWorktree) {
        const validation = await git.validateGitWorktree(params.intent.sourceDirectory, createInput);
        if (!validation.ok) {
          throw new Error(validation.errors.map((error) => error.message).filter(Boolean).join('\n') || 'The worktree request is invalid.');
        }
      }
      if (operationRef.current !== operation || params.intent.runtimeKey !== getRuntimeKey()) return;

      setState({ phase: 'creating', label: 'Creating worktree...' });
      const created = await git.createGitWorktree(params.intent.sourceDirectory, createInput);
      if (operationRef.current !== operation || params.intent.runtimeKey !== getRuntimeKey()) return;

      let bootstrap = created.bootstrapStatus;
      while (bootstrap.status === 'pending') {
        setState(bootstrap.phase === 'directory-created'
          ? { phase: 'checking-out', label: 'Checking out files...' }
          : { phase: 'setting-up', label: 'Setting up project...' });
        await delay(BOOTSTRAP_POLL_MS);
        if (operationRef.current !== operation || params.intent.runtimeKey !== getRuntimeKey()) return;
        bootstrap = await git.getGitWorktreeBootstrapStatus(created.path);
      }
      if (bootstrap.status === 'failed' || bootstrap.phase !== 'setup-ready') {
        throw new Error(bootstrap.error || 'Worktree setup failed.');
      }

      await refreshProject(params.intent.projectRoot, git);
      if (operationRef.current !== operation || params.intent.runtimeKey !== getRuntimeKey()) return;
      const receipt: DraftWorktreeCreationReceipt = {
        ...params.intent,
        path: created.path,
        branch: created.branch,
      };
      receiptRef.current = receipt;
      setState(null);
      onReadyRef.current(params.continuation, receipt);
    } catch (error) {
      if (operationRef.current !== operation) return;
      if (params.intent.runtimeKey === getRuntimeKey()) {
        void refreshProject(params.intent.projectRoot, git);
      }
      setState({
        phase: 'failed',
        label: 'Worktree creation failed',
        error: error instanceof Error ? error.message : 'Failed to create the worktree.',
      });
    }
  }, [git, refreshProject, state]);

  return {
    state,
    request,
    getReceipt: (candidate: DraftWorktreeIntent | null | undefined) => (
      intentMatches(candidate, receiptRef.current) ? receiptRef.current : null
    ),
    clearReceipt: () => { receiptRef.current = null; },
  };
}
