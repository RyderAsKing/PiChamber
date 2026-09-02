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

export interface UnsavedChangesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isSaving: boolean;
  onSaveAndContinue: () => void;
  onDiscardAndContinue: () => void;
}

export const UnsavedChangesDialog: React.FC<UnsavedChangesDialogProps> = ({
  open,
  onOpenChange,
  isSaving,
  onSaveAndContinue,
  onDiscardAndContinue,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="max-w-md">
        <DialogHeader>
          <DialogTitle>Unsaved changes</DialogTitle>
          <DialogDescription>Save your edits before continuing?</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={onSaveAndContinue}
            disabled={isSaving}
            className="border-[var(--status-success-border)] bg-[var(--status-success-background)] text-[var(--status-success)] hover:bg-[rgb(var(--status-success)/0.2)]"
          >
            Save changes
          </Button>
          <Button variant="destructive" onClick={onDiscardAndContinue}>
            Discard
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
