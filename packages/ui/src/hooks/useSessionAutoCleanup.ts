import React from 'react';
import type { Session } from '@/lib/chat/types';
import type { PiSessionShelfEntry } from '@/lib/pi/protocol';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { loadSessionCatalog } from '@/sync/session-catalog-access';
import { resolveGlobalSessionDirectory } from '@/lib/chat/sessionDirectory';
import { liveSessionRecordToUiSession, type LiveSessionRecord, type PiSessionCatalogState } from '@/sync/pi-session-catalog';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isAutoArchiveCandidate } from '@/lib/sessionShelf';
import { useUIStore } from '@/stores/useUIStore';
import { isSessionPinned, useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { useSessionShelfStore } from '@/stores/useSessionShelfStore';

/**
 * Automatic session cleanup in two passes:
 *
 * 1. Archive: sessions idle longer than `sessionAutoArchiveAfterDays`, except
 *    pinned, running, waiting on the user, snoozed until the wake, and the
 *    open session (`isAutoArchiveCandidate`).
 * 2. Delete: archived sessions whose archive time is older than
 *    `sessionAutoDeleteAfterDays`. A session that isn't archived, or whose
 *    archive time is unknown, is never a candidate.
 *
 * A setting of 0 turns its pass off. Runs happen on load and hourly while a
 * client is open, and from Settings. Several clients may run at once:
 * archiving is idempotent and every write is rechecked against fresh state.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const AUTO_RUN_INTERVAL_MS = 60 * 60 * 1000;
// The first automatic run waits a moment after cleanup turns on, so typing a
// number into the setting (3, then 30) does not act on the partial value.
const AUTO_RUN_DELAY_MS = 10_000;

type CleanupSkippedReason = 'disabled' | 'partial' | 'stale';

type CleanupPassResult = {
  completedIds: string[];
  /** Candidates not written: unready directory, failed write, or no longer a candidate on recheck. */
  failedIds: string[];
  skippedReason?: CleanupSkippedReason;
};

type CleanupResult = {
  archive: CleanupPassResult;
  delete: CleanupPassResult;
  /** `partial` or `stale` when either pass was; `disabled` when both are off. */
  skippedReason?: 'running' | CleanupSkippedReason;
};

type CleanupRules = {
  archiveDays: number;
  deleteDays: number;
  currentSessionId: string | null;
  pinnedIds: Set<string>;
  shelfEntries: Readonly<Record<string, PiSessionShelfEntry>>;
  now: number;
};

const isArchiveCandidateRecord = (record: LiveSessionRecord, rules: CleanupRules): boolean => {
  if (record.archived) return false;
  return isAutoArchiveCandidate({
    entry: rules.shelfEntries[record.id],
    pinned: isSessionPinned(rules.pinnedIds, record.directory, record.id),
    working: record.lifecycle === 'busy' || record.lifecycle === 'retry',
    needsInput: record.pendingInput != null,
    updatedAt: record.updatedAt,
    now: rules.now,
    open: record.id === rules.currentSessionId,
  }, rules.archiveDays);
};

const isDeleteCandidateRecord = (record: LiveSessionRecord, rules: CleanupRules): boolean => {
  if (!(rules.deleteDays > 0) || !record.archived) return false;
  if (record.id === rules.currentSessionId) return false;
  if (typeof record.archivedAt !== 'number' || !(record.archivedAt > 0)) return false;
  return record.archivedAt < rules.now - rules.deleteDays * DAY_MS;
};

/** Candidate ids for both passes, for the Settings page's counts. */
const listAutoCleanupCandidates = (
  records: Iterable<LiveSessionRecord>,
  rules: CleanupRules,
): { archive: string[]; delete: string[] } => {
  const archive: string[] = [];
  const toDelete: string[] = [];
  for (const record of records) {
    if (isArchiveCandidateRecord(record, rules)) archive.push(record.id);
    else if (isDeleteCandidateRecord(record, rules)) toDelete.push(record.id);
  }
  return { archive, delete: toDelete };
};

/**
 * Split candidate ids into ready-directory (authoritative, safe to mutate)
 * and unready (failed/idle/unknown — never written) buckets, so one failed
 * scope never blocks unrelated ready scopes.
 */
export const partitionCleanupCandidates = (
  candidateIds: readonly string[],
  sessionById: ReadonlyMap<string, Session>,
  readyDirectories: ReadonlySet<string>,
): { actionable: string[]; unready: string[] } => {
  const actionable: string[] = [];
  const unready: string[] = [];
  for (const id of candidateIds) {
    const session = sessionById.get(id);
    const directory = session ? resolveGlobalSessionDirectory(session) : null;
    if (directory && readyDirectories.has(directory)) actionable.push(id);
    else unready.push(id);
  }
  return { actionable, unready };
};

type CleanupRuntimeCapture = {
  store: ReturnType<typeof getPiSessionStore>;
  runtimeKey: string;
  generation: number;
};

/**
 * Single captured-runtime authority check. Any read failure denies
 * authority — there is no fallback generation that could grant a write.
 */
const captureCleanupRuntime = (): CleanupRuntimeCapture | null => {
  try {
    const store = getPiSessionStore();
    return { store, runtimeKey: getRuntimeKey(), generation: store.getRuntimeGeneration() };
  } catch {
    return null;
  }
};

const isCleanupRuntimeCurrent = (captured: CleanupRuntimeCapture): boolean => {
  try {
    const live = getPiSessionStore();
    if (live !== captured.store) return false;
    if (getRuntimeKey() !== captured.runtimeKey) return false;
    return live.getRuntimeGeneration() === captured.generation;
  } catch {
    return false;
  }
};

const readRetentionDays = (): { archiveDays: number; deleteDays: number } => {
  const ui = useUIStore.getState();
  return {
    archiveDays: ui.sessionAutoArchiveAfterDays ?? 0,
    deleteDays: ui.sessionAutoDeleteAfterDays ?? 0,
  };
};

/**
 * Fresh rules for one write. The shelf entries count only when they are a
 * successful read for the captured runtime; otherwise snoozes are unknown and
 * `shelfReady` is false.
 */
const readFreshRules = (captured: CleanupRuntimeCapture, now: number): CleanupRules & { shelfReady: boolean } => {
  const shelf = useSessionShelfStore.getState();
  return {
    ...readRetentionDays(),
    currentSessionId: useSessionUIStore.getState().currentSessionId ?? null,
    pinnedIds: useSessionPinnedStore.getState().ids,
    shelfEntries: shelf.entries,
    shelfReady: shelf.status === 'ready' && shelf.runtimeKey === captured.runtimeKey,
    now,
  };
};

let cleanupActive = false;

/** Test-only reset for the module running guard. */
export const __resetSessionAutoCleanupForTests = (): void => {
  cleanupActive = false;
};

const disabledPass = (): CleanupPassResult => ({ completedIds: [], failedIds: [], skippedReason: 'disabled' });
const partialPass = (): CleanupPassResult => ({ completedIds: [], failedIds: [], skippedReason: 'partial' });
const stalePass = (): CleanupPassResult => ({ completedIds: [], failedIds: [], skippedReason: 'stale' });

type CleanupPass = {
  /** Still a candidate under fresh rules; also false when the pass turned off. */
  isCandidate: (record: LiveSessionRecord, rules: CleanupRules & { shelfReady: boolean }) => boolean;
  write: (store: ReturnType<typeof getPiSessionStore>, id: string, directory: string) => Promise<unknown>;
};

const ARCHIVE_PASS: CleanupPass = {
  isCandidate: (record, rules) => rules.shelfReady && isArchiveCandidateRecord(record, rules),
  write: (store, id, directory) => store.archive(id, true, directory),
};

const DELETE_PASS: CleanupPass = {
  isCandidate: (record, rules) => isDeleteCandidateRecord(record, rules),
  write: (store, id, directory) => store.remove(id, directory),
};

/**
 * One pass over the catalog: pick candidates, write only ready-directory
 * ids, and recheck runtime, rules, and the live row before each write so a
 * session opened, revived, pinned, or unarchived during an earlier await is
 * skipped.
 */
const runCleanupPass = async (
  pass: CleanupPass,
  captured: CleanupRuntimeCapture,
  catalog: PiSessionCatalogState,
  readyDirectories: ReadonlySet<string>,
  hasFailedDirectories: boolean,
  now: number,
): Promise<CleanupPassResult> => {
  let candidateIds: string[];
  let sessionById: Map<string, Session>;
  try {
    const rules = readFreshRules(captured, now);
    candidateIds = [];
    sessionById = new Map();
    for (const record of catalog.byId.values()) {
      if (!pass.isCandidate(record, rules)) continue;
      candidateIds.push(record.id);
      sessionById.set(record.id, liveSessionRecordToUiSession(record));
    }
  } catch {
    return partialPass();
  }

  const { actionable, unready } = partitionCleanupCandidates(candidateIds, sessionById, readyDirectories);
  const completedIds: string[] = [];
  const failedIds: string[] = [...unready];

  for (let index = 0; index < actionable.length; index += 1) {
    const id = actionable[index]!;
    if (!isCleanupRuntimeCurrent(captured)) {
      failedIds.push(...actionable.slice(index));
      return { completedIds, failedIds, skippedReason: 'stale' };
    }

    let directory: string | null = null;
    try {
      const rules = readFreshRules(captured, now);
      const liveCatalog = getPiSessionStore().getState().catalog;
      const record = liveCatalog.byId.get(id);
      if (record && pass.isCandidate(record, rules)) {
        const resolved = resolveGlobalSessionDirectory(liveSessionRecordToUiSession(record));
        if (resolved && liveCatalog.listStatusByDirectory.get(resolved) === 'ready') directory = resolved;
      }
    } catch {
      directory = null;
    }
    if (!directory) {
      failedIds.push(id);
      continue;
    }

    try {
      await pass.write(getPiSessionStore(), id, directory);
    } catch {
      failedIds.push(id);
      continue;
    }

    if (!isCleanupRuntimeCurrent(captured)) {
      failedIds.push(id, ...actionable.slice(index + 1));
      return { completedIds, failedIds, skippedReason: 'stale' };
    }
    completedIds.push(id);
  }

  if (hasFailedDirectories || failedIds.length > 0) return { completedIds, failedIds, skippedReason: 'partial' };
  return { completedIds, failedIds };
};

const combineSkipped = (archive: CleanupPassResult, remove: CleanupPassResult): CleanupResult['skippedReason'] => {
  const reasons = [archive.skippedReason, remove.skippedReason];
  if (reasons.includes('stale')) return 'stale';
  if (reasons.includes('partial')) return 'partial';
  if (reasons.every((reason) => reason === 'disabled')) return 'disabled';
  return undefined;
};

type RunNowOptions = {
  now?: number;
};

/**
 * Owning run routine for both passes. The hook stays a thin React shell
 * (scheduling and Settings counts); orchestration lives here so async
 * behavior is testable without mounting DOM.
 *
 * Invariants:
 * - The running guard is claimed before the first await.
 * - Only `ready` directories are written; one failed scope never blocks
 *   ready scopes, and makes the result `partial`.
 * - The archive pass needs a successful shelf read for this runtime (snooze
 *   state); without one it writes nothing and reports `partial`.
 * - Stale (runtime moved) vs partial (incomplete/failed scopes) are explicit.
 * - Never rejects: a thrown load becomes `partial`.
 */
export const runSessionAutoCleanupNow = async ({ now: nowOverride }: RunNowOptions = {}): Promise<CleanupResult> => {
  if (cleanupActive) {
    return { archive: disabledPass(), delete: disabledPass(), skippedReason: 'running' };
  }

  let days: { archiveDays: number; deleteDays: number };
  try {
    days = readRetentionDays();
  } catch {
    return { archive: partialPass(), delete: partialPass(), skippedReason: 'partial' };
  }
  const archiveOn = days.archiveDays > 0;
  const deleteOn = days.deleteDays > 0;
  if (!archiveOn && !deleteOn) {
    return { archive: disabledPass(), delete: disabledPass(), skippedReason: 'disabled' };
  }

  const finish = (archive: CleanupPassResult, remove: CleanupPassResult): CleanupResult => ({
    archive,
    delete: remove,
    skippedReason: combineSkipped(archive, remove),
  });
  const forEnabled = (make: () => CleanupPassResult): CleanupResult => finish(
    archiveOn ? make() : disabledPass(),
    deleteOn ? make() : disabledPass(),
  );

  const captured = captureCleanupRuntime();
  if (!captured) return forEnabled(stalePass);

  const now = nowOverride ?? Date.now();
  cleanupActive = true;
  try {
    let loadResult: Awaited<ReturnType<typeof loadSessionCatalog>>;
    try {
      // A failed shelf read leaves the store `failed`; the archive pass sees that.
      const shelfLoad = archiveOn ? useSessionShelfStore.getState().load() : Promise.resolve();
      [loadResult] = await Promise.all([loadSessionCatalog(), shelfLoad]);
    } catch {
      return forEnabled(partialPass);
    }

    if (loadResult.stale || !isCleanupRuntimeCurrent(captured)) return forEnabled(stalePass);
    if (loadResult.readyDirectories.size === 0) return forEnabled(partialPass);

    const hasFailedDirectories = loadResult.failedDirectories.size > 0;
    let archive = disabledPass();
    if (archiveOn) {
      archive = readFreshRules(captured, now).shelfReady
        ? await runCleanupPass(ARCHIVE_PASS, captured, loadResult.catalog, loadResult.readyDirectories, hasFailedDirectories, now)
        : partialPass();
      if (archive.skippedReason === 'stale') return finish(archive, deleteOn ? stalePass() : disabledPass());
    }

    let remove = disabledPass();
    if (deleteOn) {
      // The live catalog, so sessions archived a moment ago carry their new time.
      remove = await runCleanupPass(
        DELETE_PASS,
        captured,
        getPiSessionStore().getState().catalog,
        loadResult.readyDirectories,
        hasFailedDirectories,
        now,
      );
    }
    return finish(archive, remove);
  } catch {
    return forEnabled(partialPass);
  } finally {
    cleanupActive = false;
  }
};

type CleanupOptions = {
  /** Run on load and hourly (the app shell). Settings passes false. */
  autoRun?: boolean;
  enabled?: boolean;
};

const EMPTY_RECORDS: ReadonlyMap<string, LiveSessionRecord> = new Map();
const EMPTY_CANDIDATES = { archive: [] as string[], delete: [] as string[] };

export const useSessionAutoCleanup = (enabledOrOptions?: boolean | CleanupOptions) => {
  const options = typeof enabledOrOptions === 'object' ? enabledOrOptions : undefined;
  const autoRun = options?.autoRun !== false;
  const enabled = typeof enabledOrOptions === 'boolean' ? enabledOrOptions : (options?.enabled ?? true);
  const showCounts = enabled && !autoRun;

  const archiveDays = useUIStore((state) => state.sessionAutoArchiveAfterDays);
  const deleteDays = useUIStore((state) => state.sessionAutoDeleteAfterDays);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const pinnedIds = useSessionPinnedStore((state) => state.ids);
  const shelfEntries = useSessionShelfStore((state) => state.entries);
  // Same gate as the run: without this runtime's shelf, snoozed sessions
  // can't be told apart, so no archive count is shown.
  const shelfReady = useSessionShelfStore((state) => state.status === 'ready' && state.runtimeKey === getRuntimeKey());
  // Only Settings needs the counts; the app shell's hook never wakes on catalog changes.
  const records = usePiSessionSnapshot(
    (state) => (showCounts ? state.catalog.byId : EMPTY_RECORDS),
    undefined,
    'catalog',
  );

  React.useEffect(() => {
    if (showCounts) void useSessionShelfStore.getState().load();
  }, [showCounts]);

  const candidates = React.useMemo(() => {
    if (!showCounts) return EMPTY_CANDIDATES;
    const result = listAutoCleanupCandidates(records.values(), {
      archiveDays,
      deleteDays,
      currentSessionId: currentSessionId ?? null,
      pinnedIds,
      shelfEntries,
      now: Date.now(),
    });
    return shelfReady ? result : { ...result, archive: [] };
  }, [showCounts, shelfReady, records, archiveDays, deleteDays, currentSessionId, pinnedIds, shelfEntries]);

  const [isRunning, setIsRunning] = React.useState(false);
  const runCleanup = React.useCallback(async (): Promise<CleanupResult> => {
    setIsRunning(true);
    try {
      return await runSessionAutoCleanupNow();
    } finally {
      setIsRunning(false);
    }
  }, []);

  // Automatic runs: once shortly after cleanup turns on (which includes
  // settings arriving from the server), then hourly. No toast. Each run reads
  // the current settings itself.
  const autoActive = enabled && autoRun && (archiveDays > 0 || deleteDays > 0);
  React.useEffect(() => {
    if (!autoActive) return;
    const run = () => {
      // runSessionAutoCleanupNow never rejects, and returns `running` when a run is in progress.
      void runSessionAutoCleanupNow();
    };
    const first = window.setTimeout(run, AUTO_RUN_DELAY_MS);
    const interval = window.setInterval(run, AUTO_RUN_INTERVAL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
  }, [autoActive]);

  return {
    archiveCandidates: candidates.archive,
    deleteCandidates: candidates.delete,
    isRunning,
    runCleanup,
  };
};
