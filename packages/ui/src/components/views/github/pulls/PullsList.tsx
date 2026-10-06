/* eslint-disable react-refresh/only-export-components -- list component colocated with its row-checks hook by design */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { GitHubPullRequestSummary } from '@/lib/api/types';
import {
  GitHubChecksGlyph,
  GitHubStateGlyph,
  GitHubDiffStat,
} from '../GitHubDetailScaffold';
import {
  GitHubListMenus,
  GitHubListView,
  type ListRemoteView,
} from '../GitHubListView';
import {
  GitHubRow,
  GitHubRowAuthor,
  GitHubRowBranches,
} from '../GitHubRow';
import type { PullsFilters } from '@/stores/useGitHubPullRequestsStore';
import type { GitHubHeaderActionsPresentation } from '../GitHubFiltersMenu';
import { PULL_INVOLVEMENT_TABS, PULL_SORT_OPTIONS, PULL_STATE_TABS } from './pullLogic';
import { selectPrChecksIndex, useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';

export type PullsRemoteSection = ListRemoteView<GitHubPullRequestSummary>;

export const PullsList: React.FC<{
  /** Local view rows: the surface already applied state/involvement/text/sort over the collections. */
  items: GitHubPullRequestSummary[];
  hasMore: boolean;
  isLoadingMore: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  stale: boolean;
  error: { kind: string; message?: string } | null;
  filters: PullsFilters;
  checksByUrl: Record<string, string | null>;
  /** False while the viewed collections still page: counts show a `+` suffix. */
  countComplete?: boolean;
  /** Honesty notice for incomplete collections with an active filter. */
  incompleteNotice?: { summary: string; searching: boolean; onSearchAll: () => void } | null;
  /** Server search results below the local rows (deduped by the surface). */
  remote?: PullsRemoteSection | null;
  /** `#123` / `123` query missing from loaded items: direct jump row. */
  numberJump?: number | null;
  onFiltersChange: (patch: Partial<PullsFilters>) => void;
  onClearFilters: () => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onOpen: (number: number) => void;
  /**
   * Host header slot for the action controls (Refresh; PRs have no primary
   * action). When present, actions portal into it and the toolbar keeps
   * search + filters only. Only passed while the list is shown.
   */
  headerActionsSlot?: HTMLElement | null;
  /** Which header hosts the slot (`desktop` ContextPanel or `drawer` mobile/tablet). */
  headerActionsPresentation?: GitHubHeaderActionsPresentation;
}> = ({
  items,
  hasMore,
  isLoadingMore,
  isLoading,
  isRefreshing,
  stale,
  error,
  filters,
  checksByUrl,
  countComplete = true,
  incompleteNotice = null,
  remote = null,
  numberJump = null,
  onFiltersChange,
  onClearFilters,
  onLoadMore,
  onRetry,
  onOpen,
  headerActionsSlot = null,
  headerActionsPresentation = 'drawer',
}) => {
  const { t } = useTranslation();
  const isDefaultFilters = filters.state === 'open' && filters.involvement === 'all' && !filters.search.trim();

  const renderRow = React.useCallback((pr: GitHubPullRequestSummary) => (
    <li key={pr.number} role="listitem">
      <GitHubRow
        glyph={<GitHubStateGlyph kind="pr" state={pr.state} draft={pr.draft} />}
        glyphBelow={<GitHubChecksGlyph state={(pr.url ? checksByUrl[pr.url] : undefined) ?? null} />}
        number={`#${pr.number}`}
        title={pr.title}
        status={
          <GitHubDiffStat additions={pr.additions} deletions={pr.deletions} className="typography-micro" />
        }
        meta={
          <>
            <GitHubRowAuthor login={pr.author?.login} avatarUrl={pr.author?.avatarUrl} />
            <GitHubRowBranches head={pr.head} base={pr.base} />
            {pr.draft ? (
              <span className="shrink-0 rounded bg-[var(--surface-muted)] px-1 typography-micro text-muted-foreground">
                {t('Draft')}
              </span>
            ) : null}
          </>
        }
        updatedAt={pr.updatedAt}
        onOpen={() => onOpen(pr.number)}
        ariaLabel={t('Open pull request #{{number}} {{title}}', { number: pr.number, title: pr.title })}
      />
    </li>
  ), [checksByUrl, onOpen, t]);

  return (
    <GitHubListView
      items={items}
      renderRow={renderRow}
      hasMore={hasMore}
      isLoadingMore={isLoadingMore}
      isLoading={isLoading}
      isRefreshing={isRefreshing}
      stale={stale}
      error={error}
      searchValue={filters.search}
      onSearchChange={(value) => onFiltersChange({ search: value })}
      searchPlaceholder={t("Search pull requests, or label:bug")}
      searchAriaLabel={t("Search pull requests")}
      toolbarControls={
        <GitHubListMenus
          stateValue={filters.state}
          stateOptions={PULL_STATE_TABS.map((tab) => ({ id: tab.id, label: t(tab.label) }))}
          onStateChange={(id) => onFiltersChange({ state: id as PullsFilters['state'] })}
          involvementValue={filters.involvement}
          involvementOptions={PULL_INVOLVEMENT_TABS.map((tab) => ({ id: tab.id, label: t(tab.label) }))}
          onInvolvementChange={(id) => onFiltersChange({ involvement: id as PullsFilters['involvement'] })}
          sortValue={filters.sort}
          sortOptions={PULL_SORT_OPTIONS.map((option) => ({ id: option.id, label: t(option.label) }))}
          onSortChange={(id) => onFiltersChange({ sort: id as PullsFilters['sort'] })}
          sortAriaLabel={t("Sort pull requests")}
        />
      }
      headerActionsSlot={headerActionsSlot}
      headerActionsPresentation={headerActionsPresentation}
      isDefaultFilters={isDefaultFilters}
      stateLabel={t(PULL_STATE_TABS.find((tab) => tab.id === filters.state)?.label ?? filters.state)}
      kindSingular={t("pull request")}
      kindPlural={t("pull requests")}
      noItemsTitle={filters.state === 'open' ? t('No open pull requests') : t('No pull requests yet')}
      noItemsBody={t("Pull requests for this repository appear here.")}
      noItemsIcon="git-pull-request"
      listAriaLabel={t("Pull requests")}
      skeletonLabel={t("Loading pull requests")}
      updatedAtOf={(pr) => pr.updatedAt}
      countComplete={countComplete}
      incompleteNotice={incompleteNotice}
      remote={remote}
      numberJump={numberJump}
      numberJumpKind={t("pull request")}
      onClearFilters={onClearFilters}
      onLoadMore={onLoadMore}
      onRetry={onRetry}
      onOpen={onOpen}
    />
  );
};

export const usePullsRowChecks = (
  items: GitHubPullRequestSummary[],
): Record<string, string | null> => {
  // Row checks glyphs reuse the pr-status store's authoritative checks state
  // through the shared per-URL index (derived once per store change),
  // so rows do O(rows) lookups instead of nested scans per render.
  const results = useGitHubPrStatusStore((state) => state.results);
  return React.useMemo(() => {
    const index = selectPrChecksIndex(results);
    const checksByUrl: Record<string, string | null> = {};
    for (const item of items) {
      if (!item.url) continue;
      const state = index.get(item.url);
      if (state !== undefined) checksByUrl[item.url] = state;
    }
    return checksByUrl;
  }, [items, results]);
};
