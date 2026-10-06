import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import type { GitHubErrorBody } from '@/lib/api/types';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { describeSectionError, shouldRenderSectionError } from './pulls/pullLogic';

/**
 * Reusable list primitives shared by the PR and Issues surfaces.
 */

/** Segmented state/involvement filter bar (kept for the composer link picker). */
export const GitHubFilterTabBar: React.FC<{
  options: Array<{ id: string; label: string }>;
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
}> = ({ options, value, onChange, ariaLabel }) => {
  return (
    <div role="tablist" aria-label={ariaLabel} className="flex flex-wrap gap-1">
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <Button
            key={option.id}
            type="button"
            variant="chip"
            size="xs"
            role="tab"
            aria-selected={selected}
            aria-pressed={selected}
            onClick={() => onChange(option.id)}
            className={cn(selected && 'bg-interactive-selection text-interactive-selection-foreground')}
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  );
};

/** Debounced (80 ms) search input with an icon addon. Filtering is
 * client-side over the loaded collections, so typing never fetches. */
export const GitHubSearchInput: React.FC<{
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}> = ({ value, onChange, placeholder, ariaLabel }) => {
  const { t } = useTranslation();
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  // Lists pass inline arrows that change identity every parent render; a
  // changing `onChange` must not reset the debounce timer on every keystroke.
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;
  React.useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onChangeRef.current(draft), 80);
    return () => clearTimeout(timer);
  }, [draft, value]);
  return (
    <span className="relative block min-w-0 flex-1">
      <Icon
        name="search"
        aria-hidden="true"
        className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={placeholder ?? t('Search')}
        aria-label={ariaLabel ?? t('Search')}
        className="h-8 pl-7"
      />
    </span>
  );
};

/** Skeleton rows for first load — never a spinner. */
export const GitHubListSkeleton: React.FC<{ rows?: number; label: string }> = ({ rows = 7, label }) => {
  const widths = ['w-3/5', 'w-2/5', 'w-1/2', 'w-2/3', 'w-2/5', 'w-3/5', 'w-1/2'];
  const metaWidths = ['w-2/5', 'w-1/3', 'w-2/5', 'w-1/4', 'w-1/3', 'w-2/5', 'w-1/3'];
  return (
    <div role="status" aria-label={label} className="flex animate-pulse flex-col p-1">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-2 rounded-md px-2 py-2">
          <span aria-hidden="true" className="size-4 shrink-0 rounded-full bg-muted-foreground/15" />
          <span className="min-w-0 flex-1 space-y-1.5">
            <span aria-hidden="true" className={cn('block h-3.5 rounded bg-muted-foreground/15', widths[index % widths.length])} />
            <span aria-hidden="true" className={cn('block h-3 rounded bg-muted-foreground/15', metaWidths[index % metaWidths.length])} />
          </span>
          <span className="flex shrink-0 flex-col items-end gap-1.5">
            <span aria-hidden="true" className="block h-3 w-12 rounded bg-muted-foreground/15" />
            <span aria-hidden="true" className="block h-3 w-10 rounded bg-muted-foreground/15" />
          </span>
        </div>
      ))}
    </div>
  );
};

/**
 * Centered list state: glyph, title, description, optional action.
 */
export const GitHubCenteredState: React.FC<{
  icon: IconName;
  title: string;
  description?: string;
  action?: React.ReactNode;
}> = ({ icon, title, description, action }) => {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 p-6 text-center">
      <Icon name={icon} aria-hidden="true" className="size-6 text-muted-foreground/60" />
      <p className="typography-ui-label font-medium text-foreground">{title}</p>
      {description ? (
        <p className="max-w-60 typography-micro text-muted-foreground">{description}</p>
      ) : null}
      {action}
    </div>
  );
};

export const GitHubLoadMore: React.FC<{
  hasMore: boolean;
  isLoading: boolean;
  onLoadMore: () => void;
  label?: string;
}> = ({ hasMore, isLoading, onLoadMore, label }) => {
  const { t } = useTranslation();
  if (!hasMore) return null;
  return (
    <div className="flex justify-center px-2 py-2">
      <Button type="button" variant="outline" size="sm" onClick={onLoadMore} disabled={isLoading}>
        {isLoading ? t('Loading…') : (label ?? t('Load more'))}
      </Button>
    </div>
  );
};

/**
 * Footer: muted counts summary from loaded data only.
 */
export const GitHubListFooter: React.FC<{
  summary: string;
  summaryTitle?: string;
}> = ({ summary, summaryTitle }) => {
  return (
    <footer className="flex shrink-0 items-center justify-between border-t border-border/60 px-2 py-1.5 typography-micro text-muted-foreground">
      <span className="min-w-0 truncate" title={summaryTitle ?? summary}>
        {summary}
      </span>
    </footer>
  );
};

/**
 * Honesty footer for incomplete collections with an active filter.
 */
export const GitHubIncompleteNotice: React.FC<{
  matchSummary: string;
  searching: boolean;
  onSearchAll: () => void;
}> = ({ matchSummary, searching, onSearchAll }) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/60 px-2 py-1.5 typography-micro text-muted-foreground">
      <span className="min-w-0 flex-1 truncate" title={matchSummary}>
        {matchSummary}
      </span>
      <Button type="button" variant="ghost" size="xs" onClick={onSearchAll} disabled={searching}>
        {searching ? t('Searching…') : t('Search all on GitHub')}
      </Button>
    </div>
  );
};

/**
 * Remote results section below the local rows. Errors stay inline here —
 * they never replace local results.
 */
export const GitHubRemoteSection: React.FC<{
  title: string;
  isSearching: boolean;
  error: { kind: string; message?: string; retryAt?: number | null } | null;
  hasResults: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
  children: React.ReactNode;
}> = ({ title, isSearching, error, hasResults, hasMore, isLoadingMore, onRetry, onLoadMore, children }) => {
  const { t } = useTranslation();
  const errorText =
    error?.kind === 'rate-limited'
      ? t('GitHub rate limit reached — try again in a little while.')
      : t("Couldn't search GitHub.");
  return (
    <section aria-label={title} className="border-t border-border/60">
      <p className="px-3 pb-0.5 pt-1.5 typography-micro font-medium text-muted-foreground">{title}</p>
      {error && !hasResults ? (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 typography-micro text-muted-foreground">
          <Icon name="error-warning" className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{errorText}</span>
          <Button type="button" variant="outline" size="xs" onClick={onRetry}>
            {t('Retry')}
          </Button>
        </div>
      ) : null}
      {error && hasResults ? (
        <div className="flex flex-wrap items-center gap-2 px-3 py-1 typography-micro text-muted-foreground">
          <span className="min-w-0 flex-1">{errorText}</span>
          <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
            {t('Retry')}
          </Button>
        </div>
      ) : null}
      {!error && isSearching && !hasResults ? (
        <p className="px-3 py-2 typography-micro text-muted-foreground" role="status">
          {t('Searching GitHub…')}
        </p>
      ) : null}
      {hasResults ? <div className="flex flex-col p-1 pt-0.5">{children}</div> : null}
      {!error && hasResults ? (
        <GitHubLoadMore hasMore={hasMore} isLoading={isLoadingMore} onLoadMore={onLoadMore} label={t("Load more results")} />
      ) : null}
    </section>
  );
};

/** Per-section failure row: a failed section never renders as an empty one. */
export const SectionError: React.FC<{ error: GitHubErrorBody | null | undefined; onRetry: () => void; label: string }> = ({
  error,
  onRetry,
  label,
}) => {
  const { t } = useTranslation();
  if (!shouldRenderSectionError(error)) return null;
  const detail = describeSectionError(error);
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2 typography-micro text-foreground"
      role="alert"
      aria-label={t('{{label}} failed to load', { label })}
    >
      <Icon name="error-warning" className="size-4 shrink-0 text-[var(--status-error)]" />
      <span className="min-w-0 flex-1 truncate">
        {t('{{label}} failed to load', { label })}{error ? ` — ${detail}` : ''}
      </span>
      <Button type="button" variant="outline" size="xs" onClick={onRetry}>
        {t('Retry')}
      </Button>
    </div>
  );
};

/** Direct jump row for `#123` / `123` queries missing from the loaded items. */
export const GitHubNumberJumpRow: React.FC<{
  number: number;
  kindLabel: string;
  onOpen: () => void;
}> = ({ number, kindLabel, onOpen }) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col p-1">
      <button
        type="button"
        onClick={onOpen}
        aria-label={t('Open {{kind}} #{{number}}', { kind: kindLabel, number })}
        className="group/github-row flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-interactive-hover"
      >
        <span className="inline-flex w-4 shrink-0 items-center justify-center">
          <Icon name="external-link" className="size-3.5 text-muted-foreground" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">
          {t('Open #{{number}}', { number })}
        </span>
        <span className="shrink-0 typography-micro text-muted-foreground">{t('Not in the loaded list')}</span>
      </button>
    </div>
  );
};

/** Stale banner: saved results with a failed refresh. One per surface. */
export const GitHubStaleBanner: React.FC<{ onRetry: () => void }> = ({ onRetry }) => {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-3 py-1.5 typography-micro text-foreground">
      <Icon name="error-warning" className="size-3.5 shrink-0 text-[var(--status-warning)]" />
      <span className="min-w-0 flex-1 truncate">{t('Showing saved results — last refresh failed')}</span>
      <button type="button" onClick={onRetry} className="shrink-0 underline" aria-label={t("Retry GitHub refresh")}>
        {t('Retry')}
      </button>
    </div>
  );
};

export const GitHubEmptyState: React.FC<{
  kind: 'no-items' | 'no-match';
  noItemsTitle: string;
  noItemsBody?: string;
  noItemsIcon?: IconName;
  noItemsAction?: React.ReactNode;
  onClearFilters?: () => void;
}> = ({ kind, noItemsTitle, noItemsBody, noItemsIcon, noItemsAction, onClearFilters }) => {
  const { t } = useTranslation();
  if (kind === 'no-match') {
    return (
      <GitHubCenteredState
        icon="search"
        title={t("Nothing matches these filters")}
        description={t("Try fewer words, or search by number, author, or label.")}
        action={
          onClearFilters ? (
            <Button type="button" variant="outline" size="sm" onClick={onClearFilters}>
              {t('Clear filters')}
            </Button>
          ) : undefined
        }
      />
    );
  }
  return (
    <GitHubCenteredState
      icon={noItemsIcon ?? 'git-pull-request'}
      title={noItemsTitle}
      description={noItemsBody}
      action={noItemsAction}
    />
  );
};
