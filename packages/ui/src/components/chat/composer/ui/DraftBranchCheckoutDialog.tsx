import React from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

export type DraftBranchCheckoutDialogState = {
    projectLabel: string;
    directory: string;
    branch: string;
    currentBranch: string | null;
    changedFileCount: number;
    activeSessions: readonly {
        id: string;
        title: string | null;
        directory: string;
    }[];
    activeSessionsChanged?: boolean;
    phase: 'ready' | 'checking' | 'retryable-error' | 'terminal-error';
    error?: string;
};

export function DraftBranchCheckoutDialog(props: {
    state: DraftBranchCheckoutDialogState | null;
    onCancel: () => void;
    onConfirm: () => void;
}): React.ReactNode {
    const { state, onCancel, onConfirm } = props;
    const { t } = useTranslation();
    const checking = state?.phase === 'checking';
    const terminal = state?.phase === 'terminal-error';

    return (
        <Dialog
            open={state !== null}
            onOpenChange={(open) => {
                if (!open && !checking) onCancel();
            }}
        >
            <DialogContent showCloseButton={false} className="max-w-md gap-5">
                <DialogHeader>
                    <DialogTitle>{terminal ? t('Branch checkout needs attention') : t('Check out branch?')}</DialogTitle>
                    <DialogDescription>
                        {state
                            ? t('PiChamber will check out "{{branch}}" in "{{project}}" before creating the session. This changes the files used by every session and terminal in this folder.', { branch: state.branch, project: state.projectLabel })
                            : ''}
                    </DialogDescription>
                </DialogHeader>

                {state?.activeSessions.length ? (
                    <section
                        aria-live="polite"
                        className="rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-3"
                    >
                        <h3 className="typography-ui-label font-medium text-foreground">
                            {state.activeSessions.length === 1
                                ? t('Another session is active in this project')
                                : t('{{count}} other sessions are active in this project', { count: state.activeSessions.length })}
                        </h3>
                        <p className="mt-1 typography-meta text-muted-foreground">
                            {t('Switching branches may interrupt sessions using this folder or conflict with work in a related worktree.')}
                        </p>
                        <ul className="mt-2 max-h-32 list-disc space-y-1 overflow-y-auto pl-5 typography-meta text-foreground">
                            {state.activeSessions.map((session) => (
                                <li key={session.id}>{session.title ?? t('Untitled session')}</li>
                            ))}
                        </ul>
                        {state.activeSessionsChanged ? (
                            <p className="mt-2 typography-meta font-medium text-status-warning">
                                {t('The active session list changed. Review it before continuing.')}
                            </p>
                        ) : null}
                    </section>
                ) : null}

                {state?.changedFileCount ? (
                    <p className="typography-ui-label text-muted-foreground">
                        {state.changedFileCount === 1
                            ? t('This folder has 1 uncommitted file. Git may block the checkout if it conflicts.')
                            : t('This folder has {{count}} uncommitted files. Git may block the checkout if they conflict.', { count: state.changedFileCount })}
                    </p>
                ) : null}
                {state?.error ? (
                    <p role="alert" className="typography-ui-label text-status-error">
                        {state.error}
                    </p>
                ) : null}

                <DialogFooter>
                    <Button variant="outline" onClick={onCancel} disabled={checking}>
                        {terminal ? t('Close') : t('Cancel')}
                    </Button>
                    {!terminal ? (
                        <Button onClick={onConfirm} disabled={checking}>
                            {checking
                                ? t('Checking out...')
                                : state?.phase === 'retryable-error'
                                    ? t('Try Again')
                                    : t('Check Out and Send')}
                        </Button>
                    ) : null}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
