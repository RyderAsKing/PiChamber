import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { toast } from '@/components/ui';

type MessageForkActionProps = {
  sessionId?: string | null;
  messageId: string;
  size?: 'user' | 'assistant';
};

export const MessageForkAction: React.FC<MessageForkActionProps> = React.memo(
  ({ sessionId, messageId, size = 'user' }) => {
    const forkFromMessage = useSessionUIStore((s) => s.forkFromMessage);
    const [busy, setBusy] = React.useState(false);
    const [isStreaming, setIsStreaming] = React.useState(() => {
      if (!sessionId) return false;
      const state = getPiSessionStore().getState();
      const record = state.reducer.bySession.get(sessionId);
      return record?.lifecycle === 'busy' || record?.lifecycle === 'retry';
    });

    React.useEffect(() => {
      if (!sessionId) {
        setIsStreaming(false);
        return;
      }
      const update = () => {
        const record = getPiSessionStore().getState().reducer.bySession.get(sessionId);
        setIsStreaming(record?.lifecycle === 'busy' || record?.lifecycle === 'retry');
      };
      update();
      const unsubscribe = getPiSessionStore().subscribe(update, `session:${sessionId}`);
      return unsubscribe;
    }, [sessionId]);

    const handleClick = React.useCallback(
      async (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        event.preventDefault();
        if (!sessionId || !messageId || busy || isStreaming) return;
        const entryId = messageId.includes(':') ? messageId.split(':')[0] ?? messageId : messageId;
        if (import.meta.env.DEV) {
          console.log('[fork] session', sessionId, 'messageId', messageId, 'entryId', entryId);
        }
        setBusy(true);
        try {
          await forkFromMessage(sessionId, entryId);
          toast.success('Forked — new session created from this message.');
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Failed to fork session';
          if (import.meta.env.DEV) console.error('[fork] failed', { sessionId, messageId, entryId, error });
          toast.error(msg);
        } finally {
          setBusy(false);
        }
      },
      [busy, forkFromMessage, isStreaming, messageId, sessionId],
    );

    const disabled = busy || isStreaming || !sessionId || !messageId;
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
