import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';

type Props = {
  selectedCount: number;
  scopeKey: string | null;
  scopeFolders: SessionFolder[];
  archivedBucket: boolean;
  onMoveToFolder: (folderId: string) => void;
  onCreateFolderAndMove: () => void;
  onRemoveFromFolder: () => void;
  canRemoveFromFolder: boolean;
  onRestore: () => void;
  onDelete: () => void;
  onDone: () => void;
};

export const BulkActionBar: React.FC<Props> = ({
  selectedCount,
  archivedBucket,
  onRestore,
  onDelete,
  onDone,
}) => {
  
  const destructiveLabel = archivedBucket
    ? "Delete"
    : "Archive";
  const iconButtonClass = 'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50';
  const destructiveIconButtonClass = 'inline-flex h-7 w-7 items-center justify-center rounded-md text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50';

  return (
    <div className="flex shrink-0 items-center gap-1 border-t border-border px-3 py-1.5">
      <span className="typography-ui-label text-muted-foreground whitespace-nowrap">
        {`${selectedCount} selected`}
      </span>

      <div className="ml-auto flex items-center gap-0.5">
        {archivedBucket ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onRestore}
                className={iconButtonClass}
                aria-label={"Restore"}
              >
                <Icon name="inbox-unarchive" className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}><p>{"Restore"}</p></TooltipContent>
          </Tooltip>
        ) : null}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onDelete}
              className={cn(destructiveIconButtonClass)}
              aria-label={destructiveLabel}
            >
              <Icon name="delete-bin" className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}><p>{destructiveLabel}</p></TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onDone}
              className={iconButtonClass}
              aria-label={"Exit selection"}
            >
              <Icon name="close" className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}><p>{"Exit selection"}</p></TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
};