import React from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from "@/components/icon/Icon";
import type { Session } from '@/lib/chat/types';
import { getSessionDisplayTitle } from '@/lib/chat/sessionTitle';
import type { GitStatus, GitWorktree } from '@/lib/api/types';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';

export type DeleteSessionConfirmState = {
  session: Session;
  descendantCount: number;
  // Snapshot of the descendant IDs computed when the dialog opened, so the
  // executed list matches the count shown to the user even if childrenMap
  // changes while the dialog is open.
  descendantIds: string[];
  archivedBucket: boolean;
} | null;

function SessionMutationDialogFooter(props: {
  showDeletionDialog: boolean;
  setShowDeletionDialog: (next: boolean) => void;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
  confirmLabel: 'Archive' | 'Delete';
}): React.ReactNode {
  const { showDeletionDialog, setShowDeletionDialog, onCancel, onConfirm, confirmLabel } = props;
  return (
    <DialogFooter className="w-full sm:items-center sm:justify-between">
      <button
        type="button"
        onClick={() => setShowDeletionDialog(!showDeletionDialog)}
        className="inline-flex items-center gap-1.5 typography-ui-label text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
        aria-pressed={!showDeletionDialog}
      >
        {!showDeletionDialog ? <Icon name="checkbox" className="h-4 w-4 text-primary" /> : <Icon name="checkbox-blank" className="h-4 w-4" />}
        {"Never ask"}
      </button>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 typography-ui-label text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          {"Cancel"}
        </button>
        <button
          type="button"
          onClick={() => void onConfirm()}
          className="inline-flex h-8 items-center justify-center rounded-md bg-destructive px-3 typography-ui-label text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
        >
          {confirmLabel}
        </button>
      </div>
    </DialogFooter>
  );
}

export function SessionDeleteConfirmDialog(props: {
  value: DeleteSessionConfirmState;
  setValue: (next: DeleteSessionConfirmState) => void;
  showDeletionDialog: boolean;
  setShowDeletionDialog: (next: boolean) => void;
  onConfirm: () => Promise<void> | void;
}): React.ReactNode {
  
  const { value, setValue, showDeletionDialog, setShowDeletionDialog, onConfirm } = props;
  const sessionDisplayTitle = (session: Session): string => getSessionDisplayTitle(session);

  return (
    <Dialog open={Boolean(value)} onOpenChange={(open) => { if (!open) setValue(null); }}>
      <DialogContent showCloseButton={false} className="max-w-sm gap-5">
        <DialogHeader>
          <DialogTitle>{value?.archivedBucket
            ? "Delete session?"
            : "Archive session?"}</DialogTitle>
          <DialogDescription>
            {value && value.descendantCount > 0
              ? value.archivedBucket
                ? value.descendantCount === 1
                  ? `\\"${sessionDisplayTitle(value.session)}\\" and its ${value.descendantCount} sub-task will be permanently deleted.`
                  : `\\"${sessionDisplayTitle(value.session)}\\" and its ${value.descendantCount} sub-tasks will be permanently deleted.`
                : value.descendantCount === 1
                  ? `\\"${sessionDisplayTitle(value.session)}\\" and its ${value.descendantCount} sub-task will be archived.`
                  : `\\"${sessionDisplayTitle(value.session)}\\" and its ${value.descendantCount} sub-tasks will be archived.`
              : value?.archivedBucket
                ? `\\"${value?.session ? sessionDisplayTitle(value.session) : "Untitled Session"}\\" will be permanently deleted.`
                : `\\"${value?.session ? sessionDisplayTitle(value.session) : "Untitled Session"}\\" will be archived.`}
          </DialogDescription>
        </DialogHeader>
        <SessionMutationDialogFooter
          showDeletionDialog={showDeletionDialog}
          setShowDeletionDialog={setShowDeletionDialog}
          onCancel={() => setValue(null)}
          onConfirm={onConfirm}
          confirmLabel={value?.archivedBucket ? 'Delete' : 'Archive'}
        />
      </DialogContent>
    </Dialog>
  );
}

export type BulkDeleteSessionsConfirmState = {
  sessionCount: number;
  archivedBucket: boolean;
} | null;

export function BulkSessionDeleteConfirmDialog(props: {
  value: BulkDeleteSessionsConfirmState;
  setValue: (next: BulkDeleteSessionsConfirmState) => void;
  showDeletionDialog: boolean;
  setShowDeletionDialog: (next: boolean) => void;
  onConfirm: () => Promise<void> | void;
}): React.ReactNode {
  
  const { value, setValue, showDeletionDialog, setShowDeletionDialog, onConfirm } = props;
  const archived = value?.archivedBucket === true;
  const n = value?.sessionCount ?? 0;
  const title = archived
    ? (n === 1
      ? "Delete session?"
      : "Delete sessions?")
    : (n === 1
      ? "Archive session?"
      : "Archive sessions?");
  const description = archived
    ? (n === 1
      ? `${n} session will be permanently deleted.`
      : `${n} sessions will be permanently deleted.`)
    : (n === 1
      ? `${n} session will be archived.`
      : `${n} sessions will be archived.`);

  return (
    <Dialog open={Boolean(value)} onOpenChange={(open) => { if (!open) setValue(null); }}>
      <DialogContent showCloseButton={false} className="max-w-sm gap-5">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <SessionMutationDialogFooter
          showDeletionDialog={showDeletionDialog}
          setShowDeletionDialog={setShowDeletionDialog}
          onCancel={() => setValue(null)}
          onConfirm={onConfirm}
          confirmLabel={archived ? 'Delete' : 'Archive'}
        />
      </DialogContent>
    </Dialog>
  );
}

export type DeleteFolderConfirmState = {
  scopeKey: string;
  folderId: string;
  folderName: string;
  subFolderCount: number;
  sessionCount: number;
} | null;

export type CloseWorktreeConfirmState = {
  projectId: string;
  projectPath: string;
  worktree: GitWorktree;
  hasActiveSession: boolean;
} | null;

export function WorktreeCloseConfirmDialog(props: {
  value: CloseWorktreeConfirmState;
  setValue: (next: CloseWorktreeConfirmState) => void;
  onConfirm: (options: { force: boolean }) => Promise<void> | void;
}): React.ReactNode {
  const { value, setValue, onConfirm } = props;
  const { git } = useRuntimeAPIs();
  const [status, setStatus] = React.useState<GitStatus | null>(null);
  const [statusCheckFailed, setStatusCheckFailed] = React.useState(false);
  const [discardChangesConfirmed, setDiscardChangesConfirmed] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const worktreePath = value?.worktree.path ?? null;

  React.useEffect(() => {
    let cancelled = false;
    setStatus(null);
    setStatusCheckFailed(false);
    setDiscardChangesConfirmed(false);
    setIsSubmitting(false);

    if (!value || !worktreePath) return () => { cancelled = true; };

    void git.getGitStatus(worktreePath).then((nextStatus) => {
      if (cancelled) return;
      if (typeof nextStatus?.isClean !== 'boolean') {
        setStatusCheckFailed(true);
        return;
      }
      setStatus(nextStatus);
    }).catch(() => {
      if (!cancelled) setStatusCheckFailed(true);
    });

    return () => {
      cancelled = true;
    };
  }, [git, value, worktreePath]);

  const isDirty = status?.isClean === false;
  const hasUnpublishedCommits = (status?.ahead ?? 0) > 0;
  const isDetachedWithUnpublishedCommits = hasUnpublishedCommits && !value?.worktree.branch;
  const branchRetentionMessage = value?.worktree.branch
    ? 'The local branch will be kept.'
    : 'No local branch will be deleted.';
  const canConfirm = Boolean(
    value
      && status
      && !statusCheckFailed
      && !value.hasActiveSession
      && ((!isDirty && !isDetachedWithUnpublishedCommits) || discardChangesConfirmed)
      && !isSubmitting,
  );
  const worktreeLabel = value?.worktree.branch || value?.worktree.name || value?.worktree.path || '';

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setIsSubmitting(true);
    try {
      await onConfirm({ force: isDirty });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={Boolean(value)}
      onOpenChange={(open) => {
        if (!open && !isSubmitting) setValue(null);
      }}
    >
      <DialogContent showCloseButton={false} className="max-w-md gap-5">
        <DialogHeader>
          <DialogTitle>{"Close worktree?"}</DialogTitle>
          <DialogDescription>
            {`Closing "${worktreeLabel}" removes its worktree directory. ${branchRetentionMessage}`}
          </DialogDescription>
        </DialogHeader>

        {statusCheckFailed ? (
          <div role="alert" className="rounded-md bg-[var(--status-error-background)] p-3 typography-ui-label text-[var(--status-error-foreground)]">
            {"Unable to check this worktree's status. Refresh and try again."}
          </div>
        ) : status === null ? (
          <p className="typography-ui-label text-muted-foreground" aria-live="polite">
            {"Checking worktree status…"}
          </p>
        ) : null}

        {value?.hasActiveSession ? (
          <div role="alert" className="rounded-md bg-[var(--status-warning-background)] p-3 typography-ui-label text-[var(--status-warning-foreground)]">
            {"Stop the active session before closing this worktree."}
          </div>
        ) : null}

        {isDirty ? (
          <div className="space-y-3 rounded-md bg-[var(--status-warning-background)] p-3 text-[var(--status-warning-foreground)]">
            <p className="typography-ui-label">
              {"This worktree has uncommitted changes. They will be permanently removed."}
            </p>
            <label className="flex items-start gap-2 typography-ui-label">
              <Checkbox
                checked={discardChangesConfirmed}
                onChange={setDiscardChangesConfirmed}
                ariaLabel="Confirm removal of uncommitted changes"
                className="mt-0.5"
              />
              <span>{"I understand that the uncommitted changes will be lost."}</span>
            </label>
          </div>
        ) : null}

        {hasUnpublishedCommits ? (
          <div className="space-y-3">
            <p className="typography-ui-label text-muted-foreground">
              {status?.ahead === 1
                ? `This worktree has 1 unpushed commit. ${branchRetentionMessage}`
                : `This worktree has ${status?.ahead} unpushed commits. ${branchRetentionMessage}`}
            </p>
            {isDetachedWithUnpublishedCommits ? (
              <div className="space-y-3 rounded-md bg-[var(--status-warning-background)] p-3 text-[var(--status-warning-foreground)]">
                <p className="typography-ui-label">
                  {"Because this worktree is detached, its unpushed commits may be lost."}
                </p>
                <label className="flex items-start gap-2 typography-ui-label">
                  <Checkbox
                    checked={discardChangesConfirmed}
                    onChange={setDiscardChangesConfirmed}
                    ariaLabel="Confirm removal of unpushed detached commits"
                    className="mt-0.5"
                  />
                  <span>{"I understand that the unpushed commits may be lost."}</span>
                </label>
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter className="sm:justify-end">
          <Button variant="outline" size="sm" onClick={() => setValue(null)} disabled={isSubmitting}>
            {"Cancel"}
          </Button>
          <Button variant="destructive" size="sm" onClick={() => void handleConfirm()} disabled={!canConfirm}>
            {isSubmitting ? "Closing…" : "Close worktree"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FolderDeleteConfirmDialog(props: {
  value: DeleteFolderConfirmState;
  setValue: (next: DeleteFolderConfirmState) => void;
  onConfirm: () => void;
}): React.ReactNode {
  
  const { value, setValue, onConfirm } = props;

  return (
    <Dialog open={Boolean(value)} onOpenChange={(open) => { if (!open) setValue(null); }}>
      <DialogContent showCloseButton={false} className="max-w-sm gap-5">
        <DialogHeader>
          <DialogTitle>{"Delete folder?"}</DialogTitle>
          <DialogDescription>
            {value && (value.subFolderCount > 0 || value.sessionCount > 0)
              ? value.subFolderCount > 0
                ? value.subFolderCount === 1
                  ? `\\"${value.folderName}\\" will be deleted along with ${value.subFolderCount} sub-folder. Sessions inside will not be deleted.`
                  : `\\"${value.folderName}\\" will be deleted along with ${value.subFolderCount} sub-folders. Sessions inside will not be deleted.`
                : `\\"${value.folderName}\\" will be deleted. Sessions inside will not be deleted.`
              : `\\"${value?.folderName ?? ''}\\" will be permanently deleted.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            type="button"
            onClick={() => setValue(null)}
            className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 typography-ui-label text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            {"Cancel"}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex h-8 items-center justify-center rounded-md bg-destructive px-3 typography-ui-label text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
          >
            {"Delete"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
