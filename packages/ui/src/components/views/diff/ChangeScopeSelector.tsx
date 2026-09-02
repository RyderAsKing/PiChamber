import React from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import type { DiffScope } from './diffTypes';

export interface ChangeScopeSelectorProps {
  scope: Extract<DiffScope, 'all' | 'working' | 'staged' | 'turn' | 'branch'>;
  isGitRepo: boolean | null;
  branchAvailable: boolean;
  allCount: number;
  workingCount: number;
  stagedCount: number;
  turnCount: number;
  branchCount: number;
  onScopeChange?: (scope: Extract<DiffScope, 'all' | 'working' | 'staged' | 'turn' | 'branch'>) => void;
}

export const ChangeScopeSelector = React.memo<ChangeScopeSelectorProps>(function ChangeScopeSelector({
  scope,
  isGitRepo,
  branchAvailable,
  allCount,
  workingCount,
  stagedCount,
  turnCount,
  branchCount,
  onScopeChange,
}) {
  const [open, setOpen] = React.useState(false);
  const currentCount = scope === 'all'
    ? allCount
    : scope === 'staged'
      ? stagedCount
      : scope === 'turn'
        ? turnCount
        : scope === 'branch'
          ? branchCount
          : workingCount;
  const currentLabel = scope === 'staged'
    ? "Staged"
    : scope === 'turn'
      ? "Last turn"
      : scope === 'branch'
        ? "Branch"
        : scope === 'all'
          ? "All"
          : "Changed";

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-7 flex-shrink-0 items-center gap-1.5 rounded-md px-2 typography-ui-label font-semibold text-foreground outline-none hover:bg-interactive-hover focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={"Select change mode"}
        >
          <span className="whitespace-nowrap">
            {currentLabel}<span className="diff-toolbar__scope-count">: {currentCount}</span>
          </span>
          <Icon name="arrow-down-s" className="size-4 flex-shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40">
        <DropdownMenuRadioGroup
          value={scope}
          onValueChange={(value) => {
            if (value === 'all' || value === 'working' || value === 'staged' || value === 'turn' || value === 'branch') {
              onScopeChange?.(value);
              setOpen(false);
            }
          }}
        >
          {isGitRepo !== false ? (
            <DropdownMenuRadioItem value="all">
              <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                <span>{"All"}</span>
                <span className="typography-meta text-muted-foreground">{allCount}</span>
              </span>
            </DropdownMenuRadioItem>
          ) : null}
          {isGitRepo !== false ? (
            <DropdownMenuRadioItem value="working">
              <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                <span>{"Changed"}</span>
                <span className="typography-meta text-muted-foreground">{workingCount}</span>
              </span>
            </DropdownMenuRadioItem>
          ) : null}
          {isGitRepo !== false ? (
            <DropdownMenuRadioItem value="staged">
              <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                <span>{"Staged"}</span>
                <span className="typography-meta text-muted-foreground">{stagedCount}</span>
              </span>
            </DropdownMenuRadioItem>
          ) : null}
          <DropdownMenuRadioItem value="turn">
            <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
              <span>{"Last turn"}</span>
              <span className="typography-meta text-muted-foreground">{turnCount}</span>
            </span>
          </DropdownMenuRadioItem>
          {branchAvailable ? (
            <DropdownMenuRadioItem value="branch">
              <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                <span>{"Branch"}</span>
                <span className="typography-meta text-muted-foreground">{branchCount}</span>
              </span>
            </DropdownMenuRadioItem>
          ) : null}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
