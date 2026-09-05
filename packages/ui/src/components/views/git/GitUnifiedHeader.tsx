import React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { BranchSelector } from './BranchSelector';
import { WorktreeBranchDisplay } from './WorktreeBranchDisplay';
import { IdentityDropdown } from './IdentityDropdown';
import { SyncActions } from './SyncActions';
import { ChangeScopeSelector } from '../diff/ChangeScopeSelector';
import type { DiffHeaderControlsState, DiffHeaderScope } from '../DiffView';
import type {
  GitStatus,
  GitIdentityProfile,
  GitRemote,
} from '@/lib/api/types';

type SyncAction = 'fetch' | 'pull' | 'push' | 'sync' | null;

interface GitUnifiedHeaderProps {
  status: GitStatus;
  localBranches: string[];
  remoteBranches: string[];
  branchInfo: Record<string, { ahead?: number; behind?: number }> | undefined;
  syncAction: SyncAction;
  remotes: GitRemote[];
  onFetch: (remote: GitRemote) => void;
  onSync: (remote: GitRemote) => void;
  onRemoveRemote: (remote: GitRemote) => void;
  removingRemoteName: string | null;
  onCheckoutBranch: (branch: string) => void;
  onCreateBranch: (name: string, remote?: GitRemote) => Promise<void>;
  onRenameBranch?: (oldName: string, newName: string) => Promise<void>;
  activeIdentityProfile: GitIdentityProfile | null;
  availableIdentities: GitIdentityProfile[];
  onSelectIdentity: (profile: GitIdentityProfile) => void;
  isApplyingIdentity: boolean;
  isWorktreeMode: boolean;
  upstreamTarget: string | null;
  onOpenHistory?: () => void;
  onOpenGraph?: () => void;
  onOpenStashes?: () => void;
  onOpenUpdateBranch?: () => void;
  onOpenReintegrateCommits?: () => void;
  diffScope: DiffHeaderScope;
  onDiffScopeChange: (scope: DiffHeaderScope) => void;
  allCount: number;
  workingCount: number;
  stagedCount: number;
  branchAvailable: boolean;
  diffHeaderState: DiffHeaderControlsState | null;
}

/**
 * The single git header row. Branch switching, identity, change-scope
 * filtering, sync, and every repository/diff view action live here; hosts
 * portal it into their own header (ContextPanel slot) so the panel keeps
 * exactly one header row, or render it inline with a local border when they
 * have no panel chrome (full-view git).
 */
export const GitUnifiedHeader: React.FC<GitUnifiedHeaderProps> = ({
  status,
  localBranches,
  remoteBranches,
  branchInfo,
  syncAction,
  remotes,
  onFetch,
  onSync,
  onRemoveRemote,
  removingRemoteName,
  onCheckoutBranch,
  onCreateBranch,
  onRenameBranch,
  activeIdentityProfile,
  availableIdentities,
  onSelectIdentity,
  isApplyingIdentity,
  isWorktreeMode,
  upstreamTarget,
  onOpenHistory,
  onOpenGraph,
  onOpenStashes,
  onOpenUpdateBranch,
  onOpenReintegrateCommits,
  diffScope,
  onDiffScopeChange,
  allCount,
  workingCount,
  stagedCount,
  branchAvailable,
  diffHeaderState,
}) => {
  const hasViewsMenu =
    onOpenHistory ||
    onOpenGraph ||
    onOpenStashes ||
    onOpenUpdateBranch ||
    onOpenReintegrateCommits;
  const hasDiffFiles = (diffHeaderState?.totalCount ?? 0) > 0;
  const isCollapsibleScope = diffScope !== 'turn' && diffScope !== 'branch';
  const showViewOptions = hasViewsMenu || diffHeaderState !== null;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <div className="min-w-0 flex-shrink">
        {isWorktreeMode ? (
          <WorktreeBranchDisplay
            currentBranch={status.current}
            onRename={onRenameBranch}
          />
        ) : (
          <BranchSelector
            currentBranch={status.current}
            localBranches={localBranches}
            remoteBranches={remoteBranches}
            branchInfo={branchInfo}
            onCheckout={onCheckoutBranch}
            onCreate={onCreateBranch}
            remotes={remotes}
          />
        )}
      </div>
      <div className="shrink-0">
        <IdentityDropdown
          activeProfile={activeIdentityProfile}
          identities={availableIdentities}
          onSelect={onSelectIdentity}
          isApplying={isApplyingIdentity}
          iconOnly={true}
        />
      </div>
      <div className="min-w-0 shrink-0">
        <ChangeScopeSelector
          scope={diffScope}
          isGitRepo={true}
          branchAvailable={branchAvailable}
          allCount={allCount}
          workingCount={workingCount}
          stagedCount={stagedCount}
          turnCount={diffHeaderState?.turnCount ?? 0}
          branchCount={diffHeaderState?.branchCount ?? 0}
          onScopeChange={onDiffScopeChange}
        />
      </div>
      <div className="min-w-0 flex-1" />
      <div className="shrink-0">
        <SyncActions
          syncAction={syncAction}
          remotes={remotes}
          onFetch={onFetch}
          onSync={onSync}
          onRemoveRemote={onRemoveRemote}
          removingRemoteName={removingRemoteName}
          disabled={!status}
          iconOnly={true}
          aheadCount={status.ahead}
          behindCount={status.behind}
          trackingRemoteName={status.tracking?.split('/')[0]}
          hasUncommittedChanges={(status.files?.length ?? 0) > 0}
          upstreamTarget={upstreamTarget}
        />
      </div>
      {showViewOptions ? (
        <div className="shrink-0">
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 px-0"
                    aria-label={"Repository views"}
                  >
                    <Icon name="more-fill" className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent sideOffset={8}>{"Repository views"}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">
              {onOpenHistory ? (
                <DropdownMenuItem onSelect={onOpenHistory}>
                  <Icon name="history" className="size-4" />
                  {"History"}
                </DropdownMenuItem>
              ) : null}
              {onOpenGraph ? (
                <DropdownMenuItem onSelect={onOpenGraph}>
                  <Icon name="git-branch" className="size-4" />
                  {"Graph"}
                </DropdownMenuItem>
              ) : null}
              {onOpenStashes ? (
                <DropdownMenuItem onSelect={onOpenStashes}>
                  <Icon name="archive-stack" className="size-4" />
                  {"Stashes"}
                </DropdownMenuItem>
              ) : null}
              {onOpenUpdateBranch ? (
                <DropdownMenuItem onSelect={onOpenUpdateBranch}>
                  <Icon name="git-merge" className="size-4" />
                  {"Update branch"}
                </DropdownMenuItem>
              ) : null}
              {onOpenReintegrateCommits ? (
                <DropdownMenuItem onSelect={onOpenReintegrateCommits}>
                  <Icon name="split-cells-horizontal" className="size-4" />
                  {"Re-integrate commits"}
                </DropdownMenuItem>
              ) : null}
              {hasViewsMenu && diffHeaderState !== null ? (
                <DropdownMenuSeparator />
              ) : null}
              {diffHeaderState !== null ? (
                <DropdownMenuItem
                  disabled={!hasDiffFiles}
                  onSelect={diffHeaderState.onExpandOrCollapseAll}
                >
                  <Icon name="expand-up-down" className="size-4" />
                  {diffHeaderState.expandedCount > 0 ? "Collapse all" : "Expand all"}
                </DropdownMenuItem>
              ) : null}
              {diffHeaderState !== null ? (
                <DropdownMenuItem
                  disabled={!hasDiffFiles || !isCollapsibleScope}
                  onSelect={diffHeaderState.onToggleLoadFullFiles}
                >
                  <Icon name="file-download" className="size-4" />
                  <span className="flex-1">{"Load full files"}</span>
                  {diffHeaderState.loadFullFiles ? (
                    <Icon name="check" className="size-4" />
                  ) : null}
                </DropdownMenuItem>
              ) : null}
              {diffHeaderState !== null ? (
                <DropdownMenuItem
                  disabled={!hasDiffFiles}
                  onSelect={diffHeaderState.onToggleWrapLines}
                >
                  <Icon name="text-wrap" className="size-4" />
                  <span className="flex-1">{"Wrap lines"}</span>
                  {diffHeaderState.wrapLines ? (
                    <Icon name="check" className="size-4" />
                  ) : null}
                </DropdownMenuItem>
              ) : null}
              {diffHeaderState !== null ? (
                <DropdownMenuItem
                  disabled={diffHeaderState.layoutMode === null}
                  onSelect={diffHeaderState.onToggleLayout}
                >
                  <Icon
                    name={diffHeaderState.layoutMode === 'side-by-side' ? 'layout-column' : 'align-justify'}
                    className="size-4"
                  />
                  {diffHeaderState.layoutMode === 'side-by-side'
                    ? "Switch to unified view"
                    : "Switch to side-by-side view"}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
    </div>
  );
};
