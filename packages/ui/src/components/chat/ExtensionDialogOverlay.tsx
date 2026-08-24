import * as React from 'react';

import { getPiSessionStore } from '@/apps/pi-session-store';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import type { PiExtensionDialogPayload } from '@/lib/pi/protocol';
import { piClient } from '@/lib/pi/client';
import { stripAnsi } from '@/lib/pi/ansi';
import { Button } from '@/components/ui/button';

/**
 * Blocking pi extension dialogs (ctx.ui.select / confirm / input / editor).
 * The extension runtime stays suspended until the user answers, so pending
 * dialogs render as a modal overlay for the selected session.
 */

const respond = async (
  sessionId: string,
  request: PiExtensionDialogPayload,
  answer: { cancelled?: boolean; confirmed?: boolean; value?: string; values?: Record<string, string> },
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
      aria-label={stripAnsi(title)}
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
      <h2 className="mb-2 text-sm font-semibold">{stripAnsi(title)}</h2>
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
          {request.message && <p className="mb-2 text-sm text-muted-foreground">{stripAnsi(request.message)}</p>}
          <div className="flex flex-col gap-1.5">
            {(request.options ?? []).map((option) => (
              <Button
                key={option}
                variant="outline"
                size="sm"
                className="justify-start"
                onClick={() => void respond(sessionId, request, { value: option })}
              >
                {/* Display-only strip: the daemon still receives the original option value. */}
                {stripAnsi(option)}
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
          {request.message && <p className="text-sm text-muted-foreground">{stripAnsi(request.message)}</p>}
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
          {request.message && <p className="mb-2 text-sm text-muted-foreground">{stripAnsi(request.message)}</p>}
          <textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={request.placeholder ? stripAnsi(request.placeholder) : ''}
            aria-label={stripAnsi(request.title)}
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
    case 'form': {
      const initial: Record<string, string> = {};
      for (const field of request.fields ?? []) {
        if (field.type === 'checkbox') initial[field.id] = field.initial === 'true' ? 'true' : 'false';
        else if (field.initial !== undefined) initial[field.id] = field.initial;
        else if (field.type === 'select' && field.options?.[0] !== undefined) initial[field.id] = field.options[0];
        else initial[field.id] = '';
      }
      return (
        <ExtensionFormBody
          request={request}
          initialValues={initial}
          onCancel={cancel}
          onSubmit={(values) => void respond(sessionId, request, { values })}
        />
      );
    }
    default:
      return null;
  }
};

const ExtensionFormBody: React.FC<{
  request: PiExtensionDialogPayload;
  initialValues: Record<string, string>;
  onCancel: () => void;
  onSubmit: (values: Record<string, string>) => void;
}> = ({ request, initialValues, onCancel, onSubmit }) => {
  const [values, setValues] = React.useState(initialValues);
  const [touchedSubmit, setTouchedSubmit] = React.useState(false);

  const missingRequired = (request.fields ?? [])
    .filter((field) => field.required && (values[field.id] ?? '').length === 0);
  const blocked = touchedSubmit && missingRequired.length > 0;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setTouchedSubmit(true);
        if (missingRequired.length > 0) return;
        onSubmit({ ...values });
      }}
    >
      {request.message && <p className="mb-2 text-sm text-muted-foreground">{stripAnsi(request.message)}</p>}
      <div className="flex max-h-72 flex-col gap-3 overflow-y-auto">
        {(request.fields ?? []).map((field) => {
          const invalid = blocked && field.required && (values[field.id] ?? '').length === 0;
          const value = values[field.id] ?? '';
          const setValue = (next: string) => setValues((previous) => ({ ...previous, [field.id]: next }));
          const inputClass = 'w-full rounded-md border bg-transparent p-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-focus';
          if (field.type === 'checkbox') {
            return (
              <label key={field.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={value === 'true'}
                  onChange={(event) => setValue(event.target.checked ? 'true' : 'false')}
                  className="size-4"
                />
                {/* Display-only strip: the daemon still receives the original value. */}
                {stripAnsi(field.label)}
              </label>
            );
          }
          return (
            <label key={field.id} className="flex flex-col gap-1 text-sm">
              <span>
                {stripAnsi(field.label)}
                {field.required && <span aria-hidden="true" className="text-status-error"> *</span>}
              </span>
              {field.type === 'textarea' ? (
                <textarea
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={field.placeholder ? stripAnsi(field.placeholder) : ''}
                  rows={3}
                  aria-invalid={invalid || undefined}
                  className={inputClass}
                />
              ) : field.type === 'number' ? (
                <input
                  type="number"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={field.placeholder ? stripAnsi(field.placeholder) : ''}
                  min={'min' in field && typeof field.min === 'number' ? field.min : undefined}
                  max={'max' in field && typeof field.max === 'number' ? field.max : undefined}
                  aria-invalid={invalid || undefined}
                  className={inputClass}
                />
              ) : field.type === 'select' ? (
                <select
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  aria-invalid={invalid || undefined}
                  className={inputClass}
                >
                  {(field.options ?? []).map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={field.placeholder ? stripAnsi(field.placeholder) : ''}
                  aria-invalid={invalid || undefined}
                  className={inputClass}
                />
              )}
            </label>
          );
        })}
      </div>
      {blocked && (
        <p role="alert" className="mt-2 text-xs text-status-error">
          Fill in all required fields before submitting.
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="default" size="sm">Submit</Button>
      </div>
    </form>
  );
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
