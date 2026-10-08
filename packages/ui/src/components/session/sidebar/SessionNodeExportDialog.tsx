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
    const { t } = useTranslation();
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>{t('Export Markdown')}</DialogTitle>
            <DialogDescription>
              {descendantCount === 1
                ? t('This session has {{count}} sub-agent task. Include it in the export?', { count: descendantCount })
                : t('This session has {{count}} sub-agent tasks. Include them in the export?', { count: descendantCount })}
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 typography-ui-label cursor-pointer">
            <input
              type="checkbox"
              checked={exportIncludeSubtasks}
              onChange={(e) => setExportIncludeSubtasks(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            {t('Include sub-agent tasks')}
          </label>
          <DialogFooter>
            <Button
              type="button"
              onClick={() => onOpenChange(false)}
              variant="outline"
              size="sm"
            >
              {t('Cancel')}
            </Button>
            <Button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onExport(exportIncludeSubtasks);
              }}
              size="sm"
            >
              {t('Export')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);
