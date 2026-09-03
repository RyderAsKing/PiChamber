import React from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useShiftKeyHeld } from '@/hooks/useShiftKeyHeld';

export type QuickSessionActionProps = {
  archiveLabel: string;
  deleteLabel: string;
  buttonSizeClass: string;
  iconSizeClass: string;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onMouseDown: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onArchive: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onDelete: (event: React.MouseEvent<HTMLButtonElement>) => void;
};

// Extracted so only this small button re-renders when Shift is pressed/released,
// instead of every mounted session row.
export const QuickSessionAction = React.memo(function QuickSessionAction({
  archiveLabel,
  deleteLabel,
  buttonSizeClass,
  iconSizeClass,
  onPointerDown,
  onMouseDown,
  onArchive,
  onDelete,
}: QuickSessionActionProps): React.ReactNode {
  const shiftHeld = useShiftKeyHeld();
  const label = shiftHeld ? deleteLabel : archiveLabel;

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (shiftHeld || event.shiftKey) {
      onDelete(event);
      return;
    }
    onArchive(event);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-opacity',
            shiftHeld
              ? 'text-destructive hover:text-destructive'
              : 'text-muted-foreground hover:text-foreground',
            buttonSizeClass
          )}
          aria-label={label}
          onPointerDown={onPointerDown}
          onMouseDown={onMouseDown}
          onClick={handleClick}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Icon
            name={shiftHeld ? 'delete-bin' : 'archive'}
            className={iconSizeClass}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
});
