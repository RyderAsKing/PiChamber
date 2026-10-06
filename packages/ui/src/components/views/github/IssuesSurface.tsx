import React from 'react';
import { useTranslation } from 'react-i18next';
import { GitHubSurfaceShell } from './GitHubSurfaceShell';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useGitHubLogin } from '@/stores/useGitHubStatusStore';
import {
  findIssueSeed,
  getIssuesLocalIndex,
  useGitHubIssuesStore,
  useIssueCommentsEntry,
  useIssueDetailEntry,
  useIssuesCollectionEntry,
  useIssuesFilters,
  useIssuesRemoteEntry,
  useIssuesSelection,
  type IssuesCollection,
  type IssuesRemoteQuery,
} from '@/stores/useGitHubIssuesStore';
import { subscribeToAgentTurnCompletion } from '@/stores/useGitHubPullRequestsStore';
import { filterIssueItems } from './githubListFiltering';
import { useGitHubRemoteSearch } from './useGitHubRemoteSearch';
import { IssuesList } from './issues/IssuesList';
import { IssueDetail } from './issues/IssueDetail';
import { NewIssueForm } from './issues/NewIssueForm';
import type { GitHubHeaderActionsPresentation } from './GitHubFiltersMenu';

/**
 * Issues rail surface (plan §6.4).
 *
 * Singleton: remounts on switch and restores list filters, selection, and
 * snapshots from `useGitHubIssuesStore`. Lists read two wide per-repo
 * collections (`open` + `closed`, perPage 100); state tabs, involvement,
 * labels, text, and sort are instant local views. Refresh triggers: surface
 * open, repo change, window focus/visibility, explicit refresh, and agent
 * turn completion — no list polling. The last-known snapshot renders first
 * while the fresh read revalidates in the background (30 s fresh window).
 */
const IssuesBody: React.FC<{
  directory: string;
  repo: string;
  isRefreshing: boolean;
  registerRefresh: (refresh: (() => void) | null) => void;
  onRefreshChange: (value: boolean) => void;
  /**
   * Host header slot for the action controls (Refresh + New issue). Only
   * the list branch below receives it; detail/form branches unmount the
   * list so the portal unmounts too. Hosts gate the slot by visibility
   * (terminal `terminalHeaderSlot={isActive ? slot : null}` precedent).
   */
  headerActionsSlot?: HTMLElement | null;
  /** Which header hosts the slot (`desktop` ContextPanel or `drawer` mobile/tablet). */
  headerActionsPresentation?: GitHubHeaderActionsPresentation;
}> = ({ directory, repo, isRefreshing, registerRefresh, onRefreshChange, headerActionsSlot = null, headerActionsPresentation = 'drawer' }) => {
  const { t } = useTranslation();
  const apis = useRuntimeAPIs();
  const github = apis.github ?? null;
  const filters = useIssuesFilters(directory, repo);
  const selection = useIssuesSelection(directory);
  const viewerLogin = useGitHubLogin();
  const [showForm, setShowForm] = React.useState(false);

  const selectedNumber = selection.repo === repo && typeof selection.number === 'number' ? selection.number : null;

  const need: IssuesCollection | 'both' =
    filters.state === 'open' ? 'open' : filters.state === 'all' ? 'both' : 'closed';

  const refreshAll = React.useCallback(() => {
    if (!github) return;
    onRefreshChange(true);
    void useGitHubIssuesStore
      .getState()
      .refreshAllForScope(directory, repo, github)
      .catch(() => null)
      .finally(() => onRefreshChange(false));
  }, [github, directory, repo, onRefreshChange]);

  React.useEffect(() => {
    registerRefresh(refreshAll);
    return () => registerRefresh(null);
  }, [registerRefresh, refreshAll]);

  // Surface open / repo change / state-tab change: stale-while-revalidate.
  // Search, involvement, labels, and sort changes never reach this effect.
  React.useEffect(() => {
    if (!github) return;
    onRefreshChange(true);
    void useGitHubIssuesStore
      .getState()
      .ensureCollectionsFresh(directory, repo, need, github)
      .catch(() => null)
      .finally(() => onRefreshChange(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [github, directory, repo, need]);

  // Detail + comments follow the selection.
  React.useEffect(() => {
    if (!github || selectedNumber === null) return;
    const state = useGitHubIssuesStore.getState();
    void state.ensureDetail(directory, repo, selectedNumber, github);
    void state.ensureComments(directory, repo, selectedNumber, github);
  }, [github, directory, repo, selectedNumber]);

  // Window focus/visibility revalidates through the same last-known-first
  // path — no fixed polling for lists.
  React.useEffect(() => {
    if (!github) return;
    const onFocus = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void useGitHubIssuesStore.getState().ensureCollectionsFresh(directory, repo, need, github).catch(() => {});
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [github, directory, repo, need]);

  // After an agent turn ends in this directory, the open detail re-reads
  // (shared turn-complete signal; issues only refresh their own detail).
  React.useEffect(() => subscribeToAgentTurnCompletion((turnDirectory) => {
    useGitHubIssuesStore.getState().notifyAgentTurnComplete(turnDirectory);
  }), []);

  // Per-key subscriptions: this list re-renders only when its own repo's
  // collections change — never for another repo or issue detail activity.
  const openEntry = useIssuesCollectionEntry(repo, 'open');
  const closedEntry = useIssuesCollectionEntry(repo, 'closed');

  const index = React.useMemo(
    () => getIssuesLocalIndex(repo),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repo, openEntry?.data, closedEntry?.data],
  );
  const indexNumbers = React.useMemo(() => new Set(index.map((item) => item.number)), [index]);

  const items = React.useMemo(
    () => filterIssueItems(index, {
      state: filters.state,
      involvement: filters.involvement,
      labels: filters.labels,
      search: filters.search,
      sort: filters.sort,
      viewerLogin,
    }),
    [index, filters.state, filters.involvement, filters.labels, filters.search, filters.sort, viewerLogin],
  );

  const relevantEntries = need === 'both' ? [openEntry, closedEntry] : [need === 'open' ? openEntry : closedEntry];
  const hasRelevantData = relevantEntries.some((entry) => entry?.data != null);
  const complete = hasRelevantData && relevantEntries.every((entry) => entry?.data?.nextCursor == null);
  const loadedCount = relevantEntries.reduce((total, entry) => total + (entry?.data?.items.length ?? 0), 0);
  const relevantError = relevantEntries.find((entry) => entry?.error)?.error ?? null;
  const relevantStale = relevantEntries.some((entry) => entry?.stale);

  const trimmedSearch = filters.search.trim();
  const trimmedLabels = filters.labels.trim();
  const involvementNeedsRemote =
    (filters.involvement !== 'all' && !viewerLogin) || filters.involvement === 'mentioned';
  const filterActive = trimmedSearch.length > 0 || trimmedLabels.length > 0 || filters.involvement !== 'all';

  const remoteQuery: IssuesRemoteQuery = React.useMemo(
    () => ({ state: filters.state, involvement: filters.involvement, labels: trimmedLabels, q: trimmedSearch }),
    [filters.state, filters.involvement, trimmedLabels, trimmedSearch],
  );
  const remoteKeyString = `${remoteQuery.state}|${remoteQuery.involvement}|${remoteQuery.labels}|${remoteQuery.q}`;
  // `mentioned` and unknown-viewer involvement have no local signal, so they
  // always consult the server when the local view cannot prove completeness.
  const autoRemote = !complete && hasRelevantData
    && (items.length === 0 || involvementNeedsRemote)
    && (trimmedSearch.length > 0 || trimmedLabels.length > 0 || involvementNeedsRemote);
  const runSearch = React.useCallback((searchQuery: IssuesRemoteQuery) => {
    if (!github) return Promise.resolve(null);
    return useGitHubIssuesStore.getState().searchRemote(directory, repo, searchQuery, github);
  }, [directory, repo, github]);
  const runLoadMore = React.useCallback((searchQuery: IssuesRemoteQuery) => {
    if (!github) return Promise.resolve(null);
    return useGitHubIssuesStore.getState().loadMoreRemote(directory, repo, searchQuery, github);
  }, [directory, repo, github]);
  const { remoteView: remote, numberJump, remotePending, handleSearchAll } = useGitHubRemoteSearch({
    repo,
    query: remoteQuery,
    queryKey: remoteKeyString,
    autoRemote,
    indexNumbers,
    visibleItems: items,
    searchText: trimmedSearch,
    useRemoteEntry: useIssuesRemoteEntry,
    runSearch,
    runLoadMore,
  });
  const incompleteSummary = React.useMemo(() => {
    if (complete || !hasRelevantData || !filterActive) return null;
    const match = items.length === 1 ? t('1 match') : t('{{count}} matches', { count: items.length });
    const loaded = loadedCount === 1 ? t('1 most recent loaded issue') : t('{{count}} most recent loaded issues', { count: loadedCount });
    return t('Showing {{match}} from the {{loaded}}', { match, loaded });
  }, [complete, hasRelevantData, filterActive, items.length, loadedCount, t]);

  const detailEntry = useIssueDetailEntry(repo, selectedNumber);
  const commentsEntry = useIssueCommentsEntry(repo, selectedNumber);

  // Stable detail callbacks so inline arrows never defeat memoized children.
  const handleLoadMoreComments = React.useCallback(() => {
    if (!github || selectedNumber === null) return;
    void useGitHubIssuesStore.getState().loadMoreComments(directory, repo, selectedNumber, github);
  }, [github, directory, repo, selectedNumber]);
  const handleBack = React.useCallback(() => {
    useGitHubIssuesStore.getState().selectIssue(directory, null, null);
  }, [directory]);
  const handleRetryDetail = React.useCallback(() => {
    if (!github || selectedNumber === null) return;
    void useGitHubIssuesStore.getState().refreshDetail(directory, repo, selectedNumber, github);
  }, [github, directory, repo, selectedNumber]);
  const handleRetryComments = React.useCallback(() => {
    if (!github || selectedNumber === null) return;
    void useGitHubIssuesStore.getState().refreshComments(directory, repo, selectedNumber, github);
  }, [github, directory, repo, selectedNumber]);

  if (!github) return null;

  if (showForm) {
    return (
      <NewIssueForm
        directory={directory}
        repo={repo}
        github={github}
        onCancel={() => setShowForm(false)}
        onCreated={(created) => {
          setShowForm(false);
          useGitHubIssuesStore.getState().selectIssue(directory, repo, created);
        }}
      />
    );
  }

  if (selectedNumber !== null) {
    const detailResult = detailEntry?.data?.detail ?? null;
    return (
      <IssueDetail
        directory={directory}
        repo={repo}
        number={selectedNumber}
        github={github}
        seed={findIssueSeed(repo, selectedNumber)}
        issue={detailResult?.issue ?? null}
        linkedPullRequests={detailResult?.linkedPullRequests ?? []}
        linkedPullRequestsError={detailResult?.sectionErrors?.linkedPullRequests ?? null}
        capabilities={detailResult?.capabilities ?? null}
        viewerLogin={detailResult?.viewerLogin ?? null}
        viewerPermission={detailResult?.viewerPermission ?? null}
        detailError={detailEntry?.error ?? null}
        detailStale={detailEntry?.stale ?? false}
        detailLoading={detailEntry?.isLoading ?? false}
        comments={commentsEntry?.data?.comments ?? []}
        commentsHasMore={Boolean(commentsEntry?.data?.nextCursor)}
        commentsLoading={commentsEntry?.isLoading ?? false}
        onLoadMoreComments={handleLoadMoreComments}
        onBack={handleBack}
        onRetryDetail={handleRetryDetail}
        onRetryComments={handleRetryComments}
      />
    );
  }

  return (
    <IssuesList
      items={items}
      headerActionsSlot={headerActionsSlot}
      headerActionsPresentation={headerActionsPresentation}
      hasMore={relevantEntries.some((entry) => entry?.data?.nextCursor != null)}
      isLoadingMore={relevantEntries.some((entry) => entry?.isLoading)}
      isLoading={relevantEntries.some((entry) => entry?.isLoading)}
      isRefreshing={isRefreshing}
      stale={relevantStale}
      error={relevantError}
      filters={filters}
      countComplete={complete}
      incompleteNotice={incompleteSummary ? { summary: incompleteSummary, searching: remotePending, onSearchAll: handleSearchAll } : null}
      remote={remote}
      numberJump={numberJump}
      onFiltersChange={(patch) => useGitHubIssuesStore.getState().setFilters(directory, repo, patch)}
      onClearFilters={() => useGitHubIssuesStore.getState().resetFilters(directory, repo)}
      onLoadMore={() => {
        const targets: IssuesCollection[] = need === 'both' ? ['open', 'closed'] : [need];
        void Promise.all(
          targets.map((collection) => useGitHubIssuesStore.getState().loadMoreCollection(directory, repo, collection, github)),
        );
      }}
      onRetry={() => refreshAll()}
      onOpen={(issueNumber) => useGitHubIssuesStore.getState().selectIssue(directory, repo, issueNumber)}
      onNewIssue={() => setShowForm(true)}
    />
  );
};

export const IssuesSurface: React.FC<{
  /**
   * Host header slot for the action controls (Refresh + New issue)
   * (TerminalView `terminalHeaderSlot` precedent). Only used while the list
   * is shown; detail/form routes unmount the list so the portal unmounts too.
   */
  headerActionsSlot?: HTMLElement | null;
  /** Which header hosts the slot (`desktop` ContextPanel or `drawer` mobile/tablet). */
  headerActionsPresentation?: GitHubHeaderActionsPresentation;
}> = ({ headerActionsSlot = null, headerActionsPresentation = 'drawer' }) => {
  const { t } = useTranslation();
  const directory = useEffectiveDirectory() ?? '';
  const [refreshing, setRefreshing] = React.useState(false);
  const refreshRef = React.useRef<(() => void) | null>(null);
  const registerRefresh = React.useCallback((refresh: (() => void) | null) => {
    refreshRef.current = refresh;
  }, []);
  const handleRefreshChange = React.useCallback((value: boolean) => setRefreshing(value), []);

  if (!directory) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <p className="typography-ui text-muted-foreground">{t('Open a project to browse issues.')}</p>
      </div>
    );
  }
  return (
    <GitHubSurfaceShell
      directory={directory}
      isRefreshing={refreshing}
      onRefresh={() => refreshRef.current?.()}
    >
      {({ repo, directory: dir }) => (
        <IssuesBody directory={dir} repo={repo} isRefreshing={refreshing} registerRefresh={registerRefresh} onRefreshChange={handleRefreshChange} headerActionsSlot={headerActionsSlot} headerActionsPresentation={headerActionsPresentation} />
      )}
    </GitHubSurfaceShell>
  );
};
