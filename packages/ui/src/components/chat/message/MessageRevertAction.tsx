import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useMessageHistoryAction } from './useMessageHistoryActions';

type MessageRevertActionProps = {
  sessionId?: string | null;
  messageId: string;
  /**
   * Size variant — user footer uses `h-6 w-6`, assistant footer uses `h-8 w-8`.
   * Keep the visual weight consistent with the sibling copy button.
   */
  size?: 'user' | 'assistant';
  /** Compact layout for user footer when icon-only. */
  className?: string;
  /** The active transcript's newest message is already the current state. */
  isLatestMessage?: boolean;
};

/**
 * Per-message revert control — renders under earlier user and assistant
 * messages, but not the newest rendered message because that is already the
 * current state. Disabled while the session is streaming (Pi rejects it
 * anyway). On success the daemon returns `editorText` which the
 * `revertToMessage` action puts in the composer when empty; we surface a
 * toast that files on disk were not changed.
 */
export const MessageRevertAction: React.FC<MessageRevertActionProps> = React.memo(
  ({ sessionId, messageId, size = 'user', isLatestMessage = false }) => {
    const { run, busy, disabled } = useMessageHistoryAction('revert', sessionId, messageId);
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

    if (isLatestMessage) return null;

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            aria-label="Revert conversation to here"
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
              <Icon name="history" className={iconSize} aria-hidden="true" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent sideOffset={6}>Revert to here</TooltipContent>
      </Tooltip>
    );
  },
);

MessageRevertAction.displayName = 'MessageRevertAction';
