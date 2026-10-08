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
  const { t } = useTranslation();
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
            {action === 'delete' ? t('Delete session?') : t('Archive session?')}
          </DialogTitle>
          <DialogDescription>
            {action === 'delete'
              ? t('"{{title}}" will be permanently deleted.', { title: sessionTitle })
              : t('"{{title}}" will be archived.', { title: sessionTitle })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            {action === 'delete' ? t('Delete') : t('Archive')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
