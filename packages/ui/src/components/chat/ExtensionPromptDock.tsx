import * as React from 'react';

import { getPiSessionStore } from '@/apps/pi-session-store';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { liveSessionRecordToUiSession, selectSessionsNeedingInput } from '@/sync/pi-session-catalog';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSessionDisplayTitle } from '@/lib/chat/sessionTitle';
import { SessionNeedsInputIndicator } from '@/components/session/sidebar/SessionNeedsInputIndicator';
import { formatNeedsInputLabel } from '@/components/session/sidebar/sessionAttention';
import type { PiExtensionDialogPayload, PiPendingInputSummary } from '@/lib/pi/protocol';
import { PiRequestError, piClient } from '@/lib/pi/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { stripAnsi } from '@/lib/pi/ansi';
import { AnsiText } from '@/components/chat/AnsiText';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Radio } from '@/components/ui/radio';
import { Kbd } from '@/components/ui/KeyHints';
import { cn } from '@/lib/utils';
import { resolveSelectKeyAction } from './extensionPromptKeys';
import { firstPlainLine, splitDialogTitle } from './extensionDialogTitle';

/**
 * Blocking pi extension dialogs (ctx.ui.select / confirm / input / editor / form).
 * Rendered as an inline docked prompt card above the composer in the chat column.
 */

type DialogAnswer = {
  cancelled?: boolean;
  confirmed?: boolean;
  value?: string;
  values?: Record<string, string>;
};

const respond = async (
  sessionId: string,
  request: PiExtensionDialogPayload,
  answer: DialogAnswer,
): Promise<void> => {
  try {
    await piClient.respondToExtensionDialog(
      { requestId: request.requestId, ...answer },
      { runtimeKey: getRuntimeKey() },
    );
    getPiSessionStore().dismissExtensionDialog(sessionId, request.requestId);
  } catch (error) {
    if (error instanceof PiRequestError && error.code === 'EXTENSION_DIALOG_NOT_PENDING') {
      getPiSessionStore().dismissExtensionDialog(sessionId, request.requestId);
      return;
    }
    throw error;
  }
};

const returnFocusToComposer = (): void => {
  requestAnimationFrame(() => {
    const composer = document.querySelector<HTMLElement>(
      '[data-slot="composer-editor"], .chat-input-column textarea, textarea',
    );
    composer?.focus();
  });
};

const useCountdown = (timeoutMs?: number, requestId?: string): number | null => {
  const [remainingSeconds, setRemainingSeconds] = React.useState<number | null>(() => {
    if (typeof timeoutMs !== 'number' || timeoutMs <= 0) return null;
    return Math.max(0, Math.ceil(timeoutMs / 1000));
  });

  React.useEffect(() => {
    if (typeof timeoutMs !== 'number' || timeoutMs <= 0) {
      setRemainingSeconds(null);
      return;
    }
    const startedAt = Date.now();
    let interval: ReturnType<typeof setInterval> | null = null;
    const update = () => {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, Math.ceil((timeoutMs - elapsed) / 1000));
      setRemainingSeconds(remaining);
      if (remaining <= 0 && interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };
    update();
    interval = setInterval(update, 1000);
    return () => {
      if (interval !== null) clearInterval(interval);
    };
  }, [timeoutMs, requestId]);

  return remainingSeconds;
};

const isNonEmptyEditableElement = (el: Element | null): boolean => {
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.value.trim().length > 0;
  }
  if ((el as HTMLElement).isContentEditable) {
    return (el.textContent ?? '').trim().length > 0;
  }
  return false;
};

interface SelectBodyProps {
  request: PiExtensionDialogPayload;
  onRespond: (answer: DialogAnswer) => void;
  messageId: string;
  name: string;
  highlightedIndex: number;
  setHighlightedIndex: React.Dispatch<React.SetStateAction<number>>;
}

const ignoreRadioChange = (): void => {};

const SelectBody: React.FC<SelectBodyProps> = ({
  request,
  onRespond,
  messageId,
  name,
  highlightedIndex,
  setHighlightedIndex,
}) => {
  const options = request.options ?? [];

  return (
    <div>
      {request.message && (
        <p id={messageId} className="mb-2 text-sm text-muted-foreground"><AnsiText text={request.message} /></p>
      )}
      {/* Rows bleed into the card padding so the radios line up with the text above. */}
      <div
        className="-mx-2 flex max-h-60 flex-col overflow-y-auto"
        role="listbox"
        aria-label={name}
      >
        {options.map((option, index) => {
          const isHighlighted = index === highlightedIndex;
          const quickKey = index < 9 ? index + 1 : undefined;

          return (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={isHighlighted}
              tabIndex={isHighlighted ? 0 : -1}
              onMouseEnter={() => setHighlightedIndex(index)}
              onFocus={() => setHighlightedIndex(index)}
              onClick={() => onRespond({ value: option })}
              className={cn(
                'flex w-full items-start gap-2.5 rounded-xl px-2 py-1.5 text-left outline-none',
                'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-interactive-focusRing',
                isHighlighted && 'bg-interactive-hover',
              )}
            >
              {/* h-5 matches the label's first line box, so the radio and key stay on it when the label wraps. */}
              <span className="flex h-5 shrink-0 items-center">
                <Radio checked={isHighlighted} onChange={ignoreRadioChange} decorative />
              </span>
              <span
                className={cn(
                  'min-w-0 flex-1 break-words typography-ui-label',
                  isHighlighted ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                <AnsiText text={option} />
              </span>
              {quickKey !== undefined && (
                <span className="flex h-5 shrink-0 items-center">
                  <Kbd>{quickKey}</Kbd>
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

interface ConfirmBodyProps {
  request: PiExtensionDialogPayload;
  onRespond: (answer: DialogAnswer) => void;
  messageId: string;
}

const ConfirmBody: React.FC<ConfirmBodyProps> = ({ request, onRespond, messageId }) => {
  return (
    <div>
      {request.message && (
        <p id={messageId} className="mb-3 text-sm text-muted-foreground"><AnsiText text={request.message} /></p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onRespond({ confirmed: false, cancelled: true })}
        >
          No (N)
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => onRespond({ confirmed: true })}
        >
          Yes (Y)
        </Button>
      </div>
    </div>
  );
};

interface InputEditorBodyProps {
  request: PiExtensionDialogPayload;
  onRespond: (answer: DialogAnswer) => void;
  messageId: string;
  name: string;
}

const InputEditorBody: React.FC<InputEditorBodyProps> = ({ request, onRespond, messageId, name }) => {
  const isEditor = request.method === 'editor';
  const [value, setValue] = React.useState(isEditor ? (request.prefill ?? '') : '');

  const submitValue = () => {
    onRespond({ value });
  };

  return (
    <div>
      {request.message && (
        <p id={messageId} className="mb-2 text-sm text-muted-foreground"><AnsiText text={request.message} /></p>
      )}
      {isEditor ? (
        <textarea
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={request.placeholder ? stripAnsi(request.placeholder) : ''}
          aria-label={name}
          rows={4}
          className="w-full resize-y rounded-md border bg-transparent p-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-focusRing"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submitValue();
            }
          }}
        />
      ) : (
        <input
          autoFocus
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={request.placeholder ? stripAnsi(request.placeholder) : ''}
          aria-label={name}
          className="w-full rounded-md border bg-transparent px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-focusRing"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submitValue();
            }
          }}
        />
      )}
      <div className="mt-2.5 flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onRespond({ cancelled: true })}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={submitValue}
          disabled={!isEditor && value.trim().length === 0}
        >
          Submit
        </Button>
      </div>
    </div>
  );
};

interface FormBodyProps {
  request: PiExtensionDialogPayload;
  onRespond: (answer: DialogAnswer) => void;
  messageId: string;
}

const FormBody: React.FC<FormBodyProps> = ({ request, onRespond, messageId }) => {
  const initial: Record<string, string> = {};
  for (const field of request.fields ?? []) {
    if (field.type === 'checkbox') initial[field.id] = field.initial === 'true' ? 'true' : 'false';
    else if (field.initial !== undefined) initial[field.id] = field.initial;
    else if (field.type === 'select' && field.options?.[0] !== undefined) initial[field.id] = field.options[0];
    else initial[field.id] = '';
  }

  const [values, setValues] = React.useState(initial);
  const [touchedSubmit, setTouchedSubmit] = React.useState(false);

  const missingRequired = (request.fields ?? []).filter(
    (field) => field.required && (values[field.id] ?? '').length === 0,
  );
  const invalidNumbers = (request.fields ?? []).filter((field) => {
    if (field.type !== 'number') return false;
    const val = values[field.id] ?? '';
    if (val.length === 0) return false;
    const num = Number(val);
    if (!Number.isFinite(num)) return true;
    if ('min' in field && typeof field.min === 'number' && num < field.min) return true;
    if ('max' in field && typeof field.max === 'number' && num > field.max) return true;
    return false;
  });

  const blocked = touchedSubmit && (missingRequired.length > 0 || invalidNumbers.length > 0);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setTouchedSubmit(true);
        if (missingRequired.length > 0 || invalidNumbers.length > 0) return;
        onRespond({ values: { ...values } });
      }}
    >
      {request.message && (
        <p id={messageId} className="mb-2 text-sm text-muted-foreground"><AnsiText text={request.message} /></p>
      )}
      <div className="flex max-h-60 flex-col gap-2.5 overflow-y-auto">
        {(request.fields ?? []).map((field) => {
          const isMissing = blocked && field.required && (values[field.id] ?? '').length === 0;
          const isInvalidNumber = blocked && invalidNumbers.some((f) => f.id === field.id);
          const invalid = isMissing || isInvalidNumber;
          const value = values[field.id] ?? '';
          const setValue = (next: string) =>
            setValues((previous) => ({ ...previous, [field.id]: next }));
          const inputClass =
            'w-full rounded-md border bg-transparent p-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-focusRing';

          if (field.type === 'checkbox') {
            return (
              <label key={field.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={value === 'true'}
                  onChange={(event) => setValue(event.target.checked ? 'true' : 'false')}
                  className="size-4"
                />
                <span><AnsiText text={field.label} /></span>
              </label>
            );
          }

          return (
            <label key={field.id} className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-foreground">
                <AnsiText text={field.label} />
                {field.required && <span aria-hidden="true" className="text-status-error"> *</span>}
              </span>
              {field.type === 'textarea' ? (
                <textarea
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={field.placeholder ? stripAnsi(field.placeholder) : ''}
                  rows={2}
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
                    <option key={option} value={option}>
                      {option}
                    </option>
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
          {missingRequired.length > 0 && invalidNumbers.length > 0
            ? 'Fill in all required fields and enter valid numbers within the allowed range before submitting.'
            : invalidNumbers.length > 0
              ? 'Enter valid numbers within the allowed range before submitting.'
              : 'Fill in all required fields before submitting.'}
        </p>
      )}
      <div className="mt-2.5 flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onRespond({ cancelled: true })}
        >
          Cancel
        </Button>
        <Button type="submit" variant="default" size="sm">
          Submit
        </Button>
      </div>
    </form>
  );
};

export interface ExtensionPromptDockProps {
  sessionId?: string | null;
}

/** Another session waiting on the user, for the dock overflow strip. */
interface OtherNeedingSession {
  sessionId: string;
  directory: string;
  pending: PiPendingInputSummary;
  title: string;
}

const MAX_OTHER_NEEDING_INPUT_SHOWN = 3;

const otherNeedingInputEqual = (
  left: ReadonlyArray<OtherNeedingSession>,
  right: ReadonlyArray<OtherNeedingSession>,
): boolean => {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!a || !b) return false;
    if (a.sessionId !== b.sessionId || a.directory !== b.directory || a.title !== b.title) return false;
    if (a.pending.count !== b.pending.count || a.pending.kind !== b.pending.kind || a.pending.since !== b.pending.since) {
      return false;
    }
  }
  return true;
};

/** Sessions needing input other than the visible one, oldest waiter first.
 *  Titles resolve from catalog rows through the shared display-title helper
 *  (`Untitled session` fallback); unknown titles never infer emptiness. */
const useOtherSessionsNeedingInput = (currentSessionId: string | null): OtherNeedingSession[] =>
  usePiSessionSnapshot(
    (state) => {
      const others: OtherNeedingSession[] = [];
      for (const entry of selectSessionsNeedingInput(state.catalog)) {
        if (currentSessionId && entry.sessionId === currentSessionId) continue;
        const record = state.catalog.byId.get(entry.sessionId);
        const title = record
          ? getSessionDisplayTitle(liveSessionRecordToUiSession(record), 'Untitled session')
          : 'Untitled session';
        others.push({
          sessionId: entry.sessionId,
          directory: entry.directory,
          pending: entry.pending,
          title,
        });
      }
      return others;
    },
    otherNeedingInputEqual,
    'catalog',
    currentSessionId ?? '',
  );

/** Compact strip above the dock listing other sessions waiting on the user.
 *  Visible even when the current session has no dialog, so the pending state
 *  surfaces on app open/resume. Shared `Button` keeps touch targets at the
 *  mobile floor; rows carry `min-h-[44px]` for comfortable tapping. */
const OtherSessionsNeedInputStrip: React.FC<{ sessions: ReadonlyArray<OtherNeedingSession> }> = ({
  sessions,
}) => {
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const visible = sessions.slice(0, MAX_OTHER_NEEDING_INPUT_SHOWN);
  const remaining = sessions.length - visible.length;
  return (
    <div
      role="region"
      aria-label="Other sessions need input"
      className="overflow-hidden rounded-xl border border-border/80 bg-card p-1.5 shadow-md"
    >
      <ul className="flex flex-col">
        {visible.map((item) => {
          const label = formatNeedsInputLabel(item.pending.kind, item.pending.count);
          return (
            <li key={item.sessionId} className="flex min-h-[44px] items-center gap-2 px-2 py-1">
              <SessionNeedsInputIndicator label={label} />
              <span
                className="min-w-0 flex-1 truncate text-sm text-foreground"
                title={`${item.title} \u2014 ${label}`}
              >
                {item.title}
              </span>
              {item.pending.count > 1 ? (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {`${item.pending.count} requests`}
                </span>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  void setCurrentSession(item.sessionId, item.directory);
                }}
                aria-label={`Open ${item.title}`}
              >
                Open
              </Button>
            </li>
          );
        })}
      </ul>
      {remaining > 0 ? (
        <p className="px-2 pb-1 text-xs text-muted-foreground">{`+${remaining} more`}</p>
      ) : null}
    </div>
  );
};

interface ExtensionPromptTarget {
  sessionId: string;
  request: PiExtensionDialogPayload;
  queueLength: number;
}

export const ExtensionPromptDock: React.FC<ExtensionPromptDockProps> = ({ sessionId }) => {
  const target = usePiSessionSnapshot<ExtensionPromptTarget | null>(
    (state) => {
      const preferredSessionId = sessionId ?? state.selectedSessionId;
      const session = preferredSessionId
        ? state.reducer.bySession.get(preferredSessionId)
        : undefined;
      const dialogs = session?.extensionDialogs ?? [];
      const preferred = dialogs[0];
      if (preferred && preferredSessionId) {
        return {
          sessionId: preferredSessionId,
          request: preferred,
          queueLength: dialogs.length,
        };
      }
      if (sessionId !== undefined) return null;
      for (const [candidateSessionId, candidate] of state.reducer.bySession) {
        const candidateDialogs = candidate.extensionDialogs;
        const request = candidateDialogs[0];
        if (request) {
          return {
            sessionId: candidateSessionId,
            request,
            queueLength: candidateDialogs.length,
          };
        }
      }
      return null;
    },
    (a, b) =>
      a?.sessionId === b?.sessionId &&
      a?.request.requestId === b?.request.requestId &&
      a?.queueLength === b?.queueLength,
    'dialogs',
    sessionId ?? '',
  );

  const storeCurrentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentId = sessionId ?? storeCurrentSessionId ?? null;
  const othersNeedingInput = useOtherSessionsNeedingInput(currentId);

  const [responding, setResponding] = React.useState(false);
  const [responseError, setResponseError] = React.useState(false);
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);
  const [collapsed, setCollapsed] = React.useState(false);
  const respondingRef = React.useRef(false);

  const dockRef = React.useRef<HTMLDivElement | null>(null);
  const messageId = React.useId();
  const questionId = React.useId();
  const bodyId = React.useId();
  const requestTitle = target?.request.title ?? '';
  const titleParts = React.useMemo(() => splitDialogTitle(requestTitle), [requestTitle]);

  // Keyed on request identity, not the target object: a queue-length change
  // for the same request must not clear the in-flight guard or highlight.
  const targetKey = target ? `${target.sessionId}\u0000${target.request.requestId}` : null;
  React.useEffect(() => {
    respondingRef.current = false;
    setResponding(false);
    setResponseError(false);
    setHighlightedIndex(0);
    setCollapsed(false);

    // Autofocus dock on appearance if not already focused inside and not typing in an editable element
    if (
      targetKey !== null &&
      dockRef.current &&
      !dockRef.current.contains(document.activeElement) &&
      !isNonEmptyEditableElement(document.activeElement)
    ) {
      dockRef.current.focus();
    }
  }, [targetKey]);

  const remainingSeconds = useCountdown(target?.request.timeoutMs, target?.request.requestId);

  const submit = React.useCallback(
    (answer: DialogAnswer) => {
      if (!target || responding || respondingRef.current) return;
      respondingRef.current = true;
      setResponding(true);
      setResponseError(false);
      void respond(target.sessionId, target.request, answer)
        .then(() => {
          returnFocusToComposer();
        })
        .catch(() => {
          setResponseError(true);
        })
        .finally(() => {
          respondingRef.current = false;
          setResponding(false);
        });
    },
    [responding, target],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      submit({ cancelled: true });
      return;
    }

    // A collapsed dialog hides its question, so only Escape answers it.
    if (!target || collapsed) return;

    if (target.request.method === 'confirm') {
      if (event.key === 'y' || event.key === 'Y') {
        event.preventDefault();
        submit({ confirmed: true });
        return;
      }
      if (event.key === 'n' || event.key === 'N') {
        event.preventDefault();
        submit({ confirmed: false, cancelled: true });
        return;
      }
    }

    if (target.request.method === 'select') {
      const options = target.request.options ?? [];
      const action = resolveSelectKeyAction(event.key, highlightedIndex, options.length);
      if (!action) return;

      const eventTarget = event.target instanceof HTMLElement ? event.target : null;
      const isOptionTarget = eventTarget?.getAttribute('role') === 'option';

      if (action.kind === 'highlight') {
        event.preventDefault();
        setHighlightedIndex(action.index);
        // Once focus is on an option, it follows the highlight so native
        // activation can never hit a different option than the one shown.
        if (isOptionTarget) {
          dockRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[action.index]?.focus();
        }
        return;
      }

      // Enter/Space on another control (e.g. Dismiss) keep their native action.
      const isActivationKey = event.key === 'Enter' || event.key === ' ';
      if (isActivationKey && !isOptionTarget && event.target !== event.currentTarget) return;

      const selected = options[action.index];
      if (selected === undefined) return;
      event.preventDefault();
      submit({ value: selected });
    }
  };

  const { label, text } = titleParts;
  const name = stripAnsi(label ?? text) || 'Extension';
  const describedBy = [
    text && label ? questionId : null,
    target?.request.message ? messageId : null,
  ].filter(Boolean).join(' ');

  // The strip keeps the dock mounted while other sessions wait, even when
  // the current session has no dialog.
  if (!target && othersNeedingInput.length === 0) return null;

  return (
    <div data-extension-prompt-dock className="chat-input-column relative mb-2 flex flex-col gap-2">
      {othersNeedingInput.length > 0 ? (
        <OtherSessionsNeedInputStrip sessions={othersNeedingInput} />
      ) : null}
      {target ? (
      // Above the custom() overlay layer (z-30), which dims the rest of the
      // pane: an overlay's own code can be waiting on this dialog. Only the
      // dialog rises; the strip stays under the dim with the composer.
      <div
        ref={dockRef}
        role="dialog"
        aria-label={name}
        aria-describedby={describedBy || undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        // Same surface as the composer card below it (ChatInput's
        // data-composer-card): radius, fill, border and shadow.
        className="relative z-40 overflow-hidden rounded-[1.5rem] border border-border/80 bg-[var(--surface-subtle)] shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)] outline-none"
      >
        <div className="flex items-center gap-2 py-2.5 pl-4 pr-2.5">
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            title={collapsed ? 'Show the request' : 'Hide the request'}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left outline-none focus-visible:ring-1 focus-visible:ring-interactive-focusRing"
          >
            <span
              className={cn(
                'min-w-0 truncate typography-meta text-muted-foreground',
                collapsed && text && label ? 'max-w-[50%] shrink-0' : 'flex-1',
              )}
            >
              <AnsiText text={label ?? 'Extension'} />
            </span>
            {collapsed && text ? (
              <>
                <span aria-hidden="true" className="typography-meta text-subtle-foreground">
                  ·
                </span>
                <span className="min-w-0 flex-1 truncate typography-meta text-foreground">
                  {firstPlainLine(text)}
                </span>
              </>
            ) : null}
            <Icon
              name={collapsed ? 'arrow-down-s' : 'arrow-up-s'}
              className="size-4 shrink-0 text-subtle-foreground"
            />
          </button>
          <div className="flex shrink-0 items-center gap-2">
            {target.queueLength > 1 && (
              <span className="rounded-full bg-muted px-2 py-0.5 typography-micro font-medium text-muted-foreground">
                1 of {target.queueLength}
              </span>
            )}
            {remainingSeconds !== null && (
              <span
                className="font-mono typography-micro tabular-nums text-muted-foreground"
                title={`${remainingSeconds}s remaining`}
              >
                {remainingSeconds}s
              </span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => submit({ cancelled: true })}
              className="shrink-0 px-1.5 font-sans text-muted-foreground hover:text-foreground"
              aria-label="Dismiss extension dialog"
              title="Dismiss (Esc)"
            >
              Esc
            </Button>
          </div>
        </div>

        {/* Hidden, not unmounted: an input, editor or form keeps what was
            typed while collapsed, and `hidden` takes its controls out of the
            tab order. */}
        <div id={bodyId} hidden={collapsed} className="px-4 pb-3">
          {text && (
            // Extension text is terminal text: keep its line breaks and
            // spacing, and scroll a long request instead of growing the dock.
            <div
              id={questionId}
              className="mb-2.5 max-h-60 overflow-y-auto whitespace-pre-wrap break-words typography-ui-label text-foreground"
            >
              <AnsiText text={text} links />
            </div>
          )}
          <div
            className={responding ? 'pointer-events-none opacity-60' : undefined}
            aria-busy={responding || undefined}
          >
            {target.request.method === 'select' && (
              <SelectBody
                request={target.request}
                onRespond={submit}
                messageId={messageId}
                name={name}
                highlightedIndex={highlightedIndex}
                setHighlightedIndex={setHighlightedIndex}
              />
            )}
            {target.request.method === 'confirm' && (
              <ConfirmBody request={target.request} onRespond={submit} messageId={messageId} />
            )}
            {(target.request.method === 'input' || target.request.method === 'editor') && (
              <InputEditorBody request={target.request} onRespond={submit} messageId={messageId} name={name} />
            )}
            {target.request.method === 'form' && (
              <FormBody request={target.request} onRespond={submit} messageId={messageId} />
            )}
          </div>
        </div>

        {responseError && (
          <p role="alert" className="px-4 pb-3 text-xs text-status-error">
            Could not send the response. Check your connection and try again.
          </p>
        )}
      </div>
      ) : null}
    </div>
  );
};
