import React from 'react';
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
      title={`${count} comments`}
      aria-label={`${count} comments`}
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
          aria-label="New issue"
          title="New issue"
        >
          <Icon name="add" className="size-4" />
          New issue
        </Button>
      )
      : (
        <Button
          type="button"
          variant="ghost"
          size="default"
          onClick={onNewIssue}
          aria-label="New issue"
          title="New issue"
        >
          <Icon name="add" className="size-4" />
          New issue
        </Button>
      )
    : (
      <Button
        type="button"
        variant="ghost"
        size={isTouchIssues ? "sm" : "xs"}
        onClick={onNewIssue}
        aria-label="New issue"
        title="New issue"
      >
        <Icon name="add" className="size-3.5" />
        New issue
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
        ariaLabel={`Open issue #${issue.number} ${issue.title}`}
      />
    </li>
  ), [onOpen]);

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
      searchPlaceholder="Search issues, or label:bug"
      searchAriaLabel="Search issues"
      toolbarControls={
        <GitHubListMenus
          stateValue={filters.state}
          stateOptions={ISSUE_STATE_TABS.map((tab) => ({ id: tab.id, label: tab.label }))}
          onStateChange={(id) => onFiltersChange({ state: id as IssuesFilters['state'] })}
          involvementValue={filters.involvement}
          involvementOptions={ISSUE_INVOLVEMENT_TABS.map((tab) => ({ id: tab.id, label: tab.label }))}
          onInvolvementChange={(id) => onFiltersChange({ involvement: id as IssuesFilters['involvement'] })}
          labelsValue={filters.labels}
          onLabelsChange={(value) => onFiltersChange({ labels: value })}
          sortValue={filters.sort}
          sortOptions={ISSUE_SORT_OPTIONS.map((option) => ({ id: option.id, label: option.label }))}
          onSortChange={(id) => onFiltersChange({ sort: id as IssuesFilters['sort'] })}
          sortAriaLabel="Sort issues"
        />
      }
      primaryAction={primaryAction}
      headerActionsSlot={headerActionsSlot}
      headerActionsPresentation={headerPresentation}
      isDefaultFilters={isDefaultFilters}
      noItemsTitle={filters.state === 'open' ? 'No open issues' : 'No issues yet'}
      noItemsBody="Issues for this repository appear here."
      noItemsIcon="inbox-archive"
      noItemsAction={
        <Button type="button" variant="outline" size="sm" onClick={onNewIssue}>
          <Icon name="add" className="size-3.5" />
          New issue
        </Button>
      }
      listAriaLabel="Issues"
      skeletonLabel="Loading issues"
      incompleteNotice={incompleteNotice}
      remote={remote}
      numberJump={numberJump}
      numberJumpKind="issue"
      onClearFilters={onClearFilters}
      onLoadMore={onLoadMore}
      onRetry={onRetry}
      onOpen={onOpen}
    />
  );
};
