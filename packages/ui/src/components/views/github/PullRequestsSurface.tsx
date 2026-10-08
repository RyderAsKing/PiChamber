import React from 'react';
import { useTranslation } from 'react-i18next';
import type { GitHubPullRequestSummary } from '@/lib/api/types';
import { GitHubSurfaceShell } from './GitHubSurfaceShell';
import { GitHubUnavailableState } from './GitHubUnavailableState';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useGitHubLogin } from '@/stores/useGitHubStatusStore';
import {
  findPullSeed,
  useGitHubPullRequestsStore,
  usePullChecksEntry,
  usePullCommentsEntry,
  usePullDetailEntry,
  usePullFilesEntry,
  usePullsCollectionEntry,
  usePullsFilters,
  usePullsRemoteEntry,
  usePullsSelection,
  getPullsLocalIndex,
  subscribeToAgentTurnCompletion,
  type PullsCollection,
  type PullsRemoteQuery,
} from '@/stores/useGitHubPullRequestsStore';
import { PullDetail } from './pulls/PullDetail';
import { PullsList, usePullsRowChecks } from './pulls/PullsList';
import { filterPullItems } from './githubListFiltering';
import { useGitHubRemoteSearch } from './useGitHubRemoteSearch';
import { normalizeDirectoryPathKey } from '@/lib/directoryPathKey';
import type { GitHubHeaderActionsPresentation } from './GitHubFiltersMenu';
/**
 * Pull requests rail surface (plan §6.3).
 * Singleton: remounts on switch and restores list filters, selection, and
 * scroll from `useGitHubPullRequestsStore`.
 */
export type PullRequestsSurfaceProps = {
  /**
   * Mobile v1 parity: the Capacitor drawer shows Overview and Checks only.
   * Files and inline review stay desktop/web surfaces (plan §6.7).
   */
  hideFilesTab?: boolean;
  /**
   * Host header slot for the action controls (Refresh; PRs have no primary
   * action). Only used while the list is shown; the detail route unmounts
   * the list so the portal unmounts too. Hosts gate the slot by visibility
   * (terminal `terminalHeaderSlot={isActive ? slot : null}` precedent).
   */
  headerActionsSlot?: HTMLElement | null;
  /** Which header hosts the slot (`desktop` ContextPanel or `drawer` mobile/tablet). */
  headerActionsPresentation?: GitHubHeaderActionsPresentation;
};

export const PullRequestsSurface: React.FC<PullRequestsSurfaceProps> = ({ hideFilesTab = false, headerActionsSlot = null, headerActionsPresentation = 'drawer' }) => {
  const { t } = useTranslation();
  const directory = useEffectiveDirectory() ?? '';
  if (!directory) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <p className="typography-ui text-muted-foreground">{t('Open a project to browse pull requests.')}</p>
      </div>
    );
  }
  return <PullRequestsSurfaceBody directory={directory} hideFilesTab={hideFilesTab} headerActionsSlot={headerActionsSlot} headerActionsPresentation={headerActionsPresentation} />;
};

const PullRequestsSurfaceBody: React.FC<{ directory: string; hideFilesTab: boolean; headerActionsSlot?: HTMLElement | null; headerActionsPresentation?: GitHubHeaderActionsPresentation }> = ({ directory, hideFilesTab, headerActionsSlot = null, headerActionsPresentation = 'drawer' }) => {
  const apis = useRuntimeAPIs();
  const github = apis.github ?? null;
  const [refreshing, setRefreshing] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  // The shell's refresh button forces a refetch through the mounted
  // content's handler (a remount alone would only revalidate when stale).
  const refreshRef = React.useRef<(() => void) | null>(null);

  // Agent turn completion invalidates pr-status + open detail (§7.2/§8).
  React.useEffect(() => subscribeToAgentTurnCompletion(), []);

  return (
    <GitHubSurfaceShell
      directory={directory}
      isRefreshing={refreshing}
      onRefresh={() => refreshRef.current?.()}
    >
      {({ repo, directory: scopeDirectory }) => (
        <PullsContent
          key={repo}
          directory={scopeDirectory}
          repo={repo}
          github={github}
          refreshing={refreshing}
          setRefreshing={setRefreshing}
          loadingMore={loadingMore}
          setLoadingMore={setLoadingMore}
          refreshRef={refreshRef}
          hideFilesTab={hideFilesTab}
          headerActionsSlot={headerActionsSlot}
          headerActionsPresentation={headerActionsPresentation}
        />
      )}
    </GitHubSurfaceShell>
  );
};

const PullsContent: React.FC<{
  directory: string;
  repo: string;
  github: ReturnType<typeof useRuntimeAPIs>['github'] | null;
  refreshing: boolean;
  setRefreshing: (value: boolean) => void;
  loadingMore: boolean;
  setLoadingMore: (value: boolean) => void;
  refreshRef: React.MutableRefObject<(() => void) | null>;
  hideFilesTab: boolean;
  headerActionsSlot?: HTMLElement | null;
  headerActionsPresentation?: GitHubHeaderActionsPresentation;
}> = ({ directory, repo, github, refreshing, setRefreshing, loadingMore, setLoadingMore, refreshRef, hideFilesTab, headerActionsSlot = null, headerActionsPresentation = 'drawer' }) => {
  const { t } = useTranslation();
  const ensureCollectionsFresh = useGitHubPullRequestsStore((state) => state.ensureCollectionsFresh);
  const searchRemote = useGitHubPullRequestsStore((state) => state.searchRemote);
  const loadMoreRemote = useGitHubPullRequestsStore((state) => state.loadMoreRemote);
  const loadMoreCollection = useGitHubPullRequestsStore((state) => state.loadMoreCollection);
  const refreshAllForScope = useGitHubPullRequestsStore((state) => state.refreshAllForScope);
  const selectPullRequest = useGitHubPullRequestsStore((state) => state.selectPullRequest);
  const setFilters = useGitHubPullRequestsStore((state) => state.setFilters);
  const resetFilters = useGitHubPullRequestsStore((state) => state.resetFilters);
  const filters = usePullsFilters(directory, repo);
  const selection = usePullsSelection(directory);
  const viewerLogin = useGitHubLogin();
  const selectedNumber = selection.repo === repo ? selection.number : null;

  // The state tab decides which collections the view needs: closed/merged
  // read the `closed` collection, `all` reads both, `open` reads open only.
  const need: PullsCollection | 'both' =
    filters.state === 'open' ? 'open' : filters.state === 'all' ? 'both' : 'closed';

  // Stale-while-revalidate on mount/scope/tab change: cached collections
  // show immediately, revalidation runs only past the fresh window. Search,
  // involvement, and sort changes never reach this effect — they are local.
  React.useEffect(() => {
    if (!github) return;
    let cancelled = false;
    setRefreshing(true);
    void ensureCollectionsFresh(directory, repo, need, github).then(() => {
      if (!cancelled) setRefreshing(false);
    }).catch(() => {
      if (!cancelled) setRefreshing(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directory, repo, github, need]);

  // Revalidate on window focus/visibility (no fixed list polling).
  React.useEffect(() => {
    if (!github) return;
    const onFocus = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void ensureCollectionsFresh(directory, repo, need, github).catch(() => {});
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directory, repo, github, need]);

  // Per-key subscriptions: this list re-renders only when its own repo's
  // collections change — never for another repo or PR detail activity.
  const openEntry = usePullsCollectionEntry(repo, 'open');
  const closedEntry = usePullsCollectionEntry(repo, 'closed');

  // Local index: both collections plus remote-search hits for this repo.
  const index = React.useMemo(
    () => getPullsLocalIndex(repo),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repo, openEntry?.data, closedEntry?.data],
  );
  const indexNumbers = React.useMemo(() => new Set(index.map((item) => item.number)), [index]);

  // Instant local view: state split, involvement, text, sort — no network.
  const items = React.useMemo(
    () => filterPullItems(index, {
      state: filters.state,
      involvement: filters.involvement,
      search: filters.search,
      sort: filters.sort,
      viewerLogin,
    }),
    [index, filters.state, filters.involvement, filters.search, filters.sort, viewerLogin],
  );
  const checksByUrl = usePullsRowChecks(items);

  const relevantEntries = need === 'both' ? [openEntry, closedEntry] : [need === 'open' ? openEntry : closedEntry];
  const hasRelevantData = relevantEntries.some((entry) => entry?.data != null);
  const complete = hasRelevantData && relevantEntries.every((entry) => entry?.data?.nextCursor == null);
  const loadedCount = relevantEntries.reduce((total, entry) => total + (entry?.data?.items.length ?? 0), 0);
  const relevantError = relevantEntries.find((entry) => entry?.error)?.error ?? null;
  const relevantLoading = relevantEntries.some((entry) => entry?.isLoading);
  const relevantStale = relevantEntries.some((entry) => entry?.stale);

  const trimmedSearch = filters.search.trim();
  const involvementNeedsRemote = filters.involvement !== 'all' && !viewerLogin;
  const filterActive = trimmedSearch.length > 0 || filters.involvement !== 'all';

  // Remote search for what the wide fetch never downloaded: auto-run after
  // ~400 ms idle when an active filter finds nothing locally in an
  // incomplete collection (or involvement cannot filter without a viewer).
  const remoteQuery: PullsRemoteQuery = React.useMemo(
    () => ({ state: filters.state, involvement: filters.involvement, q: trimmedSearch }),
    [filters.state, filters.involvement, trimmedSearch],
  );
  const remoteKeyString = `${remoteQuery.state}|${remoteQuery.involvement}|${remoteQuery.q}`;
  const autoRemote = !complete && hasRelevantData && items.length === 0
    && (trimmedSearch.length > 0 || involvementNeedsRemote);
  const runSearch = React.useCallback((searchQuery: PullsRemoteQuery) => {
    if (!github) return Promise.resolve(null);
    return searchRemote(directory, repo, searchQuery, github);
  }, [directory, repo, github, searchRemote]);
  const runLoadMore = React.useCallback((searchQuery: PullsRemoteQuery) => {
    if (!github) return Promise.resolve(null);
    return loadMoreRemote(directory, repo, searchQuery, github);
  }, [directory, repo, github, loadMoreRemote]);
  const { remoteView: remote, numberJump, remotePending, handleSearchAll } = useGitHubRemoteSearch({
    repo,
    query: remoteQuery,
    queryKey: remoteKeyString,
    autoRemote,
    indexNumbers,
    visibleItems: items,
    searchText: trimmedSearch,
    useRemoteEntry: usePullsRemoteEntry,
    runSearch,
    runLoadMore,
  });
  const incompleteSummary = React.useMemo(() => {
    if (complete || !hasRelevantData || !filterActive) return null;
    const match = items.length === 1 ? t('1 match') : t('{{count}} matches', { count: items.length });
    const loaded = loadedCount === 1 ? t('1 most recent loaded pull request') : t('{{count}} most recent loaded pull requests', { count: loadedCount });
    return t('Showing {{match}} from the {{loaded}}', { match, loaded });
  }, [complete, hasRelevantData, filterActive, items.length, loadedCount, t]);

  const handleRefresh = React.useCallback(() => {
    if (!github) return;
    setRefreshing(true);
    void refreshAllForScope(directory, repo, github).then(() => {
      setRefreshing(false);
    }).catch(() => setRefreshing(false));
  }, [directory, repo, github, refreshAllForScope, setRefreshing]);

  React.useEffect(() => {
    refreshRef.current = handleRefresh;
    return () => {
      if (refreshRef.current === handleRefresh) refreshRef.current = null;
    };
  }, [refreshRef, handleRefresh]);

  const handleLoadMore = React.useCallback(() => {
    if (!github) return;
    setLoadingMore(true);
    // Page every relevant collection that still has a cursor.
    const targets: PullsCollection[] = need === 'both' ? ['open', 'closed'] : [need];
    void Promise.all(targets.map((collection) => loadMoreCollection(directory, repo, collection, github)))
      .then(() => setLoadingMore(false))
      .catch(() => setLoadingMore(false));
  }, [directory, repo, need, github, loadMoreCollection, setLoadingMore]);

  const handleOpen = React.useCallback(
    (prNumber: number) => {
      selectPullRequest(directory, repo, prNumber);
    },
    [directory, repo, selectPullRequest],
  );

  const handleBack = React.useCallback(() => {
    selectPullRequest(directory, null, null);
  }, [directory, selectPullRequest]);

  if (!github) {
    return <GitHubUnavailableState info={{ reason: 'failed', message: 'GitHub is not available in this runtime.' }} />;
  }

  if (selectedNumber != null) {
    return (
      <PullDetailLoader
        directory={directory}
        repo={repo}
        number={selectedNumber}
        github={github}
        onBack={handleBack}
        hideFilesTab={hideFilesTab}
        seed={findPullSeed(repo, selectedNumber)}
      />
    );
  }

  // A failed read with data keeps the rows plus the stale banner, never an
  // empty list. Skeleton shows only on true first load (handled in the list
  // from empty rows + loading, with the toolbar staying mounted). This is
  // the list branch: the detail branch above unmounts the list, so the
  // header portal unmounts with it and the header never shows list filters
  // for a detail view.
  return (
    <PullsList
      items={items}
      headerActionsSlot={headerActionsSlot}
      headerActionsPresentation={headerActionsPresentation}
      hasMore={relevantEntries.some((entry) => entry?.data?.nextCursor != null)}
      isLoadingMore={loadingMore}
      isLoading={relevantLoading}
      isRefreshing={refreshing && hasRelevantData}
      stale={relevantStale}
      error={relevantError}
      filters={filters}
      checksByUrl={checksByUrl}
      countComplete={complete}
      incompleteNotice={incompleteSummary ? { summary: incompleteSummary, searching: remotePending, onSearchAll: handleSearchAll } : null}
      remote={remote}
      numberJump={numberJump}
      onFiltersChange={(patch) => setFilters(directory, repo, patch)}
      onClearFilters={() => resetFilters(directory, repo)}
      onLoadMore={handleLoadMore}
      onRetry={handleRefresh}
      onOpen={handleOpen}
    />
  );
};

const PullDetailLoader: React.FC<{
  directory: string;
  repo: string;
  number: number;
  github: NonNullable<ReturnType<typeof useRuntimeAPIs>['github']>;
  onBack: () => void;
  hideFilesTab: boolean;
  seed: GitHubPullRequestSummary | null;
}> = ({ directory, repo, number, github, onBack, hideFilesTab, seed }) => {
  const ensureDetail = useGitHubPullRequestsStore((state) => state.ensureDetail);
  const ensureComments = useGitHubPullRequestsStore((state) => state.ensureComments);
  const ensureFiles = useGitHubPullRequestsStore((state) => state.ensureFiles);
  const ensureChecks = useGitHubPullRequestsStore((state) => state.ensureChecks);
  const loadMoreFiles = useGitHubPullRequestsStore((state) => state.loadMoreFiles);
  const loadMoreComments = useGitHubPullRequestsStore((state) => state.loadMoreComments);
  const refreshComments = useGitHubPullRequestsStore((state) => state.refreshComments);
  const refreshDetail = useGitHubPullRequestsStore((state) => state.refreshDetail);
  const refreshChecks = useGitHubPullRequestsStore((state) => state.refreshChecks);

  React.useEffect(() => {
    void ensureDetail(directory, repo, number, github).catch(() => {});
    void ensureComments(directory, repo, number, github).catch(() => {});
    if (!hideFilesTab) {
      void ensureFiles(directory, repo, number, github).catch(() => {});
    }
    void ensureChecks(directory, repo, number, github).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directory, repo, number, hideFilesTab]);

  // Per-key subscriptions: this detail re-renders only when its own PR's
  // entries settle — never for other PRs or list activity.
  const detailEntry = usePullDetailEntry(repo, number);
  const commentsEntry = usePullCommentsEntry(repo, number);
  const filesEntry = usePullFilesEntry(repo, number);
  const checksEntry = usePullChecksEntry(repo, number);

  const detail = detailEntry?.data?.detail ?? null;
  // Top-level (conversation) comments read through the issues comments API
  // for the PR number (GET /pulls/:number/comments), paginated oldest-first.
  const openFilesAtLine = React.useCallback(
    (path: string, line: number) => {
      const dirKey = normalizeDirectoryPathKey(directory);
      // Annotation file:line links open in the Files surface via the existing
      // openContext* actions; full PR Files tab stays mounted (no navigation
      // away from the PR).
      void import('@/stores/useUIStore').then(({ useUIStore }) => {
        useUIStore.getState().openContextFileAtLine(dirKey, path, line);
      }).catch(() => {});
    },
    [directory],
  );

  // Stable callbacks: `FileCard` is memoized, so inline arrows here would
  // re-render every diff card on each loader render.
  const handleLoadMoreFiles = React.useCallback(() => {
    void loadMoreFiles(directory, repo, number, github).catch(() => {});
  }, [directory, repo, number, github, loadMoreFiles]);
  const handleLoadMoreComments = React.useCallback(() => {
    void loadMoreComments(directory, repo, number, github).catch(() => {});
  }, [directory, repo, number, github, loadMoreComments]);
  const handleRetryComments = React.useCallback(() => {
    void refreshComments(directory, repo, number, github).catch(() => {});
  }, [directory, repo, number, github, refreshComments]);
  const handleRetryDetail = React.useCallback(() => {
    void refreshDetail(directory, repo, number, github).catch(() => {});
  }, [directory, repo, number, github, refreshDetail]);
  const handleRetryFiles = React.useCallback(() => {
    void ensureFiles(directory, repo, number, github).catch(() => {});
  }, [directory, repo, number, github, ensureFiles]);
  const handleRetryChecks = React.useCallback(() => {
    void refreshChecks(directory, repo, number, github).catch(() => {});
  }, [directory, repo, number, github, refreshChecks]);

  return (
    <PullDetail
      hideFilesTab={hideFilesTab}
      seed={seed}
      directory={directory}
      repo={repo}
      number={number}
      github={github}
      detail={detail}
      detailError={detailEntry?.error ?? null}
      detailStale={detailEntry?.stale ?? false}
      files={filesEntry?.data ?? null}
      filesError={filesEntry?.error ?? null}
      filesLoading={filesEntry?.isLoading ?? false}
      filesHasMore={filesEntry?.data?.nextCursor != null}
      onLoadMoreFiles={handleLoadMoreFiles}
      checks={checksEntry?.data ?? null}
      checksError={checksEntry?.error ?? null}
      checksLoading={checksEntry?.isLoading ?? false}
      reviews={detail?.reviews ?? []}
      threads={detail?.threads ?? []}
      comments={commentsEntry?.data?.comments ?? []}
      commentsError={commentsEntry?.error ?? null}
      commentsLoading={commentsEntry?.isLoading ?? false}
      commentsHasMore={commentsEntry?.data?.nextCursor != null}
      onLoadMoreComments={handleLoadMoreComments}
      onRetryComments={handleRetryComments}
      onBack={onBack}
      onRetryDetail={handleRetryDetail}
      onRetryFiles={handleRetryFiles}
      onRetryChecks={handleRetryChecks}
      onOpenFilesAtLine={openFilesAtLine}
    />
  );
};
