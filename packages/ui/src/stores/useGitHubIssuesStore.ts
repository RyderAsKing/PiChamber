import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type {
  GitHubAPI,
  GitHubErrorBody,
  GitHubIssue,
  GitHubIssueComment,
  GitHubIssueCommentsResult,
  GitHubIssueGetResult,
  GitHubIssuesListResult,
  GitHubIssuesQuery,
} from '@/lib/api/types';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { normalizeDirectoryPathKey } from '@/lib/directoryPathKey';
import i18n from '@/i18n';
import {
  buildGitHubResourceKey,
  useKeyedResourceEntry,
  type GitHubResourceEntry,
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

/**
 * Issues list/detail/comments store (plan §6.4, §7.1).
 *
 * Lists are two wide per-repo collections — `open` and `closed`, fetched
 * with `perPage: 100`. Cache keys are runtime + repo + collection only:
 * state tabs, involvement, labels, text search, and sort are pure local
 * views over the collections, so typing and tab switches never fetch.
 *
 * Loading contract: stale-while-revalidate with a 30 s fresh window. Mounts
 * show cached collections immediately and revalidate in the background only
 * when stale; the manual refresh button forces. Failure keeps previous data
 * marked stale, never empty.
 *
 * Items the wide fetch has not downloaded yet are covered by a per-query
 * remote search cache (`state + involvement + labels + q`, perPage 50, last
 * 10 queries per repo) whose results also merge into the local repo index.
 * - Detail + comments keyed `runtime + repo + number`.
 * - Components subscribe per resource key (`useIssuesCollectionEntry` etc.).
 * - Optimistic updates only for the viewer's own actions (state incl. close
 *   reason, labels, assignees, title/body, comments) with rollback on
 *   failure; post-action server `POST /api/github/invalidate` then re-read.
 *   Never auto-retries after an uncertain outcome.
 * - No list polling: refresh on surface open / focus / repo change /
 *   explicit refresh. Agent-turn refresh arrives through
 *   `notifyAgentTurnComplete` (wired by the surface to the shared
 *   turn-complete signal), which also marks the repo's collections stale so
 *   the next visible list revalidates.
 */

export type IssuesStateFilter = 'open' | 'closed' | 'all';
export type IssuesInvolvementFilter = 'all' | 'mine' | 'assigned' | 'mentioned';
export type IssuesSort = 'updated' | 'newest' | 'oldest';

export type IssuesFilters = {
  state: IssuesStateFilter;
  involvement: IssuesInvolvementFilter;
  labels: string;
  search: string;
  sort: IssuesSort;
};

export const DEFAULT_ISSUES_FILTERS: IssuesFilters = {
  state: 'open',
  involvement: 'all',
  labels: '',
  search: '',
  sort: 'updated',
};

/** Wide per-repo collections. */
export type IssuesCollection = 'open' | 'closed';

/** Background revalidation only runs when the cached read is older than this. */
export const ISSUES_FRESH_WINDOW_MS = 30_000;

const ISSUES_COLLECTION_PAGE_SIZE = 100;
const ISSUES_REMOTE_PAGE_SIZE = 50;

export type IssuesCollectionData = GitHubCollectionPage<GitHubIssuesListResult['items'][number]>;

export type IssuesRemoteQuery = {
  state: IssuesStateFilter;
  involvement: IssuesInvolvementFilter;
  labels: string;
  q: string;
};

export type IssuesRemoteData = GitHubCollectionPage<GitHubIssuesListResult['items'][number]>;

export type IssuesDetailData = {
  detail: GitHubIssueGetResult;
};

export type IssuesCommentsData = GitHubThreadPage;

export type IssuesSelection = {
  repo: string | null;
  number: number | null;
};

export type IssueStatePatch = {
  state: 'open' | 'closed';
  /** Required by the server when closing; omitted when reopening. */
  stateReason?: 'completed' | 'not_planned';
};

export const issuesCollectionKeyFor = (repo: string, collection: IssuesCollection): string =>
  buildGitHubResourceKey([repo, 'issues-collection', collection]);

export const issuesRemoteKeyFor = (repo: string, query: IssuesRemoteQuery): string =>
  buildGitHubResourceKey([
    repo,
    'issues-remote',
    query.state,
    query.involvement,
    query.labels.trim(),
    query.q.trim(),
  ]);

export const issueDetailKeyFor = (repo: string, number: number): string =>
  buildGitHubResourceKey([repo, 'issue-detail', number]);

export const issueCommentsKeyFor = (repo: string, number: number): string =>
  buildGitHubResourceKey([repo, 'issue-comments', number]);

const collectionQuery = (collection: IssuesCollection): GitHubIssuesQuery => ({
  state: collection,
  perPage: ISSUES_COLLECTION_PAGE_SIZE,
});

const remoteQueryFor = (query: IssuesRemoteQuery, cursor?: string | null): GitHubIssuesQuery => ({
  state: query.state,
  filter: query.involvement,
  q: query.q.trim() ? query.q.trim() : undefined,
  labels: query.labels.trim() ? query.labels.trim() : undefined,
  perPage: ISSUES_REMOTE_PAGE_SIZE,
  ...(cursor ? { cursor } : {}),
});

type IssuesStoreState = {
  filtersByScope: Record<string, IssuesFilters>;
  selectionByDirectory: Record<string, IssuesSelection>;
  actionErrorByDetail: Record<string, GitHubErrorBody | null>;
  actingActions: Record<string, boolean>;
  setFilters: (directory: string, repo: string, patch: Partial<IssuesFilters>) => void;
  resetFilters: (directory: string, repo: string) => void;
  selectIssue: (directory: string, repo: string | null, number: number | null) => void;
  ensureCollection: (directory: string, repo: string, collection: IssuesCollection, github: GitHubAPI) => Promise<GitHubResourceEntry<IssuesCollectionData>>;
  ensureCollectionsFresh: (directory: string, repo: string, need: IssuesCollection | 'both', github: GitHubAPI) => Promise<void>;
  prefetchClosedCollection: (directory: string, repo: string, github: GitHubAPI) => void;
  loadMoreCollection: (directory: string, repo: string, collection: IssuesCollection, github: GitHubAPI) => Promise<GitHubResourceEntry<IssuesCollectionData> | null>;
  refreshCollections: (directory: string, repo: string, need: IssuesCollection | 'both', github: GitHubAPI) => Promise<void>;
  searchRemote: (directory: string, repo: string, query: IssuesRemoteQuery, github: GitHubAPI) => Promise<GitHubResourceEntry<IssuesRemoteData>>;
  loadMoreRemote: (directory: string, repo: string, query: IssuesRemoteQuery, github: GitHubAPI) => Promise<GitHubResourceEntry<IssuesRemoteData> | null>;
  dropRemoteForRepo: (repo: string) => void;
  refreshAllForScope: (directory: string, repo: string, github: GitHubAPI) => Promise<void>;
  ensureDetail: (directory: string, repo: string, number: number, github: GitHubAPI) => Promise<GitHubResourceEntry<IssuesDetailData>>;
  refreshDetail: (directory: string, repo: string, number: number, github: GitHubAPI) => Promise<GitHubResourceEntry<IssuesDetailData>>;
  ensureComments: (directory: string, repo: string, number: number, github: GitHubAPI) => Promise<GitHubResourceEntry<IssuesCommentsData>>;
  loadMoreComments: (directory: string, repo: string, number: number, github: GitHubAPI) => Promise<GitHubResourceEntry<IssuesCommentsData> | null>;
  refreshComments: (directory: string, repo: string, number: number, github: GitHubAPI) => Promise<GitHubResourceEntry<IssuesCommentsData>>;
  updateIssue: (
    directory: string,
    repo: string,
    number: number,
    patch: { title?: string; body?: string; labels?: string[]; assignees?: string[] } & Partial<IssueStatePatch>,
    github: GitHubAPI,
  ) => Promise<{ ok: boolean; error?: GitHubErrorBody }>;
  addComment: (directory: string, repo: string, number: number, body: string, github: GitHubAPI) => Promise<{ ok: boolean; error?: GitHubErrorBody }>;
  createIssue: (
    input: { directory: string; repo: string; title: string; body?: string; labels?: string[]; assignees?: string[] },
    github: GitHubAPI,
  ) => Promise<{ ok: boolean; number?: number; error?: GitHubErrorBody }>;
  notifyAgentTurnComplete: (directory: string) => void;
  resetForRuntimeSwitch: () => void;
};

// Shared list/detail/comments machinery. The deps binding carries an
// explicit annotation so the core's type never depends on the store below
// (which in turn spreads the core) — otherwise inference cycles.
const issuesDeps: ListCoreDeps<IssuesFilters> = {
  set: (partial) => {
    if (typeof partial === 'function') {
      useGitHubIssuesStore.setState((state) => {
        const slice: ListCoreSlice<IssuesFilters> = {
          filtersByScope: state.filtersByScope,
          selectionByDirectory: state.selectionByDirectory,
        };
        return partial(slice);
      });
    } else {
      useGitHubIssuesStore.setState(partial);
    }
  },
  get: (): ListCoreSlice<IssuesFilters> => {
    const state = useGitHubIssuesStore.getState();
    return {
      filtersByScope: state.filtersByScope,
      selectionByDirectory: state.selectionByDirectory,
    };
  },
};

const issuesCore = createGitHubListCore<
  GitHubIssuesListResult['items'][number],
  IssuesCollection,
  IssuesRemoteQuery,
  IssuesFilters,
  GitHubIssueGetResult
>(
  {
    openCollection: 'open',
    closedCollection: 'closed',
    defaultFilters: DEFAULT_ISSUES_FILTERS,
    freshWindowMs: ISSUES_FRESH_WINDOW_MS,
    serverKind: 'issues',
    errorFallback: 'Issue request failed',
    collectionKeyFor: issuesCollectionKeyFor,
    remoteKeyFor: issuesRemoteKeyFor,
    detailKeyFor: issueDetailKeyFor,
    commentsKeyFor: issueCommentsKeyFor,
    buildCollectionQuery: (collection) => ({ ...collectionQuery(collection) }),
    buildRemoteQuery: (query, cursor) => ({ ...remoteQueryFor(query, cursor) }),
    fetchList: async (github, directory, repo, query) => {
      const page = await github.issuesList(directory, repo, query as GitHubIssuesQuery);
      return { items: page.items, nextCursor: page.nextCursor, fetchedAt: page.fetchedAt };
    },
    fetchDetail: async (github, directory, repo, number) => {
      return github.issueGet(directory, repo, number);
    },
    fetchComments: async (github, directory, repo, number, cursor) => {
      const page: GitHubIssueCommentsResult = await github.issueComments(directory, repo, number, cursor);
      return { comments: page.comments, nextCursor: page.nextCursor, fetchedAt: page.fetchedAt };
    },
  },
  issuesDeps,
);

export const useGitHubIssuesStore = create<IssuesStoreState>()(
  devtools(
    (set, get) => ({
      ...issuesCore.initialState,
      actionErrorByDetail: {},
      actingActions: {},

      setFilters: issuesCore.setFilters,
      resetFilters: issuesCore.resetFilters,
      selectIssue: issuesCore.select,

      ensureCollection: issuesCore.ensureCollection,
      ensureCollectionsFresh: issuesCore.ensureCollectionsFresh,
      prefetchClosedCollection: issuesCore.prefetchClosedCollection,
      loadMoreCollection: issuesCore.loadMoreCollection,
      refreshCollections: issuesCore.refreshCollections,
      searchRemote: issuesCore.searchRemote,
      loadMoreRemote: issuesCore.loadMoreRemote,
      dropRemoteForRepo: issuesCore.dropRemoteForRepo,
      refreshAllForScope: issuesCore.refreshAllForScope,
      ensureDetail: issuesCore.ensureDetail,
      refreshDetail: issuesCore.refreshDetail,
      ensureComments: issuesCore.ensureComments,
      loadMoreComments: issuesCore.loadMoreComments,
      refreshComments: issuesCore.refreshComments,

      updateIssue: async (directory, repo, number, patch, github) => {
        const scope = detailScopeKey(repo, number);
        const detailKey = issueDetailKeyFor(repo, number);
        if (get().actingActions[scope]) {
          return { ok: false, error: { kind: 'failed', message: i18n.t('An update is already in progress') } };
        }
        set((state) => ({
          actingActions: { ...state.actingActions, [scope]: true },
          actionErrorByDetail: { ...state.actionErrorByDetail, [scope]: null },
        }));
        const prevDetail = issuesCore.resources.details.getEntry(detailKey)?.data?.detail ?? null;
        const prevIssue: GitHubIssue | null = prevDetail?.issue ?? null;
        // Optimistic update only for the viewer's own action, with rollback.
        const optimisticIssue: GitHubIssue | null = prevIssue
          ? {
              ...prevIssue,
              title: patch.title ?? prevIssue.title,
              body: patch.body ?? prevIssue.body,
              state: patch.state ?? prevIssue.state,
              stateReason: patch.state !== undefined ? (patch.stateReason ?? null) : prevIssue.stateReason,
              labels: patch.labels !== undefined
                ? patch.labels.map((name) => ({ name }))
                : prevIssue.labels,
              assignees: patch.assignees !== undefined
                ? patch.assignees.map((login) => ({ login }))
                : prevIssue.assignees,
            }
          : null;
        if (optimisticIssue && prevDetail) {
          await issuesCore.resources.details
            .refresh(detailKey, async () => ({ detail: { ...prevDetail, issue: optimisticIssue } }))
            .catch(() => null);
        }
        try {
          await github.issueUpdate(directory, repo, number, patch);
          // Post-action invalidate then re-read; never auto-retry on an
          // uncertain outcome — the single attempt above is the action.
          await serverInvalidate(github, { directory, repo, kind: 'issues', number });
          // State membership may have moved across collections — re-read
          // both and drop this repo's remote-search caches.
          get().dropRemoteForRepo(repo);
          await get().refreshCollections(directory, repo, 'both', github).catch(() => null);
          await get().refreshDetail(directory, repo, number, github).catch(() => null);
          set((state) => ({ actingActions: { ...state.actingActions, [scope]: false } }));
          return { ok: true };
        } catch (error) {
          const body = issuesCore.toStoreError(error);
          // Rollback the optimistic change.
          if (prevDetail) {
            await issuesCore.resources.details
              .refresh(detailKey, async () => ({ detail: prevDetail }))
              .catch(() => null);
          }
          set((state) => ({
            actingActions: { ...state.actingActions, [scope]: false },
            actionErrorByDetail: { ...state.actionErrorByDetail, [scope]: body },
          }));
          return { ok: false, error: body };
        }
      },

      addComment: async (directory, repo, number, body, github) => {
        const scope = detailScopeKey(repo, number);
        const key = issueCommentsKeyFor(repo, number);
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
        const prevData = issuesCore.resources.comments.getEntry(key)?.data ?? null;
        if (prevData) {
          const merged: IssuesCommentsData = {
            comments: [...prevData.comments, optimistic],
            nextCursor: prevData.nextCursor,
            fetchedAt: prevData.fetchedAt,
          };
          await issuesCore.resources.comments.refresh(key, async () => merged).catch(() => null);
        }
        try {
          await github.issueComment(directory, repo, number, trimmed);
          await serverInvalidate(github, { directory, repo, kind: 'issues', number });
          // Re-read the thread so the optimistic comment reconciles against
          // the authoritative list (which carries server ids/timestamps).
          await get().refreshComments(directory, repo, number, github).catch(() => null);
          await get().refreshDetail(directory, repo, number, github).catch(() => null);
          return { ok: true };
        } catch (error) {
          const errBody = issuesCore.toStoreError(error);
          // Rollback the optimistic comment.
          if (prevData) {
            await issuesCore.resources.comments.refresh(key, async () => prevData).catch(() => null);
          } else {
            issuesCore.resources.comments.remove(key);
          }
          set((state) => ({
            actionErrorByDetail: { ...state.actionErrorByDetail, [scope]: errBody },
          }));
          return { ok: false, error: errBody };
        }
      },

      createIssue: async (input, github) => {
        try {
          const result = await github.issueCreate(input.directory, input.repo, {
            title: input.title,
            body: input.body,
            labels: input.labels,
            assignees: input.assignees,
          });
          await serverInvalidate(github, { directory: input.directory, repo: input.repo, kind: 'issues' });
          get().dropRemoteForRepo(input.repo);
          await get().refreshCollections(input.directory, input.repo, 'both', github).catch(() => null);
          return { ok: true, number: result.issue.number };
        } catch (error) {
          return { ok: false, error: issuesCore.toStoreError(error) };
        }
      },

      notifyAgentTurnComplete: (directory) => {
        const dirKey = normalizeDirectoryPathKey((directory || '').trim());
        if (!dirKey) return;
        const selection = get().selectionByDirectory[dirKey];
        if (!selection?.repo || typeof selection.number !== 'number') return;
        // Mark the repo's collections stale so the next visible list
        // revalidates once, instead of refetching from this notification.
        issuesCore.markCollectionsStale(selection.repo);
        void import('@/contexts/runtimeAPIRegistry')
          .then(({ getRegisteredRuntimeAPIs }) => {
            const github = getRegisteredRuntimeAPIs()?.github ?? null;
            if (!github) return;
            return get().refreshDetail(dirKey, selection.repo as string, selection.number as number, github);
          })
          .catch(() => {});
      },

      resetForRuntimeSwitch: () => {
        issuesCore.resetCore();
        set({
          actionErrorByDetail: {},
          actingActions: {},
        });
      },
    }),
    { name: 'github-issues-store' },
  ),
);

if (typeof window !== 'undefined') {
  subscribeRuntimeEndpointChanged(() => {
    useGitHubIssuesStore.getState().resetForRuntimeSwitch();
  });
}

export const getIssuesCollectionEntry = (
  repo: string,
  collection: IssuesCollection,
): GitHubResourceEntry<IssuesCollectionData> | null =>
  issuesCore.resources.collections.getEntry(issuesCollectionKeyFor(repo, collection));

export const getIssuesRemoteEntry = (
  repo: string,
  query: IssuesRemoteQuery,
): GitHubResourceEntry<IssuesRemoteData> | null =>
  issuesCore.resources.remote.getEntry(issuesRemoteKeyFor(repo, query));

/**
 * Every locally known issue for the repo: both wide collections plus the
 * remote search index (deduped by number, remote hits win). Used for local
 * views and detail seeds.
 */
export const getIssuesLocalIndex = (repo: string): GitHubIssuesListResult['items'] =>
  issuesCore.getLocalIndex(repo);

/** Seed for the detail view: searches collections + remote index by number. */
export const findIssueSeed = (repo: string, number: number): GitHubIssuesListResult['items'][number] | null =>
  issuesCore.getLocalIndex(repo).find((item) => item.number === number) ?? null;

export const getIssueDetailEntry = (repo: string, number: number): GitHubResourceEntry<IssuesDetailData> | null =>
  issuesCore.resources.details.getEntry(issueDetailKeyFor(repo, number));

/** Per-key subscriptions: re-render only when this repo's collection changes. */
export const useIssuesCollectionEntry = (
  repo: string | null,
  collection: IssuesCollection,
): GitHubResourceEntry<IssuesCollectionData> | null =>
  useKeyedResourceEntry(
    issuesCore.resources.collections,
    repo ? issuesCollectionKeyFor(repo, collection) : null,
  );

export const useIssuesRemoteEntry = (
  repo: string | null,
  query: IssuesRemoteQuery,
): GitHubResourceEntry<IssuesRemoteData> | null =>
  useKeyedResourceEntry(
    issuesCore.resources.remote,
    repo ? issuesRemoteKeyFor(repo, query) : null,
  );

export const useIssueDetailEntry = (
  repo: string | null,
  number: number | null,
): GitHubResourceEntry<IssuesDetailData> | null =>
  useKeyedResourceEntry(
    issuesCore.resources.details,
    repo != null && number != null ? issueDetailKeyFor(repo, number) : null,
  );

export const useIssueCommentsEntry = (
  repo: string | null,
  number: number | null,
): GitHubResourceEntry<IssuesCommentsData> | null =>
  useKeyedResourceEntry(
    issuesCore.resources.comments,
    repo != null && number != null ? issueCommentsKeyFor(repo, number) : null,
  );

export const useIssuesFilters = (directory: string | null, repo: string | null): IssuesFilters => {
  return useGitHubIssuesStore((state) => {
    if (!directory || !repo) return DEFAULT_ISSUES_FILTERS;
    return state.filtersByScope[scopeKeyFor(directory, repo)] ?? DEFAULT_ISSUES_FILTERS;
  });
};

export const useIssuesSelection = (directory: string | null): IssuesSelection => {
  return useGitHubIssuesStore((state) => {
    if (!directory) return EMPTY_GITHUB_SELECTION;
    return state.selectionByDirectory[normalizeDirectoryPathKey(directory)] ?? EMPTY_GITHUB_SELECTION;
  });
};
