import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

const COMMENT_FIELD_MAX_HEIGHT = 240;

export type GitHubCommentFormFollowUp = {
  /** Busy key while this follow-up runs (e.g. `'close'` / `'reopen'`). */
  id: string;
  label: string;
  busyLabel: string;
  onRun: () => void;
  allowed: boolean;
  reason?: string | null;
};

/**
 * Shared presentational inline comment form: auto-growing draft,
 * Comment button + optional ghost close/reopen-with-comment,
 * Ctrl/⌘+Enter. Draft/busy/error state stays with the caller.
 */
export const GitHubCommentForm: React.FC<{
  draft: string;
  onDraftChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  /**
   * Busy key: `null` when idle, `'comment'` while posting, or the
   * follow-up `id` while the follow-up action runs. Everything locks while
   * non-null.
   */
  busy: string | null;
  error?: string | null;
  /** Disabled reason for the Comment button's `title`. */
  disabledReason?: string | null;
  followUp?: GitHubCommentFormFollowUp | null;
  onSubmitComment: () => void;
  /** Flush hook for debounced drafts (persist on blur). */
  onDraftBlur?: () => void;
}> = ({
  draft,
  onDraftChange,
  placeholder,
  ariaLabel,
  busy,
  error,
  disabledReason,
  followUp,
  onSubmitComment,
  onDraftBlur,
}) => {
  const { t } = useTranslation();
  const fieldRef = React.useRef<HTMLTextAreaElement>(null);
  const [multiline, setMultiline] = React.useState(false);
  // Line height + vertical padding are read once: per-keystroke
  // `getComputedStyle` forces layout on every keystroke otherwise.
  const metricsRef = React.useRef<{ lineHeight: number; padding: number } | null>(null);

  // Grow with the draft like the chat composer, capped at ~10 lines; the
  // textarea scrolls beyond that.
  React.useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = '0px';
    field.style.height = `${Math.min(field.scrollHeight, COMMENT_FIELD_MAX_HEIGHT)}px`;
    // Centre the buttons against a single line; pin them to the bottom once
    // the draft wraps so they stay next to the caret's last line.
    let metrics = metricsRef.current;
    if (!metrics) {
      const style = getComputedStyle(field);
      metrics = {
        lineHeight: Number.parseFloat(style.lineHeight) || 20,
        padding: Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom) || 0,
      };
      metricsRef.current = metrics;
    }
    const next = field.scrollHeight - metrics.padding > metrics.lineHeight * 1.5;
    setMultiline((prev) => (prev === next ? prev : next));
  }, [draft]);

  const empty = draft.trim().length === 0;
  const locked = busy !== null;

  return (
    <form
      className="flex flex-col gap-2 border-t border-border/60 pt-5"
      aria-label={ariaLabel ?? t('Leave a comment')}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmitComment();
      }}
    >
      <div className={`flex ${multiline ? 'items-end' : 'items-center'} gap-1.5 rounded-md border border-border bg-[var(--surface-elevated)] py-1 pr-1 focus-within:border-[var(--interactive-focus-ring)]`}>
        <Textarea
          simple
          ref={fieldRef}
          rows={1}
          value={draft}
          placeholder={`${placeholder ?? t('Leave a comment')} (⌘↩)`}
          aria-label={ariaLabel ?? t('Leave a comment')}
          disabled={locked}
          onChange={(event) => onDraftChange(event.target.value)}
          onBlur={() => onDraftBlur?.()}
          outerClassName="min-w-0 flex-1"
          className="min-h-0 w-full resize-none overflow-y-auto border-0 bg-transparent px-2.5 py-1 typography-ui text-foreground shadow-none outline-none placeholder:text-muted-foreground focus-visible:ring-0"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (
              event.key === 'Enter' &&
              (event.metaKey || event.ctrlKey) &&
              !event.shiftKey &&
              !event.altKey &&
              !event.repeat
            ) {
              event.preventDefault();
              event.stopPropagation();
              if (!empty && !locked) onSubmitComment();
            }
          }}
        />
        {!empty && followUp && followUp.allowed ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={locked}
            title={followUp.reason ?? followUp.label}
            onClick={followUp.onRun}
          >
            {busy === followUp.id ? followUp.busyLabel : followUp.label}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="default"
          size="xs"
          disabled={empty || locked}
          title={disabledReason ?? t('Post comment')}
          onClick={onSubmitComment}
        >
          {busy === 'comment' ? t('Posting…') : t('Comment')}
        </Button>
      </div>
      {error ? (
        <p className="typography-micro text-[var(--status-error)]" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
};
