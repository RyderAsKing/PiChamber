import React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { sessionEvents } from '@/lib/sessionEvents';
import { useGitStore } from '@/stores/useGitStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getActiveSyncSessions } from '@/sync/sync-refs';
import {
    draftBranchCheckoutReceiptMatches,
    useSessionUIStore,
    type DraftBranchCheckoutReceipt,
    type DraftBranchIntent,
} from '@/sync/session-ui-store';
import { toast } from '@/components/ui';
import type { DraftBranchCheckoutDialogState } from '../ui/DraftBranchCheckoutDialog';
import {
    buildDraftBranchProjectDirectories,
    hasNewActiveSessions,
    type DraftBranchActiveSession,
} from './draftBranchActiveSessions';

type PendingCheckout<T> = DraftBranchCheckoutDialogState & {
    runtimeKey: string;
    projectId: string | null;
    continuation: T;
};

const getActiveProjectSessions = (
    directory: string,
    projectId?: string | null,
): DraftBranchActiveSession[] => {
    const projectsState = useProjectsStore.getState();
    const worktrees = (useSessionUIStore.getState() as {
        availableWorktreesByProject?: Map<string, ReadonlyArray<{ path?: string | null }>>;
    }).availableWorktreesByProject;
    const projectDirectories = buildDraftBranchProjectDirectories({
        targetDirectory: directory,
        projectId,
        projects: projectsState.projects,
        availableWorktreesByProject: worktrees ?? new Map(),
    });
    return getActiveSyncSessions()
        .filter((session) => projectDirectories.has(session.directory))
        .sort((left, right) => (
            (left.title ?? '').localeCompare(right.title ?? '') || left.id.localeCompare(right.id)
        ));
};

export function useDraftBranchCheckout<T>(input: {
    activeRuntimeKey: string;
    intent: DraftBranchIntent | null | undefined;
    onReady: (continuation: T, receipt: DraftBranchCheckoutReceipt) => void;
}) {
    const { activeRuntimeKey, intent, onReady } = input;
    const { git } = useRuntimeAPIs();
    const fetchStatus = useGitStore((state) => state.fetchStatus);
    const fetchBranches = useGitStore((state) => state.fetchBranches);
    const clearDiffCache = useGitStore((state) => state.clearDiffCache);
    const [pending, setPending] = React.useState<PendingCheckout<T> | null>(null);
    const preflightInFlightRef = React.useRef(false);
    const operationRef = React.useRef(0);
    const receiptRef = React.useRef<DraftBranchCheckoutReceipt | null>(null);
    const onReadyRef = React.useRef(onReady);
    onReadyRef.current = onReady;

    const intentRuntimeKey = intent?.runtimeKey ?? '';
    const intentDirectory = intent?.directory ?? '';
    const intentBranch = intent?.branch ?? '';

    React.useEffect(() => {
        operationRef.current += 1;
        receiptRef.current = null;
        setPending(null);
    }, [activeRuntimeKey, intentBranch, intentDirectory, intentRuntimeKey]);

    const refreshAfterCheckout = React.useCallback((directory: string) => {
        if (!git) return;
        clearDiffCache(directory);
        sessionEvents.requestGitRefresh({ directory });
        void Promise.all([
            fetchStatus(directory, git, { silent: true }),
            fetchBranches(directory, git),
        ]);
    }, [clearDiffCache, fetchBranches, fetchStatus, git]);

    const setReady = React.useCallback((
        continuation: T,
        branchIntent: DraftBranchIntent,
    ) => {
        const receipt = {
            runtimeKey: branchIntent.runtimeKey,
            directory: branchIntent.directory,
            branch: branchIntent.branch,
        };
        receiptRef.current = receipt;
        onReadyRef.current(continuation, receipt);
    }, []);

    const request = React.useCallback(async (params: {
        intent: DraftBranchIntent;
        projectId?: string | null;
        continuation: T;
    }): Promise<void> => {
        const branchIntent = params.intent;
        if (preflightInFlightRef.current || pending) return;
        if (!git) {
            toast.error('Git is not available for the selected runtime.');
            return;
        }
        if (branchIntent.runtimeKey !== getRuntimeKey()) {
            toast.error('The runtime changed. Select the branch again before sending.');
            return;
        }

        preflightInFlightRef.current = true;
        try {
            const [branches, status] = await Promise.all([
                git.getGitBranches(branchIntent.directory),
                git.getGitStatus(branchIntent.directory, { mode: 'light' }),
            ]);
            const latestIntent = useSessionUIStore.getState().newSessionDraft.branchIntent;
            if (!draftBranchCheckoutReceiptMatches(branchIntent, latestIntent)) return;
            if (!branches.all.includes(branchIntent.branch) || branchIntent.branch.startsWith('remotes/')) {
                toast.error(`Local branch ${branchIntent.branch} no longer exists.`);
                void fetchBranches(branchIntent.directory, git);
                return;
            }
            if (status.mergeInProgress || status.rebaseInProgress || status.attentionReason) {
                const operation = status.attentionReason
                    ?? (status.rebaseInProgress ? 'rebase' : 'merge');
                toast.error(`Finish or abort the ${operation} before switching branches.`);
                return;
            }
            const currentBranch = status.current?.trim() || branches.current?.trim() || null;
            if (currentBranch === branchIntent.branch) {
                setReady(params.continuation, branchIntent);
                return;
            }

            const projectLabel = params.projectId
                ? useProjectsStore.getState().projects.find((project) => project.id === params.projectId)?.label?.trim()
                : null;
            const fallbackLabel = branchIntent.directory.split(/[\\/]/).filter(Boolean).pop() || branchIntent.directory;
            setPending({
                runtimeKey: branchIntent.runtimeKey,
                projectId: params.projectId ?? null,
                directory: branchIntent.directory,
                branch: branchIntent.branch,
                currentBranch,
                projectLabel: projectLabel || fallbackLabel,
                changedFileCount: status.files.length,
                activeSessions: getActiveProjectSessions(branchIntent.directory, params.projectId),
                phase: 'ready',
                continuation: params.continuation,
            });
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to inspect the selected branch.');
        } finally {
            preflightInFlightRef.current = false;
        }
    }, [fetchBranches, git, pending, setReady]);

    const cancel = React.useCallback(() => {
        operationRef.current += 1;
        receiptRef.current = null;
        setPending(null);
    }, []);

    const confirm = React.useCallback(async () => {
        const checkout = pending;
        if (!checkout || checkout.phase === 'checking' || checkout.phase === 'terminal-error' || !git) return;

        const operation = operationRef.current + 1;
        operationRef.current = operation;
        setPending({ ...checkout, phase: 'checking', activeSessionsChanged: false, error: undefined });

        try {
            const draft = useSessionUIStore.getState().newSessionDraft;
            if (!draft.open || !draftBranchCheckoutReceiptMatches(draft.branchIntent, checkout)) {
                throw Object.assign(new Error('The draft target changed. Press Send again to review the branch.'), {
                    terminal: true,
                });
            }
            if (checkout.runtimeKey !== getRuntimeKey()) {
                throw Object.assign(new Error('The runtime changed. Select the branch again before sending.'), {
                    terminal: true,
                });
            }
            const latestActiveSessions = getActiveProjectSessions(checkout.directory, checkout.projectId);
            if (hasNewActiveSessions(checkout.activeSessions, latestActiveSessions)) {
                setPending({
                    ...checkout,
                    activeSessions: latestActiveSessions,
                    phase: 'ready',
                    activeSessionsChanged: true,
                    error: undefined,
                });
                return;
            }

            const latestBranches = await git.getGitBranches(checkout.directory);
            if (operationRef.current !== operation) return;
            const latestCurrent = latestBranches.current?.trim() || null;
            if (latestCurrent !== checkout.currentBranch && latestCurrent !== checkout.branch) {
                throw Object.assign(
                    new Error(`The current branch changed to ${latestCurrent ?? 'detached HEAD'}. Press Send again to review it.`),
                    { terminal: true },
                );
            }
            if (!latestBranches.all.includes(checkout.branch) || checkout.branch.startsWith('remotes/')) {
                throw Object.assign(new Error(`Local branch ${checkout.branch} no longer exists.`), { terminal: true });
            }

            if (latestCurrent !== checkout.branch) {
                const result = await git.checkoutBranch(checkout.directory, checkout.branch, {
                    expectedCurrent: latestCurrent,
                    localOnly: true,
                });
                if (result.currentBranch !== checkout.branch) {
                    throw Object.assign(new Error(`Git did not confirm checkout of ${checkout.branch}.`), { terminal: true });
                }
            }

            if (operationRef.current !== operation) return;
            if (checkout.runtimeKey !== getRuntimeKey()) {
                toast.warning('The branch may have changed on the previous runtime. The message was not sent.');
                return;
            }

            refreshAfterCheckout(checkout.directory);
            setPending(null);
            setReady(checkout.continuation, checkout);
        } catch (error) {
            if (operationRef.current !== operation) return;
            const rawMessage = error instanceof Error ? error.message : 'Failed to check out the selected branch.';
            let currentAfterFailure: string | null | undefined;
            try {
                currentAfterFailure = (await git.getGitBranches(checkout.directory)).current?.trim() || null;
            } catch {
                currentAfterFailure = undefined;
            }
            if (operationRef.current !== operation) return;

            refreshAfterCheckout(checkout.directory);
            const terminal = Boolean(error && typeof error === 'object' && 'terminal' in error)
                || (error && typeof error === 'object' && 'code' in error && error.code === 'BRANCH_CHANGED')
                || currentAfterFailure === checkout.branch
                || currentAfterFailure === undefined;
            const message = currentAfterFailure === checkout.branch
                ? `Git switched to ${checkout.branch}, but reported an error: ${rawMessage} Review the repository, then press Send again.`
                : rawMessage;
            setPending({
                ...checkout,
                phase: terminal ? 'terminal-error' : 'retryable-error',
                error: message,
            });
        }
    }, [git, pending, refreshAfterCheckout, setReady]);

    return {
        dialogState: pending as DraftBranchCheckoutDialogState | null,
        request,
        confirm,
        cancel,
        getReceipt: (branchIntent: DraftBranchIntent | null | undefined) => (
            draftBranchCheckoutReceiptMatches(branchIntent, receiptRef.current) ? receiptRef.current : null
        ),
        clearReceipt: () => { receiptRef.current = null; },
    };
}
