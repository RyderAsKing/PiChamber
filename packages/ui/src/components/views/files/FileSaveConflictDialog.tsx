import React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export type FileSaveConflictDetails = {
  path: string;
  displayPath: string;
  exists: boolean;
  currentRevision: string | null;
  currentContent: string | null;
  dirtyContent: string;
};

type FileSaveConflictDialogProps = {
  open: boolean;
  conflict: FileSaveConflictDetails | null;
  isResolving: boolean;
  showCompare: boolean;
  onToggleCompare: () => void;
  onReload: () => void;
  onOverwrite: () => void;
  onClose: () => void;
};

const truncatePreview = (value: string, maxChars = 4000): string => (
  value.length > maxChars ? `${value.slice(0, maxChars)}\n\n… truncated …` : value
);

/**
 * Explicit reload / overwrite / compare workflow for file-save revision
 * conflicts. Dirty text is never cleared by this dialog; Reload discards it
 * only on explicit user action, Overwrite forces the preserved dirty text,
 * and Compare previews both versions before choosing.
 */
export const FileSaveConflictDialog: React.FC<FileSaveConflictDialogProps> = ({
  open,
  conflict,
  isResolving,
  showCompare,
  onToggleCompare,
  onReload,
  onOverwrite,
  onClose,
}) => {
  if (!conflict) return null;
  const deleted = !conflict.exists;
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent showCloseButton={false} className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{deleted ? 'File deleted on disk' : 'File changed on disk'}</DialogTitle>
          <DialogDescription>
            {deleted
              ? `“${conflict.displayPath}” was deleted since you opened it. Your edits are preserved. Reload to discard them, or overwrite to recreate the file.`
              : `“${conflict.displayPath}” changed since you opened it. Your edits are preserved. Reload to discard them and load the current version, or overwrite to keep your edits.`}
          </DialogDescription>
        </DialogHeader>
        {showCompare && !deleted ? (
          <div className="grid max-h-64 grid-cols-1 gap-2 overflow-auto py-2">
            <div>
              <div className="typography-meta text-muted-foreground">Current version on disk</div>
              <pre className="mt-1 max-h-28 overflow-auto rounded-md bg-[var(--surface-subtle)] p-2 text-xs whitespace-pre-wrap break-words">
                {truncatePreview(conflict.currentContent ?? '')}
              </pre>
            </div>
            <div>
              <div className="typography-meta text-muted-foreground">Your edits</div>
              <pre className="mt-1 max-h-28 overflow-auto rounded-md bg-[var(--surface-subtle)] p-2 text-xs whitespace-pre-wrap break-words">
                {truncatePreview(conflict.dirtyContent)}
              </pre>
            </div>
          </div>
        ) : null}
        <DialogFooter className="flex flex-wrap gap-2">
          {!deleted ? (
            <Button
              variant="outline"
              onClick={onToggleCompare}
              disabled={isResolving}
              aria-label={showCompare ? 'Hide version comparison' : 'Compare versions'}
              title={showCompare ? 'Hide version comparison' : 'Compare versions'}
            >
              {showCompare ? 'Hide compare' : 'Compare'}
            </Button>
          ) : null}
          <Button
            variant="outline"
            onClick={onReload}
            disabled={isResolving}
            aria-label={deleted ? 'Discard edits and close' : 'Reload current version'}
            title={deleted ? 'Discard edits and close' : 'Reload current version'}
          >
            {deleted ? 'Discard edits' : 'Reload'}
          </Button>
          <Button
            variant="destructive"
            onClick={onOverwrite}
            disabled={isResolving}
            aria-label={deleted ? 'Recreate file with my edits' : 'Overwrite with my edits'}
            title={deleted ? 'Recreate file with my edits' : 'Overwrite with my edits'}
          >
            {isResolving ? 'Working…' : 'Overwrite'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
