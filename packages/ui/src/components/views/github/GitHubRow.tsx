import React from 'react';
import { useTranslation } from 'react-i18next';
import { GitHubAvatar, GitHubLabelChip, formatGitHubRelativeTime } from './GitHubDetailScaffold';
import { cn } from '@/lib/utils';

/**
 * Shared two-line row for the PR and Issues lists (t3code
 * `PullRequestListRow` contract, PiChamber tokens).
 *
 * Leading glyph column (`w-4`), line 1 = `#N` mono muted tabular + title
 * truncate + signals + `ml-auto` status, line 2 = muted micro meta with
 * `ml-auto` relative time (`3h ago`). Flat rows (`rounded-md`), hover
 * background, selection token when selected — no chevron, no borders.
 */

const GITHUB_ROW_NUMBER_CLASS =
  'shrink-0 font-mono typography-micro tabular-nums text-muted-foreground';

const GitHubRowGlyph: React.FC<{
  glyph: React.ReactNode;
  /** Stacked under the glyph, level with the second line (e.g. PR checks). */
  below?: React.ReactNode;
}> = ({ glyph, below }) => {
  return (
    <span className="flex w-4 shrink-0 flex-col items-center gap-0.5">
      <span className="inline-flex">{glyph}</span>
      {below ? <span className="inline-flex">{below}</span> : null}
    </span>
  );
};

export const GitHubRowAuthor: React.FC<{ login?: string | null; avatarUrl?: string | null }> = ({
  login,
  avatarUrl,
}) => {
  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-1" title={login ?? 'ghost'}>
      <GitHubAvatar login={login} avatarUrl={avatarUrl} size="xs" />
      <span className="truncate">{login ?? 'ghost'}</span>
    </span>
  );
};

/** `head → base` in branch mono; the base keeps its width so a long head cannot squeeze it out. */
export const GitHubRowBranches: React.FC<{ head: string; base: string }> = ({ head, base }) => {
  return (
    <span className="flex min-w-0 items-center gap-1 font-mono">
      <span className="min-w-0 flex-1 truncate" title={head}>
        {head}
      </span>
      <span className="shrink-0">→</span>
      <span className="max-w-[45%] shrink-0 truncate" title={base}>
        {base}
      </span>
    </span>
  );
};

const LABEL_SLOTS = [
  { show: '' },
  { show: 'hidden @xl/github-row:inline-flex' },
  { show: 'hidden @3xl/github-row:inline-flex' },
] as const;

const LABEL_OVERFLOW = [
  'hidden @xl/github-row:hidden',
  'hidden @xl/github-row:inline-flex @3xl/github-row:hidden',
  '',
] as const;

/** Up to 3 label chips staged by row width, with `+N` riding the last visible pill. */
export const GitHubRowLabels: React.FC<{ labels: Array<{ name: string; color?: string | null }> }> = ({
  labels,
}) => {
  const { t } = useTranslation();
  if (labels.length === 0) return null;
  return (
    <span className="flex min-w-0 shrink-0 items-center gap-1">
      {LABEL_SLOTS.map((slot, index) => {
        const label = labels[index];
        if (!label) return null;
        const remaining = labels.length - index - 1;
        return (
          <span key={label.name} className={cn('min-w-0', slot.show)}>
            <GitHubLabelChip name={label.name} color={label.color} />
            {remaining > 0 ? (
              <span className={cn('ml-0.5 shrink-0', LABEL_OVERFLOW[index])} aria-label={t('{{count}} more labels', { count: remaining })}>
                +{remaining}
              </span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
};

export const GitHubRow: React.FC<{
  glyph: React.ReactNode;
  glyphBelow?: React.ReactNode;
  number: string;
  title: string;
  signals?: React.ReactNode;
  /** Right end of line 1 (PR diffstat). */
  status?: React.ReactNode;
  meta?: React.ReactNode;
  updatedAt?: string | null;
  selected?: boolean;
  onOpen: () => void;
  ariaLabel: string;
}> = ({ glyph, glyphBelow, number, title, signals, status, meta, updatedAt, selected, onOpen, ariaLabel }) => {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={ariaLabel}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        '@container/github-row group/github-row flex w-full items-center gap-2 rounded-md px-2 py-1 text-left',
        selected ? 'bg-interactive-selection text-interactive-selection-foreground' : 'hover:bg-interactive-hover',
      )}
    >
      <GitHubRowGlyph glyph={glyph} below={glyphBelow} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={GITHUB_ROW_NUMBER_CLASS}>{number}</span>
          <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground" title={title}>
            {title}
          </span>
          {signals ? <span className="flex shrink-0 items-center gap-1">{signals}</span> : null}
          {status ? <span className="ml-auto flex shrink-0 items-center gap-1.5">{status}</span> : null}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden typography-micro text-muted-foreground">
          {meta}
          {updatedAt ? (
            <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums">
              {formatGitHubRelativeTime(updatedAt)}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
};
