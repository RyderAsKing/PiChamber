import React from 'react';

import { cn } from '@/lib/utils';
import type { Snippet } from '@/types/snippet';

interface SnippetCardProps {
  snippet: Snippet;
  onSelect: (name: string) => void;
  /** Hide the Project/Global pill — used when grid is already filtered by scope. */
  showSourcePill?: boolean;
}

/** Grid card for snippet browse. Shows name, description/content preview, and source pill. */
export const SnippetCard: React.FC<SnippetCardProps> = ({ snippet, onSelect, showSourcePill = true }) => {
  const sourceLabel = snippet.source === 'project' ? 'Project' : snippet.source === 'global' ? 'Global' : snippet.source;
  const description = snippet.description?.trim() || snippet.content.replace(/\s+/g, ' ').trim().slice(0, 140) || 'No description';
  const isPreviewTruncated = description.length >= 140 || (snippet.description?.trim()?.length ?? 0) === 0 && snippet.content.length > 140;

  return (
    <button
      type="button"
      onClick={() => onSelect(snippet.name)}
      aria-label={`${snippet.name} snippet, ${sourceLabel}`}
      className={cn(
        'group flex min-h-[118px] flex-col gap-3 rounded-xl border bg-[var(--surface-elevated)] p-4 text-left',
        'border-border/60 hover:bg-interactive-hover hover:border-border',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
        'transition-colors duration-150',
      )}
    >
      {showSourcePill ? (
        <div className="flex justify-start">
          <span
            className={cn(
              'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 typography-micro font-medium capitalize',
              snippet.source === 'project'
                ? 'bg-[var(--primary-base)]/10 text-[var(--primary-base)]'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {sourceLabel}
          </span>
        </div>
      ) : null}

      <div className="min-w-0 flex-1">
        <div className="truncate typography-ui-label font-medium text-foreground">/{snippet.name}</div>
        <div className="mt-1 line-clamp-2 typography-micro text-muted-foreground">
          {description}
          {isPreviewTruncated ? '…' : null}
        </div>
      </div>

      {!snippet.editable ? (
        <div className="flex items-center gap-1 typography-micro text-muted-foreground/70">
          <span className="inline-flex size-1.5 rounded-full bg-muted-foreground/40" aria-hidden />
          Read-only
        </div>
      ) : null}
    </button>
  );
};

interface SnippetCardSkeletonProps {
  count?: number;
}

export const SnippetCardSkeleton: React.FC<SnippetCardSkeletonProps> = ({ count = 6 }) => (
  <>
    {Array.from({ length: count }).map((_, index) => (
      <div
        key={index}
        className="flex min-h-[118px] flex-col gap-3 rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-4"
      >
        <div className="flex justify-start">
          <div className="h-5 w-16 animate-pulse rounded-full bg-muted" />
        </div>
        <div className="space-y-1.5">
          <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-3 w-full animate-pulse rounded bg-muted" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      </div>
    ))}
  </>
);
