import React from 'react';
import { Button } from '@/components/ui/button';
import { sandboxReasonText } from '@/lib/pi/sandboxText';
import { usePiSessionSnapshot, usePiSessionStore } from '@/sync/pi-session-context';
import { useReloadWhenSandboxChanges } from '@/hooks/useReloadWhenSandboxChanges';

/**
 * Shown above the composer while a session's transcript was read from disk
 * because its project's sandbox cannot start (#242): the history is there,
 * but nothing can be sent until the sandbox works.
 */
export const SessionReadOnlyNote: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const store = usePiSessionStore();
  const readOnly = usePiSessionSnapshot(
    (state) => state.reducer.bySession.get(sessionId)?.readOnly,
    undefined,
    `session:${sessionId}`,
  );
  const [retrying, setRetrying] = React.useState(false);
  useReloadWhenSandboxChanges(sessionId, Boolean(readOnly));

  if (!readOnly) return null;

  const retry = async () => {
    setRetrying(true);
    try {
      await store.reloadSession(sessionId);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="chat-input-column">
      <div className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-border/40 bg-card px-3 py-2" role="status">
        <p className="min-w-0 typography-meta text-muted-foreground text-pretty">
          {`This session is read-only: its project is sandboxed and the sandbox cannot start. ${sandboxReasonText(readOnly.reason)}`}
        </p>
        <Button variant="outline" size="xs" className="shrink-0" disabled={retrying} onClick={() => { void retry(); }}>
          Try again
        </Button>
      </div>
    </div>
  );
};
