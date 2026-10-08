import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type {
  GitHubAPI,
  GitHubChecksResult,
  GitHubErrorBody,
  GitHubIssueComment,
  GitHubPullRequestAction,
  GitHubPullRequestDetail,
  GitHubPullRequestDetailResult,
  GitHubPullRequestFilesResult,
  GitHubPullRequestSummary,
  GitHubPullsQuery,
  GitHubReviewInlineComment,
} from '@/lib/api/types';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { normalizeDirectoryPathKey } from '@/lib/directoryPathKey';
import i18n from '@/i18n';
import {
  buildGitHubResourceKey,
  createKeyedAsyncResource,
  useKeyedResourceEntry,
  type GitHubResourceEntry,
  type KeyedAsyncResource,
} from './github/githubAsyncResource';
import {
  createGitHubListCore,
  detailScopeKey,
  EMPTY_GITHUB_SELECTION,
  scopeKeyFor,
  serverInvalidate,
  type GitHubCollectionPage,
  type GitHubThreadPage,
  type ListCoreDeps,
  type ListCoreSlice,
} from './github/githubListCore';
import { useGitHubPrStatusStore } from './useGitHubPrStatusStore';

/**
 * Pull-request list/detail/files/checks store (plan §7.1).
 *
 * Lists are two wide per-repo collections — `open` and `closed` (the closed
 * collection holds merged + closed, split locally by `mergedAt`) — fetched
 * with `perPage: 100`. Cache keys are runtime + repo + collection only:
 * state tabs, involvement, text search, labels, and sort are pure local
 * views over the collections, so typing and tab switches never fetch.
 *
 * Loading contract: stale-while-revalidate with a 30 s fresh window. Mounts
 * show cached collections immediately and revalidate in the background only
 * when stale; the manual refresh button forces. Failure keeps previous data
 * marked stale, never empty. Cursor pagination appends per collection with
 * `complete` tracked via `nextCursor === null`.
 *
 * Items the wide fetch has not downloaded yet are covered by a per-query
 * remote search cache (`state + involvement + q`, perPage 50, last 10
 * queries per repo) whose results also merge into the local repo index, so
 * selecting and re-searching work.
 * - Detail/comments/files/checks keyed `runtime + repo + number`.
 * - Components subscribe per resource key (`usePullsCollectionEntry` etc.),
 *   so a load settling for one PR never re-renders another PR or repo list.
 * - Optimistic updates only for the viewer's own actions (title/body edits,
 *   state actions, comments) with rollback on failure; post-action invalidate
 *   (server `POST /api/github/invalidate`) then re-read.
 * - No fixed list polling: refresh on surface open / focus / repo change /
 *   explicit refresh. Current-branch status polling stays in
 *   `useGitHubPrStatusStore`.
 * - Agent turn completion: `subscribeToAgentTurnCompletion` observes the sync
 *   layer's turn-complete notifications (`useNotificationStore`, fed only by
 *   live `PiSessionStore` terminal lifecycle events) and invalidates the
 *   affected directory's pr-status plus the open PR detail, marking the
 *   repo's collections stale so the next visible list revalidates.
 */

export type PullsStateFilter = 'open' | 'closed' | 'merged' | 'all';
export type PullsInvolvementFilter = 'all' | 'mine' | 'review' | 'assigned';
export type PullsSort = 'updated' | 'newest' | 'oldest';

export type PullsFilters = {
  state: PullsStateFilter;
  involvement: PullsInvolvementFilter;
  search: string;
  sort: PullsSort;
};

export const DEFAULT_PULLS_FILTERS: PullsFilters = {
  state: 'open',
  involvement: 'all',
  search: '',
  sort: 'updated',
};

/** Wide per-repo collections. `closed` holds merged + closed (split locally). */
export type PullsCollection = 'open' | 'closed';

/** Background revalidation only runs when the cached read is older than this. */
export const PULLS_FRESH_WINDOW_MS = 30_000;

const PULLS_COLLECTION_PAGE_SIZE = 100;
const PULLS_REMOTE_PAGE_SIZE = 50;

export type PullsCollectionData = GitHubCollectionPage<GitHubPullRequestSummary>;

export type PullsRemoteQuery = {
  state: PullsStateFilter;
  involvement: PullsInvolvementFilter;
  q: string;
};

export type PullsRemoteData = GitHubCollectionPage<GitHubPullRequestSummary>;

export type PullsDetailData = {
  detail: GitHubPullRequestDetailResult;
};

export type PullCommentsData = GitHubThreadPage;

export type PullsSelection = {
  repo: string | null;
  number: number | null;
};

export const pullsCollectionKeyFor = (repo: string, collection: PullsCollection): string =>
  buildGitHubResourceKey([repo, 'pulls-collection', collection]);

export const pullsRemoteKeyFor = (repo: string, query: PullsRemoteQuery): string =>
  buildGitHubResourceKey([repo, 'pulls-remote', query.state, query.involvement, query.q.trim()]);

export const pullDetailKeyFor = (repo: string, number: number): string =>
  buildGitHubResourceKey([repo, 'pull-detail', number]);

export const pullCommentsKeyFor = (repo: string, number: number): string =>
  buildGitHubResourceKey([repo, 'pull-comments', number]);

export const pullFilesKeyFor = (repo: string, number: number): string =>
  buildGitHubResourceKey([repo, 'pull-files', number]);

export const pullChecksKeyFor = (repo: string, number: number): string =>
  buildGitHubResourceKey([repo, 'pull-checks', number]);

const collectionQuery = (collection: PullsCollection): GitHubPullsQuery => ({
  state: collection,
  perPage: PULLS_COLLECTION_PAGE_SIZE,
});

const remoteQueryFor = (query: PullsRemoteQuery, cursor?: string | null): GitHubPullsQuery => ({
  state: query.state,
  filter: query.involvement,
  q: query.q.trim() ? query.q.trim() : undefined,
  perPage: PULLS_REMOTE_PAGE_SIZE,
  ...(cursor ? { cursor } : {}),
});

const mergeMethodStorageKey = (repo: string): string =>
  `pichamber:pr-merge-method:${repo}`;

// localStorage is unavailable in unit tests / SSR; keep an in-memory mirror so
// merge-method memory still survives remounts there.
const memoryMergeMethods = new Map<string, PullMergeMethod>();

const storageGet = (key: string): string | null => {
  try {
    if (typeof localStorage !== 'undefined') return localStorage.getItem(key);
  } catch {
    // fall through to memory
  }
  return null;
};

const storageSet = (key: string, value: string): void => {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
      return;
    }
  } catch {
    // fall through to memory
  }
};

export type PullMergeMethod = 'merge' | 'squash' | 'rebase';

export const readMergeMethod = (repo: string): PullMergeMethod | null => {
  if (!repo) return null;
  const raw = storageGet(mergeMethodStorageKey(repo));
  if (raw === 'merge' || raw === 'squash' || raw === 'rebase') return raw;
  return memoryMergeMethods.get(mergeMethodStorageKey(repo)) ?? null;
};

const writeMergeMethod = (repo: string, method: PullMergeMethod): void => {
  if (!repo) return;
  memoryMergeMethods.set(mergeMethodStorageKey(repo), method);
  try {
    storageSet(mergeMethodStorageKey(repo), method);
  } catch {
    // ignore
  }
};

type PullsStoreState = {
  filtersByScope: Record<string, PullsFilters>;
  selectionByDirectory: Record<string, PullsSelection>;
  actionErrorByDetail: Record<string, GitHubErrorBody | null>;
  actingActions: Record<string, boolean>;
  setFilters: (directory: string, repo: string, patch: Partial<PullsFilters>) => void;
  resetFilters: (directory: string, repo: string) => void;
  selectPullRequest: (directory: string, repo: string | null, number: number | null) => void;
  ensureCollection: (directory: string, repo: string, collection: PullsCollection, github: GitHubAPI) => Promise<GitHubResourceEntry<PullsCollectionData>>;
  ensureCollectionsFresh: (directory: string, repo: string, need: PullsCollection | 'both', github: GitHubAPI) => Promise<void>;
  prefetchClosedCollection: (directory: string, repo: string, github: GitHubAPI) => void;
  loadMoreCollection: (directory: string, repo: string, collection: PullsCollection, github: GitHubAPI) => Promise<GitHubResourceEntry<PullsCollectionData> | null>;
  refreshCollections: (directory: string, repo: string, need: PullsCollection | 'both', github: GitHubAPI) => Promise<void>;
  searchRemote: (directory: string, repo: string, query: PullsRemoteQuery, github: GitHubAPI) => Promise<GitHubResourceEntry<PullsRemoteData>>;
  loadMoreRemote: (directory: string, repo: string, query: PullsRemoteQuery, github: GitHubAPI) => Promise<GitHubResourceEntry<PullsRemoteData> | null>;
  dropRemoteForRepo: (repo: string) => void;
  refreshAllForScope: (directory: string, repo: string, github: GitHubAPI) => Promise<void>;
  ensureDetail: (directory: string, repo: string, number: number, github: GitHubAPI) => Promise<GitHubResourceEntry<PullsDetailData>>;
  refreshDetail: (directory: string, repo: string, number: number, github: GitHubAPI) => Promise<GitHubResourceEntry<PullsDetailData>>;
  ensureComments: (directory: string, repo: string, number: number, github: GitHubAPI) => Promise<GitHubResourceEntry<PullCommentsData>>;
  loadMoreComments: (directory: string, repo: string, number: number, github: GitHubAPI) => Promise<GitHubResourceEntry<PullCommentsData> | null>;
  refreshComments: (directory: string, repo: string, number: number, github: GitHubAPI) => Promise<GitHubResourceEntry<PullCommentsData>>;
  ensureFiles: (directory: string, repo: string, number: number, github: GitHubAPI) => Promise<GitHubResourceEntry<GitHubPullRequestFilesResult>>;
  loadMoreFiles: (directory: string, repo: string, number: number, github: GitHubAPI) => Promise<GitHubResourceEntry<GitHubPullRequestFilesResult> | null>;
  ensureChecks: (directory: string, repo: string, number: number, github: GitHubAPI) => Promise<GitHubResourceEntry<GitHubChecksResult>>;
  refreshChecks: (directory: string, repo: string, number: number, github: GitHubAPI) => Promise<GitHubResourceEntry<GitHubChecksResult>>;
  performAction: (
    directory: string,
    repo: string,
    number: number,
    action: GitHubPullRequestAction,
    github: GitHubAPI,
  ) => Promise<{ ok: boolean; error?: GitHubErrorBody }>;
  updateTitleBody: (
    directory: string,
    repo: string,
    number: number,
    patch: { title?: string; body?: string },
    github: GitHubAPI,
  ) => Promise<{ ok: boolean; error?: GitHubErrorBody }>;
  addComment: (directory: string, repo: string, number: number, body: string, github: GitHubAPI) => Promise<{ ok: boolean; error?: GitHubErrorBody }>;
  submitReview: (
    directory: string,
    repo: string,
    number: number,
    review: { event: 'approve' | 'request-changes' | 'comment'; body?: string; comments?: GitHubReviewInlineComment[] },
    github: GitHubAPI,
  ) => Promise<{ ok: boolean; error?: GitHubErrorBody }>;
  threadAction: (
    directory: string,
    repo: string,
    number: number,
    threadId: string,
    action: { action: 'reply'; body: string; commentId: number } | { action: 'resolve' | 'unresolve' },
    github: GitHubAPI,
  ) => Promise<{ ok: boolean; error?: GitHubErrorBody }>;
  checkout: (
    directory: string,
    repo: string,
    number: number,
    mode: 'worktree' | 'current',
    github: GitHubAPI,
  ) => Promise<{ ok: boolean; path?: string | null; branch?: string; error?: GitHubErrorBody }>;
  createPullRequest: (
    input: { directory: string; repo: string; title: string; head: string; base: string; body?: string; draft?: boolean },
    github: GitHubAPI,
  ) => Promise<{ ok: boolean; number?: number; error?: GitHubErrorBody }>;
  rerunFailedChecks: (directory: string, repo: string, runId: number, github: GitHubAPI) => Promise<{ ok: boolean; error?: GitHubErrorBody }>;
  setMergeMethod: (repo: string, method: PullMergeMethod) => void;
  notifyAgentTurnComplete: (directory: string) => void;
  resetForRuntimeSwitch: () => void;
};

// Shared list/detail/comments machinery. The deps binding carries an
// explicit annotation so the core's type never depends on the store below
// explicit annotation so the core's type never depends on the store below
// (which in turn spreads the core) — otherwise inference cycles.
const pullsDeps: ListCoreDeps<PullsFilters> = {
  set: (partial) => {
    if (typeof partial === 'function') {
      useGitHubPullRequestsStore.setState((state) => {
        const slice: ListCoreSlice<PullsFilters> = {
          filtersByScope: state.filtersByScope,
          selectionByDirectory: state.selectionByDirectory,
        };
        return partial(slice);
      });
    } else {
      useGitHubPullRequestsStore.setState(partial);
    }
  },
  get: (): ListCoreSlice<PullsFilters> => {
    const state = useGitHubPullRequestsStore.getState();
    return {
      filtersByScope: state.filtersByScope,
      selectionByDirectory: state.selectionByDirectory,
    };
  },
};

const pullsCore = createGitHubListCore<
  GitHubPullRequestSummary,
  PullsCollection,
  PullsRemoteQuery,
  PullsFilters,
  GitHubPullRequestDetailResult
>(
  {
    openCollection: 'open',
    closedCollection: 'closed',
    defaultFilters: DEFAULT_PULLS_FILTERS,
    freshWindowMs: PULLS_FRESH_WINDOW_MS,
    serverKind: 'pulls',
    errorFallback: 'Pull request request failed',
    collectionKeyFor: pullsCollectionKeyFor,
    remoteKeyFor: pullsRemoteKeyFor,
    detailKeyFor: pullDetailKeyFor,
    commentsKeyFor: pullCommentsKeyFor,
    buildCollectionQuery: (collection) => ({ ...collectionQuery(collection) }),
    buildRemoteQuery: (query, cursor) => ({ ...remoteQueryFor(query, cursor) }),
    fetchList: async (github, directory, repo, query) => {
      const page = await github.pullsList(directory, repo, query as GitHubPullsQuery);
      return { items: page.items, nextCursor: page.nextCursor, fetchedAt: page.fetchedAt };
    },
    fetchDetail: async (github, directory, repo, number) => {
      return github.pullGet(directory, repo, number);
    },
    fetchComments: async (github, directory, repo, number, cursor) => {
      const page = await github.pullComments(directory, repo, number, cursor);
      return { comments: page.comments, nextCursor: page.nextCursor, fetchedAt: page.fetchedAt };
    },
  },
  pullsDeps,
);

const filesResource: KeyedAsyncResource<GitHubPullRequestFilesResult> =
  createKeyedAsyncResource<GitHubPullRequestFilesResult>();
const checksResource: KeyedAsyncResource<GitHubChecksResult> =
  createKeyedAsyncResource<GitHubChecksResult>();

export const useGitHubPullRequestsStore = create<PullsStoreState>()(
  devtools(
    (set, get) => ({
      ...pullsCore.initialState,
      actionErrorByDetail: {},
      actingActions: {},

      setFilters: pullsCore.setFilters,
      resetFilters: pullsCore.resetFilters,
      selectPullRequest: pullsCore.select,

      ensureCollection: pullsCore.ensureCollection,
      ensureCollectionsFresh: pullsCore.ensureCollectionsFresh,
      prefetchClosedCollection: pullsCore.prefetchClosedCollection,
      loadMoreCollection: pullsCore.loadMoreCollection,
      refreshCollections: pullsCore.refreshCollections,
      searchRemote: pullsCore.searchRemote,
      loadMoreRemote: pullsCore.loadMoreRemote,
      dropRemoteForRepo: pullsCore.dropRemoteForRepo,
      refreshAllForScope: pullsCore.refreshAllForScope,
      ensureDetail: pullsCore.ensureDetail,
      refreshDetail: pullsCore.refreshDetail,
      ensureComments: pullsCore.ensureComments,
      loadMoreComments: pullsCore.loadMoreComments,
      refreshComments: pullsCore.refreshComments,

      ensureFiles: (directory, repo, number, github) => {
        const key = pullFilesKeyFor(repo, number);
        return filesResource.ensure(key, async () => {
          return github.pullFiles(directory, repo, number);
        });
      },

      loadMoreFiles: async (directory, repo, number, github) => {
        const key = pullFilesKeyFor(repo, number);
        const entry = filesResource.getEntry(key);
        const cursor = entry?.data?.nextCursor ?? null;
        if (!cursor || entry?.isLoading) return entry;
        try {
          const outcome = await pullsCore.withSingleFlight(`${key}:more`, async () => {
            const page = await github.pullFiles(directory, repo, number, cursor);
            const current = filesResource.getEntry(key)?.data;
            const seen = new Set((current?.files ?? []).map((file) => file.filename));
            const merged: GitHubPullRequestFilesResult = {
              repo: page.repo,
              number: page.number,
              files: [...(current?.files ?? []), ...page.files.filter((file) => !seen.has(file.filename))],
              nextCursor: page.nextCursor,
              fetchedAt: page.fetchedAt,
            };
            return filesResource.refresh(key, async () => merged);
          });
          if (!outcome.ran) return filesResource.getEntry(key);
          return outcome.result ?? filesResource.getEntry(key);
        } catch (error) {
          return filesResource.setError(key, error) ?? filesResource.getEntry(key);
        }
      },

      ensureChecks: (directory, repo, number, github) => {
        const key = pullChecksKeyFor(repo, number);
        return checksResource.ensure(key, async () => {
          return github.pullChecks(directory, repo, number, true);
        });
      },

      refreshChecks: (directory, repo, number, github) => {
        const key = pullChecksKeyFor(repo, number);
        return checksResource.refresh(key, async () => {
          return github.pullChecks(directory, repo, number, true);
        });
      },

      performAction: async (directory, repo, number, action, github) => {
        const scope = detailScopeKey(repo, number);
        const detailKey = pullDetailKeyFor(repo, number);
        if (get().actingActions[scope]) return { ok: false, error: { kind: 'failed', message: i18n.t('Action already in progress') } };
        set((state) => ({
          actingActions: { ...state.actingActions, [scope]: true },
          actionErrorByDetail: { ...state.actionErrorByDetail, [scope]: null },
        }));
        const prevDetail = pullsCore.resources.details.getEntry(detailKey)?.data?.detail ?? null;
        const prevPr: GitHubPullRequestDetail | null = prevDetail?.pr ?? null;
        // Optimistic update only for the viewer's own state changes, with rollback.
        const optimisticPr: GitHubPullRequestDetail | null = prevPr
          ? {
              ...prevPr,
              state:
                action === 'close'
                  ? 'closed'
                  : action === 'reopen'
                    ? 'open'
                    : action === 'merge' || action === 'squash' || action === 'rebase'
                      ? 'merged'
                      : prevPr.state,
              draft: action === 'ready' ? false : action === 'draft' ? true : prevPr.draft,
            }
          : null;
        if (optimisticPr && prevDetail) {
          await pullsCore.resources.details.refresh(detailKey, async () => ({ detail: { ...prevDetail, pr: optimisticPr } })).catch(() => null);
        }
        try {
          await github.pullAction(directory, repo, number, action);
          if (action === 'merge' || action === 'squash' || action === 'rebase') {
            get().setMergeMethod(repo, action);
          }
          // Post-action invalidate then re-read (never auto-retry on uncertain outcome).
          await serverInvalidate(github, { directory, repo, kind: 'pulls', number });
          // State membership may have moved across collections — re-read
          // both and drop this repo's remote-search caches.
          get().dropRemoteForRepo(repo);
          await get().refreshCollections(directory, repo, 'both', github).catch(() => null);
          await get().refreshDetail(directory, repo, number, github).catch(() => null);
          await get().refreshChecks(directory, repo, number, github).catch(() => null);
          set((state) => ({ actingActions: { ...state.actingActions, [scope]: false } }));
          return { ok: true };
        } catch (error) {
          const body = pullsCore.toStoreError(error);
          // Rollback the optimistic state change.
          if (prevDetail) {
            await pullsCore.resources.details.refresh(detailKey, async () => ({ detail: prevDetail })).catch(() => null);
          }
          set((state) => ({
            actingActions: { ...state.actingActions, [scope]: false },
            actionErrorByDetail: { ...state.actionErrorByDetail, [scope]: body },
          }));
          return { ok: false, error: body };
        }
      },

      updateTitleBody: async (directory, repo, number, patch, github) => {
        const scope = detailScopeKey(repo, number);
        const detailKey = pullDetailKeyFor(repo, number);
        const prevDetail = pullsCore.resources.details.getEntry(detailKey)?.data?.detail ?? null;
        const prevPr = prevDetail?.pr ?? null;
        const optimisticPr: GitHubPullRequestDetail | null =
          prevPr && (patch.title !== undefined || patch.body !== undefined)
            ? {
                ...prevPr,
                title: patch.title ?? prevPr.title,
                body: patch.body ?? prevPr.body,
              }
            : null;
        if (optimisticPr && prevDetail) {
          await pullsCore.resources.details.refresh(detailKey, async () => ({ detail: { ...prevDetail, pr: optimisticPr } })).catch(() => null);
        }
        try {
          await github.pullUpdate(directory, repo, number, patch);
          await serverInvalidate(github, { directory, repo, kind: 'pulls', number });
          get().dropRemoteForRepo(repo);
          await get().refreshCollections(directory, repo, 'both', github).catch(() => null);
          await get().refreshDetail(directory, repo, number, github).catch(() => null);
          return { ok: true };
        } catch (error) {
          const body = pullsCore.toStoreError(error);
          if (prevDetail) {
            await pullsCore.resources.details.refresh(detailKey, async () => ({ detail: prevDetail })).catch(() => null);
          }
          set((state) => ({
            actionErrorByDetail: { ...state.actionErrorByDetail, [scope]: body },
          }));
          return { ok: false, error: body };
        }
      },

      addComment: async (directory, repo, number, body, github) => {
        const scope = detailScopeKey(repo, number);
        const key = pullCommentsKeyFor(repo, number);
        const trimmed = body.trim();
        // Optimistic insert so the new comment appears immediately; the
        // negative id marks it as unconfirmed until the re-read reconciles.
        const optimistic: GitHubIssueComment = {
          id: -Date.now(),
          url: '',
          body: trimmed,
          author: null,
          createdAt: new Date().toISOString(),
          updatedAt: null,
        };
        const prevData = pullsCore.resources.comments.getEntry(key)?.data ?? null;
        if (prevData) {
          const merged: PullCommentsData = {
            comments: [...prevData.comments, optimistic],
            nextCursor: prevData.nextCursor,
            fetchedAt: prevData.fetchedAt,
          };
          await pullsCore.resources.comments.refresh(key, async () => merged).catch(() => null);
        }
        try {
          await github.pullComment(directory, repo, number, trimmed);
          await serverInvalidate(github, { directory, repo, kind: 'pulls', number });
          // Re-read the thread so the optimistic comment reconciles against
          // the authoritative list (which carries server ids/timestamps).
          await get().refreshComments(directory, repo, number, github).catch(() => null);
          await get().refreshDetail(directory, repo, number, github).catch(() => null);
          return { ok: true };
        } catch (error) {
          const errBody = pullsCore.toStoreError(error);
          // Rollback the optimistic comment.
          if (prevData) {
            await pullsCore.resources.comments.refresh(key, async () => prevData).catch(() => null);
          } else {
            pullsCore.resources.comments.remove(key);
          }
          set((state) => ({
            actionErrorByDetail: { ...state.actionErrorByDetail, [scope]: errBody },
          }));
          return { ok: false, error: errBody };
        }
      },

      submitReview: async (directory, repo, number, review, github) => {
        const scope = detailScopeKey(repo, number);
        try {
          // The pending-review store owns line comments + summary; this call
          // sends exactly the snapshot the composer hands over.
          await github.pullReview(directory, repo, number, {
            event: review.event,
            body: review.body,
            comments: review.comments,
          });
          await serverInvalidate(github, { directory, repo, kind: 'pulls', number });
          await get().refreshDetail(directory, repo, number, github).catch(() => null);
          return { ok: true };
        } catch (error) {
          const errBody = pullsCore.toStoreError(error);
          set((state) => ({
            actionErrorByDetail: { ...state.actionErrorByDetail, [scope]: errBody },
          }));
          return { ok: false, error: errBody };
        }
      },

      threadAction: async (directory, repo, number, threadId, action, github) => {
        const scope = detailScopeKey(repo, number);
        try {
          await github.pullThread(directory, repo, number, threadId, action);
          await serverInvalidate(github, { directory, repo, kind: 'pulls', number });
          await get().refreshDetail(directory, repo, number, github).catch(() => null);
          return { ok: true };
        } catch (error) {
          const errBody = pullsCore.toStoreError(error);
          set((state) => ({
            actionErrorByDetail: { ...state.actionErrorByDetail, [scope]: errBody },
          }));
          return { ok: false, error: errBody };
        }
      },

      checkout: async (directory, repo, number, mode, github) => {
        try {
          const result = await github.pullCheckout(directory, repo, number, mode);
          return { ok: true, path: result.path, branch: result.branch };
        } catch (error) {
          return { ok: false, error: pullsCore.toStoreError(error) };
        }
      },

      createPullRequest: async (input, github) => {
        try {
          const result = await github.pullCreate(input);
          await serverInvalidate(github, { directory: input.directory, repo: input.repo, kind: 'pulls' });
          get().dropRemoteForRepo(input.repo);
          await get().refreshCollections(input.directory, input.repo, 'both', github).catch(() => null);
          return { ok: true, number: result.pr.number };
        } catch (error) {
          return { ok: false, error: pullsCore.toStoreError(error) };
        }
      },

      rerunFailedChecks: async (directory, repo, runId, github) => {
        try {
          await github.checksRerun(directory, repo, runId);
          return { ok: true };
        } catch (error) {
          return { ok: false, error: pullsCore.toStoreError(error) };
        }
      },

      setMergeMethod: (repo, method) => {
        writeMergeMethod(repo, method);
      },

      notifyAgentTurnComplete: (directory) => {
        const dirKey = normalizeDirectoryPathKey((directory || '').trim());
        if (!dirKey) return;
        // Invalidate current-branch PR status for every branch entry of this
        // directory (cheap: pr-status store re-reads on demand tiers), and the
        // open PR detail when one is selected.
        const prState = useGitHubPrStatusStore.getState();
        for (const key of Object.keys(prState.results)) {
          const [, entryDirectory] = key.split('\n');
          if (entryDirectory !== dirKey) continue;
          const [, , branch] = key.split('\n');
          if (!branch) continue;
          void import('@/contexts/runtimeAPIRegistry')
            .then(({ getRegisteredRuntimeAPIs }) => {
              const github = getRegisteredRuntimeAPIs()?.github ?? null;
              if (!github) return;
              return prState.refresh(dirKey, branch, github, { force: true });
            })
            .catch(() => {});
        }
        const selection = get().selectionByDirectory[dirKey];
        if (selection?.repo && typeof selection.number === 'number') {
          // Mark the repo's collections stale so the next visible list
          // revalidates once, instead of refetching from this notification.
          pullsCore.markCollectionsStale(selection.repo);
          void import('@/contexts/runtimeAPIRegistry')
            .then(({ getRegisteredRuntimeAPIs }) => {
              const github = getRegisteredRuntimeAPIs()?.github ?? null;
              if (!github) return;
              return get().refreshDetail(dirKey, selection.repo as string, selection.number as number, github);
            })
            .catch(() => {});
        }
      },

      resetForRuntimeSwitch: () => {
        pullsCore.resetCore();
        filesResource.reset();
        checksResource.reset();
        set({
          actionErrorByDetail: {},
          actingActions: {},
        });
      },
    }),
    { name: 'github-pull-requests-store' },
  ),
);

if (typeof window !== 'undefined') {
  subscribeRuntimeEndpointChanged(() => {
    useGitHubPullRequestsStore.getState().resetForRuntimeSwitch();
  });
  window.addEventListener('focus', () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    // Focus refresh is owned by the mounted surface (it calls
    // ensureCollectionsFresh with its live need). No global fetch here so
    // hidden or unmounted scopes perform no ongoing work.
  });
}

/**
 * Clean hook from the sync layer's turn-complete signal.
 *
 * The sync layer's authoritative turn-complete signal is the notification
 * store (`useNotificationStore.list` entries of type `turn-complete`, appended
 * only by live `PiSessionStore` terminal lifecycle events — never by
 * persisted history). Subscribe once from the Pull requests surface; each new
 * turn-complete for a directory calls `notifyAgentTurnComplete(directory)`.
 *
 * Gap: the notification carries the session directory, not the repo. When a
 * directory maps to several GitHub repositories, only the selected repo's
 * open detail is invalidated; other repos refresh on next surface open/focus.
 */
export const subscribeToAgentTurnCompletion = (onTurn?: (directory: string) => void): (() => void) => {
  if (typeof window === 'undefined') return () => {};
  let seenIds = new Set<string>();
  let initialized = false;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  // The notification store is loaded lazily, but the cleanup is returned
  // synchronously so it is safe as a React effect cleanup. Disposing before
  // the import settles prevents the subscription from ever being created.
  void import('@/sync/notification-store').then(({ useNotificationStore }) => {
    if (disposed) return;
    const updateSeen = () => {
      const list = useNotificationStore.getState().list;
      const ids = new Set(list.map((entry) => `${entry.type}:${entry.session ?? ''}:${entry.time}`));
      if (!initialized) {
        seenIds = ids;
        initialized = true;
        return;
      }
      for (const entry of list) {
        const id = `${entry.type}:${entry.session ?? ''}:${entry.time}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        if (entry.type === 'turn-complete' && entry.directory) {
          useGitHubPullRequestsStore.getState().notifyAgentTurnComplete(entry.directory);
          onTurn?.(entry.directory);
        }
      }
    };
    updateSeen();
    unsubscribe = useNotificationStore.subscribe(updateSeen);
  }).catch(() => {});
  return () => {
    disposed = true;
    unsubscribe?.();
    unsubscribe = null;
  };
};

export const getPullsCollectionEntry = (
  repo: string,
  collection: PullsCollection,
): GitHubResourceEntry<PullsCollectionData> | null =>
  pullsCore.resources.collections.getEntry(pullsCollectionKeyFor(repo, collection));

export const getPullsRemoteEntry = (
  repo: string,
  query: PullsRemoteQuery,
): GitHubResourceEntry<PullsRemoteData> | null =>
  pullsCore.resources.remote.getEntry(pullsRemoteKeyFor(repo, query));

/**
 * Every locally known PR for the repo: both wide collections plus the remote
 * search index (deduped by number, remote hits win). Used for local views
 * and detail seeds.
 */
export const getPullsLocalIndex = (repo: string): GitHubPullRequestSummary[] =>
  pullsCore.getLocalIndex(repo);

/** Seed for the detail view: searches collections + remote index by number. */
export const findPullSeed = (repo: string, number: number): GitHubPullRequestSummary | null =>
  pullsCore.getLocalIndex(repo).find((item) => item.number === number) ?? null;

export const getPullDetailEntry = (repo: string, number: number): GitHubResourceEntry<PullsDetailData> | null =>
  pullsCore.resources.details.getEntry(pullDetailKeyFor(repo, number));

export const getPullCommentsEntry = (repo: string, number: number): GitHubResourceEntry<PullCommentsData> | null =>
  pullsCore.resources.comments.getEntry(pullCommentsKeyFor(repo, number));

/** Per-key subscriptions: re-render only when this repo's collection changes. */
export const usePullsCollectionEntry = (
  repo: string | null,
  collection: PullsCollection,
): GitHubResourceEntry<PullsCollectionData> | null =>
  useKeyedResourceEntry(
    pullsCore.resources.collections,
    repo ? pullsCollectionKeyFor(repo, collection) : null,
  );

export const usePullsRemoteEntry = (
  repo: string | null,
  query: PullsRemoteQuery,
): GitHubResourceEntry<PullsRemoteData> | null =>
  useKeyedResourceEntry(
    pullsCore.resources.remote,
    repo ? pullsRemoteKeyFor(repo, query) : null,
  );

export const usePullDetailEntry = (
  repo: string | null,
  number: number | null,
): GitHubResourceEntry<PullsDetailData> | null =>
  useKeyedResourceEntry(
    pullsCore.resources.details,
    repo != null && number != null ? pullDetailKeyFor(repo, number) : null,
  );

export const usePullCommentsEntry = (
  repo: string | null,
  number: number | null,
): GitHubResourceEntry<PullCommentsData> | null =>
  useKeyedResourceEntry(
    pullsCore.resources.comments,
    repo != null && number != null ? pullCommentsKeyFor(repo, number) : null,
  );

export const usePullFilesEntry = (
  repo: string | null,
  number: number | null,
): GitHubResourceEntry<GitHubPullRequestFilesResult> | null =>
  useKeyedResourceEntry(
    filesResource,
    repo != null && number != null ? pullFilesKeyFor(repo, number) : null,
  );

export const usePullChecksEntry = (
  repo: string | null,
  number: number | null,
): GitHubResourceEntry<GitHubChecksResult> | null =>
  useKeyedResourceEntry(
    checksResource,
    repo != null && number != null ? pullChecksKeyFor(repo, number) : null,
  );

export const usePullsFilters = (directory: string | null, repo: string | null): PullsFilters => {
  return useGitHubPullRequestsStore((state) => {
    if (!directory || !repo) return DEFAULT_PULLS_FILTERS;
    return state.filtersByScope[scopeKeyFor(directory, repo)] ?? DEFAULT_PULLS_FILTERS;
  });
};

export const usePullsSelection = (directory: string | null): PullsSelection => {
  return useGitHubPullRequestsStore((state) => {
    if (!directory) return EMPTY_GITHUB_SELECTION;
    return state.selectionByDirectory[normalizeDirectoryPathKey(directory)] ?? EMPTY_GITHUB_SELECTION;
  });
};
