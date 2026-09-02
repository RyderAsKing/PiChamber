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

export type HeaderRetentionAction = 'delete' | 'archive' | null;

export interface HeaderRetentionDialogProps {
  action: HeaderRetentionAction;
  onClose: () => void;
  sessionTitle: string;
  onConfirm: () => void;
}

export const HeaderRetentionDialog: React.FC<HeaderRetentionDialogProps> = ({
  action,
  onClose,
  sessionTitle,
  onConfirm,
}) => {
  return (
    <Dialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="max-w-sm gap-5">
        <DialogHeader>
          <DialogTitle>
            {action === 'delete' ? 'Delete session?' : 'Archive session?'}
          </DialogTitle>
          <DialogDescription>
            {action === 'delete'
              ? `"${sessionTitle}" will be permanently deleted.`
              : `"${sessionTitle}" will be archived.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {'Cancel'}
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            {action === 'delete' ? 'Delete' : 'Archive'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
