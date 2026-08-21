import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { toast } from '@/components/ui';

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
};

/**
 * Per-message revert control — renders under each user *and* assistant
 * message (research: `navigateTree` moves to parent for user, to self for
 * other entries). Disabled while the session is streaming (Pi rejects it
 * anyway). On success the daemon returns `editorText` which the
 * `revertToMessage` action puts in the composer when empty; we surface a
 * toast that files on disk were not changed.
 */
export const MessageRevertAction: React.FC<MessageRevertActionProps> = React.memo(
  ({ sessionId, messageId, size = 'user' }) => {
    const revertToMessage = useSessionUIStore((s) => s.revertToMessage);
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
        // Strip part suffix like "c865141a:text:1" → "c865141a" so a part-level
        // id (e.g. from a tool or thinking block) still resolves to its parent
        // entry. Pi's `getEntry` only knows entry ids.
        const entryId = messageId.includes(':') ? messageId.split(':')[0] ?? messageId : messageId;
        if (import.meta.env.DEV) {
          console.log('[revert] session', sessionId, 'messageId', messageId, 'entryId', entryId);
        }
        setBusy(true);
        try {
          await revertToMessage(sessionId, entryId);
          toast.success('Reverted — conversation rewound. Files on disk were not changed.');
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to revert conversation';
          // Surface the Pi code (e.g. INVALID_REQUEST) in dev so the 400 is actionable.
          if (import.meta.env.DEV) console.error('[revert] failed', { sessionId, messageId, entryId, error });
          toast.error(message);
        } finally {
          setBusy(false);
        }
      },
      [busy, isStreaming, messageId, revertToMessage, sessionId],
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
