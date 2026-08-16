/**
 * Live session catalog — runtime-scoped metadata for every Pi session the
 * connected runtime knows about.
 *
 * The catalog is the single live source of truth for "is this session busy,
 * what is its title, when did it update". Transcripts live separately in
 * `PiSessionStore.reducer.bySession` (LRU-capped). The catalog holds metadata
 * only — no messages, no parts — and is keyed by session id with a per-
 * directory membership index for sidebar / header / mobile lists.
 *
 * Membership semantics:
 *
 * - A successful per-directory `listSessions` replaces that directory's
 *   membership. Other directories are not touched.
 * - A failed per-directory list flips that directory's status to `'failed'`
 *   but never deletes prior rows. Failure is not empty success.
 * - Pi events update rows in place: `session.lifecycle` flips `lifecycle`,
 *   rename/title updates `title`, archive toggles `archived`, delete removes
 *   the row, create inserts a row.
 *
 * Reference hygiene (per the perf checklist): a mutation clones only the
 * fields it actually touches and only the directories whose membership
 * changed. Unrelated rows and unrelated directories keep their previous
 * references so a background busy event for one session cannot rebuild
 * unrelated sidebar row objects.
 */

import { mapWithConcurrency } from '@/lib/concurrency';
import { normalizePath } from '@/lib/pathNormalization';
import type { Session } from '@/lib/chat/types';
import type { PiSessionListItem } from '@/lib/pi/protocol';
import type { PiSessionId } from '@/lib/pi/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Live lifecycle mirror. The reducer's `PiReducerSessionState.lifecycle` is
 * the source of truth while a transcript is resident; the catalog row
 * carries the same value so the sidebar can still render a status dot for
 * sessions the LRU has evicted.
 */
export type LiveSessionLifecycle = 'idle' | 'busy' | 'retry' | 'error';

/** Per-directory list lifecycle. `'idle'` means the catalog has never tried. */
export type DirectoryListStatus = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * Metadata-only session record. No messages, no parts — those live in
 * `reducer.bySession`. The `hydrated` flag is a pointer into the reducer,
 * not a copy of it; consumers that need a transcript must call
 * `ensureHydrated(id)` and read from the reducer.
 */
export interface LiveSessionRecord {
  /** Stable session identity (server-confirmed). */
  id: PiSessionId;
  /** Normalized directory that owns this session. */
  directory: string;
  /** Parent session id for forks / clones, or null. */
  parentId: PiSessionId | null;
  /** Display title — the most recent title the catalog has seen. */
  title: string;
  /** Whether the session is hidden from the active sidebar. */
  archived: boolean;
  /** Server-confirmed creation timestamp (ms epoch). */
  createdAt: number;
  /** Last activity timestamp the catalog has observed (ms epoch). */
  updatedAt: number;
  /** Optional message preview from the listing API. */
  preview?: string;
  /** Optional message count from the listing API. */
  messageCount?: number;
  /** Live lifecycle mirror — see `LiveSessionLifecycle`. */
  lifecycle: LiveSessionLifecycle;
  /** True iff the session's transcript currently lives in `reducer.bySession`. */
  hydrated: boolean;
}

export interface PiSessionCatalogState {
  /** All known sessions keyed by id. Reference-stable for unaffected entries. */
  byId: ReadonlyMap<PiSessionId, LiveSessionRecord>;
  /** Per-directory membership, in the order the listing API returned them. */
  byDirectory: ReadonlyMap<string, readonly PiSessionId[]>;
  /** Per-directory list lifecycle. */
  listStatusByDirectory: ReadonlyMap<string, DirectoryListStatus>;
}

export const initialCatalog = (): PiSessionCatalogState => ({
  byId: new Map(),
  byDirectory: new Map(),
  listStatusByDirectory: new Map(),
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const normalizedDirectory = (directory: string): string =>
  normalizePath(directory) ?? directory;

/** Stable record signature for narrow no-op detection. */
const recordsStructurallyEqual = (left: LiveSessionRecord, right: LiveSessionRecord): boolean => (
  left.id === right.id
  && left.directory === right.directory
  && left.parentId === right.parentId
  && left.title === right.title
  && left.archived === right.archived
  && left.createdAt === right.createdAt
  && left.updatedAt === right.updatedAt
  && left.preview === right.preview
  && left.messageCount === right.messageCount
  && left.lifecycle === right.lifecycle
  && left.hydrated === right.hydrated
);

/** Drop the prior membership for `directory` and seed `next`. The order in
 *  `next` is preserved by the caller (typically the listing API's order). */
const replaceDirectoryMembership = (
  byId: Map<PiSessionId, LiveSessionRecord>,
  byDirectory: Map<string, readonly PiSessionId[]>,
  directory: string,
  next: readonly PiSessionId[],
): void => {
  // Delete records that are no longer in this directory's listing.
  const prior = byDirectory.get(directory) ?? [];
  for (const id of prior) {
    if (next.includes(id)) continue;
    byId.delete(id);
  }
  byDirectory.set(directory, [...next]);
};

/**
 * Apply a successful listing for one directory. Replaces that directory's
 * membership; other directories are untouched. Returns a new state object
 * only when the result actually changes; returns the input otherwise so
 * unaffected subscribers see a stable reference.
 */
export const applyDirectoryListToCatalog = (
  state: PiSessionCatalogState,
  directory: string,
  items: readonly PiSessionListItem[],
  now: number,
): PiSessionCatalogState => {
  const normalized = normalizedDirectory(directory);
  const nextIds: PiSessionId[] = [];
  let nextById: Map<PiSessionId, LiveSessionRecord> | null = null;
  let nextByDirectory: Map<string, readonly PiSessionId[]> | null = null;

  for (const item of items) {
    const session = item?.session;
    if (!session?.id || !session.directory) continue;
    const sessionDirectory = normalizedDirectory(session.directory);
    if (sessionDirectory !== normalized) continue; // cross-directory leakage guard
    // `timeArchived === 0` is the restored-session convention (see
    // `sync/DOCUMENTATION.md`); classify as active even when the raw
    // `archived` flag is true so the global archive split matches
    // `splitGlobalSessionsByArchived`.
    const isArchived = typeof session.timeArchived === 'number'
      ? session.timeArchived > 0
      : Boolean(session.archived);
    const nextRecord: LiveSessionRecord = {
      id: session.id,
      directory: sessionDirectory,
      parentId: session.parentId ?? null,
      title: session.title ?? '',
      archived: isArchived,
      createdAt: session.createdAt,
      updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)
        ? item.updatedAt
        : (typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt)
          ? session.updatedAt
          : now),
      ...(typeof item.preview === 'string' ? { preview: item.preview } : {}),
      ...(typeof session.messageCount === 'number' ? { messageCount: session.messageCount } : {}),
      // Listings do not carry lifecycle; preserve whatever the catalog
      // already had for this session (event-driven mirror), default to idle.
      lifecycle: state.byId.get(session.id)?.lifecycle ?? 'idle',
      hydrated: state.byId.get(session.id)?.hydrated ?? false,
    };
    const existing = state.byId.get(session.id);
    if (existing && recordsStructurallyEqual(existing, nextRecord)) {
      nextIds.push(session.id);
      continue;
    }
    if (!nextById) {
      nextById = new Map(state.byId);
      nextByDirectory = new Map(state.byDirectory);
    }
    nextById.set(session.id, nextRecord);
    nextIds.push(session.id);
  }

  const prior = state.byDirectory.get(normalized) ?? [];
  const priorIdsForDirectory = prior;
  // Detect a real membership change for this directory.
  const membershipChanged =
    priorIdsForDirectory.length !== nextIds.length
    || priorIdsForDirectory.some((id, index) => id !== nextIds[index]);
  if (!nextById && !membershipChanged) {
    // No record touched and membership unchanged — but a successful list
    // also flips the directory status from `'loading'`/`'failed'` to `'ready'`.
    if (state.listStatusByDirectory.get(normalized) !== 'ready') {
      const nextStatus = new Map(state.listStatusByDirectory);
      nextStatus.set(normalized, 'ready');
      return { ...state, listStatusByDirectory: nextStatus };
    }
    return state;
  }

  if (!nextById) nextById = new Map(state.byId);
  if (!nextByDirectory) nextByDirectory = new Map(state.byDirectory);

  // Replace the directory's membership, removing rows that are no longer listed.
  replaceDirectoryMembership(nextById, nextByDirectory, normalized, nextIds);

  let nextListStatus: Map<string, DirectoryListStatus> | null = null;
  if (state.listStatusByDirectory.get(normalized) !== 'ready') {
    nextListStatus = new Map(state.listStatusByDirectory);
    nextListStatus.set(normalized, 'ready');
  }

  return {
    byId: nextById,
    byDirectory: nextByDirectory,
    listStatusByDirectory: nextListStatus ?? state.listStatusByDirectory,
  };
};

/**
 * Mark a directory as loading. Returns the input unchanged if the catalog
 * was already in `'loading'` (or already `'ready'` — we don't downgrade
 * ready to loading on a duplicate trigger). Used by `refreshDirectoryCatalog`
 * so concurrent triggers don't churn listeners.
 */
export const markDirectoryLoading = (
  state: PiSessionCatalogState,
  directory: string,
): PiSessionCatalogState => {
  const normalized = normalizedDirectory(directory);
  const current = state.listStatusByDirectory.get(normalized);
  if (current === 'loading' || current === 'ready') return state;
  const next = new Map(state.listStatusByDirectory);
  next.set(normalized, 'loading');
  return { ...state, listStatusByDirectory: next };
};

/**
 * Mark a directory as failed. Existing catalog rows for that directory are
 * preserved — failure is not empty success. Returns the input unchanged if
 * the catalog was already in `'failed'`.
 */
export const markDirectoryFailed = (
  state: PiSessionCatalogState,
  directory: string,
): PiSessionCatalogState => {
  const normalized = normalizedDirectory(directory);
  const current = state.listStatusByDirectory.get(normalized);
  if (current === 'failed') return state;
  const next = new Map(state.listStatusByDirectory);
  next.set(normalized, 'failed');
  return { ...state, listStatusByDirectory: next };
};

/**
 * Update a single row's lifecycle. Returns the input unchanged if the
 * record is absent or already at the requested lifecycle (per narrow
 * no-op detection — a busy → busy event cannot rebuild subscribers).
 */
export const applyLifecycleChange = (
  state: PiSessionCatalogState,
  sessionId: PiSessionId,
  lifecycle: LiveSessionLifecycle,
): PiSessionCatalogState => {
  const existing = state.byId.get(sessionId);
  if (!existing) return state;
  if (existing.lifecycle === lifecycle) return state;
  const nextById = new Map(state.byId);
  nextById.set(sessionId, { ...existing, lifecycle });
  return { ...state, byId: nextById };
};

/**
 * Mirror the reducer's `lastAccess` / hydrate lifecycle into the catalog row.
 * Reference-stable when nothing changes; mirrors `applyLifecycleChange`'s
 * no-op rule for the `hydrated` flag.
 */
export const applyHydratedChange = (
  state: PiSessionCatalogState,
  sessionId: PiSessionId,
  hydrated: boolean,
): PiSessionCatalogState => {
  const existing = state.byId.get(sessionId);
  if (!existing) return state;
  if (existing.hydrated === hydrated) return state;
  const nextById = new Map(state.byId);
  nextById.set(sessionId, { ...existing, hydrated });
  return { ...state, byId: nextById };
};

/**
 * Update a single row's title and `updatedAt`. Returns the input unchanged
 * when both fields already match.
 */
export const applyTitleChange = (
  state: PiSessionCatalogState,
  sessionId: PiSessionId,
  title: string,
  updatedAt: number,
): PiSessionCatalogState => {
  const existing = state.byId.get(sessionId);
  if (!existing) return state;
  if (existing.title === title && existing.updatedAt === updatedAt) return state;
  const nextById = new Map(state.byId);
  nextById.set(sessionId, { ...existing, title, updatedAt });
  return { ...state, byId: nextById };
};

/**
 * Update a single row's `archived` flag. Does not move the row between the
 * active and archived categories — that is the consumer's responsibility
 * (the reducer does the same: archive flips a flag, the sidebar filters).
 */
export const applyArchiveChange = (
  state: PiSessionCatalogState,
  sessionId: PiSessionId,
  archived: boolean,
  updatedAt: number,
): PiSessionCatalogState => {
  const existing = state.byId.get(sessionId);
  if (!existing) return state;
  if (existing.archived === archived && existing.updatedAt === updatedAt) return state;
  const nextById = new Map(state.byId);
  nextById.set(sessionId, { ...existing, archived, updatedAt });
  return { ...state, byId: nextById };
};

/**
 * Insert or update a full catalog record. Used by `create()` to seed the
 * row before the daemon returns; also used by event handlers that carry a
 * complete session payload (e.g. `session.updated`).
 */
export const upsertRecord = (
  state: PiSessionCatalogState,
  record: LiveSessionRecord,
): PiSessionCatalogState => {
  const existing = state.byId.get(record.id);
  if (existing && recordsStructurallyEqual(existing, record)) return state;
  const nextById = new Map(state.byId);
  nextById.set(record.id, record);

  // Maintain byDirectory membership. If the record's directory already has
  // membership, replace any old position with the new one at the front (so
  // a freshly created session surfaces at the top of the directory list).
  const directoryIds = state.byDirectory.get(record.directory);
  if (directoryIds) {
    const filtered = directoryIds.filter((id) => id !== record.id);
    const nextByDirectory = new Map(state.byDirectory);
    nextByDirectory.set(record.directory, [record.id, ...filtered]);
    return { ...state, byId: nextById, byDirectory: nextByDirectory };
  }
  // First time we see this directory's membership.
  const nextByDirectory = new Map(state.byDirectory);
  nextByDirectory.set(record.directory, [record.id]);
  return { ...state, byId: nextById, byDirectory: nextByDirectory };
};

/**
 * Remove a record entirely. Used by `remove()` (after the daemon confirms
 * the deletion) and by event handlers that observe `session.deleted`.
 * Returns the input unchanged when the record was not present.
 */
export const removeRecord = (
  state: PiSessionCatalogState,
  sessionId: PiSessionId,
): PiSessionCatalogState => {
  const existing = state.byId.get(sessionId);
  if (!existing) return state;
  const nextById = new Map(state.byId);
  nextById.delete(sessionId);
  const directoryIds = state.byDirectory.get(existing.directory);
  let nextByDirectory: Map<string, readonly PiSessionId[]> | null = null;
  if (directoryIds) {
    const filtered = directoryIds.filter((id) => id !== sessionId);
    nextByDirectory = new Map(state.byDirectory);
    if (filtered.length === 0) {
      nextByDirectory.delete(existing.directory);
    } else {
      nextByDirectory.set(existing.directory, filtered);
    }
  }
  return {
    byId: nextById,
    byDirectory: nextByDirectory ?? state.byDirectory,
    listStatusByDirectory: state.listStatusByDirectory,
  };
};

/**
 * Map a catalog record to the UI `Session` shape that sidebar / header /
 * mobile lists consume. Catalog rows carry the same fields the listing
 * API returns, so this stays a thin structural mapping. The global
 * sessions store calls through to this helper until that store retires.
 */
export const liveSessionRecordToUiSession = (record: LiveSessionRecord): Session => ({
  id: record.id,
  directory: record.directory,
  parentID: record.parentId,
  title: record.title,
  time: {
    created: record.createdAt,
    updated: record.updatedAt,
    ...(record.archived ? { archived: record.updatedAt } : {}),
  },
});

// ---------------------------------------------------------------------------
// Concurrency-2 directory refresh scheduler
// ---------------------------------------------------------------------------

/**
 * Maximum number of in-flight per-directory refreshes. Matches the rule the
 * retiring global store used (`DIRECTORY_SESSION_REFRESH_CONCURRENCY = 2`).
 * Moving the scheduler out of the global store is what lets the global
 * store eventually become a thin wrapper around `PiSessionStore`; until
 * then, callers in either layer can hold a slot through this helper.
 */
const DIRECTORY_REFRESH_CONCURRENCY = 2;

let activeRefreshSlots = 0;
const refreshWaiters: Array<() => void> = [];

/**
 * Run `task` once a scheduler slot is free, with at most
 * `DIRECTORY_REFRESH_CONCURRENCY` tasks in flight at any moment. Multiple
 * callers awaiting a slot are served in FIFO order. Errors propagate to the
 * caller; the slot is released either way.
 */
export const withDirectoryRefreshSlot = async <T>(task: () => Promise<T>): Promise<T> => {
  if (activeRefreshSlots >= DIRECTORY_REFRESH_CONCURRENCY) {
    await new Promise<void>((resolve) => refreshWaiters.push(resolve));
  } else {
    activeRefreshSlots += 1;
  }
  try {
    return await task();
  } finally {
    const next = refreshWaiters.shift();
    if (next) next();
    else activeRefreshSlots = Math.max(0, activeRefreshSlots - 1);
  }
};

/** Run many directory refresh tasks with at most two in flight. */
export const mapDirectoriesWithRefreshSlot = <T, R>(
  directories: readonly T[],
  mapper: (value: T) => Promise<R>,
): Promise<R[]> => mapWithConcurrency([...directories], DIRECTORY_REFRESH_CONCURRENCY, async (directory) => withDirectoryRefreshSlot(() => mapper(directory)));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Reset the module-level scheduler. Tests call this between cases. */
export const __resetDirectoryRefreshSchedulerForTests = (): void => {
  activeRefreshSlots = 0;
  refreshWaiters.length = 0;
};