import React from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';

type SnippetEditorMode = 'write' | 'preview';

interface SnippetMarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  initialMode?: SnippetEditorMode;
  placeholder?: string;
  /** Accessible label for the content textarea. */
  contentLabel?: string;
  /** Optional id for anchoring via data-settings-item. */
  settingsItem?: string;
  minHeight?: number;
  /** Hide the footer trigger note. Used for Behavior/Skills. */
  hideExpandsNote?: boolean;
  /** Dynamic trigger preview for the footer note, e.g. "#my-snippet" or "/review". */
  triggerPreview?: string;
  /** Verb shown before the trigger preview. Defaults to snippet expansion language. */
  triggerActionLabel?: string;
  /** Variable chips offered in Write mode; each inserts its value at the caret. */
  variableChips?: Array<{ value: string; label?: string; hint?: string }>;
}

export const SnippetMarkdownEditor: React.FC<SnippetMarkdownEditorProps> = ({
  value,
  onChange,
  readOnly = false,
  initialMode = 'preview',
  placeholder,
  contentLabel,
  settingsItem,
  minHeight = 220,
  hideExpandsNote = false,
  triggerPreview,
  triggerActionLabel,
  variableChips,
}) => {
  const { t } = useTranslation();
  const resolvedPlaceholder = placeholder ?? t('Enter snippet text... Use markdown to format your snippet. It will expand as #name in the composer.');
  const resolvedContentLabel = contentLabel ?? t('Snippet content');
  const resolvedTriggerActionLabel = triggerActionLabel ?? t('Expands as');
  const [mode, setMode] = React.useState<SnippetEditorMode>(() => readOnly ? 'preview' : initialMode);
  const hasContent = value.trim().length > 0;

  React.useEffect(() => {
    if (readOnly && mode === 'write') {
      setMode('preview');
    }
    if (!readOnly && mode === 'preview' && !hasContent) {
      // keep preview if user explicitly chose it, but allow switch
    }
  }, [readOnly, mode, hasContent]);

  const showWrite = mode === 'write' && !readOnly;

  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const insertVariable = React.useCallback((insert: string) => {
    const start = textareaRef.current?.selectionStart ?? value.length;
    const end = textareaRef.current?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + insert + value.slice(end));
    requestAnimationFrame(() => {
      const target = textareaRef.current;
      if (!target) return;
      target.focus();
      const caret = start + insert.length;
      target.setSelectionRange(caret, caret);
    });
  }, [onChange, value]);

  return (
    <div
      data-settings-item={settingsItem}
      className="overflow-hidden rounded-xl border border-border/60 bg-[var(--surface-elevated)]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/20 px-2 py-1.5">
        <div className="flex items-center gap-1">
          <Button
            variant="chip"
            size="xs"
            aria-pressed={mode === 'preview'}
            onClick={() => setMode('preview')}
          >
            <Icon name="eye" className="size-3.5" aria-hidden />
            {t('Preview')}
          </Button>
          <Button
            variant="chip"
            size="xs"
            aria-pressed={mode === 'write'}
            disabled={readOnly}
            onClick={() => setMode('write')}
            className={cn(readOnly && 'opacity-50')}
          >
            <Icon name="edit" className="size-3.5" aria-hidden />
            {t('Write')}
          </Button>
        </div>
        {readOnly ? (
          <span className="hidden typography-micro text-muted-foreground @xl:inline">{t('Read-only')}</span>
        ) : null}
      </div>

      {showWrite ? (
        <div className="p-0">
          {variableChips && variableChips.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 bg-muted/20 px-3 py-2">
              <span className="typography-micro text-muted-foreground">{t('Variables')}</span>
              {variableChips.map((chip) => (
                <Button
                  key={chip.value}
                  variant="chip"
                  size="xs"
                  onClick={() => insertVariable(chip.value)}
                  aria-label={chip.hint ?? t('Insert {{value}}', { value: chip.value })}
                  title={chip.hint ?? chip.value}
                >
                  <span className="font-mono">{chip.label ?? chip.value}</span>
                </Button>
              ))}
            </div>
          ) : null}
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={resolvedPlaceholder}
            simple
            fillContainer={false}
            outerClassName="border-0 ring-0 rounded-none bg-transparent"
            className={cn(
              'min-h-[220px] w-full bg-transparent px-3 py-3 font-mono typography-meta leading-6',
              'placeholder:text-muted-foreground/70',
            )}
            style={{ minHeight }}
            aria-label={resolvedContentLabel}
          />
        </div>
      ) : (
        <div className="min-h-[220px] px-4 py-4 @xl:px-6" style={{ minHeight }}>
          {hasContent ? (
            <SimpleMarkdownRenderer content={value} className="max-w-none" />
          ) : (
            <div className="flex min-h-[180px] flex-col items-center justify-center gap-2 py-10 text-center">
              <Icon name="file-text" className="size-6 text-muted-foreground/50" aria-hidden />
              <p className="typography-meta text-muted-foreground">
                {readOnly ? t('No content') : t('Nothing to preview')}
              </p>
              {!readOnly ? (
                <p className="typography-micro text-muted-foreground">{t('Start writing in the Write tab to see a live preview.')}</p>
              ) : null}
            </div>
          )}
        </div>
      )}

      {!readOnly ? (
        <div className="flex items-center justify-between gap-2 border-t border-border/40 bg-muted/10 px-3 py-2 typography-micro text-muted-foreground">
          {!hideExpandsNote && triggerPreview ? (
            <span className="flex items-center gap-1.5">
              <Icon name="information" className="size-3.5 shrink-0 opacity-60" aria-hidden />
              {resolvedTriggerActionLabel} <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{triggerPreview}</code> {t('in the composer')}
            </span>
          ) : (
            <span />
          )}
          <span className="tabular-nums">{t('{{count}} chars', { count: value.length })}</span>
        </div>
      ) : null}
    </div>
  );
};
