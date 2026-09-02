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

export interface SessionNodeExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  descendantCount: number;
  exportIncludeSubtasks: boolean;
  setExportIncludeSubtasks: (value: boolean) => void;
  onExport: (includeSubtasks: boolean) => void;
}

export const SessionNodeExportDialog = React.memo(
  function SessionNodeExportDialog({
    open,
    onOpenChange,
    descendantCount,
    exportIncludeSubtasks,
    setExportIncludeSubtasks,
    onExport,
  }: SessionNodeExportDialogProps) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>{'Export Markdown'}</DialogTitle>
            <DialogDescription>
              {descendantCount === 1
                ? `This session has ${descendantCount} sub-agent task. Include it in the export?`
                : `This session has ${descendantCount} sub-agent tasks. Include them in the export?`}
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 typography-ui-label cursor-pointer">
            <input
              type="checkbox"
              checked={exportIncludeSubtasks}
              onChange={(e) => setExportIncludeSubtasks(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            {'Include sub-agent tasks'}
          </label>
          <DialogFooter>
            <Button
              type="button"
              onClick={() => onOpenChange(false)}
              variant="outline"
              size="sm"
            >
              {'Cancel'}
            </Button>
            <Button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onExport(exportIncludeSubtasks);
              }}
              size="sm"
            >
              {'Export'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);
