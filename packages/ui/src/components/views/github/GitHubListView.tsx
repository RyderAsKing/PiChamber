import React from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { formatGitHubRelativeTime } from './GitHubDetailScaffold';
import {
  GitHubEmptyState,
  GitHubIncompleteNotice,
  GitHubListFooter,
  GitHubListSkeleton,
  GitHubLoadMore,
  GitHubNumberJumpRow,
  GitHubRemoteSection,
  GitHubSearchInput,
  GitHubStaleBanner,
} from './GitHubListPrimitives';
import {
  GitHubFiltersMenu,
  GitHubRefreshButton,
  GitHubSortMenu,
  type GitHubHeaderActionsPresentation,
} from './GitHubFiltersMenu';
import { GitHubUnavailableState, toUnavailableInfo } from './GitHubUnavailableState';
import type { IconName } from '@/components/icon/icons';

/**
 * Generic list view shared by the Pull requests and Issues lists (which are
 * ~70% identical: toolbar, stale banner, blocking error/first-load
 * branching, empty state, load more, remote section, incomplete notice,
 * footer). Entity specifics arrive as props: row rendering, toolbar menus,
 * and copy. The toolbar stays mounted through every list state so a filter
 * change never unmounts the search input mid-typing.
 */

export type ListRemoteView<TItem> = {
  items: TItem[];
  isSearching: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  error: { kind: string; message?: string; retryAt?: number | null } | null;
  onSearchAll: () => void;
  onLoadMore: () => void;
  onRetry: () => void;
};

export type GitHubListViewProps<TItem extends { number: number }> = {
  /** Local view rows: the surface already applied state/involvement/text/sort. */
  items: TItem[];
  renderRow: (item: TItem) => React.ReactNode;
  hasMore: boolean;
  isLoadingMore: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  stale: boolean;
  error: { kind: string; message?: string } | null;
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  searchAriaLabel: string;
  /** State/involvement (/labels) menus + sort. Always stays inline in the list toolbar (second row). */
  toolbarControls: React.ReactNode;
  /**
   * Primary list action (e.g. New issue). Portals into `headerActionsSlot`
   * with Refresh when a slot is provided; renders inline in the toolbar
   * when no slot is provided (any other host).
   */
  primaryAction?: React.ReactNode;
  /**
   * Host header slot (TerminalView `terminalHeaderSlot` precedent). When
   * present, the action controls (Refresh + `primaryAction`) portal into
   * it and the toolbar keeps only search + `toolbarControls` (filters).
   * When absent, actions render inline in the toolbar exactly as before.
   * Only the list route passes a slot; detail/form routes unmount the
   * list, so the portal unmounts and the header never shows list actions.
   */
  headerActionsSlot?: HTMLElement | null;
  /**
   * Which header hosts the slot: `desktop` (ContextPanel `h-10` header,
   * ghost `h-8 w-8` buttons) or `drawer` (mobile/tablet
   * `MobileSurfaceHeader` actions, ghost 36px touch targets). Defaults to
   * `drawer`.
   */
  headerActionsPresentation?: GitHubHeaderActionsPresentation;
  /** True when no filter is active: empty state reads as "no items". */
  isDefaultFilters: boolean;
  /** Lowercase state label for the footer (`open`, `closed`, …). */
  stateLabel: string;
  kindSingular: string;
  kindPlural: string;
  noItemsTitle: string;
  noItemsBody?: string;
  noItemsIcon?: IconName;
  noItemsAction?: React.ReactNode;
  listAriaLabel: string;
  skeletonLabel: string;
  /** ISO timestamp per row for the footer's "updated …" suffix. */
  updatedAtOf: (item: TItem) => string | null | undefined;
  /** False while the viewed collections still page: counts show a `+` suffix. */
  countComplete?: boolean;
  /** Honesty notice for incomplete collections with an active filter. */
  incompleteNotice?: { summary: string; searching: boolean; onSearchAll: () => void } | null;
  /** Server search results below the local rows (deduped by the surface). */
  remote?: ListRemoteView<TItem> | null;
  /** `#123` / `123` query missing from loaded items: direct jump row. */
  numberJump?: number | null;
  numberJumpKind: string;
  onClearFilters: () => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onOpen: (number: number) => void;
};

export const GitHubListView = <TItem extends { number: number }>({
  items,
  renderRow,
  hasMore,
  isLoadingMore,
  isLoading,
  isRefreshing,
  stale,
  error,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  searchAriaLabel,
  toolbarControls,
  primaryAction,
  headerActionsSlot = null,
  headerActionsPresentation = 'drawer',
  isDefaultFilters,
  stateLabel,
  kindSingular,
  kindPlural,
  noItemsTitle,
  noItemsBody,
  noItemsIcon,
  noItemsAction,
  listAriaLabel,
  skeletonLabel,
  updatedAtOf,
  countComplete = true,
  incompleteNotice = null,
  remote = null,
  numberJump = null,
  numberJumpKind,
  onClearFilters,
  onLoadMore,
  onRetry,
  onOpen,
}: GitHubListViewProps<TItem>): React.ReactElement => {
  const { t } = useTranslation();
  const footerSummary = React.useMemo(() => {
    if (items.length === 0) return null;
    const count = items.length === 1 && countComplete
      ? t('1 {{kind}}', { kind: kindSingular })
      : t('{{count}} {{kind}}', { count: `${items.length}${countComplete ? '' : '+'}`, kind: kindPlural });
    let latest = 0;
    for (const item of items) {
      const parsed = updatedAtOf(item) ? Date.parse(updatedAtOf(item) as string) : NaN;
      if (Number.isFinite(parsed) && parsed > latest) latest = parsed;
    }
    const updated = latest > 0 ? formatGitHubRelativeTime(new Date(latest).toISOString()) : '';
    return `${count} · ${stateLabel.toLowerCase()}${updated ? ` · ${t('updated {{time}}', { time: updated })}` : ''}`;
  }, [items, stateLabel, kindSingular, kindPlural, countComplete, updatedAtOf, t]);

  const blockingError = Boolean(error) && items.length === 0;
  const firstLoad = !blockingError && isLoading && items.length === 0;
  // Action controls (Refresh + primary) portal into the host header while
  // the list is mounted. Filters/Sort always stay inline in the toolbar.
  // The drawer keeps hidden tabs mounted, but each tab owns its slot, so a
  // hidden tab's portal stays inside its own hidden header and never leaks
  // into the visible tab. Hosts additionally gate the slot by visibility
  // (terminal `terminalHeaderSlot={isActive ? slot : null}` precedent), and
  // detail routes unmount this view entirely, which unmounts the portal
  // and empties the header.
  const headerSlot = headerActionsSlot ?? null;
  const headerPresentation = headerActionsPresentation ?? 'drawer';
  const isRefreshingNow = isRefreshing || isLoading;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {stale ? <GitHubStaleBanner onRetry={onRetry} /> : null}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        <GitHubSearchInput
          value={searchValue}
          onChange={onSearchChange}
          placeholder={searchPlaceholder}
          ariaLabel={searchAriaLabel}
        />
        {toolbarControls}
        {headerSlot ? null : (
          <>
            {primaryAction}
            <GitHubRefreshButton isRefreshing={isRefreshingNow} onRefresh={onRetry} presentation="toolbar" />
          </>
        )}
      </div>
      {headerSlot
        ? createPortal(
            <>
              {primaryAction}
              <GitHubRefreshButton isRefreshing={isRefreshingNow} onRefresh={onRetry} presentation={headerPresentation} />
            </>,
            headerSlot,
          )
        : null}
      {blockingError ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <GitHubUnavailableState
            info={toUnavailableInfo(error as never)}
            onRetry={onRetry}
            isRetrying={isLoading}
          />
        </div>
      ) : firstLoad ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <GitHubListSkeleton label={skeletonLabel} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto" role="list" aria-label={listAriaLabel}>
          {items.length === 0 && numberJump == null ? (
            <GitHubEmptyState
              kind={isDefaultFilters ? 'no-items' : 'no-match'}
              noItemsTitle={noItemsTitle}
              noItemsBody={isDefaultFilters ? noItemsBody : undefined}
              noItemsIcon={noItemsIcon}
              noItemsAction={isDefaultFilters ? noItemsAction : undefined}
              onClearFilters={isDefaultFilters ? undefined : onClearFilters}
            />
          ) : (
            <>
              {items.length > 0 ? (
                <ul className="flex flex-col p-1">
                  {items.map((item) => (
                    <React.Fragment key={item.number}>{renderRow(item)}</React.Fragment>
                  ))}
                </ul>
              ) : null}
              {numberJump != null ? (
                <GitHubNumberJumpRow number={numberJump} kindLabel={numberJumpKind} onOpen={() => onOpen(numberJump)} />
              ) : null}
            </>
          )}
          <GitHubLoadMore hasMore={hasMore} isLoading={isLoadingMore || isLoading} onLoadMore={onLoadMore} />
          {remote && (remote.isSearching || remote.error || remote.items.length > 0) ? (
            <GitHubRemoteSection
              title={t("More results from GitHub")}
              isSearching={remote.isSearching}
              error={remote.error}
              hasResults={remote.items.length > 0}
              hasMore={remote.hasMore}
              isLoadingMore={remote.isLoadingMore}
              onRetry={remote.onRetry}
              onLoadMore={remote.onLoadMore}
            >
              <ul className="flex flex-col">
                {remote.items.map((item) => (
                  <React.Fragment key={item.number}>{renderRow(item)}</React.Fragment>
                ))}
              </ul>
            </GitHubRemoteSection>
          ) : null}
        </div>
      )}
      {!blockingError && !firstLoad && incompleteNotice ? (
        <GitHubIncompleteNotice
          matchSummary={incompleteNotice.summary}
          searching={incompleteNotice.searching}
          onSearchAll={incompleteNotice.onSearchAll}
        />
      ) : null}
      {!blockingError && !firstLoad && footerSummary ? <GitHubListFooter summary={footerSummary} /> : null}
    </div>
  );
};

/** Row toolbar for entity filter/sort menus (always inline in the list toolbar; the action controls live in the view). */
export const GitHubListMenus: React.FC<{
  stateValue: string;
  stateOptions: Array<{ id: string; label: string }>;
  onStateChange: (id: string) => void;
  involvementValue: string;
  involvementOptions: Array<{ id: string; label: string }>;
  onInvolvementChange: (id: string) => void;
  labelsValue?: string;
  onLabelsChange?: (value: string) => void;
  sortValue: string;
  sortOptions: Array<{ id: string; label: string }>;
  onSortChange: (id: string) => void;
  sortAriaLabel: string;
}> = ({
  stateValue,
  stateOptions,
  onStateChange,
  involvementValue,
  involvementOptions,
  onInvolvementChange,
  labelsValue,
  onLabelsChange,
  sortValue,
  sortOptions,
  onSortChange,
  sortAriaLabel,
}) => (
  <>
    <GitHubFiltersMenu
      stateValue={stateValue}
      stateOptions={stateOptions}
      onStateChange={onStateChange}
      involvementValue={involvementValue}
      involvementOptions={involvementOptions}
      onInvolvementChange={onInvolvementChange}
      labelsValue={labelsValue}
      onLabelsChange={onLabelsChange}
    />
    <GitHubSortMenu
      value={sortValue}
      options={sortOptions}
      onChange={onSortChange}
      ariaLabel={sortAriaLabel}
    />
  </>
);
