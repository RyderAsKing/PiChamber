import React from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { HistorySection } from './HistorySection';
import type { CommitFileEntry, GitLogResponse } from '@/lib/api/types';

export type HistoryBranchDivider = {
  insertBeforeIndex: number;
  branchName: string;
  direction: 'up' | 'down';
} | null;

export type GitLogDialogMode = 'history' | 'graph';

export interface GitHistoryDialogProps {
  mode: GitLogDialogMode | null;
  onOpenChange: (open: boolean) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  log: GitLogResponse | null;
  maxCount: number;
  onMaxCountChange: (count: number) => void;
  expandedCommitHashes: Set<string>;
  onToggleCommit: (hash: string) => void;
  commitFilesMap: Map<string, CommitFileEntry[]>;
  loadingCommitHashes: Set<string>;
  onCopyHash: (hash: string) => void;
  directory?: string;
  branchDivider?: HistoryBranchDivider;
  onConflict?: (result: { conflict: boolean; conflictFiles?: string[]; operation: 'cherry-pick' | 'revert' | 'merge' | 'rebase' }) => void;
  onActionSuccess?: () => void;
}

export const GitHistoryDialog = React.memo<GitHistoryDialogProps>(function GitHistoryDialog({
  mode,
  onOpenChange,
  onRefresh,
  isRefreshing,
  log,
  maxCount,
  onMaxCountChange,
  expandedCommitHashes,
  onToggleCommit,
  commitFilesMap,
  loadingCommitHashes,
  onCopyHash,
  directory,
  branchDivider,
  onConflict,
  onActionSuccess,
}) {
  if (!mode) return null;

  return (
    <Dialog open={mode !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl h-[90vh] max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <div className="flex items-center justify-between gap-2">
            <DialogTitle>
              {mode === 'graph' ? "Graph" : "History"}
            </DialogTitle>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mr-6 h-7 shrink-0 gap-1.5 px-2"
              onClick={onRefresh}
              disabled={isRefreshing}
              title={"Refresh"}
              aria-label={"Refresh"}
            >
              <Icon
                name="refresh"
                className={cn('size-4', isRefreshing && 'animate-spin')}
              />
              {"Refresh"}
            </Button>
          </div>
          <DialogDescription>
            {"Browse recent commits and inspect changed files."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0">
          <HistorySection
            mode={mode === 'graph' ? 'graph' : 'history'}
            log={log}
            isLogLoading={isRefreshing}
            logMaxCount={maxCount}
            onLogMaxCountChange={onMaxCountChange}
            expandedCommitHashes={expandedCommitHashes}
            onToggleCommit={onToggleCommit}
            commitFilesMap={commitFilesMap}
            loadingCommitHashes={loadingCommitHashes}
            onCopyHash={onCopyHash}
            directory={directory}
            showHeader={false}
            contentMaxHeightClassName="h-full max-h-none"
            branchDivider={mode === 'graph' ? null : branchDivider}
            onConflict={mode === 'graph' ? onConflict : undefined}
            onActionSuccess={mode === 'graph' ? onActionSuccess : undefined}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
});
