import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Icon } from "@/components/icon/Icon";
import { DirectoryExplorerDialog } from './DirectoryExplorerDialog';
import type { Session } from '@/lib/chat/types';
import { useSessionUIStore } from '@/sync/session-ui-store';
import * as sessionActions from '@/sync/session-actions';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useDeviceInfo } from '@/lib/device';
import { sessionEvents } from '@/lib/sessionEvents';

const renderToastDescription = (text?: string) =>
    text ? <span className="text-foreground/80 dark:text-foreground/70">{text}</span> : undefined;

type DeleteDialogState = {
    sessions: Session[];
    dateLabel?: string;
};

export const SessionDialogs: React.FC = () => {
    const [isDirectoryDialogOpen, setIsDirectoryDialogOpen] = React.useState(false);
    const [hasShownInitialDirectoryPrompt, setHasShownInitialDirectoryPrompt] = React.useState(false);
    const [deleteDialog, setDeleteDialog] = React.useState<DeleteDialogState | null>(null);
    const [isProcessingDelete, setIsProcessingDelete] = React.useState(false);

    const deleteSession = sessionActions.deleteSession;
    const deleteSessions = useSessionUIStore((s) => s.deleteSessions);
    const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
    const setShowDeletionDialog = useUIStore((state) => state.setShowDeletionDialog);
    const isHomeReady = useDirectoryStore((s) => s.isHomeReady);
    const projects = useProjectsStore((s) => s.projects);
    const { isMobile, isTablet, hasTouchInput } = useDeviceInfo();
    const useMobileOverlay = isMobile || isTablet || hasTouchInput;

    React.useEffect(() => {
        if (hasShownInitialDirectoryPrompt || !isHomeReady || projects.length > 0) {
            return;
        }

        setHasShownInitialDirectoryPrompt(true);
        setIsDirectoryDialogOpen(true);
    }, [
        hasShownInitialDirectoryPrompt,
        isHomeReady,
        projects.length,
    ]);

    const openDeleteDialog = React.useCallback((payload: { sessions: Session[]; dateLabel?: string }) => {
        setDeleteDialog({
            sessions: payload.sessions,
            dateLabel: payload.dateLabel,
        });
    }, []);

    const closeDeleteDialog = React.useCallback(() => {
        setDeleteDialog(null);
        setIsProcessingDelete(false);
    }, []);

    const deleteSessionsWithoutDialog = React.useCallback(async (payload: { sessions: Session[]; dateLabel?: string }) => {
        if (payload.sessions.length === 0) {
            return;
        }

        if (payload.sessions.length === 1) {
            const target = payload.sessions[0];
            const success = await deleteSession(target.id);
            if (success) {
                toast.success("Session deleted");
            } else {
                toast.error("Failed to delete session");
            }
            return;
        }

        const ids = payload.sessions.map((session) => session.id);
        const { deletedIds, failedIds } = await deleteSessions(ids);

        if (deletedIds.length > 0) {
            const successDescription = failedIds.length > 0
                ? (failedIds.length === 1
                    ? `${failedIds.length} session could not be deleted.`
                    : `${failedIds.length} sessions could not be deleted.`)
                : payload.dateLabel
                    ? `Removed all sessions from ${payload.dateLabel}.`
                    : undefined;
            toast.success(deletedIds.length === 1
                ? "Deleted {count} session"
                : `Deleted ${deletedIds.length} sessions`, {
                description: renderToastDescription(successDescription),
            });
        }

        if (failedIds.length > 0) {
            toast.error(failedIds.length === 1
                ? `Failed to delete ${failedIds.length} session`
                : `Failed to delete ${failedIds.length} sessions`, {
                description: renderToastDescription("Please try again in a moment."),
            });
        }
    }, [deleteSession, deleteSessions]);

    React.useEffect(() => {
        return sessionEvents.onDeleteRequest((payload) => {
            if (!showDeletionDialog) {
                void deleteSessionsWithoutDialog(payload);
                return;
            }
            openDeleteDialog(payload);
        });
    }, [openDeleteDialog, showDeletionDialog, deleteSessionsWithoutDialog]);

    React.useEffect(() => {
        return sessionEvents.onDirectoryRequest(() => {
            setIsDirectoryDialogOpen(true);
        });
    }, []);

    const handleConfirmDelete = React.useCallback(async () => {
        if (!deleteDialog) {
            return;
        }
        setIsProcessingDelete(true);

        try {
            if (deleteDialog.sessions.length === 1) {
                const target = deleteDialog.sessions[0];
                const success = await deleteSession(target.id);
                if (!success) {
                    toast.error("Failed to delete session");
                    setIsProcessingDelete(false);
                    return;
                }
                toast.success("Session deleted", {
                    action: {
                        label: "OK",
                        onClick: () => { },
                    },
                });
            } else {
                const ids = deleteDialog.sessions.map((session) => session.id);
                const result = await deleteSessions(ids);
                const deletedIds = result.deletedIds;
                const failedIds = result.failedIds;

                if (deletedIds.length > 0) {
                    const successDescription = failedIds.length > 0
                        ? (failedIds.length === 1
                            ? `${failedIds.length} session could not be deleted.`
                            : `${failedIds.length} sessions could not be deleted.`)
                        : deleteDialog.dateLabel
                            ? `Removed all sessions from ${deleteDialog.dateLabel}.`
                            : undefined;
                    toast.success(deletedIds.length === 1
                        ? "Deleted {count} session"
                        : `Deleted ${deletedIds.length} sessions`, {
                        description: renderToastDescription(successDescription),
                        action: {
                            label: "OK",
                            onClick: () => { },
                        },
                    });
                }

                if (failedIds.length > 0) {
                    toast.error(failedIds.length === 1
                        ? `Failed to delete ${failedIds.length} session`
                        : `Failed to delete ${failedIds.length} sessions`, {
                        description: renderToastDescription("Please try again in a moment."),
                    });
                    if (deletedIds.length === 0) {
                        setIsProcessingDelete(false);
                        return;
                    }
                }
            }

            closeDeleteDialog();
        } finally {
            setIsProcessingDelete(false);
        }
    }, [
        deleteDialog,
        deleteSession,
        deleteSessions,
        closeDeleteDialog,
    ]);

    const deleteDialogDescription = deleteDialog
        ? deleteDialog.sessions.length === 1
            ? (deleteDialog.dateLabel
                ? `This action permanently removes 1 session from ${deleteDialog.dateLabel}.`
                : "This action permanently removes 1 session.")
            : (deleteDialog.dateLabel
                ? `This action permanently removes ${deleteDialog.sessions.length} sessions from ${deleteDialog.dateLabel}.`
                : `This action permanently removes ${deleteDialog.sessions.length} sessions.`)
        : '';

    const deleteDialogBody = deleteDialog ? (
        <div className="space-y-2">
            {deleteDialog.sessions.length > 0 && (
                <div className="space-y-1.5 rounded-xl border border-border/40 bg-sidebar/60 p-3">
                    <ul className="space-y-0.5">
                        {deleteDialog.sessions.slice(0, 5).map((session) => (
                            <li
                                key={session.id}
                                className="typography-micro text-muted-foreground/80"
                            >
                                <span className="truncate">
                                    {session.title || "Untitled Session"}
                                </span>
                            </li>
                        ))}
                        {deleteDialog.sessions.length > 5 && (
                            <li className="typography-micro text-muted-foreground/70">
                                {`+${deleteDialog.sessions.length - 5} more`}
                            </li>
                        )}
                    </ul>
                </div>
            )}
            <div className="rounded-xl border border-border/40 bg-sidebar/60 p-3">
                <p className="typography-meta text-muted-foreground/80">
                    {"Worktree directories stay intact. Subsessions linked to the selected sessions will also be removed."}
                </p>
            </div>
        </div>
    ) : null;

    const deleteDialogActions = (
        <div className="flex w-full items-center justify-between gap-3">
            <button
                type="button"
                onClick={() => setShowDeletionDialog(!showDeletionDialog)}
                className="inline-flex items-center gap-1.5 typography-meta text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
                aria-pressed={!showDeletionDialog}
            >
                {!showDeletionDialog ? <Icon name="checkbox" className="size-4 text-primary" /> : <Icon name="checkbox-blank" className="size-4" />}
                {"Never ask"}
            </button>
            <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={closeDeleteDialog} disabled={isProcessingDelete}>
                    {"Cancel"}
                </Button>
                <Button variant="destructive" onClick={handleConfirmDelete} disabled={isProcessingDelete}>
                    {isProcessingDelete
                        ? "Deleting…"
                        : deleteDialog?.sessions.length === 1
                            ? "Delete session"
                            : "Delete sessions"}
                </Button>
            </div>
        </div>
    );

    const deleteDialogTitle = deleteDialog?.sessions.length === 1
        ? "Delete session"
        : "Delete sessions";

    return (
        <>
            {useMobileOverlay ? (
                <MobileOverlayPanel
                    open={Boolean(deleteDialog)}
                    onClose={() => {
                        if (isProcessingDelete) {
                            return;
                        }
                        closeDeleteDialog();
                    }}
                    title={deleteDialogTitle}
                    footer={<div className="flex justify-end gap-2">{deleteDialogActions}</div>}
                >
                    <div className="space-y-2 pb-2">
                        {deleteDialogDescription && (
                            <p className="typography-meta text-muted-foreground/80">{deleteDialogDescription}</p>
                        )}
                        {deleteDialogBody}
                    </div>
                </MobileOverlayPanel>
            ) : (
                <Dialog
                    open={Boolean(deleteDialog)}
                    onOpenChange={(open) => {
                        if (!open) {
                            if (isProcessingDelete) {
                                return;
                            }
                            closeDeleteDialog();
                        }
                    }}
                >
                    <DialogContent className="max-w-[min(520px,100vw-2rem)] space-y-2 pb-2">
                        <DialogHeader>
                            <DialogTitle>
                                {deleteDialogTitle}
                            </DialogTitle>
                            {deleteDialogDescription && <DialogDescription>{deleteDialogDescription}</DialogDescription>}
                        </DialogHeader>
                        <div className="flex-1 min-h-0 overflow-y-auto space-y-2">
                            {deleteDialogBody}
                        </div>
                        <DialogFooter className="mt-2 gap-2 pt-1 pb-1">{deleteDialogActions}</DialogFooter>
                    </DialogContent>
                </Dialog>
            )}

            <DirectoryExplorerDialog
                open={isDirectoryDialogOpen}
                onOpenChange={setIsDirectoryDialogOpen}
            />
        </>
    );
};
