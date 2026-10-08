/* eslint-disable react-refresh/only-export-components -- shared view primitives colocated with their components by design */
import React from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import type { GitHubIssueComment } from '@/lib/api/types';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { GitHubRichBody, preprocessMarkdownImages } from './GitHubRichBody';
import { isLongCommentBody, LONG_HTML_CHARS, shortRepoRef } from './githubBody';
import { useGitHubScope } from '@/stores/useGitHubScopeStore';
import { copyTextToClipboard } from '@/lib/clipboard';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useDeviceInfo } from '@/lib/device';

/**
 * Detail scaffold shared by PR and issue detail views.
 * Narrow widths stack list → detail; surfaces render this inside the shell.
 *
 * Header anatomy (adapted from the reference PR UI to PiChamber tokens):
 * row 1 (`h-7`) carries the back control, the repository (muted, only when
 * several repositories are in scope), the `#N ↗` external link tinted by
 * state, and a state pill (Open / Draft / Merged / Closed), with the
 * primary action + overflow menu on the right. Row 2 is the title
 * (`typography-ui-header`, semibold, truncate, hover pencil where editing
 * is allowed), then a `·`-separated meta line and the `base ← head`
 * branches line for PRs. Tabs render as underline text tabs with an active
 * 2px selection bar and muted-micro counts, plus an optional right-side
 * per-tab summary.
 */

/** Short `owner/repo` for the detail header, or null for single-repo scope. */
export const useHeaderRepoName = (directory: string, repo: string): string | null => {
  const scopeEntry = useGitHubScope(directory);
  return React.useMemo(() => {
    const repositories = scopeEntry.scope?.repositories ?? [];
    const selectable = repositories.filter(
      (entry) => entry.host && entry.owner && entry.repo && !entry.disabledReason,
    );
    if (selectable.length < 2) return null;
    return shortRepoRef(repo);
  }, [scopeEntry.scope, repo]);
};

/** Stable copy-link handler for detail overflow menus (copies + toasts). */
export const useCopyGitHubLink = (url: string | null | undefined): (() => void) => {
  return React.useCallback(() => {
    if (!url) return;
    void copyTextToClipboard(url).then((result) => {
      toast[result.ok ? 'success' : 'error'](result.ok ? i18n.t('Link copied') : i18n.t('Failed to copy link'));
    }).catch(() => toast.error(i18n.t('Failed to copy link')));
  }, [url]);
};

/** Short relative labels (`just now`, `5m ago`, `3h ago`, `2d ago`, `3w ago`, `2mo ago`, `1y ago`). */
export const formatGitHubRelativeTime = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const diffMs = Date.now() - then;
  if (diffMs < 0) return i18n.t('just now');
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return i18n.t('just now');
  if (minutes < 60) return i18n.t('{{count}}m ago', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return i18n.t('{{count}}h ago', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return i18n.t('{{count}}d ago', { count: days });
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return i18n.t('{{count}}w ago', { count: weeks });
  const months = Math.floor(days / 30);
  if (months < 12) return i18n.t('{{count}}mo ago', { count: months });
  return i18n.t('{{count}}y ago', { count: Math.floor(months / 12) });
};

export const GitHubAvatar: React.FC<{ login?: string | null; avatarUrl?: string | null; size?: 'xs' | 'sm' | 'md' }> = ({
  login,
  avatarUrl,
  size = 'sm',
}) => {
  const { t } = useTranslation();
  const cls = size === 'md' ? 'size-6' : size === 'xs' ? 'size-3.5' : 'size-5';
  if (!avatarUrl) {
    return (
      <span className={cn('inline-flex shrink-0 items-center justify-center rounded-full bg-[var(--surface-muted)] text-muted-foreground', cls)} aria-hidden="true">
        <Icon name="user" className="size-3" />
      </span>
    );
  }
  // Images load without credentials (plan §9): no referrer, no auth.
  return (
    <img
      src={avatarUrl}
      alt={login ? t('{{login}} avatar', { login }) : t('Avatar')}
      loading="lazy"
      referrerPolicy="no-referrer"
      className={cn('shrink-0 rounded-full border border-border/60 bg-muted object-cover', cls)}
    />
  );
};

const stateGlyphForPr = (state: string, draft?: boolean): { icon: IconName; label: string; className: string } => {
  if (state === 'merged') return { icon: 'git-merge', label: 'Merged', className: 'text-[var(--status-info)]' };
  if (state === 'closed') return { icon: 'close-circle', label: 'Closed', className: 'text-[var(--status-error)]' };
  if (draft) return { icon: 'git-pull-request', label: 'Draft', className: 'text-muted-foreground' };
  return { icon: 'git-pull-request', label: 'Open', className: 'text-[var(--status-success)]' };
};

const stateGlyphForIssue = (state: string, stateReason?: string | null): { icon: IconName; label: string; className: string } => {
  if (state === 'closed') {
    if (stateReason === 'not_planned') return { icon: 'close-circle', label: 'Not planned', className: 'text-muted-foreground' };
    return { icon: 'checkbox-circle', label: 'Completed', className: 'text-[var(--status-info)]' };
  }
  return { icon: 'checkbox-blank-circle-fill', label: 'Open', className: 'text-[var(--status-success)]' };
};

export const GitHubStateGlyph: React.FC<{
  kind: 'pr' | 'issue';
  state: string;
  draft?: boolean;
  stateReason?: string | null;
}> = ({ kind, state, draft, stateReason }) => {
  const { t } = useTranslation();
  const glyph = kind === 'pr' ? stateGlyphForPr(state, draft) : stateGlyphForIssue(state, stateReason);
  return (
    <span className={cn('inline-flex items-center gap-1', glyph.className)} title={t(glyph.label)} aria-label={t(glyph.label)}>
      <Icon name={glyph.icon} className="size-4 shrink-0" />
    </span>
  );
};

/** Tint class for the `#N ↗` header link, resolved from the same state glyph. */
export const gitHubStateTintClass = (
  kind: 'pr' | 'issue',
  state: string,
  draft?: boolean,
  stateReason?: string | null,
): string => {
  const glyph = kind === 'pr' ? stateGlyphForPr(state, draft) : stateGlyphForIssue(state, stateReason);
  return glyph.className;
};

export const GitHubChecksGlyph: React.FC<{ state?: string | null }> = ({ state }) => {
  const { t } = useTranslation();
  if (!state || state === 'unknown') return null;
  if (state === 'success') {
    return (
      <span className="inline-flex items-center gap-1 text-[var(--status-success)]" title={t("Checks passing")} aria-label={t("Checks passing")}>
        <Icon name="check" className="size-3.5" />
      </span>
    );
  }
  if (state === 'failure') {
    return (
      <span className="inline-flex items-center gap-1 text-[var(--status-error)]" title={t("Checks failing")} aria-label={t("Checks failing")}>
        <Icon name="close" className="size-3.5" />
      </span>
    );
  }
  if (state === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 text-[var(--status-warning)]" title={t("Checks pending")} aria-label={t("Checks pending")}>
        <Icon name="loader-4" className="size-3.5 animate-spin" />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground" title={t("Checks")} aria-label={t("Checks")}>
      <Icon name="subtract" className="size-3.5" />
    </span>
  );
};

/** Label chips use GitHub label colors with accessible contrast per theme rules. */
export const GitHubLabelChip: React.FC<{ name: string; color?: string | null }> = ({ name, color }) => {
  const style = React.useMemo(() => {
    if (!color) return undefined;
    const hex = color.replace('#', '').trim();
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;
    // Tinted chip: label color at low mix over the surface so text stays
    // legible in light/dark/high-contrast without hardcoding palette colors.
    return {
      backgroundColor: `color-mix(in srgb, #${hex} 18%, var(--surface-muted))`,
      borderColor: `color-mix(in srgb, #${hex} 45%, transparent)`,
      color: 'var(--surface-foreground)',
    } as React.CSSProperties;
  }, [color]);
  return (
    <span
      className="inline-flex max-w-32 items-center rounded-full border border-border/60 bg-[var(--surface-muted)] px-1.5 py-px typography-micro text-muted-foreground"
      style={style}
      title={name}
    >
      <span className="truncate">{name}</span>
    </span>
  );
};

/** State pill for the detail header row (Open / Draft / Merged / Closed with the state glyph). */
export const GitHubStatePill: React.FC<{
  kind: 'pr' | 'issue';
  state: string;
  draft?: boolean;
  stateReason?: string | null;
}> = ({ kind, state, draft, stateReason }) => {
  const { t } = useTranslation();
  const glyph = kind === 'pr' ? stateGlyphForPr(state, draft) : stateGlyphForIssue(state, stateReason);
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border border-border/60 bg-[var(--surface-muted)] px-1.5 py-px typography-micro',
        glyph.className,
      )}
    >
      <Icon name={glyph.icon} className="size-3 shrink-0" aria-hidden="true" />
      {t(glyph.label)}
    </span>
  );
};

/**
 * Shared detail header (reference-PR header anatomy, PiChamber tokens).
 *
 * Row 1 (`h-7`): back ghost icon, repository (muted, null hides it for
 * single-repo scope), the `#N ↗` external link tinted by state, and the
 * state pill; the primary action + overflow menu render on the right.
 * Row 2: title (`typography-ui-header` semibold, truncate, hover pencil
 * where `onEditTitle` is set), then the `·`-separated meta line and
 * optional branches line.
 */
export const GitHubDetailHeader: React.FC<{
  onBack: () => void;
  backLabel: string;
  /** Short `owner/repo` (or host-qualified ref); null hides the repo segment. */
  repoName?: string | null;
  number: number;
  url?: string | null;
  /** Tint for the `#N ↗` link (from `gitHubStateTintClass`). */
  numberTintClass?: string;
  openLabel: string;
  /** Null while nothing is known yet (no list seed): renders a placeholder bar. */
  title: string | null;
  onEditTitle?: () => void;
  editTitleLabel?: string;
  editTitleDisabledReason?: string | null;
  /** State pill rendered on row 1 after the `#N ↗` link (from `GitHubStatePill`). */
  statePill?: React.ReactNode;
  /** `author · updated 3h ago`-style meta with `·` separators. */
  meta?: React.ReactNode;
  /** PR `base ← head` branches line with files count + diffstat. */
  branches?: React.ReactNode;
  /** Inline status-warning line (e.g. out-of-date base) — never a card. */
  warning?: React.ReactNode;
  primary?: React.ReactNode;
  menu?: React.ReactNode;
}> = ({
  onBack,
  backLabel,
  repoName,
  number,
  url,
  numberTintClass,
  statePill,
  openLabel,
  title,
  onEditTitle,
  editTitleLabel,
  editTitleDisabledReason,
  meta,
  branches,
  warning,
  primary,
  menu,
}) => {
  const { t } = useTranslation();
  const { isMobile, isTablet } = useDeviceInfo();
  const isTouchDetail = isMobile || isTablet;
  return (
    <div className="min-w-0 px-2 pt-1 pb-2">
      <div className={cn('flex min-w-0 items-center gap-1', isTouchDetail ? 'h-9' : 'h-7')}>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onBack}
          title={backLabel}
          aria-label={backLabel}
          className={cn('shrink-0', isTouchDetail ? 'size-9' : 'size-6')}
        >
          <Icon name="arrow-left" className="size-4" />
        </Button>
        {repoName ? (
          <span className="min-w-0 shrink truncate typography-micro text-muted-foreground" title={repoName}>
            {repoName}
          </span>
        ) : null}
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={openLabel}
            title={openLabel}
            className={cn('inline-flex shrink-0 items-center gap-0.5 font-medium typography-micro underline-offset-2 hover:underline', numberTintClass)}
          >
            #{number}
            <Icon name="external-link" className="size-2.5" aria-hidden="true" />
          </a>
        ) : (
          <span className={cn('shrink-0 font-medium typography-micro', numberTintClass)}>#{number}</span>
        )}
        {statePill}
        <span className="min-w-0 flex-1" />
        {primary}
        {menu}
      </div>
      <div className="group/title mt-0.5 flex min-w-0 items-center gap-1 px-1">
        {title !== null ? (
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground" title={title}>
            {title}
          </h1>
        ) : (
          <span aria-hidden="true" className="my-1 block h-4 w-3/5 animate-pulse rounded bg-muted-foreground/15" />
        )}
        {onEditTitle && title !== null ? (
          <Button
            type="button"
            variant="ghost"
            aria-label={editTitleLabel ?? t('Edit title')}
            title={editTitleDisabledReason ?? editTitleLabel ?? t('Edit title')}
            disabled={editTitleDisabledReason != null}
            className="size-6 shrink-0 opacity-0 group-hover/title:opacity-100 focus-visible:opacity-100"
          >
            <Icon name="edit" className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {meta ? (
        <p className="mt-0.5 truncate px-1 typography-micro text-muted-foreground">{meta}</p>
      ) : null}
      {branches ? (
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 px-1 typography-micro text-muted-foreground">{branches}</p>
      ) : null}
      {warning}
    </div>
  );
};

/**
 * `+12 −3` diff stat: additions in the success tone, deletions in the error
 * tone (same tokens as the git history change types). Hidden when both are
 * zero or unknown, so a missing count never reads as an empty diff.
 */
export const GitHubDiffStat: React.FC<{
  additions?: number | null;
  deletions?: number | null;
  className?: string;
}> = ({ additions, deletions, className }) => {
  const { t } = useTranslation();
  const add = typeof additions === 'number' ? additions : 0;
  const del = typeof deletions === 'number' ? deletions : 0;
  if (add === 0 && del === 0) return null;
  return (
    <span
      className={cn('inline-flex shrink-0 items-baseline gap-1 font-mono tabular-nums', className)}
      aria-label={`${add === 1 ? t('{{count}} addition', { count: add }) : t('{{count}} additions', { count: add })}, ${del === 1 ? t('{{count}} deletion', { count: del }) : t('{{count}} deletions', { count: del })}`}
    >
      <span aria-hidden="true" className="text-[var(--status-success)]">+{add}</span>
      <span aria-hidden="true" className="text-[var(--status-error)]">−{del}</span>
    </span>
  );
};

/** Placeholder body while a detail read is in flight (header renders from the list seed). */
export const GitHubDetailSkeleton: React.FC<{ label: string }> = ({ label }) => {
  const widths = ['w-1/3', 'w-full', 'w-11/12', 'w-4/5', 'w-2/3'];
  return (
    <div role="status" aria-label={label} className="flex animate-pulse flex-col gap-2.5 px-4 py-3">
      {widths.map((width, index) => (
        <span key={index} aria-hidden="true" className={cn('block h-3 rounded bg-muted-foreground/15', width, index === 0 && 'mb-1')} />
      ))}
    </div>
  );
};

export const GitHubDetailScaffold: React.FC<{
  header: React.ReactNode;
  /** Underline text tabs: counts render in muted micro, `glyph` prefixes a status glyph (e.g. the checks rollup). */
  tabs: Array<{ id: string; label: string; hint?: string; glyph?: React.ReactNode }>;
  activeTab: string;
  onTabChange: (id: string) => void;
  /** Right-side per-tab summary (e.g. the checks rollup on the tab nav). */
  tabSummary?: React.ReactNode;
  children: React.ReactNode;
}> = ({ header, tabs, activeTab, onTabChange, tabSummary, children }) => {
  const { t } = useTranslation();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/60">{header}</div>
      {tabs.length > 0 ? (
        <nav aria-label={t("Detail sections")} className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border/60 px-4">
          <div role="tablist" aria-label={t("Detail sections")} className="flex min-w-0 items-stretch gap-4">
            {tabs.map((tab) => {
              const selected = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => onTabChange(tab.id)}
                  className={cn(
                    'relative flex h-9 shrink-0 items-center gap-1.5 text-xs leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                    selected ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {tab.glyph}
                  {tab.label}
                  {tab.hint ? <span className="typography-micro tabular-nums text-muted-foreground">{tab.hint}</span> : null}
                  {selected ? <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 bg-interactive-selection" /> : null}
                </button>
              );
            })}
          </div>
          {tabSummary ? <div className="ml-auto flex min-w-0 shrink-0 items-center">{tabSummary}</div> : null}
        </nav>
      ) : null}
      {/* Scroll root for virtualized diffs (PR Code tab): without it Pierre's
          virtualizer watches the document, which never scrolls here, and rows
          past the first viewport stay blank. */}
      <div className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]" data-diff-virtual-root>
        {children}
      </div>
    </div>
  );
};

/** `Reviewers` / `Labels` style fact row: `grid-cols-[6rem_minmax(0,1fr)]`. */
export const GitHubMetaRow: React.FC<{
  icon: IconName;
  label: string;
  children: React.ReactNode;
}> = ({ icon, label, children }) => {
  return (
    <div className="grid min-w-0 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 typography-ui text-foreground">
      <span className="flex items-center gap-1.5 typography-micro text-muted-foreground">
        <Icon name={icon} className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </span>
      <span className="min-w-0">{children}</span>
    </div>
  );
};

/**
 * Collapsible detail section (Description / Checks / Review / Comments).
 * Sticky header in `text-xs font-medium text-muted-foreground` with a
 * rotating chevron (transform-only animation). Sections sit directly on the
 * tab background — never inside another bordered box.
 */
export const GitHubSection: React.FC<{
  id: string;
  title: string;
  defaultOpen?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}> = ({ id, title, defaultOpen = true, action, children }) => {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <section aria-label={title}>
      <div className="sticky top-0 z-10 flex w-full items-center bg-[var(--surface-background)]">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <span className="truncate">{title}</span>
          <Icon
            name="arrow-down-s"
            aria-hidden="true"
            className={cn('size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-150', !open && '-rotate-90')}
          />
        </button>
        {action}
      </div>
      {open ? <div id={`${id}-panel`} className="min-w-0 px-1 pb-1">{children}</div> : null}
    </section>
  );
};

/**
 * The only bordered card allowed in detail views: comment cards sit directly
 * on the tab background (`rounded-md border`, header row with the 20px
 * avatar, author and `·`-separated meta, `px-3 py-2` header, body `px-3
 * py-3`). The relative time links to GitHub when `timeHref` is set.
 */
export const GitHubCommentCard: React.FC<{
  author: React.ReactNode;
  time?: React.ReactNode;
  /** GitHub URL for the comment: renders the time as an external link. */
  timeHref?: string | null;
  timeTitle?: string;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  label: string;
  children: React.ReactNode;
}> = ({ author, time, timeHref, timeTitle, badge, action, label, children }) => {
  const { t } = useTranslation();
  return (
    <article aria-label={label} className="min-w-0 overflow-hidden rounded-md border border-border/60">
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 bg-muted/25 px-3 py-2">
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 typography-micro text-foreground">
          {author}
          {badge}
          {time ? (
            <>
              <span aria-hidden="true" className="text-muted-foreground/60">·</span>
              {timeHref ? (
                <a
                  href={timeHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={timeTitle ?? t('Open on GitHub')}
                  className="shrink-0 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {time}
                </a>
              ) : (
                <span className="shrink-0 text-muted-foreground">{time}</span>
              )}
            </>
          ) : null}
        </span>
        {action}
      </header>
      <div className="min-w-0 px-3 py-3">{children}</div>
    </article>
  );
};

/**
 * GitHub body: renders GitHub's `bodyHTML` when present (signed image URLs
 * for attachments/private images, sanitized via `GitHubRichBody`), else the
 * markdown fallback with raw `<img>` tags preprocessed into images. `html`
 * is empty for older caches and optimistic posts. `fallbackUrl` backs the
 * expired-image link (the comment/PR URL) when the image has no anchor href.
 */
export const GitHubMarkdownBody: React.FC<{ markdown: string; html?: string | null; fallbackUrl?: string | null }> = ({
  markdown,
  html,
  fallbackUrl,
}) => {
  if (html && html.trim()) {
    return (
      <div className="min-w-0 break-words">
        <GitHubRichBody html={html} fallbackUrl={fallbackUrl} />
      </div>
    );
  }
  const content = preprocessMarkdownImages(markdown);
  if (!content.trim()) return null;
  return (
    <div className="min-w-0 break-words">
      <SimpleMarkdownRenderer content={content} className="max-w-none" />
    </div>
  );
};

/**
 * Long-body collapse shared by issue/PR descriptions and comments: long
 * bodies render clipped with a fade until expanded. The rendered body is kept
 * while collapsed (a raw-markdown excerpt read as broken formatting);
 * sanitized HTML is cached, so this stays cheap on re-render.
 */
export const GitHubCollapsibleBody: React.FC<{
  markdown: string;
  html?: string | null;
  fallbackUrl?: string | null;
  label: string;
}> = ({ markdown, html, fallbackUrl, label }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState(false);
  const long = isLongCommentBody(markdown) || (html != null && html.length > LONG_HTML_CHARS);
  if (!long) {
    return <GitHubMarkdownBody markdown={markdown} html={html} fallbackUrl={fallbackUrl} />;
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className={expanded ? 'min-w-0' : 'relative min-w-0 max-h-64 overflow-hidden'}>
        <GitHubMarkdownBody markdown={markdown} html={html} fallbackUrl={fallbackUrl} />
        {expanded ? null : (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[var(--surface-background)] to-transparent"
          />
        )}
      </div>
      <div>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={expanded ? t('Show less of {{label}}', { label }) : t('Show more of {{label}}', { label })}
        >
          {expanded ? t('Show less') : t('Show more')}
        </Button>
      </div>
    </div>
  );
};

/**
 * One comment card in the PR/issue thread: avatar + author, relative time
 * linking to GitHub, an automation badge for bots, and the collapsible body.
 */
export const GitHubThreadComment: React.FC<{ comment: GitHubIssueComment; bot?: boolean }> = ({ comment, bot }) => {
  const { t } = useTranslation();
  const login = comment.author?.login ?? (bot ? 'bot' : 'ghost');
  return (
    <GitHubCommentCard
      label={t('{{kind}} by {{login}}', { kind: bot ? t('Bot comment') : t('Comment'), login })}
      author={
        <>
          <GitHubAvatar login={comment.author?.login} avatarUrl={comment.author?.avatarUrl} size="sm" />
          <span className="truncate font-medium">{login}</span>
        </>
      }
      time={comment.createdAt ? formatGitHubRelativeTime(comment.createdAt) : undefined}
      timeHref={comment.url ?? null}
      timeTitle={t("Open comment on GitHub")}
      badge={
        bot ? (
          <span className="shrink-0 rounded bg-[var(--surface-muted)] px-1 typography-micro text-muted-foreground">
            bot
          </span>
        ) : undefined
      }
    >
      <GitHubCollapsibleBody markdown={comment.body} html={comment.bodyHtml ?? null} fallbackUrl={comment.url} label={t('{{kind}} by {{login}}', { kind: bot ? t('bot comment') : t('comment'), login })} />
    </GitHubCommentCard>
  );
};

/** Newest/oldest toggle for the comments section action. */
export const GitHubCommentOrderToggle: React.FC<{
  order: 'newest' | 'oldest';
  onToggle: () => void;
}> = ({ order, onToggle }) => {
  const { t } = useTranslation();
  return (
  <Button
    type="button"
    variant="ghost"
    size="xs"
    onClick={onToggle}
    aria-label={order === 'newest' ? t('Show oldest first') : t('Show newest first')}
    title={t("Toggle comment order")}
  >
    {order === 'newest' ? t('Newest first') : t('Oldest first')}
  </Button>
  );
};

/**
 * Bot comments behind one group toggle (human comments render fully above).
 * Expanded state is local; switching items keeps the toggle as-is, like the
 * detail sections.
 */
export const GitHubBotCommentGroup: React.FC<{ comments: GitHubIssueComment[] }> = ({ comments }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState(false);
  if (comments.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={expanded ? t('Hide bot comments') : comments.length === 1 ? t('Show {{count}} bot comment', { count: comments.length }) : t('Show {{count}} bot comments', { count: comments.length })}
      >
        {expanded ? t('Hide bot comments') : comments.length === 1 ? t('Show {{count}} bot comment', { count: comments.length }) : t('Show {{count}} bot comments', { count: comments.length })}
      </Button>
      {expanded ? comments.map((comment) => <GitHubThreadComment key={comment.id} comment={comment} bot />) : null}
    </div>
  );
};
