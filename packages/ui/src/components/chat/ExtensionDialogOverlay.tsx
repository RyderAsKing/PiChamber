import * as React from 'react';

import { getPiSessionStore } from '@/apps/pi-session-store';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import type { PiExtensionDialogPayload } from '@/lib/pi/protocol';
import { piClient } from '@/lib/pi/client';
import { Button } from '@/components/ui/button';

/**
 * Blocking pi extension dialogs (ctx.ui.select / confirm / input / editor).
 * The extension runtime stays suspended until the user answers, so pending
 * dialogs render as a modal overlay for the selected session.
 */

const respond = async (
  sessionId: string,
  request: PiExtensionDialogPayload,
  answer: { cancelled?: boolean; confirmed?: boolean; value?: string },
): Promise<void> => {
  try {
    await piClient.respondToExtensionDialog({ requestId: request.requestId, ...answer });
  } catch {
    // A stale or already-settled response (404) means the dialog resolved
    // elsewhere, e.g. daemon idle disposal; nothing to surface.
  } finally {
    getPiSessionStore().dismissExtensionDialog(sessionId, request.requestId);
  }
};

const DialogFrame: React.FC<{
  title: string;
  children: React.ReactNode;
  onRequestCancel: () => void;
}> = ({ title, children, onRequestCancel }) => (
  <div className="pointer-events-auto fixed inset-0 z-50 flex items-end justify-center bg-black/40 px-4 pb-4 sm:items-center sm:pb-0">
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="w-full max-w-md rounded-xl border bg-card p-4 text-card-foreground shadow-lg"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onRequestCancel();
        }
      }}
      tabIndex={-1}
      ref={(node) => node?.focus()}
    >
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {children}
    </div>
  </div>
);

const CancelButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <Button variant="ghost" size="sm" onClick={onClick}>Cancel</Button>
);

const ExtensionDialogBody: React.FC<{
  sessionId: string;
  request: PiExtensionDialogPayload;
}> = ({ sessionId, request }) => {
  const cancel = React.useCallback(() => {
    void respond(sessionId, request, { cancelled: true });
  }, [sessionId, request]);

  const [value, setValue] = React.useState(request.method === 'editor' ? (request.prefill ?? '') : '');

  const submitValue = () => {
    void respond(sessionId, request, { value });
  };

  switch (request.method) {
    case 'select':
      return (
        <>
          {request.message && <p className="mb-2 text-sm text-muted-foreground">{request.message}</p>}
          <div className="flex flex-col gap-1.5">
            {(request.options ?? []).map((option) => (
              <Button
                key={option}
                variant="outline"
                size="sm"
                className="justify-start"
                onClick={() => void respond(sessionId, request, { value: option })}
              >
                {option}
              </Button>
            ))}
          </div>
          <div className="mt-3 flex justify-end">
            <CancelButton onClick={cancel} />
          </div>
        </>
      );
    case 'confirm':
      return (
        <>
          {request.message && <p className="text-sm text-muted-foreground">{request.message}</p>}
          <div className="mt-3 flex justify-end gap-2">
            <CancelButton onClick={cancel} />
            <Button
              variant="default"
              size="sm"
              onClick={() => void respond(sessionId, request, { confirmed: true })}
            >
              Confirm
            </Button>
          </div>
        </>
      );
    case 'input':
    case 'editor':
      return (
        <>
          {request.message && <p className="mb-2 text-sm text-muted-foreground">{request.message}</p>}
          <textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={request.placeholder ?? ''}
            aria-label={request.title}
            rows={request.method === 'editor' ? 6 : 2}
            className="w-full resize-y rounded-md border bg-transparent p-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-focus"
            onKeyDown={(event) => {
              // Enter submits single-line inputs; editors keep newlines and
              // submit through the button or Cmd/Ctrl+Enter.
              if (event.key === 'Enter' && !event.shiftKey && request.method === 'input') {
                event.preventDefault();
                submitValue();
              }
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && request.method === 'editor') {
                event.preventDefault();
                submitValue();
              }
            }}
            autoFocus
          />
          <div className="mt-3 flex justify-end gap-2">
            <CancelButton onClick={cancel} />
            <Button variant="default" size="sm" onClick={submitValue} disabled={value.length === 0}>
              Submit
            </Button>
          </div>
        </>
      );
    default:
      return null;
  }
};

interface ExtensionDialogOverlayProps {
  /** Defaults to the store's selected session when omitted. */
  sessionId?: string | null;
}

export const ExtensionDialogOverlay: React.FC<ExtensionDialogOverlayProps> = ({ sessionId }) => {
  const selectedSessionId = usePiSessionSnapshot((state) => state.selectedSessionId);
  const activeSessionId = sessionId ?? selectedSessionId;

  const dialogs = usePiSessionSnapshot(
    (state) => (activeSessionId ? state.reducer.bySession.get(activeSessionId)?.extensionDialogs ?? [] : []),
    (a, b) => a.length === b.length && a.every((dialog, index) => dialog.requestId === b[index]?.requestId),
    `session:${activeSessionId ?? ''}`,
  );

  // Only the oldest dialog renders at a time; answering it reveals the next.
  const current = dialogs[0];

  if (!activeSessionId || !current) return null;

  return (
    <DialogFrame
      title={current.title}
      onRequestCancel={() => void respond(activeSessionId, current, { cancelled: true })}
    >
      <ExtensionDialogBody key={current.requestId} sessionId={activeSessionId} request={current} />
    </DialogFrame>
  );
};

export default ExtensionDialogOverlay;
