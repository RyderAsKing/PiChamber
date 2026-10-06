import React from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';

interface DialogsProps {
  activeDialog: 'createFile' | 'createFolder' | 'rename' | 'delete' | null;
  dialogData: { path: string; name?: string; type?: 'file' | 'directory' } | null;
  dialogInputValue: string;
  onDialogInputChange: (value: string) => void;
  isDialogSubmitting: boolean;
  onDialogSubmit: (e?: React.FormEvent) => Promise<void>;
  onClose: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

export const Dialogs: React.FC<DialogsProps> = ({
  activeDialog,
  dialogData,
  dialogInputValue,
  onDialogInputChange,
  isDialogSubmitting,
  onDialogSubmit,
  onClose,
  inputRef,
}) => {
  const { t } = useTranslation();
  return (
    <Dialog open={!!activeDialog} onOpenChange={(open) => !open && onClose()}>
      <DialogContent initialFocus={inputRef}>
        <DialogHeader>
          <DialogTitle>
            {activeDialog === 'createFile' && t("Create File")}
            {activeDialog === 'createFolder' && t("Create Folder")}
            {activeDialog === 'rename' && t("Rename")}
            {activeDialog === 'delete' && t("Delete")}
          </DialogTitle>
          <DialogDescription>
            {activeDialog === 'createFile' && t('Create a new file in {{path}}', { path: dialogData?.path ?? t("root") })}
            {activeDialog === 'createFolder' && t('Create a new folder in {{path}}', { path: dialogData?.path ?? t("root") })}
            {activeDialog === 'rename' && t('Rename {{name}}', { name: dialogData?.name ?? '' })}
            {activeDialog === 'delete' && t('Are you sure you want to delete {{name}}? This action cannot be undone.', { name: dialogData?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>

        {activeDialog !== 'delete' && (
          <div className="py-4">
            <Input
              value={dialogInputValue}
              onChange={(e) => onDialogInputChange(e.target.value)}
              placeholder={activeDialog === 'rename' ? t("New name") : t("Name")}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void onDialogSubmit();
                }
              }}
              ref={inputRef}
              />
            </div>
          )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isDialogSubmitting}>
            {t("Cancel")}
          </Button>
          <Button
            variant={activeDialog === 'delete' ? 'destructive' : 'default'}
            onClick={() => void onDialogSubmit()}
            disabled={isDialogSubmitting || (activeDialog !== 'delete' && !dialogInputValue.trim())}
          >
            {isDialogSubmitting ? <Icon name="loader-4" className="size-4 animate-spin" /> : (
                activeDialog === 'delete' ? t("Delete") : t("Confirm")
            )}
          </Button>
        </DialogFooter>
        </DialogContent>
      </Dialog>
    );
};
