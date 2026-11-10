import React from 'react';

import { getPiSessionStore } from '@/apps/pi-session-store';
import { toast } from '@/components/ui';
import { useSessionUIStore } from '@/sync/session-ui-store';

/** Whether Pi is answering in the session; history actions wait until it ends. */
const useSessionStreaming = (sessionId?: string | null): boolean => {
  const [isStreaming, setIsStreaming] = React.useState(() => {
    if (!sessionId) return false;
    const record = getPiSessionStore().getState().reducer.bySession.get(sessionId);
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
    return getPiSessionStore().subscribe(update, `session:${sessionId}`);
  }, [sessionId]);

  return isStreaming;
};

/** Strips a part suffix like "c865141a:text:1" so a part id resolves to its entry; Pi only knows entry ids. */
const toEntryId = (messageId: string) => (messageId.includes(':') ? messageId.split(':')[0] ?? messageId : messageId);

type MessageHistoryAction = {
  run: () => Promise<void>;
  busy: boolean;
  disabled: boolean;
};

/**
 * One of a message's history actions (revert the conversation to it, or fork a
 * new session from it), shared by its icon button and the phone's message menu.
 */
export const useMessageHistoryAction = (
  kind: 'revert' | 'fork',
  sessionId: string | null | undefined,
  messageId: string,
): MessageHistoryAction => {
  const revertToMessage = useSessionUIStore((s) => s.revertToMessage);
  const forkFromMessage = useSessionUIStore((s) => s.forkFromMessage);
  const isStreaming = useSessionStreaming(sessionId);
  const [busy, setBusy] = React.useState(false);

  const run = React.useCallback(async () => {
    if (!sessionId || !messageId || busy || isStreaming) return;
    const entryId = toEntryId(messageId);
    if (import.meta.env.DEV) {
      console.log(`[${kind}] session`, sessionId, 'messageId', messageId, 'entryId', entryId);
    }
    setBusy(true);
    try {
      if (kind === 'revert') {
        await revertToMessage(sessionId, entryId);
        toast.success('Reverted — conversation rewound. Files on disk were not changed.');
      } else {
        await forkFromMessage(sessionId, entryId);
        toast.success('Forked — new session created from this message.');
      }
    } catch (error) {
      const fallback = kind === 'revert' ? 'Failed to revert conversation' : 'Failed to fork session';
      // Surface the Pi code (e.g. INVALID_REQUEST) in dev so a 400 is actionable.
      if (import.meta.env.DEV) console.error(`[${kind}] failed`, { sessionId, messageId, entryId, error });
      toast.error(error instanceof Error ? error.message : fallback);
    } finally {
      setBusy(false);
    }
  }, [busy, forkFromMessage, isStreaming, kind, messageId, revertToMessage, sessionId]);

  return { run, busy, disabled: busy || isStreaming || !sessionId || !messageId };
};
