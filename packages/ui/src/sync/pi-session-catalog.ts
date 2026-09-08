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
import { getGlobalSessionDirectories } from './global-session-directory';


import type { PiSessionListItem } from '@/lib/pi/protocol';
import type { PiRetryInfo, PiSessionId } from '@/lib/pi/types';

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
  /** Retry countdown/error context while `lifecycle` is `retry`. */
  retry?: PiRetryInfo;
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

/**
 * Insert a minimal catalog row for a session that has not been listed by
 * any directory's RPC yet. Stubs carry only the identity, the event's
 * directory, and the lifecycle from the payload so the sidebar can render
 * the session as busy. The row is replaced wholesale when the directory's
 * listing finally lands; `applyDirectoryListToCatalog` preserves a non-idle
 * lifecycle on that path so a stub never gets downgraded to idle by a slow
 * list.
 */
export const upsertStubRecord = (
  state: PiSessionCatalogState,
  sessionId: PiSessionId,
  directory: string,
  lifecycle: LiveSessionLifecycle,
  now?: number,
): PiSessionCatalogState => {
  if (state.byId.has(sessionId)) return state;
  const normalized = normalizedDirectory(directory);
  const timestamp = now ?? Date.now();
  const record: LiveSessionRecord = {
    id: sessionId,
    directory: normalized,
    parentId: null,
    title: '',
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    lifecycle,
    hydrated: false,
  };
  const nextById = new Map(state.byId);
  nextById.set(sessionId, record);
  const prior = state.byDirectory.get(normalized);
  const nextByDirectory = new Map(state.byDirectory);
  if (prior && prior.includes(sessionId)) {
    nextByDirectory.set(normalized, prior);
  } else if (prior) {
    nextByDirectory.set(normalized, [sessionId, ...prior]);
  } else {
    nextByDirectory.set(normalized, [sessionId]);
  }
  return { ...state, byId: nextById, byDirectory: nextByDirectory };
};

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
  && left.retry === right.retry
  && left.hydrated === right.hydrated
);

/** Drop the prior membership for `directory` and seed `next`. The order in
 *  `next` is preserved by the caller (typically the listing API's order).
 *  A row is removed from `byId` only when no other directory still owns
 *  it — a session that has moved A → B must keep its B row when A's
 *  listing comes back without it. */
const replaceDirectoryMembership = (
  byId: Map<PiSessionId, LiveSessionRecord>,
  byDirectory: Map<string, readonly PiSessionId[]>,
  directory: string,
  next: readonly PiSessionId[],
): void => {
  const prior = byDirectory.get(directory) ?? [];
  for (const id of prior) {
    if (next.includes(id)) continue;
    // Only drop the row if this session does not belong to any other
    // directory in the catalog. A record whose `directory` is still `B`
    // means B's listing owns it; A's stale entry must not erase it.
    const record = byId.get(id);
    const ownedElsewhere = record && record.directory !== directory;
    if (!ownedElsewhere) {
      byId.delete(id);
    }
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
    // `archived` flag is true so the catalog archive filter matches
    // `listUiSessionsFromCatalog`.
    const isArchived = typeof session.timeArchived === 'number'
      ? session.timeArchived > 0
      : Boolean(session.archived);
    const existing = state.byId.get(session.id);
    const listedUpdatedAt = typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)
      ? item.updatedAt
      : (typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt)
        ? session.updatedAt
        : now);
    const nextRecord: LiveSessionRecord = {
      id: session.id,
      directory: sessionDirectory,
      parentId: session.parentId ?? null,
      title: session.title ?? '',
      archived: isArchived,
      createdAt: session.createdAt,
      // Recency is last-prompt. A later list must not overwrite a prompt stamp.
      updatedAt: existing ? existing.updatedAt : listedUpdatedAt,
      ...(typeof item.preview === 'string' ? { preview: item.preview } : {}),
      ...(typeof session.messageCount === 'number' ? { messageCount: session.messageCount } : {}),
      // Listings do not carry lifecycle; preserve whatever the catalog
      // already had for this session (event-driven mirror), default to idle.
      lifecycle: existing?.lifecycle ?? 'idle',
      ...(existing?.retry ? { retry: existing.retry } : {}),
      hydrated: existing?.hydrated ?? false,
    };
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
  retry?: PiRetryInfo,
): PiSessionCatalogState => {
  const existing = state.byId.get(sessionId);
  if (!existing) return state;
  const nextRetry = lifecycle === 'retry' ? retry : undefined;
  if (existing.lifecycle === lifecycle && existing.retry === nextRetry) return state;
  const nextById = new Map(state.byId);
  nextById.set(sessionId, { ...existing, lifecycle, retry: nextRetry });
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
 * Last-prompt recency. Only the send path should call this — lifecycle and
 * snapshot events must not bump `updatedAt` or the sidebar would reorder
 * mid-turn and on session switch.
 */
export const touchRecordUpdatedAt = (
  state: PiSessionCatalogState,
  sessionId: PiSessionId,
  updatedAt: number,
  stub?: { directory: string; lifecycle: LiveSessionLifecycle },
): PiSessionCatalogState => {
  const existing = state.byId.get(sessionId);
  if (!existing) {
    if (!stub) return state;
    const withStub = upsertStubRecord(state, sessionId, stub.directory, stub.lifecycle, updatedAt);
    const stubRow = withStub.byId.get(sessionId);
    if (!stubRow || stubRow.updatedAt === updatedAt) return withStub;
    const nextById = new Map(withStub.byId);
    nextById.set(sessionId, { ...stubRow, updatedAt });
    return { ...withStub, byId: nextById };
  }
  if (existing.updatedAt >= updatedAt && existing.lifecycle === (stub?.lifecycle ?? existing.lifecycle)) {
    return state;
  }
  const nextById = new Map(state.byId);
  nextById.set(sessionId, {
    ...existing,
    updatedAt: Math.max(existing.updatedAt, updatedAt),
    ...(stub?.lifecycle ? { lifecycle: stub.lifecycle } : {}),
  });
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
const uiSessionByRecord = new WeakMap<LiveSessionRecord, Session>();

export const liveSessionRecordToUiSession = (record: LiveSessionRecord): Session => {
  const cached = uiSessionByRecord.get(record);
  if (cached) return cached;
  const session: Session = {
    id: record.id,
    directory: record.directory,
    parentID: record.parentId,
    title: record.title,
    ...(typeof record.messageCount === 'number' ? { messageCount: record.messageCount } : {}),
    time: {
      created: record.createdAt,
      updated: record.updatedAt,
      ...(record.archived ? { archived: record.updatedAt } : {}),
    },
  };
  uiSessionByRecord.set(record, session);
  return session;
};

export const EMPTY_UI_SESSIONS: Session[] = [];

export const uiSessionListEqual = (left: readonly Session[], right: readonly Session[]): boolean => {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

export const listUiSessionsFromCatalog = (
  catalog: PiSessionCatalogState,
  options?: { archived?: boolean; directory?: string | null },
): Session[] => {
  const archived = options?.archived ?? false;
  // Omitted or `undefined` directory = runtime-wide catalog. The React hook
  // always passes `{ archived, directory }`, so `undefined` must not be
  // treated as an empty focused slice. Only `null` / `''` mean "no
  // focused directory; show nothing."
  const directory = options?.directory;
  let ids: readonly string[];
  if (typeof directory === 'string' && directory.length > 0) {
    const normalized = normalizedDirectory(directory);
    const base = catalog.byDirectory.get(normalized) ?? [];
    const globalDirs = getGlobalSessionDirectories();
    if (!globalDirs.includes(normalized)) {
      ids = base;
    } else {
      const globalIds: string[] = [];
      const seen = new Set<string>(base);
      for (const globalDirectory of globalDirs) {
        if (globalDirectory === normalized) continue;
        const aliasIds = catalog.byDirectory.get(globalDirectory);
        if (!aliasIds) continue;
        for (const id of aliasIds) {
          if (seen.has(id)) continue;
          seen.add(id);
          globalIds.push(id);
        }
      }
      ids = globalIds.length > 0 ? [...base, ...globalIds] : base;
    }
  } else if (directory === null || directory === '') {
    return EMPTY_UI_SESSIONS;
  } else {
    ids = [...catalog.byId.keys()];
  }
  const sessions: Session[] = [];
  for (const id of ids) {
    const record = catalog.byId.get(id);
    if (!record) continue;
    if (Boolean(record.archived) !== archived) continue;
    sessions.push(liveSessionRecordToUiSession(record));
  }
  return sessions.length === 0 ? EMPTY_UI_SESSIONS : sessions;
};

export const listLiveSessionRecordsFromCatalog = (
  catalog: PiSessionCatalogState,
): LiveSessionRecord[] => {
  const records: LiveSessionRecord[] = [];
  for (const record of catalog.byId.values()) {
    if (record.lifecycle === 'busy' || record.lifecycle === 'retry') records.push(record);
  }
  return records;
};

export const catalogLiveSessionIdsKey = (catalog: PiSessionCatalogState): string => {
  const ids: string[] = [];
  for (const record of catalog.byId.values()) {
    if (record.lifecycle === 'busy' || record.lifecycle === 'retry') ids.push(record.id);
  }
  ids.sort();
  return ids.join('|');
};

// ---------------------------------------------------------------------------
// List/mutation reconciliation — owned by the PiSessionStore catalog.
// ---------------------------------------------------------------------------

/**
 * Reconcile a stale-prone directory listing against catalog mutations that
 * committed after the listing started.
 *
 * `baseline` is the catalog captured synchronously when the list operation
 * started (held in the operation's closure, so its lifetime is exactly the
 * RPC duration — no unbounded tombstone history). `current` is the catalog
 * at commit time, which already includes every rename/archive/remove/create
 * /detail-upsert/stream-event mutation that landed while the RPC was in
 * flight. `tombstones` carries removal ids for rows that were already
 * absent at both snapshots (a `remove()` of an unlisted row is a no-op
 * locally, so the baseline comparison alone cannot see it). Tombstones live
 * only while at least one list is in flight and are cleared when the last
 * list settles; a delete confirmed before any list started is not an
 * in-flight contract (stale server echoes rely on authoritative
 * disappearance for unmutated rows, never on unbounded history).
 *
 * Per-session rules, never whole-response rejection (one failed or stale
 * entity must not erase unrelated complete entities):
 *
 * - Existing rows that still belong to `directory` use a field-sensitive
 *   overlay. Only `title`/`archived` values actually changed since `baseline`
 *   are preserved from `current`; all other listing fields come from the
 *   fresh payload. Live `lifecycle`/`retry`/`hydrated`/`updatedAt` are
 *   preserved via `applyDirectoryListToCatalog`'s normal merge, so a busy
 *   event during the list cannot freeze stale title/archive while a true
 *   local rename/archive newer than the list start survives. Listing-only
 *   fields (`preview`/`messageCount`/`parentId`/`createdAt`) always take the
 *   listing's authoritative values. Added rows that the stale listing already
 *   contains are left to `applyDirectoryListToCatalog` (it preserves a
 *   stub's busy lifecycle while taking the listing's authoritative title),
 *   so a pre-list busy stub is never frozen with an empty title.
 * - A row deleted after the listing started (baseline had it, current does
 *   not, or its id is in `tombstones`) is filtered out of the stale listing
 *   so the response cannot resurrect it.
 * - A row that moved out of `directory` after the listing started (current
 *   directory differs) is filtered out of this directory's stale listing;
 *   the owning directory's row survives via the `ownedElsewhere` rule.
 * - Unmutated rows trust the listing, including authoritative disappearance
 *   (present in baseline, unchanged locally, omitted from a complete
 *   snapshot).
 * - Omitted mutated rows are retained as current known proof, distinguished
 *   by cause: locally mutated metadata (`title`/`archived` changed) or a
 *   newly added row survives because the mutation is newer than the stale
 *   listing; a live-only change (`lifecycle`/`retry`/`hydrated`/`updatedAt`)
 *   survives because live activity observed after the list started proves
 *   the row still exists on the connected runtime.
 */
export const applyDirectoryListWithReconciliation = (
  baseline: PiSessionCatalogState,
  current: PiSessionCatalogState,
  directory: string,
  items: readonly PiSessionListItem[],
  now: number,
  tombstones?: ReadonlySet<string>,
): PiSessionCatalogState => {
  const normalized = normalizedDirectory(directory);
  // Validate + filter the fresh payload to this directory first, preserving
  // order and dropping cross-directory leakage (same guard as the plain apply).
  const freshIdsOrdered: PiSessionId[] = [];
  const freshItemsForDir: PiSessionListItem[] = [];
  const freshSeen = new Set<PiSessionId>();
  for (const item of items) {
    const session = item?.session;
    if (!session?.id || !session.directory) continue;
    if (normalizedDirectory(session.directory) !== normalized) continue;
    if (freshSeen.has(session.id)) continue;
    freshSeen.add(session.id);
    freshIdsOrdered.push(session.id);
    freshItemsForDir.push(item);
  }
  const freshSet = new Set(freshIdsOrdered);
  const baselineMem = baseline.byDirectory.get(normalized) ?? [];
  const currentMem = current.byDirectory.get(normalized) ?? [];
  const baselineSet = new Set(baselineMem);
  // Rows deleted after the list started: baseline membership had them, the
  // current catalog has no row at all. Filtered so a stale listing cannot
  // resurrect them.
  const deletedViaSnapshot = new Set<PiSessionId>();
  for (const id of baselineSet) {
    if (!current.byId.has(id)) deletedViaSnapshot.add(id);
  }
  // Per-session mutation scan, scoped to ids relevant to this directory
  // (baseline/current membership or the fresh payload). O(dir + fresh), never
  // a full-catalog scan — listings are low-frequency but directories can hold
  // hundreds of rows. No extra registry: compare `baseline` vs `current`
  // field-by-field for the two locally mutated metadata fields
  // (`title`/`archived`); live fields (`lifecycle`/`retry`/`hydrated`/
  // `updatedAt`) ride the normal merge below.
  const addedOmitted = new Map<PiSessionId, LiveSessionRecord>();
  const omittedMetadata = new Map<PiSessionId, LiveSessionRecord>();
  const omittedLive = new Map<PiSessionId, LiveSessionRecord>();
  const overlayPresent = new Map<PiSessionId, { rec: LiveSessionRecord; titleChanged: boolean; archivedChanged: boolean }>();
  const movedOutIds = new Set<PiSessionId>();
  const relevant = new Set<PiSessionId>();
  for (const id of baselineMem) relevant.add(id);
  for (const id of currentMem) relevant.add(id);
  for (const id of freshIdsOrdered) relevant.add(id);
  for (const id of relevant) {
    const currentRec = current.byId.get(id);
    if (!currentRec) continue; // deleted — handled above / via tombstones.
    const baselineRec = baseline.byId.get(id);
    if (baselineRec === currentRec) continue; // unmutated — trust the listing.
    if (currentRec.directory !== normalized) {
      // Moved out of this directory after the list started (or a stale dual
      // membership entry). Exclude the stale listing row; the owning
      // directory keeps the current row via `ownedElsewhere`.
      if (baselineRec && (baselineRec.directory === normalized || baselineSet.has(id) || freshSet.has(id))) {
        movedOutIds.add(id);
      }
      continue;
    }
    if (!baselineRec) {
      // Added during the list. When the stale listing already contains the id
      // (pre-list busy/detail stub), leave it to the plain apply so the
      // listing's authoritative title wins while the stub's busy lifecycle is
      // preserved. Only rows the stale listing omits (true creates / moves-in
      // / remote stubs) need explicit preservation.
      if (freshSet.has(id)) continue;
      addedOmitted.set(id, currentRec);
      continue;
    }
    // Existing row that still belongs here: field-sensitive. Preserve only
    // metadata actually changed since baseline; live fields are already
    // preserved by the normal merge and listing-only fields always take the
    // listing. A lifecycle/hydration-only change must not freeze old title.
    const titleChanged = currentRec.title !== baselineRec.title;
    const archivedChanged = currentRec.archived !== baselineRec.archived;
    if (freshSet.has(id)) {
      if (titleChanged || archivedChanged) {
        overlayPresent.set(id, { rec: currentRec, titleChanged, archivedChanged });
      }
      // Live-only: trust the listing's title/archive, keep current live via merge.
      continue;
    }
    if (titleChanged || archivedChanged) {
      omittedMetadata.set(id, currentRec);
    } else {
      // Live-only but omitted: live observed after list start proves existence.
      omittedLive.set(id, currentRec);
    }
  }
  const filteredItems = freshItemsForDir.filter((item) => {
    const id = item.session.id;
    if (deletedViaSnapshot.has(id)) return false;
    if (tombstones?.has(id)) return false;
    if (movedOutIds.has(id)) return false;
    return true;
  });
  const intermediate = applyDirectoryListToCatalog(current, normalized, filteredItems, now);
  let nextById: Map<PiSessionId, LiveSessionRecord> | null = null;
  // Field-sensitive overlay for present rows: only changed title/archive win.
  // Live lifecycle/retry/hydrated/updatedAt already ride the normal merge.
  for (const [id, info] of overlayPresent) {
    const intermediateRec = intermediate.byId.get(id);
    if (!intermediateRec) {
      // Filtered via tombstone (remove-then-recreate same id): the stale
      // listing row is gone, so retain the recreated current row below.
      omittedMetadata.set(id, info.rec);
      continue;
    }
    const nextTitle = info.titleChanged ? info.rec.title : intermediateRec.title;
    const nextArchived = info.archivedChanged ? info.rec.archived : intermediateRec.archived;
    if (intermediateRec.title !== nextTitle || intermediateRec.archived !== nextArchived) {
      if (!nextById) nextById = new Map(intermediate.byId);
      nextById.set(id, { ...intermediateRec, title: nextTitle, archived: nextArchived });
    }
  }
  if (addedOmitted.size === 0 && omittedMetadata.size === 0 && omittedLive.size === 0 && !nextById) return intermediate;
  const effectiveById = nextById ?? intermediate.byId;
  const intermediateMem = intermediate.byDirectory.get(normalized) ?? [];
  const intermediateSet = new Set(intermediateMem);
  // Rows the stale listing omitted but still owned: re-insert in
  // current-membership order (new creates surface at the front, matching
  // `upsertRecord`), ahead of the listing's authoritative order. Metadata-
  // mutated, newly added, and live-only rows all retain existence — the
  // first two because the mutation is newer than the stale listing, the last
  // because live observed after list start proves the row still exists.
  const preservedForReinsert = new Map<PiSessionId, LiveSessionRecord>([
    ...addedOmitted,
    ...omittedMetadata,
    ...omittedLive,
  ]);
  const toReinsert: PiSessionId[] = [];
  for (const id of currentMem) {
    if (preservedForReinsert.has(id) && !intermediateSet.has(id)) toReinsert.push(id);
  }
  let nextByDirectory: Map<string, readonly PiSessionId[]> | null = null;
  if (toReinsert.length > 0) {
    nextByDirectory = new Map(intermediate.byDirectory);
    nextByDirectory.set(normalized, [...toReinsert, ...intermediateMem]);
    if (!nextById) nextById = new Map(effectiveById);
    for (const id of toReinsert) {
      const rec = preservedForReinsert.get(id);
      if (rec) nextById.set(id, rec);
    }
  }
  if (!nextById && !nextByDirectory) return intermediate;
  return {
    byId: nextById ?? intermediate.byId,
    byDirectory: nextByDirectory ?? intermediate.byDirectory,
    listStatusByDirectory: intermediate.listStatusByDirectory,
  };
};

// ---------------------------------------------------------------------------
// Concurrency-2 directory refresh scheduler
// ---------------------------------------------------------------------------

/**
 * Maximum number of in-flight per-directory refreshes. Owned by the catalog
 * (`DIRECTORY_SESSION_REFRESH_CONCURRENCY = 2`); `PiSessionStore` is the
 * single mutation authority that holds slots through this helper.
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

/** Run many directory refresh tasks with at most two in flight. The
 *  `withDirectoryRefreshSlot` limiter is the single concurrency cap; the
 *  scheduler inside `mapWithConcurrency` would create a *nested* cap that
 *  could deadlock once the catalog owner also takes slots internally.
 *  Keep this single-limiter rule documented at every call site. */
export const mapDirectoriesWithRefreshSlot = <T, R>(
  directories: readonly T[],
  mapper: (value: T) => Promise<R>,
): Promise<R[]> => mapWithConcurrency(
  [...directories],
  DIRECTORY_REFRESH_CONCURRENCY,
  async (directory) => mapper(directory),
);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Reset the module-level scheduler. Tests call this between cases. */
export const __resetDirectoryRefreshSchedulerForTests = (): void => {
  activeRefreshSlots = 0;
  refreshWaiters.length = 0;
};