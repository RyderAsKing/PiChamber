import React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from "@/components/icon/Icon";
import type { Session } from '@/lib/chat/types';

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
  const untitledSession = "Untitled Session";

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
                  ? `\\"${value.session.title || untitledSession}\\" and its ${value.descendantCount} sub-task will be permanently deleted.`
                  : `\\"${value.session.title || untitledSession}\\" and its ${value.descendantCount} sub-tasks will be permanently deleted.`
                : value.descendantCount === 1
                  ? `\\"${value.session.title || untitledSession}\\" and its ${value.descendantCount} sub-task will be archived.`
                  : `\\"${value.session.title || untitledSession}\\" and its ${value.descendantCount} sub-tasks will be archived.`
              : value?.archivedBucket
                ? `\\"${value?.session.title || untitledSession}\\" will be permanently deleted.`
                : `\\"${value?.session.title || untitledSession}\\" will be archived.`}
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
