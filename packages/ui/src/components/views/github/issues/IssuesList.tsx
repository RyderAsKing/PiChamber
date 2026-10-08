import React from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import type { GitHubIssueSummary } from '@/lib/api/types';
import {
  GitHubStateGlyph,
} from '../GitHubDetailScaffold';
import {
  GitHubListMenus,
  GitHubListView,
  type ListRemoteView,
} from '../GitHubListView';
import {
  GitHubRow,
  GitHubRowAuthor,
  GitHubRowLabels,
} from '../GitHubRow';
import type { IssuesFilters } from '@/stores/useGitHubIssuesStore';
import type { GitHubHeaderActionsPresentation } from '../GitHubFiltersMenu';
import { ISSUE_INVOLVEMENT_TABS, ISSUE_SORT_OPTIONS, ISSUE_STATE_TABS } from './issueLogic';
import { useDeviceInfo } from '@/lib/device';

const commentCountSignal = (count?: number): React.ReactNode => {
  if (typeof count !== 'number' || count === 0) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 typography-micro tabular-nums text-muted-foreground"
      title={i18n.t('{{count}} comments', { count })}
      aria-label={i18n.t('{{count}} comments', { count })}
    >
      <Icon name="chat-1" className="size-3.5" />
      {count}
    </span>
  );
};

export type IssuesRemoteSection = ListRemoteView<GitHubIssueSummary>;

export const IssuesList: React.FC<{
  /** Local view rows: the surface already applied state/involvement/labels/text/sort over the collections. */
  items: GitHubIssueSummary[];
  hasMore: boolean;
  isLoadingMore: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  stale: boolean;
  error: { kind: string; message?: string } | null;
  filters: IssuesFilters;
  /** False while the viewed collections still page: counts show a `+` suffix. */
  countComplete?: boolean;
  /** Honesty notice for incomplete collections with an active filter. */
  incompleteNotice?: { summary: string; searching: boolean; onSearchAll: () => void } | null;
  /** Server search results below the local rows (deduped by the surface). */
  remote?: IssuesRemoteSection | null;
  /** `#123` / `123` query missing from loaded items: direct jump row. */
  numberJump?: number | null;
  onFiltersChange: (patch: Partial<IssuesFilters>) => void;
  onClearFilters: () => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onOpen: (number: number) => void;
  onNewIssue: () => void;
  /**
   * Host header slot for the action controls (Refresh + New issue). When
   * present, actions portal into it and the toolbar keeps search + filters
   * only. Only passed while the list is shown.
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
  countComplete = true,
  incompleteNotice = null,
  remote = null,
  numberJump = null,
  onFiltersChange,
  onClearFilters,
  onLoadMore,
  onRetry,
  onOpen,
  onNewIssue,
  headerActionsSlot = null,
  headerActionsPresentation = 'drawer',
}) => {
  const { t } = useTranslation();
  const isDefaultFilters =
    filters.state === 'open' && filters.involvement === 'all' && !filters.search.trim() && !filters.labels.trim();
  const { isMobile, isTablet } = useDeviceInfo();
  const isTouchIssues = isMobile || isTablet;
  const hasHeaderSlot = headerActionsSlot != null;
  const headerPresentation = headerActionsPresentation ?? 'drawer';
  // The primary action is explicitly separate from the filter controls:
  // the same node portals into the host header when a slot is provided
  // (header sizing) and renders inline in the toolbar otherwise (toolbar
  // sizing, as before). Desktop header matches the `h-8` panel buttons;
  // drawer header uses `h-9` touch targets; both use `size-4` icons.
  const primaryAction = hasHeaderSlot
    ? headerPresentation === 'desktop'
      ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onNewIssue}
          aria-label={t("New issue")}
          title={t("New issue")}
        >
          <Icon name="add" className="size-4" />
          {t('New issue')}
        </Button>
      )
      : (
        <Button
          type="button"
          variant="ghost"
          size="default"
          onClick={onNewIssue}
          aria-label={t("New issue")}
          title={t("New issue")}
        >
          <Icon name="add" className="size-4" />
          {t('New issue')}
        </Button>
      )
    : (
      <Button
        type="button"
        variant="ghost"
        size={isTouchIssues ? "sm" : "xs"}
        onClick={onNewIssue}
        aria-label={t("New issue")}
        title={t("New issue")}
      >
        <Icon name="add" className="size-3.5" />
        {t('New issue')}
      </Button>
    );

  const renderRow = React.useCallback((issue: GitHubIssueSummary) => (
    <li key={issue.number} role="listitem">
      <GitHubRow
        glyph={<GitHubStateGlyph kind="issue" state={issue.state} />}
        number={`#${issue.number}`}
        title={issue.title}
        signals={commentCountSignal(issue.comments)}
        meta={
          <>
            <GitHubRowAuthor login={issue.author?.login} avatarUrl={issue.author?.avatarUrl} />
            <GitHubRowLabels labels={issue.labels ?? []} />
          </>
        }
        updatedAt={issue.updatedAt}
        onOpen={() => onOpen(issue.number)}
        ariaLabel={t('Open issue #{{number}} {{title}}', { number: issue.number, title: issue.title })}
      />
    </li>
  ), [onOpen, t]);

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
      searchPlaceholder={t("Search issues, or label:bug")}
      searchAriaLabel={t("Search issues")}
      toolbarControls={
        <GitHubListMenus
          stateValue={filters.state}
          stateOptions={ISSUE_STATE_TABS.map((tab) => ({ id: tab.id, label: t(tab.label) }))}
          onStateChange={(id) => onFiltersChange({ state: id as IssuesFilters['state'] })}
          involvementValue={filters.involvement}
          involvementOptions={ISSUE_INVOLVEMENT_TABS.map((tab) => ({ id: tab.id, label: t(tab.label) }))}
          onInvolvementChange={(id) => onFiltersChange({ involvement: id as IssuesFilters['involvement'] })}
          labelsValue={filters.labels}
          onLabelsChange={(value) => onFiltersChange({ labels: value })}
          sortValue={filters.sort}
          sortOptions={ISSUE_SORT_OPTIONS.map((option) => ({ id: option.id, label: t(option.label) }))}
          onSortChange={(id) => onFiltersChange({ sort: id as IssuesFilters['sort'] })}
          sortAriaLabel={t("Sort issues")}
        />
      }
      primaryAction={primaryAction}
      headerActionsSlot={headerActionsSlot}
      headerActionsPresentation={headerPresentation}
      isDefaultFilters={isDefaultFilters}
      stateLabel={t(ISSUE_STATE_TABS.find((tab) => tab.id === filters.state)?.label ?? filters.state)}
      kindSingular={t("issue")}
      kindPlural={t("issues")}
      noItemsTitle={filters.state === 'open' ? t('No open issues') : t('No issues yet')}
      noItemsBody={t("Issues for this repository appear here.")}
      noItemsIcon="inbox-archive"
      noItemsAction={
        <Button type="button" variant="outline" size="sm" onClick={onNewIssue}>
          <Icon name="add" className="size-3.5" />
          {t('New issue')}
        </Button>
      }
      listAriaLabel={t("Issues")}
      skeletonLabel={t("Loading issues")}
      updatedAtOf={(issue) => issue.updatedAt}
      countComplete={countComplete}
      incompleteNotice={incompleteNotice}
      remote={remote}
      numberJump={numberJump}
      numberJumpKind={t("issue")}
      onClearFilters={onClearFilters}
      onLoadMore={onLoadMore}
      onRetry={onRetry}
      onOpen={onOpen}
    />
  );
};
