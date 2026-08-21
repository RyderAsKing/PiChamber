import React from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';

interface SnippetMarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  /** Optional id for anchoring via data-settings-item. */
  settingsItem?: string;
  minHeight?: number;
}

export const SnippetMarkdownEditor: React.FC<SnippetMarkdownEditorProps> = ({
  value,
  onChange,
  readOnly = false,
  placeholder = 'Enter the prompt template text... Use markdown to format your snippet. It will expand as /name in Pi.',
  settingsItem,
  minHeight = 220,
}) => {
  const [mode, setMode] = React.useState<'write' | 'preview'>(readOnly ? 'preview' : 'write');
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
            aria-pressed={mode === 'write'}
            disabled={readOnly}
            onClick={() => setMode('write')}
            className={cn(readOnly && 'opacity-50')}
          >
            <Icon name="edit" className="size-3.5" aria-hidden />
            Write
          </Button>
          <Button
            variant="chip"
            size="xs"
            aria-pressed={mode === 'preview'}
            onClick={() => setMode('preview')}
          >
            <Icon name="eye" className="size-3.5" aria-hidden />
            Preview
          </Button>
        </div>
        <span className="hidden typography-micro text-muted-foreground @xl:inline">
          {readOnly ? 'Read-only' : 'Markdown supported'}
        </span>
      </div>

      {showWrite ? (
        <div className="p-0">
          <Textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            simple
            fillContainer={false}
            outerClassName="border-0 ring-0 rounded-none bg-transparent"
            className={cn(
              'min-h-[220px] w-full bg-transparent px-3 py-3 font-mono typography-meta leading-6',
              'placeholder:text-muted-foreground/70',
            )}
            style={{ minHeight }}
            aria-label="Snippet content"
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
                {readOnly ? 'No content' : 'Nothing to preview'}
              </p>
              {!readOnly ? (
                <p className="typography-micro text-muted-foreground">Start writing in the Write tab to see a live preview.</p>
              ) : null}
            </div>
          )}
        </div>
      )}

      {!readOnly ? (
        <div className="flex items-center justify-between gap-2 border-t border-border/40 bg-muted/10 px-3 py-2 typography-micro text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Icon name="information" className="size-3.5 shrink-0 opacity-60" aria-hidden />
            Expands as <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">/{'`{name}`'}</code> in Pi
          </span>
          <span className="tabular-nums">{value.length} chars</span>
        </div>
      ) : null}
    </div>
  );
};
