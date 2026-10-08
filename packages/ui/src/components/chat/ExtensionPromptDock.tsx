import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { getPiSessionStore } from '@/apps/pi-session-store';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import type { PiExtensionDialogPayload } from '@/lib/pi/protocol';
import { PiRequestError, piClient } from '@/lib/pi/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { stripAnsi } from '@/lib/pi/ansi';
import { AnsiText } from '@/components/chat/AnsiText';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { resolveSelectKeyAction } from './extensionPromptKeys';

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
  highlightedIndex: number;
  setHighlightedIndex: React.Dispatch<React.SetStateAction<number>>;
}

const SelectBody: React.FC<SelectBodyProps> = ({
  request,
  onRespond,
  messageId,
  highlightedIndex,
  setHighlightedIndex,
}) => {
  const options = request.options ?? [];

  return (
    <div>
      {request.message && (
        <p id={messageId} className="mb-2 text-sm text-muted-foreground"><AnsiText text={request.message} /></p>
      )}
      <div
        className="flex flex-col gap-1 max-h-60 overflow-y-auto"
        role="listbox"
        aria-label={stripAnsi(request.title)}
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
                'flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors outline-none',
                isHighlighted
                  ? 'bg-interactive-selection text-interactive-selection-foreground font-medium'
                  : 'text-foreground hover:bg-interactive-hover',
              )}
            >
              <span className="truncate"><AnsiText text={option} /></span>
              {quickKey !== undefined && (
                <span
                  className={cn(
                    'ml-2 shrink-0 font-mono text-xs opacity-70',
                    isHighlighted ? 'text-interactive-selection-foreground' : 'text-muted-foreground',
                  )}
                >
                  {quickKey}
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
  const { t } = useTranslation();
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
          {t('No (N)')}
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => onRespond({ confirmed: true })}
        >
          {t('Yes (Y)')}
        </Button>
      </div>
    </div>
  );
};

interface InputEditorBodyProps {
  request: PiExtensionDialogPayload;
  onRespond: (answer: DialogAnswer) => void;
  messageId: string;
}

const InputEditorBody: React.FC<InputEditorBodyProps> = ({ request, onRespond, messageId }) => {
  const { t } = useTranslation();
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
          aria-label={stripAnsi(request.title)}
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
          aria-label={stripAnsi(request.title)}
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
          {t('Cancel')}
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={submitValue}
          disabled={!isEditor && value.trim().length === 0}
        >
          {t('Submit')}
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
  const { t } = useTranslation();
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
            ? t('Fill in all required fields and enter valid numbers within the allowed range before submitting.')
            : invalidNumbers.length > 0
              ? t('Enter valid numbers within the allowed range before submitting.')
              : t('Fill in all required fields before submitting.')}
        </p>
      )}
      <div className="mt-2.5 flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onRespond({ cancelled: true })}
        >
          {t('Cancel')}
        </Button>
        <Button type="submit" variant="default" size="sm">
          {t('Submit')}
        </Button>
      </div>
    </form>
  );
};

export interface ExtensionPromptDockProps {
  sessionId?: string | null;
}

interface ExtensionPromptTarget {
  sessionId: string;
  request: PiExtensionDialogPayload;
  queueLength: number;
}

export const ExtensionPromptDock: React.FC<ExtensionPromptDockProps> = ({ sessionId }) => {
  const { t } = useTranslation();
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

  const [responding, setResponding] = React.useState(false);
  const [responseError, setResponseError] = React.useState(false);
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);
  const respondingRef = React.useRef(false);

  const dockRef = React.useRef<HTMLDivElement | null>(null);
  const messageId = React.useId();

  // Keyed on request identity, not the target object: a queue-length change
  // for the same request must not clear the in-flight guard or highlight.
  const targetKey = target ? `${target.sessionId}\u0000${target.request.requestId}` : null;
  React.useEffect(() => {
    respondingRef.current = false;
    setResponding(false);
    setResponseError(false);
    setHighlightedIndex(0);

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

    if (!target) return;

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

  if (!target) return null;

  return (
    <div className="chat-input-column mb-2">
      <div
        ref={dockRef}
        role="dialog"
        aria-label={stripAnsi(target.request.title)}
        aria-describedby={target.request.message ? messageId : undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="overflow-hidden rounded-xl border border-border/80 bg-card p-3 shadow-md transition-[opacity,transform] duration-150 outline-none"
      >
        {/* Header */}
        <div className="mb-2.5 flex items-center justify-between gap-2 border-b border-border/40 pb-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <Icon name="plug-2" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-xs font-semibold uppercase tracking-wider text-foreground">
              <AnsiText text={target.request.title} />
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {target.queueLength > 1 && (
              <span className="rounded-full bg-muted px-2 py-0.5 typography-micro font-medium text-muted-foreground">
                {t('1 of {{total}}', { total: target.queueLength })}
              </span>
            )}
            {remainingSeconds !== null && (
              <span
                className="font-mono text-xs tabular-nums text-muted-foreground"
                title={t('{{count}}s remaining', { count: remainingSeconds })}
              >
                {t('{{count}}s', { count: remainingSeconds })}
              </span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => submit({ cancelled: true })}
              className="h-6 px-1.5 typography-micro text-muted-foreground hover:text-foreground"
              aria-label={t('Dismiss extension dialog')}
            >
              {t('Dismiss (Esc)')}
            </Button>
          </div>
        </div>

        {/* Body */}
        <div
          className={responding ? 'pointer-events-none opacity-60' : undefined}
          aria-busy={responding || undefined}
        >
          {target.request.method === 'select' && (
            <SelectBody
              request={target.request}
              onRespond={submit}
              messageId={messageId}
              highlightedIndex={highlightedIndex}
              setHighlightedIndex={setHighlightedIndex}
            />
          )}
          {target.request.method === 'confirm' && (
            <ConfirmBody request={target.request} onRespond={submit} messageId={messageId} />
          )}
          {(target.request.method === 'input' || target.request.method === 'editor') && (
            <InputEditorBody request={target.request} onRespond={submit} messageId={messageId} />
          )}
          {target.request.method === 'form' && (
            <FormBody request={target.request} onRespond={submit} messageId={messageId} />
          )}
        </div>

        {responseError && (
          <p role="alert" className="mt-2 text-xs text-status-error">
            {t('Could not send the response. Check your connection and try again.')}
          </p>
        )}
      </div>
    </div>
  );
};
