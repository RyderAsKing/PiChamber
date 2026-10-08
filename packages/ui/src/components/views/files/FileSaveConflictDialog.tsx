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
  const { t } = useTranslation();
  if (!conflict) return null;
  const deleted = !conflict.exists;
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent showCloseButton={false} className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{deleted ? t('File deleted on disk') : t('File changed on disk')}</DialogTitle>
          <DialogDescription>
            {deleted
              ? t('“{{displayPath}}” was deleted since you opened it. Your edits are preserved. Reload to discard them, or overwrite to recreate the file.', { displayPath: conflict.displayPath })
              : t('“{{displayPath}}” changed since you opened it. Your edits are preserved. Reload to discard them and load the current version, or overwrite to keep your edits.', { displayPath: conflict.displayPath })}
          </DialogDescription>
        </DialogHeader>
        {showCompare && !deleted ? (
          <div className="grid max-h-64 grid-cols-1 gap-2 overflow-auto py-2">
            <div>
              <div className="typography-meta text-muted-foreground">{t('Current version on disk')}</div>
              <pre className="mt-1 max-h-28 overflow-auto rounded-md bg-[var(--surface-subtle)] p-2 text-xs whitespace-pre-wrap break-words">
                {truncatePreview(conflict.currentContent ?? '')}
              </pre>
            </div>
            <div>
              <div className="typography-meta text-muted-foreground">{t('Your edits')}</div>
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
              aria-label={showCompare ? t('Hide version comparison') : t('Compare versions')}
              title={showCompare ? t('Hide version comparison') : t('Compare versions')}
            >
              {showCompare ? t('Hide compare') : t('Compare')}
            </Button>
          ) : null}
          <Button
            variant="outline"
            onClick={onReload}
            disabled={isResolving}
            aria-label={deleted ? t('Discard edits and close') : t('Reload current version')}
            title={deleted ? t('Discard edits and close') : t('Reload current version')}
          >
            {deleted ? t('Discard edits') : t('Reload')}
          </Button>
          <Button
            variant="destructive"
            onClick={onOverwrite}
            disabled={isResolving}
            aria-label={deleted ? t('Recreate file with my edits') : t('Overwrite with my edits')}
            title={deleted ? t('Recreate file with my edits') : t('Overwrite with my edits')}
          >
            {isResolving ? t('Working…') : t('Overwrite')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
