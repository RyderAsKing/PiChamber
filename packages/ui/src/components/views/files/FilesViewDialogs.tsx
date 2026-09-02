import React from 'react';
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

  return (
    <Dialog open={!!activeDialog} onOpenChange={(open) => !open && onClose()}>
      <DialogContent initialFocus={inputRef}>
        <DialogHeader>
          <DialogTitle>
            {activeDialog === 'createFile' && "Create File"}
            {activeDialog === 'createFolder' && "Create Folder"}
            {activeDialog === 'rename' && "Rename"}
            {activeDialog === 'delete' && "Delete"}
          </DialogTitle>
          <DialogDescription>
            {activeDialog === 'createFile' && `Create a new file in ${dialogData?.path ?? "root"}`}
            {activeDialog === 'createFolder' && `Create a new folder in ${dialogData?.path ?? "root"}`}
            {activeDialog === 'rename' && `Rename ${dialogData?.name ?? ''}`}
            {activeDialog === 'delete' && `Are you sure you want to delete ${dialogData?.name ?? ''}? This action cannot be undone.`}
          </DialogDescription>
        </DialogHeader>

        {activeDialog !== 'delete' && (
          <div className="py-4">
            <Input
              value={dialogInputValue}
              onChange={(e) => onDialogInputChange(e.target.value)}
              placeholder={activeDialog === 'rename' ? "New name" : "Name"}
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
            {"Cancel"}
          </Button>
          <Button
            variant={activeDialog === 'delete' ? 'destructive' : 'default'}
            onClick={() => void onDialogSubmit()}
            disabled={isDialogSubmitting || (activeDialog !== 'delete' && !dialogInputValue.trim())}
          >
            {isDialogSubmitting ? <Icon name="loader-4" className="size-4 animate-spin" /> : (
                activeDialog === 'delete' ? "Delete" : "Confirm"
            )}
          </Button>
        </DialogFooter>
        </DialogContent>
      </Dialog>
    );
};
