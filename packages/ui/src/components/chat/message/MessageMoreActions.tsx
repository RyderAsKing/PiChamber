import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useMessageHistoryAction } from './useMessageHistoryActions';

type MessageMoreActionsProps = {
  sessionId?: string | null;
  messageId: string;
  /** Revert is offered on earlier messages only; the newest is already the current state. */
  showRevert: boolean;
  /** Saves the answer as an image; called with the menu's trigger so it can find the message. */
  onSaveImage?: (trigger: HTMLElement) => void;
  saveImageDisabled?: boolean;
  size?: 'user' | 'assistant';
};

/**
 * On touch screens a message keeps Copy in view and puts its other actions
 * (Revert to here, Fork to new session, Save as image) behind one ⋯ button
 * with written labels, so the row under each message stays quiet.
 */
export const MessageMoreActions: React.FC<MessageMoreActionsProps> = React.memo(
  ({ sessionId, messageId, showRevert, onSaveImage, saveImageDisabled = false, size = 'user' }) => {
    const revert = useMessageHistoryAction('revert', sessionId, messageId);
    const fork = useMessageHistoryAction('fork', sessionId, messageId);
    const triggerRef = React.useRef<HTMLButtonElement | null>(null);
    const busy = revert.busy || fork.busy;

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="icon"
            aria-label="More message actions"
            className={cn(
              size === 'user' ? 'h-6 w-6' : 'h-8 w-8',
              'text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50',
            )}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {busy ? (
              <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Icon name="more-fill" className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {showRevert ? (
            <DropdownMenuItem disabled={revert.disabled} onSelect={() => void revert.run()}>
              {'Revert to here'}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem disabled={fork.disabled} onSelect={() => void fork.run()}>
            {'Fork to new session'}
          </DropdownMenuItem>
          {onSaveImage ? (
            <DropdownMenuItem
              disabled={saveImageDisabled}
              onSelect={() => {
                if (triggerRef.current) onSaveImage(triggerRef.current);
              }}
            >
              {'Save as image'}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  },
);

MessageMoreActions.displayName = 'MessageMoreActions';
