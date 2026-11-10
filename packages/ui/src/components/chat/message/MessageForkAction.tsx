import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useMessageHistoryAction } from './useMessageHistoryActions';

type MessageForkActionProps = {
  sessionId?: string | null;
  messageId: string;
  size?: 'user' | 'assistant';
};

export const MessageForkAction: React.FC<MessageForkActionProps> = React.memo(
  ({ sessionId, messageId, size = 'user' }) => {
    const { run, busy, disabled } = useMessageHistoryAction('fork', sessionId, messageId);
    const handleClick = React.useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        event.preventDefault();
        void run();
      },
      [run],
    );
    const dimH = size === 'user' ? 'h-6 w-6' : 'h-8 w-8';
    const iconSize = size === 'user' ? 'h-3 w-3' : 'h-3.5 w-3.5';

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            aria-label="Fork conversation from here"
            className={cn(
              dimH,
              'text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50',
              disabled && 'opacity-50',
            )}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={handleClick}
          >
            {busy ? (
              <Icon name="loader-4" className={cn(iconSize, 'animate-spin')} aria-hidden="true" />
            ) : (
              <Icon name="git-branch" className={iconSize} aria-hidden="true" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent sideOffset={6}>Fork to new session</TooltipContent>
      </Tooltip>
    );
  },
);

MessageForkAction.displayName = 'MessageForkAction';
