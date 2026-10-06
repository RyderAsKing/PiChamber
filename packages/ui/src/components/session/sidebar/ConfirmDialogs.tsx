import React from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  return (
    <DialogFooter className="w-full sm:items-center sm:justify-between">
      <button
        type="button"
        onClick={() => setShowDeletionDialog(!showDeletionDialog)}
        className="inline-flex items-center gap-1.5 typography-ui-label text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
        aria-pressed={!showDeletionDialog}
      >
        {!showDeletionDialog ? <Icon name="checkbox" className="h-4 w-4 text-primary" /> : <Icon name="checkbox-blank" className="h-4 w-4" />}
        {t("Never ask")}
      </button>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 typography-ui-label text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          {t("Cancel")}
        </button>
        <button
          type="button"
          onClick={() => void onConfirm()}
          className="inline-flex h-8 items-center justify-center rounded-md bg-destructive px-3 typography-ui-label text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
        >
          {t(confirmLabel)}
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
  const { t } = useTranslation();
  const sessionDisplayTitle = (session: Session): string => getSessionDisplayTitle(session);

  return (
    <Dialog open={Boolean(value)} onOpenChange={(open) => { if (!open) setValue(null); }}>
      <DialogContent showCloseButton={false} className="max-w-sm gap-5">
        <DialogHeader>
          <DialogTitle>{value?.archivedBucket
            ? t("Delete session?")
            : t("Archive session?")}</DialogTitle>
          <DialogDescription>
            {value && value.descendantCount > 0
              ? value.archivedBucket
                ? value.descendantCount === 1
                  ? t('"{{title}}" and its {{count}} sub-task will be permanently deleted.', { title: sessionDisplayTitle(value.session), count: value.descendantCount })
                  : t('"{{title}}" and its {{count}} sub-tasks will be permanently deleted.', { title: sessionDisplayTitle(value.session), count: value.descendantCount })
                : value.descendantCount === 1
                  ? t('"{{title}}" and its {{count}} sub-task will be archived.', { title: sessionDisplayTitle(value.session), count: value.descendantCount })
                  : t('"{{title}}" and its {{count}} sub-tasks will be archived.', { title: sessionDisplayTitle(value.session), count: value.descendantCount })
              : value?.archivedBucket
                ? t('"{{title}}" will be permanently deleted.', { title: value?.session ? sessionDisplayTitle(value.session) : t("Untitled Session") })
                : t('"{{title}}" will be archived.', { title: value?.session ? sessionDisplayTitle(value.session) : t("Untitled Session") })}
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
  const { t } = useTranslation();
  const archived = value?.archivedBucket === true;
  const n = value?.sessionCount ?? 0;
  const title = archived
    ? (n === 1
      ? t("Delete session?")
      : t("Delete sessions?"))
    : (n === 1
      ? t("Archive session?")
      : t("Archive sessions?"));
  const description = archived
    ? (n === 1
      ? t('{{count}} session will be permanently deleted.', { count: n })
      : t('{{count}} sessions will be permanently deleted.', { count: n }))
    : (n === 1
      ? t('{{count}} session will be archived.', { count: n })
      : t('{{count}} sessions will be archived.', { count: n }));

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
  const { t } = useTranslation();
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
    ? t('The local branch will be kept.')
    : t('No local branch will be deleted.');
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
          <DialogTitle>{t("Close worktree?")}</DialogTitle>
          <DialogDescription>
            {t('Closing "{{label}}" removes its worktree directory. {{retention}}', { label: worktreeLabel, retention: branchRetentionMessage })}
          </DialogDescription>
        </DialogHeader>

        {statusCheckFailed ? (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-3">
            <Icon name="alert" className="mt-0.5 size-4 shrink-0 text-[var(--status-error)]" />
            <p className="typography-ui-label text-foreground">{t("Unable to check this worktree's status. Refresh and try again.")}</p>
          </div>
        ) : status === null ? (
          <p className="typography-ui-label text-muted-foreground" aria-live="polite">
            {t("Checking worktree status…")}
          </p>
        ) : null}

        {value?.hasActiveSession ? (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-3">
            <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />
            <p className="typography-ui-label text-foreground">{t("Stop the active session before closing this worktree.")}</p>
          </div>
        ) : null}

        {isDirty ? (
          <div className="space-y-3 rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-3">
            <div className="flex items-start gap-2">
              <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />
              <p className="typography-ui-label text-foreground">
                {t("This worktree has uncommitted changes. They will be permanently removed.")}
              </p>
            </div>
            <label className="flex items-start gap-2 pl-6 typography-ui-label text-foreground">
              <Checkbox
                checked={discardChangesConfirmed}
                onChange={setDiscardChangesConfirmed}
                ariaLabel={t("Confirm removal of uncommitted changes")}
                className="mt-0.5"
              />
              <span>{t("I understand that the uncommitted changes will be lost.")}</span>
            </label>
          </div>
        ) : null}

        {hasUnpublishedCommits ? (
          <div className="space-y-3">
            <p className="typography-ui-label text-muted-foreground">
              {status?.ahead === 1
                ? t('This worktree has 1 unpushed commit. {{retention}}', { retention: branchRetentionMessage })
                : t('This worktree has {{count}} unpushed commits. {{retention}}', { count: status?.ahead, retention: branchRetentionMessage })}
            </p>
            {isDetachedWithUnpublishedCommits ? (
              <div className="space-y-3 rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-3">
                <div className="flex items-start gap-2">
                  <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />
                  <p className="typography-ui-label text-foreground">
                    {t("Because this worktree is detached, its unpushed commits may be lost.")}
                  </p>
                </div>
                <label className="flex items-start gap-2 pl-6 typography-ui-label text-foreground">
                  <Checkbox
                    checked={discardChangesConfirmed}
                    onChange={setDiscardChangesConfirmed}
                    ariaLabel={t("Confirm removal of unpushed detached commits")}
                    className="mt-0.5"
                  />
                  <span>{t("I understand that the unpushed commits may be lost.")}</span>
                </label>
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter className="sm:justify-end">
          <Button variant="outline" size="sm" onClick={() => setValue(null)} disabled={isSubmitting}>
            {t("Cancel")}
          </Button>
          <Button variant="destructive" size="sm" onClick={() => void handleConfirm()} disabled={!canConfirm}>
            {isSubmitting ? t("Closing…") : t("Close worktree")}
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
  const { t } = useTranslation();

  return (
    <Dialog open={Boolean(value)} onOpenChange={(open) => { if (!open) setValue(null); }}>
      <DialogContent showCloseButton={false} className="max-w-sm gap-5">
        <DialogHeader>
          <DialogTitle>{t("Delete folder?")}</DialogTitle>
          <DialogDescription>
            {value && (value.subFolderCount > 0 || value.sessionCount > 0)
              ? value.subFolderCount > 0
                ? value.subFolderCount === 1
                  ? t('"{{name}}" will be deleted along with {{count}} sub-folder. Sessions inside will not be deleted.', { name: value.folderName, count: value.subFolderCount })
                  : t('"{{name}}" will be deleted along with {{count}} sub-folders. Sessions inside will not be deleted.', { name: value.folderName, count: value.subFolderCount })
                : t('"{{name}}" will be deleted. Sessions inside will not be deleted.', { name: value.folderName })
              : t('"{{name}}" will be permanently deleted.', { name: value?.folderName ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            type="button"
            onClick={() => setValue(null)}
            className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 typography-ui-label text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            {t("Cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex h-8 items-center justify-center rounded-md bg-destructive px-3 typography-ui-label text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
          >
            {t("Delete")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
