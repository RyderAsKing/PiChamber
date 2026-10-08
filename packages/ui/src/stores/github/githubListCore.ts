import type {
  GitHubAPI,
  GitHubErrorBody,
  GitHubIssueComment,
} from '@/lib/api/types';
import { GitHubAPIError } from '@/lib/api/types';
import { normalizeDirectoryPathKey } from '@/lib/directoryPathKey';
import {
  createKeyedAsyncResource,
  type GitHubResourceEntry,
  type KeyedAsyncResource,
} from './githubAsyncResource';
import { mergeCommentsById, mergeItemsByNumber } from '@/components/views/github/githubListFiltering';
import i18n from '@/i18n';

/**
 * Shared machinery for the GitHub entity list stores (pull requests, issues).
 *
 * Both stores keep two wide per-repo collections (`open` + `closed`,
 * `perPage: 100`) with pure local views over them, a per-query remote-search
 * cache (`perPage: 50`) merged into a repo index, and keyed detail/comment
 * entries — all stale-while-revalidate with a 30 s fresh window. This module
 * owns that duplicated machinery; per-entity stores keep only their
 * loaders, key builders, and entity-only actions.
 *
 * Render contract: entries live outside React state. Every settled load
 * notifies that key's subscribers (see `useKeyedResourceEntry`), so a load
 * settling for PR A never re-renders PR B or another repo's list.
 */

export type GitHubCollectionPage<TItem> = {
  items: TItem[];
  nextCursor: string | null;
  fetchedAt: number;
};

export type GitHubThreadPage = {
  comments: GitHubIssueComment[];
  nextCursor: string | null;
  fetchedAt: number;
};

export type GitHubEntitySelection = {
  repo: string | null;
  number: number | null;
};

export type ListCoreSlice<TFilters> = {
  filtersByScope: Record<string, TFilters>;
  selectionByDirectory: Record<string, GitHubEntitySelection>;
};

/** Stable fallback: a fresh object per selector call loops zustand snapshots. */
export const EMPTY_GITHUB_SELECTION: GitHubEntitySelection = Object.freeze({ repo: null, number: null });

/** Repo segment of a runtime-scoped key (`runtime\nrepo\n...`). */
const repoOfKey = (key: string): string => key.split('\n')[1] ?? '';

export const scopeKeyFor = (directory: string, repo: string): string =>
  `${normalizeDirectoryPathKey(directory)}\n${repo}`;

export const detailScopeKey = (repo: string, number: number): string => `${repo}#${number}`;

const toStoreError = (error: unknown, fallback: string): GitHubErrorBody => {
  const body = (error as GitHubAPIError | null)?.body;
  if (body && typeof body.kind === 'string') return body as GitHubErrorBody;
  return { kind: 'failed', message: error instanceof Error ? error.message : fallback };
};

export const serverInvalidate = async (
  github: GitHubAPI | null,
  input: { directory?: string; repo?: string; kind?: 'pulls' | 'issues' | 'checks' | 'repo' | 'all'; number?: number },
): Promise<void> => {
  if (!github) return;
  try {
    await github.invalidate(input);
  } catch {
    // Server invalidation is best-effort; the re-read still refreshes
    // through the server cache TTL.
  }
};

const isFreshEntry = <TData>(
  entry: GitHubResourceEntry<TData> | null,
  windowMs: number,
): boolean => {
  if (!entry?.data || !entry.fetchedAt) return false;
  return Date.now() - entry.fetchedAt < windowMs;
};

/** Remote-search query entries kept per repo; older queries evict first. */
const MAX_REMOTE_QUERIES_PER_REPO = 10;

export type ListCoreConfig<TItem extends { number: number }, TCollection extends string, TRemoteQuery, TFilters, TDetail> = {
  openCollection: TCollection;
  closedCollection: TCollection;
  defaultFilters: TFilters;
  freshWindowMs: number;
  serverKind: 'pulls' | 'issues';
  errorFallback: string;
  collectionKeyFor: (repo: string, collection: TCollection) => string;
  remoteKeyFor: (repo: string, query: TRemoteQuery) => string;
  detailKeyFor: (repo: string, number: number) => string;
  commentsKeyFor: (repo: string, number: number) => string;
  buildCollectionQuery: (collection: TCollection) => { cursor?: string | null; [key: string]: unknown };
  buildRemoteQuery: (query: TRemoteQuery, cursor?: string | null) => { [key: string]: unknown };
  fetchList: (github: GitHubAPI, directory: string, repo: string, query: Record<string, unknown>) => Promise<GitHubCollectionPage<TItem>>;
  fetchDetail: (github: GitHubAPI, directory: string, repo: string, number: number) => Promise<TDetail>;
  fetchComments: (github: GitHubAPI, directory: string, repo: string, number: number, cursor?: string | null) => Promise<GitHubThreadPage>;
};

export type ListCoreDeps<TFilters> = {
  set: {
    (partial: Partial<ListCoreSlice<TFilters>>): void;
    (updater: (state: ListCoreSlice<TFilters>) => Partial<ListCoreSlice<TFilters>>): void;
  };
  get: () => ListCoreSlice<TFilters>;
};

export const createGitHubListCore = <
  TItem extends { number: number },
  TCollection extends string,
  TRemoteQuery,
  TFilters,
  TDetail,
>(
  config: ListCoreConfig<TItem, TCollection, TRemoteQuery, TFilters, TDetail>,
  deps: ListCoreDeps<TFilters>,
) => {
  const collections: KeyedAsyncResource<GitHubCollectionPage<TItem>> =
    createKeyedAsyncResource<GitHubCollectionPage<TItem>>();
  const remote: KeyedAsyncResource<GitHubCollectionPage<TItem>> =
    createKeyedAsyncResource<GitHubCollectionPage<TItem>>({ maxEntries: 60 });
  const details: KeyedAsyncResource<{ detail: TDetail }> =
    createKeyedAsyncResource<{ detail: TDetail }>();
  const comments: KeyedAsyncResource<GitHubThreadPage> =
    createKeyedAsyncResource<GitHubThreadPage>();

  // Local repo index of items fetched through remote search (never
  // downloaded via the wide collections). Keyed by the runtime-scoped
  // collection key's repo segment so runtime switches cannot leak entries.
  const remoteIndexByRepoKey = new Map<string, Map<number, TItem>>();

  // Single-flight guards for page appends, keyed `${entryKey}:more`.
  const inFlightActions = new Map<string, Promise<unknown>>();

  const withSingleFlight = async <T>(
    actionKey: string,
    task: () => Promise<T>,
  ): Promise<{ ran: boolean; result: T | null }> => {
    const existing = inFlightActions.get(actionKey);
    if (existing) {
      await existing.catch(() => null);
      return { ran: false, result: null };
    }
    const current = task();
    inFlightActions.set(actionKey, current);
    try {
      return { ran: true, result: await current };
    } finally {
      if (inFlightActions.get(actionKey) === current) inFlightActions.delete(actionKey);
    }
  };

  const mergeRemoteIntoIndex = (repo: string, items: TItem[]) => {
    if (items.length === 0) return;
    const repoKey = config.collectionKeyFor(repo, config.openCollection);
    let index = remoteIndexByRepoKey.get(repoKey);
    if (!index) {
      index = new Map();
      remoteIndexByRepoKey.set(repoKey, index);
    }
    for (const item of items) index.set(item.number, item);
  };

  const capRemoteQueriesForRepo = (repo: string) => {
    const keys = Object.keys(remote.snapshot()).filter(
      (key) => repoOfKey(key) === repo && !remote.getEntry(key)?.isLoading,
    );
    if (keys.length <= MAX_REMOTE_QUERIES_PER_REPO) return;
    const byAge = keys
      .map((key) => ({ key, fetchedAt: remote.getEntry(key)?.data?.fetchedAt ?? 0 }))
      .sort((a, b) => a.fetchedAt - b.fetchedAt);
    for (let index = 0; index < byAge.length - MAX_REMOTE_QUERIES_PER_REPO; index += 1) {
      remote.remove((byAge[index] as { key: string }).key);
    }
  };

  const getLocalIndex = (repo: string): TItem[] => {
    const open = collections.getEntry(config.collectionKeyFor(repo, config.openCollection))?.data?.items ?? [];
    const closed = collections.getEntry(config.collectionKeyFor(repo, config.closedCollection))?.data?.items ?? [];
    const combined = mergeItemsByNumber(open, closed);
    const index = remoteIndexByRepoKey.get(config.collectionKeyFor(repo, config.openCollection));
    if (!index || index.size === 0) return combined;
    return mergeItemsByNumber(combined, [...index.values()]);
  };

  const setFilters = (directory: string, repo: string, patch: Partial<TFilters>) => {
    const key = scopeKeyFor(directory, repo);
    const prev = deps.get().filtersByScope[key] ?? config.defaultFilters;
    deps.set((state) => ({
      filtersByScope: { ...state.filtersByScope, [key]: { ...prev, ...patch } },
    }));
  };

  const resetFilters = (directory: string, repo: string) => {
    const key = scopeKeyFor(directory, repo);
    deps.set((state) => ({
      filtersByScope: { ...state.filtersByScope, [key]: { ...config.defaultFilters } },
    }));
  };

  const select = (directory: string, repo: string | null, number: number | null) => {
    const dirKey = normalizeDirectoryPathKey(directory);
    if (!dirKey) return;
    deps.set((state) => ({
      selectionByDirectory: { ...state.selectionByDirectory, [dirKey]: { repo, number } },
    }));
  };

  const ensureCollection = (
    directory: string,
    repo: string,
    collection: TCollection,
    github: GitHubAPI,
  ): Promise<GitHubResourceEntry<GitHubCollectionPage<TItem>>> => {
    const key = config.collectionKeyFor(repo, collection);
    return collections.ensure(key, async () => {
      const first = await config.fetchList(github, directory, repo, config.buildCollectionQuery(collection));
      return { items: first.items, nextCursor: first.nextCursor, fetchedAt: first.fetchedAt };
    });
  };

  const prefetchClosedCollection = (directory: string, repo: string, github: GitHubAPI): void => {
    const key = config.collectionKeyFor(repo, config.closedCollection);
    if (collections.getEntry(key)?.data || collections.getEntry(key)?.isLoading) return;
    void ensureCollection(directory, repo, config.closedCollection, github).catch(() => null);
  };

  const ensureCollectionsFresh = async (
    directory: string,
    repo: string,
    need: TCollection | 'both',
    github: GitHubAPI,
  ): Promise<void> => {
    const wantsOpen = need === 'open' || need === 'both';
    const wantsClosed = need === 'closed' || need === 'both';
    const jobs: Array<Promise<unknown>> = [];
    // Stale-while-revalidate: cached reads inside the fresh window show
    // immediately with no network; stale, marked, or missing collections
    // re-read last-known-first through the resource.
    const openEntry = collections.getEntry(config.collectionKeyFor(repo, config.openCollection));
    const closedEntry = collections.getEntry(config.collectionKeyFor(repo, config.closedCollection));
    if (wantsOpen && (!isFreshEntry(openEntry, config.freshWindowMs) || openEntry?.stale)) {
      jobs.push(ensureCollection(directory, repo, config.openCollection, github));
    }
    if (wantsClosed && (!isFreshEntry(closedEntry, config.freshWindowMs) || closedEntry?.stale)) {
      jobs.push(ensureCollection(directory, repo, config.closedCollection, github));
    }
    await Promise.all(jobs.map((job) => job.catch(() => null)));
    // Open lands first; the closed collection prefetches in the background
    // so other state tabs switch instantly. Prefetch failures stay silent —
    // the open view must not show errors for a collection it does not need.
    if (wantsOpen && !collections.getEntry(config.collectionKeyFor(repo, config.closedCollection))?.data) {
      prefetchClosedCollection(directory, repo, github);
    }
  };

  const loadMoreCollection = async (
    directory: string,
    repo: string,
    collection: TCollection,
    github: GitHubAPI,
  ): Promise<GitHubResourceEntry<GitHubCollectionPage<TItem>> | null> => {
    const key = config.collectionKeyFor(repo, collection);
    const entry = collections.getEntry(key);
    const cursor = entry?.data?.nextCursor ?? null;
    if (!cursor || entry?.isLoading) return entry;
    try {
      const outcome = await withSingleFlight(`${key}:more`, async () => {
        const page = await config.fetchList(github, directory, repo, { ...config.buildCollectionQuery(collection), cursor });
        const current = collections.getEntry(key)?.data;
        const merged: GitHubCollectionPage<TItem> = {
          items: mergeItemsByNumber(current?.items ?? [], page.items),
          nextCursor: page.nextCursor,
          fetchedAt: page.fetchedAt,
        };
        return collections.refresh(key, async () => merged);
      });
      if (!outcome.ran) return collections.getEntry(key);
      return outcome.result ?? collections.getEntry(key);
    } catch (error) {
      // A failed page keeps the loaded pages with the cursor intact for
      // retry, and records the error inline so the UI can offer a retry.
      return collections.setError(key, error) ?? collections.getEntry(key);
    }
  };

  const refreshCollections = async (
    directory: string,
    repo: string,
    need: TCollection | 'both',
    github: GitHubAPI,
  ): Promise<void> => {
    const targets: TCollection[] = need === 'both'
      ? [config.openCollection, config.closedCollection]
      : [need as TCollection];
    await Promise.all(
      targets.map((collection) => {
        const key = config.collectionKeyFor(repo, collection);
        return collections
          .refresh(key, async () => {
            const first = await config.fetchList(github, directory, repo, config.buildCollectionQuery(collection));
            return { items: first.items, nextCursor: first.nextCursor, fetchedAt: first.fetchedAt };
          })
          .catch(() => null);
      }),
    );
  };

  const searchRemote = async (
    directory: string,
    repo: string,
    query: TRemoteQuery,
    github: GitHubAPI,
  ): Promise<GitHubResourceEntry<GitHubCollectionPage<TItem>>> => {
    const key = config.remoteKeyFor(repo, query);
    // Distinct queries own distinct entries, so a slow response for an older
    // query can never overwrite the latest one; per-key in-flight coalescing
    // keeps a single request per query.
    const result = await remote.refresh(key, async () => {
      const page = await config.fetchList(github, directory, repo, config.buildRemoteQuery(query));
      return { items: page.items, nextCursor: page.nextCursor, fetchedAt: page.fetchedAt };
    });
    // Merge remote hits into the repo index so selecting and subsequent
    // local search find items the wide collections never downloaded. A
    // failed search keeps its error inline; local rows are untouched.
    if (result.data) {
      mergeRemoteIntoIndex(repo, result.data.items);
      capRemoteQueriesForRepo(repo);
    }
    return result;
  };

  const loadMoreRemote = async (
    directory: string,
    repo: string,
    query: TRemoteQuery,
    github: GitHubAPI,
  ): Promise<GitHubResourceEntry<GitHubCollectionPage<TItem>> | null> => {
    const key = config.remoteKeyFor(repo, query);
    const entry = remote.getEntry(key);
    const cursor = entry?.data?.nextCursor ?? null;
    if (!cursor || entry?.isLoading) return entry;
    try {
      const page = await config.fetchList(github, directory, repo, config.buildRemoteQuery(query, cursor));
      const current = remote.getEntry(key)?.data;
      const merged: GitHubCollectionPage<TItem> = {
        items: mergeItemsByNumber(current?.items ?? [], page.items),
        nextCursor: page.nextCursor,
        fetchedAt: page.fetchedAt,
      };
      const result = await remote.refresh(key, async () => merged);
      if (result.data) {
        mergeRemoteIntoIndex(repo, result.data.items);
        capRemoteQueriesForRepo(repo);
      }
      return result;
    } catch (error) {
      return remote.setError(key, error) ?? remote.getEntry(key);
    }
  };

  const dropRemoteForRepo = (repo: string): void => {
    for (const key of Object.keys(remote.snapshot())) {
      if (repoOfKey(key) === repo) remote.remove(key);
    }
    for (const indexKey of [...remoteIndexByRepoKey.keys()]) {
      if (repoOfKey(indexKey) === repo) remoteIndexByRepoKey.delete(indexKey);
    }
  };

  const refreshDetail = (
    directory: string,
    repo: string,
    number: number,
    github: GitHubAPI,
  ): Promise<GitHubResourceEntry<{ detail: TDetail }>> => {
    const key = config.detailKeyFor(repo, number);
    return details.refresh(key, async () => {
      const detail = await config.fetchDetail(github, directory, repo, number);
      return { detail };
    });
  };

  const ensureDetail = (
    directory: string,
    repo: string,
    number: number,
    github: GitHubAPI,
  ): Promise<GitHubResourceEntry<{ detail: TDetail }>> => {
    const key = config.detailKeyFor(repo, number);
    return details.ensure(key, async () => {
      const detail = await config.fetchDetail(github, directory, repo, number);
      return { detail };
    });
  };

  const ensureComments = (
    directory: string,
    repo: string,
    number: number,
    github: GitHubAPI,
  ): Promise<GitHubResourceEntry<GitHubThreadPage>> => {
    const key = config.commentsKeyFor(repo, number);
    return comments.ensure(key, async () => {
      const page = await config.fetchComments(github, directory, repo, number);
      return { comments: page.comments, nextCursor: page.nextCursor, fetchedAt: page.fetchedAt };
    });
  };

  const loadMoreComments = async (
    directory: string,
    repo: string,
    number: number,
    github: GitHubAPI,
  ): Promise<GitHubResourceEntry<GitHubThreadPage> | null> => {
    const key = config.commentsKeyFor(repo, number);
    const entry = comments.getEntry(key);
    const cursor = entry?.data?.nextCursor ?? null;
    if (!cursor || entry?.isLoading) return entry;
    try {
      const page = await config.fetchComments(github, directory, repo, number, cursor);
      const current = comments.getEntry(key)?.data;
      const merged: GitHubThreadPage = {
        // Cursor pages can overlap when new comments land mid-paging;
        // dedupe by id so a comment never renders twice in either order.
        comments: mergeCommentsById(current?.comments ?? [], page.comments),
        nextCursor: page.nextCursor,
        fetchedAt: page.fetchedAt,
      };
      return await comments.refresh(key, async () => merged);
    } catch (error) {
      // A failed page keeps the loaded comments with the cursor intact, and
      // records the error inline so the UI can offer a retry.
      return comments.setError(key, error) ?? comments.getEntry(key);
    }
  };

  const refreshComments = (
    directory: string,
    repo: string,
    number: number,
    github: GitHubAPI,
  ): Promise<GitHubResourceEntry<GitHubThreadPage>> => {
    const key = config.commentsKeyFor(repo, number);
    return comments.refresh(key, async () => {
      const page = await config.fetchComments(github, directory, repo, number);
      return { comments: page.comments, nextCursor: page.nextCursor, fetchedAt: page.fetchedAt };
    });
  };

  const refreshAllForScope = async (directory: string, repo: string, github: GitHubAPI): Promise<void> => {
    await serverInvalidate(github, { directory, repo, kind: config.serverKind });
    dropRemoteForRepo(repo);
    await refreshCollections(directory, repo, 'both', github).catch(() => null);
    const selection = deps.get().selectionByDirectory[normalizeDirectoryPathKey(directory)];
    if (selection?.repo === repo && typeof selection.number === 'number') {
      await refreshDetail(directory, repo, selection.number, github).catch(() => null);
    }
  };

  /** Mark the repo's collections stale so the next visible view revalidates (no fetch now). */
  const markCollectionsStale = (repo: string): void => {
    collections.markStale(config.collectionKeyFor(repo, config.openCollection));
    collections.markStale(config.collectionKeyFor(repo, config.closedCollection));
  };

  const resetCore = (): void => {
    collections.reset();
    remote.reset();
    remoteIndexByRepoKey.clear();
    details.reset();
    comments.reset();
    inFlightActions.clear();
    deps.set({ filtersByScope: {}, selectionByDirectory: {} });
  };

  return {
    initialState: {
      filtersByScope: {},
      selectionByDirectory: {},
    } as ListCoreSlice<TFilters>,
    resources: { collections, remote, details, comments },
    setFilters,
    resetFilters,
    select,
    ensureCollection,
    ensureCollectionsFresh,
    prefetchClosedCollection,
    loadMoreCollection,
    refreshCollections,
    searchRemote,
    loadMoreRemote,
    dropRemoteForRepo,
    refreshAllForScope,
    ensureDetail,
    refreshDetail,
    ensureComments,
    loadMoreComments,
    refreshComments,
    markCollectionsStale,
    getLocalIndex,
    withSingleFlight,
    resetCore,
    toStoreError: (error: unknown) => toStoreError(error, i18n.t(config.errorFallback)),
  };
};

