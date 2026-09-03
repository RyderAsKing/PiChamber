import React from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { BranchIntegrationSection, type OperationLogEntry } from './BranchIntegrationSection';

export interface UpdateBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branchOperation: 'merge' | 'rebase' | null;
  currentBranch?: string;
  localBranches: string[];
  remoteBranches: string[];
  defaultTargetBranch: string | null;
  onMerge: (branch: string) => Promise<void>;
  onRebase: (branch: string) => Promise<void>;
  disabled: boolean;
  operationLogs: OperationLogEntry[];
  onOperationComplete: () => void;
  canShowBranchWorkflows: boolean;
}

export const UpdateBranchDialog = React.memo<UpdateBranchDialogProps>(function UpdateBranchDialog({
  open,
  onOpenChange,
  branchOperation,
  currentBranch,
  localBranches,
  remoteBranches,
  defaultTargetBranch,
  onMerge,
  onRebase,
  disabled,
  operationLogs,
  onOperationComplete,
  canShowBranchWorkflows,
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        // Prevent dismissing the dialog while merge/rebase is actively running so the
        // operation log stays visible until it completes or fails.
        if (!nextOpen && branchOperation !== null) {
          return;
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-2xl min-h-[26rem]">
        <DialogHeader>
          <DialogTitle>{"Update branch"}</DialogTitle>
          <DialogDescription>
            {"Bring the latest changes into"}{' '}
            <span className="font-mono text-foreground">{currentBranch ?? ''}</span>.
          </DialogDescription>
        </DialogHeader>
        {canShowBranchWorkflows ? (
          <BranchIntegrationSection
            mode="bare"
            currentBranch={currentBranch}
            localBranches={localBranches}
            remoteBranches={remoteBranches}
            defaultTargetBranch={defaultTargetBranch ?? undefined}
            onMerge={onMerge}
            onRebase={onRebase}
            disabled={disabled}
            isOperating={branchOperation !== null}
            operationLogs={operationLogs}
            onOperationComplete={onOperationComplete}
          />
        ) : (
          <p className="typography-meta text-muted-foreground">
            {"Branch actions unavailable in this repository state"}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
});
