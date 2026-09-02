import React from 'react';

import type { CommitFileEntry } from '@/lib/api/types';
import type { OperationLogEntry } from './BranchIntegrationSection';
import { ConflictDialog } from './ConflictDialog';
import { GitHistoryDialog, type GitLogDialogMode, type HistoryBranchDivider } from './GitHistoryDialog';
import { GitmojiPickerDialog } from './GitmojiPickerDialog';
import { StashDialog } from './StashDialog';
import { StashesDialog } from './StashesDialog';
import { UpdateBranchDialog } from './UpdateBranchDialog';

export type BranchOperation = 'merge' | 'rebase' | null;

export interface GitViewDialogsProps {
  currentDirectory: string | null;

  // UpdateBranchDialog props
  isUpdateBranchDialogOpen: boolean;
  setIsUpdateBranchDialogOpen: (open: boolean) => void;
  branchOperation: BranchOperation;
  currentBranch?: string;
  localBranches: string[];
  remoteBranches: string[];
  updateTargetBranch: string | null;
  onMerge: (sourceBranch: string) => Promise<void>;
  onRebase: (sourceBranch: string) => Promise<void>;
  isBusy: boolean;
  operationLogs: OperationLogEntry[];
  onOperationComplete: () => void;
  canShowBranchWorkflows: boolean;

  // GitHistoryDialog props
  gitLogDialogMode: GitLogDialogMode | null;
  setGitLogDialogMode: (mode: GitLogDialogMode | null) => void;
  onRefreshHistory: () => void;
  isLogRefreshing: boolean;
  log: any;
  maxCount: number;
  onMaxCountChange: (count: number) => void;
  expandedCommitHashes: Set<string>;
  onToggleCommit: (hash: string) => void;
  commitFilesMap: Map<string, CommitFileEntry[]>;
  loadingCommitHashes: Set<string>;
  onCopyHash: (hash: string) => void;
  historyBranchDivider: HistoryBranchDivider | null;
  onConflict?: (conflict: any) => void;
  onActionSuccess?: () => void;

  // StashesDialog props
  isStashesDialogOpen: boolean;
  setIsStashesDialogOpen: (open: boolean) => void;
  hasUncommittedChanges: boolean;
  hasStagedChanges: boolean;
  uncommittedFileCount: number;
  onStashesChanged: (change?: { affectsIndex?: boolean }) => Promise<void>;

  // GitmojiPickerDialog props
  isGitmojiPickerOpen: boolean;
  setIsGitmojiPickerOpen: (open: boolean) => void;
  gitmojiEmojis: any[];
  onSelectGitmoji: (emoji: string, code: string) => void;

  // ConflictDialog props
  conflictDialogOpen: boolean;
  setConflictDialogOpen: (open: boolean) => void;
  conflictFiles: string[];
  conflictOperation: 'merge' | 'rebase';
  onAbortConflict: () => Promise<void>;
  onClearConflictState: () => void;

  // StashDialog props
  stashDialogOpen: boolean;
  setStashDialogOpen: (open: boolean) => void;
  stashDialogOperation: 'merge' | 'rebase';
  stashDialogBranch: string;
  onConfirmStashAndRetry: (restoreAfter: boolean) => Promise<void>;
}

export const GitViewDialogs: React.FC<GitViewDialogsProps> = ({
  currentDirectory,
  isUpdateBranchDialogOpen,
  setIsUpdateBranchDialogOpen,
  branchOperation,
  currentBranch,
  localBranches,
  remoteBranches,
  updateTargetBranch,
  onMerge,
  onRebase,
  isBusy,
  operationLogs,
  onOperationComplete,
  canShowBranchWorkflows,
  gitLogDialogMode,
  setGitLogDialogMode,
  onRefreshHistory,
  isLogRefreshing,
  log,
  maxCount,
  onMaxCountChange,
  expandedCommitHashes,
  onToggleCommit,
  commitFilesMap,
  loadingCommitHashes,
  onCopyHash,
  historyBranchDivider,
  onConflict,
  onActionSuccess,
  isStashesDialogOpen,
  setIsStashesDialogOpen,
  hasUncommittedChanges,
  hasStagedChanges,
  uncommittedFileCount,
  onStashesChanged,
  isGitmojiPickerOpen,
  setIsGitmojiPickerOpen,
  gitmojiEmojis,
  onSelectGitmoji,
  conflictDialogOpen,
  setConflictDialogOpen,
  conflictFiles,
  conflictOperation,
  onAbortConflict,
  onClearConflictState,
  stashDialogOpen,
  setStashDialogOpen,
  stashDialogOperation,
  stashDialogBranch,
  onConfirmStashAndRetry,
}) => {
  return (
    <>
      <UpdateBranchDialog
        open={isUpdateBranchDialogOpen}
        onOpenChange={setIsUpdateBranchDialogOpen}
        branchOperation={branchOperation}
        currentBranch={currentBranch}
        localBranches={localBranches}
        remoteBranches={remoteBranches}
        defaultTargetBranch={updateTargetBranch}
        onMerge={onMerge}
        onRebase={onRebase}
        disabled={isBusy}
        operationLogs={operationLogs}
        onOperationComplete={onOperationComplete}
        canShowBranchWorkflows={canShowBranchWorkflows}
      />

      <GitHistoryDialog
        mode={gitLogDialogMode}
        onOpenChange={(open) => {
          if (!open) setGitLogDialogMode(null);
        }}
        onRefresh={onRefreshHistory}
        isRefreshing={isLogRefreshing}
        log={log}
        maxCount={maxCount}
        onMaxCountChange={onMaxCountChange}
        expandedCommitHashes={expandedCommitHashes}
        onToggleCommit={onToggleCommit}
        commitFilesMap={commitFilesMap}
        loadingCommitHashes={loadingCommitHashes}
        onCopyHash={onCopyHash}
        directory={currentDirectory ?? undefined}
        branchDivider={historyBranchDivider}
        onConflict={onConflict}
        onActionSuccess={onActionSuccess}
      />

      <StashesDialog
        open={isStashesDialogOpen}
        onOpenChange={setIsStashesDialogOpen}
        directory={currentDirectory}
        hasUncommittedChanges={hasUncommittedChanges}
        hasStagedChanges={hasStagedChanges}
        uncommittedFileCount={uncommittedFileCount}
        onChanged={onStashesChanged}
      />

      <GitmojiPickerDialog
        open={isGitmojiPickerOpen}
        onOpenChange={setIsGitmojiPickerOpen}
        gitmojis={gitmojiEmojis}
        onSelect={onSelectGitmoji}
      />

      {currentDirectory && (
        <ConflictDialog
          open={conflictDialogOpen}
          onOpenChange={setConflictDialogOpen}
          conflictFiles={conflictFiles}
          directory={currentDirectory}
          operation={conflictOperation}
          onAbort={onAbortConflict}
          onClearState={onClearConflictState}
        />
      )}

      <StashDialog
        open={stashDialogOpen}
        onOpenChange={setStashDialogOpen}
        operation={stashDialogOperation}
        targetBranch={stashDialogBranch}
        onConfirm={onConfirmStashAndRetry}
      />
    </>
  );
};
