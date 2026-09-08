import React from 'react';
import type { Session } from '@/lib/chat/types';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { loadSessionCatalog } from '@/sync/session-catalog-access';
import { resolveGlobalSessionDirectory } from '@/lib/chat/sessionDirectory';
import { liveSessionRecordToUiSession, listUiSessionsFromCatalog, uiSessionListEqual } from '@/sync/pi-session-catalog';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';

const DAY_MS = 24 * 60 * 60 * 1000;
const AUTO_DELETE_KEEP_RECENT = 5;
const AUTO_DELETE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const EMPTY_SESSIONS: Session[] = [];

const getSessionLastActivity = (session: Session): number => {
  return session.time?.updated ?? session.time?.created ?? 0;
};

type BuildAutoDeleteCandidatesOptions = {
  sessions: Session[];
  currentSessionId: string | null;
  cutoffDays: number;
  keepRecent?: number;
  now?: number;
};

export const buildAutoDeleteCandidates = ({
  sessions,
  currentSessionId,
  cutoffDays,
  keepRecent = AUTO_DELETE_KEEP_RECENT,
  now = Date.now(),
}: BuildAutoDeleteCandidatesOptions): string[] => {
  if (!Array.isArray(sessions) || cutoffDays <= 0) {
    return [];
  }

  const cutoffTime = now - cutoffDays * DAY_MS;
  const sorted = [...sessions].sort(
    (a, b) => getSessionLastActivity(b) - getSessionLastActivity(a)
  );
  const protectedIds = new Set(sorted.slice(0, keepRecent).map((session) => session.id));

  return sorted
    .filter((session) => {
      if (!session?.id) return false;
      if (protectedIds.has(session.id)) return false;
      if (session.id === currentSessionId) return false;
      if (session.share) return false;
      const lastActivity = getSessionLastActivity(session);
      if (!lastActivity) return false;
      return lastActivity < cutoffTime;
    })
    .map((session) => session.id);
};

type CleanupResult = {
  completedIds: string[];
  failedIds: string[];
  action: 'archive' | 'delete';
  skippedReason?: 'disabled' | 'cooldown' | 'no-candidates' | 'running' | 'stale' | 'partial';
};

/**
 * Split pre-computed candidate ids into ready-directory (authoritative,
 * safe to mutate) and unready (failed/idle/unknown — never destructive)
 * buckets. Newest-5 protection must already have run against ALL known
 * active rows before calling here; this only enforces per-directory
 * authority so one failed scope never blocks unrelated ready scopes.
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
 * authority — there is no fallback generation that could grant a delete.
 */
const captureCleanupRuntime = (): CleanupRuntimeCapture | null => {
  try {
    const store = getPiSessionStore();
    return {
      store,
      runtimeKey: getRuntimeKey(),
      generation: store.getRuntimeGeneration(),
    };
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

let cleanupActive = false;

/** Test-only reset for the module running guard. */
export const __resetSessionAutoCleanupForTests = (): void => {
  cleanupActive = false;
};

const isCleanupActive = (): boolean => cleanupActive;

type RunNowOptions = {
  force?: boolean;
  now?: number;
};

/**
 * Owning run routine for retention cleanup. The hook stays a thin React
 * shell (subscriptions + auto-run trigger); all orchestration lives here so
 * async behavior is testable without mounting DOM.
 *
 * Invariants:
 * - Running guard is claimed before the first await.
 * - Newest-5 runs against ALL known active rows, then only ready-directory
 *   ids are mutated; one failed scope never blocks ready scopes.
 * - Current session + fresh candidate state are rechecked before EACH
 *   destructive action, so an open or new activity during a prior await
 *   skips that id.
 * - Stale (runtime moved) vs partial (incomplete/failed scopes) are
 *   explicit, and cooldown advances only on complete success or an
 *   authoritative empty result — never on partial, so retries are not
 *   delayed 24h.
 * - A thrown catalog load becomes explicit partial, never an unhandled
 *   rejection from the auto-run effect.
 */
export const runSessionAutoCleanupNow = async ({
  force = false,
  now: nowOverride,
}: RunNowOptions = {}): Promise<CleanupResult> => {
  const readRetentionAction = (): 'archive' | 'delete' => {
    try {
      return useUIStore.getState().sessionRetentionAction ?? 'archive';
    } catch {
      return 'archive';
    }
  };

  if (cleanupActive) {
    return { completedIds: [], failedIds: [], action: readRetentionAction(), skippedReason: 'running' };
  }

  let retention: { enabled: boolean; days: number; action: 'archive' | 'delete'; lastRunAt: number | null };
  try {
    const ui = useUIStore.getState();
    retention = {
      enabled: ui.autoDeleteEnabled,
      days: ui.autoDeleteAfterDays,
      action: ui.sessionRetentionAction ?? 'archive',
      lastRunAt: ui.autoDeleteLastRunAt ?? null,
    };
  } catch {
    return { completedIds: [], failedIds: [], action: 'archive', skippedReason: 'partial' };
  }

  if (!retention.enabled || retention.days <= 0) {
    if (!force) {
      return { completedIds: [], failedIds: [], action: retention.action, skippedReason: 'disabled' };
    }
  }

  const batchNow = nowOverride ?? Date.now();
  if (!force && retention.lastRunAt && batchNow - retention.lastRunAt < AUTO_DELETE_INTERVAL_MS) {
    return { completedIds: [], failedIds: [], action: retention.action, skippedReason: 'cooldown' };
  }

  const captured = captureCleanupRuntime();
  if (!captured) {
    return { completedIds: [], failedIds: [], action: retention.action, skippedReason: 'stale' };
  }

  cleanupActive = true;
  try {
    try {
      let loadResult: Awaited<ReturnType<typeof loadSessionCatalog>>;
      try {
        loadResult = await loadSessionCatalog();
      } catch {
        return { completedIds: [], failedIds: [], action: retention.action, skippedReason: 'partial' };
      }

      if (loadResult.stale || !isCleanupRuntimeCurrent(captured)) {
        return { completedIds: [], failedIds: [], action: retention.action, skippedReason: 'stale' };
      }

      if (loadResult.readyDirectories.size === 0) {
        return { completedIds: [], failedIds: [], action: retention.action, skippedReason: 'partial' };
      }

      const allActive: Session[] = [];
      for (const record of loadResult.catalog.byId.values()) {
        if (record.archived) continue;
        allActive.push(liveSessionRecordToUiSession(record));
      }

      if (allActive.length === 0) {
        if (loadResult.failedDirectories.size > 0) {
          return { completedIds: [], failedIds: [], action: retention.action, skippedReason: 'partial' };
        }
        try {
          useUIStore.getState().setAutoDeleteLastRunAt(batchNow);
        } catch { /* cooldown is best-effort */ }
        return { completedIds: [], failedIds: [], action: retention.action, skippedReason: 'no-candidates' };
      }

      let latestCurrent: string | null;
      let latestAction: 'archive' | 'delete';
      let latestDays: number;
      try {
        latestCurrent = useSessionUIStore.getState().currentSessionId ?? null;
        const latestUi = useUIStore.getState();
        latestAction = latestUi.sessionRetentionAction ?? retention.action;
        latestDays = latestUi.autoDeleteAfterDays ?? retention.days;
      } catch {
        return { completedIds: [], failedIds: [], action: retention.action, skippedReason: 'partial' };
      }

      const candidateIds = buildAutoDeleteCandidates({
        sessions: allActive,
        currentSessionId: latestCurrent,
        cutoffDays: latestDays,
        now: batchNow,
      });

      if (candidateIds.length === 0) {
        if (loadResult.failedDirectories.size > 0) {
          return { completedIds: [], failedIds: [], action: latestAction, skippedReason: 'partial' };
        }
        try {
          useUIStore.getState().setAutoDeleteLastRunAt(batchNow);
        } catch { /* cooldown is best-effort */ }
        return { completedIds: [], failedIds: [], action: latestAction, skippedReason: 'no-candidates' };
      }

      const sessionById = new Map(allActive.map((session) => [session.id, session] as const));
      const { actionable, unready } = partitionCleanupCandidates(candidateIds, sessionById, loadResult.readyDirectories);

      if (actionable.length === 0) {
        return { completedIds: [], failedIds: [...unready], action: latestAction, skippedReason: 'partial' };
      }

      const completedIds: string[] = [];
      const failedSet = new Set<string>(unready);
      const failedIds: string[] = [...unready];
      const pushFailed = (id: string): void => {
        if (!failedSet.has(id)) {
          failedSet.add(id);
          failedIds.push(id);
        }
      };

      let sawStale = false;
      let resultAction: 'archive' | 'delete' = latestAction;

      for (let index = 0; index < actionable.length; index += 1) {
        const id = actionable[index]!;
        if (!isCleanupRuntimeCurrent(captured)) {
          for (let tail = index; tail < actionable.length; tail += 1) {
            pushFailed(actionable[tail]!);
          }
          sawStale = true;
          break;
        }

        let freshCurrent: string | null;
        let freshAction: 'archive' | 'delete';
        let freshDays: number;
        let freshCatalog: typeof loadResult.catalog;
        try {
          freshCurrent = useSessionUIStore.getState().currentSessionId ?? null;
          const freshUi = useUIStore.getState();
          freshAction = freshUi.sessionRetentionAction ?? latestAction;
          freshDays = freshUi.autoDeleteAfterDays ?? latestDays;
          freshCatalog = getPiSessionStore().getState().catalog;
        } catch {
          pushFailed(id);
          continue;
        }
        resultAction = freshAction;

        let stillCandidate = false;
        let freshDirectory: string | null = null;
        try {
          const freshAll: Session[] = [];
          for (const record of freshCatalog.byId.values()) {
            if (record.archived) continue;
            freshAll.push(liveSessionRecordToUiSession(record));
          }
          const freshCandidates = new Set(
            buildAutoDeleteCandidates({
              sessions: freshAll,
              currentSessionId: freshCurrent,
              cutoffDays: freshDays,
              now: batchNow,
            }),
          );
          stillCandidate = freshCandidates.has(id);
          if (stillCandidate) {
            const record = freshCatalog.byId.get(id);
            freshDirectory = record ? resolveGlobalSessionDirectory(liveSessionRecordToUiSession(record)) : null;
          }
        } catch {
          pushFailed(id);
          continue;
        }

        if (!stillCandidate || !freshDirectory) {
          pushFailed(id);
          continue;
        }

        let status: unknown;
        try {
          status = freshCatalog.listStatusByDirectory.get(freshDirectory);
        } catch {
          pushFailed(id);
          continue;
        }
        if (status !== 'ready') {
          pushFailed(id);
          continue;
        }

        try {
          const liveStore = getPiSessionStore();
          if (freshAction === 'archive') {
            await liveStore.archive(id, true, freshDirectory);
          } else {
            await liveStore.remove(id, freshDirectory);
          }
        } catch {
          pushFailed(id);
          continue;
        }

        if (!isCleanupRuntimeCurrent(captured)) {
          pushFailed(id);
          for (let tail = index + 1; tail < actionable.length; tail += 1) {
            pushFailed(actionable[tail]!);
          }
          sawStale = true;
          break;
        }

        completedIds.push(id);
      }

      if (sawStale) {
        return { completedIds, failedIds, action: resultAction, skippedReason: 'stale' };
      }

      if (loadResult.failedDirectories.size > 0 || failedIds.length > 0) {
        return { completedIds, failedIds, action: resultAction, skippedReason: 'partial' };
      }

      try {
        useUIStore.getState().setAutoDeleteLastRunAt(batchNow);
      } catch { /* cooldown is best-effort */ }
      return { completedIds, failedIds, action: resultAction };
    } catch {
      return { completedIds: [], failedIds: [], action: retention.action, skippedReason: 'partial' };
    }
  } finally {
    cleanupActive = false;
  }
};

type CleanupOptions = {
  autoRun?: boolean;
  enabled?: boolean;
};

export const useSessionAutoCleanup = (enabledOrOptions?: boolean | CleanupOptions) => {
  const options = typeof enabledOrOptions === 'object' ? enabledOrOptions : undefined;
  const autoRun = options?.autoRun !== false;
  const enabled = typeof enabledOrOptions === 'boolean' ? enabledOrOptions : (options?.enabled ?? true);

  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const autoDeleteEnabled = useUIStore((state) => state.autoDeleteEnabled);
  const autoDeleteAfterDays = useUIStore((state) => state.autoDeleteAfterDays);
  const sessionRetentionAction = useUIStore((state) => state.sessionRetentionAction);
  const autoDeleteLastRunAt = useUIStore((state) => state.autoDeleteLastRunAt);
  const needsGlobalSessions = enabled && (!autoRun || autoDeleteEnabled);
  // Leaf catalog subscription: runtime-wide active rows on the `catalog`
  // topic only. Streaming deltas (`session:*`) and broadcast (`*`) never
  // wake this hook; sidebar busy ticks do not rebuild the candidate list.
  // The shared PiSessionCatalogFeeder owns the fill — this hook never
  // triggers a startup list itself. Manual cleanup still loads on demand
  // through runSessionAutoCleanupNow.
  const catalogActiveSessions = usePiSessionSnapshot(
    (state) => listUiSessionsFromCatalog(state.catalog, { archived: false }),
    uiSessionListEqual,
    'catalog',
  );
  const globalSessions = needsGlobalSessions ? catalogActiveSessions : EMPTY_SESSIONS;

  const [isRunning, setIsRunning] = React.useState(false);

  const candidates = React.useMemo(() => {
    if (autoDeleteAfterDays <= 0) {
      return [];
    }
    return buildAutoDeleteCandidates({
      sessions: globalSessions,
      currentSessionId,
      cutoffDays: autoDeleteAfterDays,
    });
  }, [autoDeleteAfterDays, currentSessionId, globalSessions]);

  const runCleanup = React.useCallback(
    async ({ force = false }: { force?: boolean } = {}): Promise<CleanupResult> => {
      setIsRunning(true);
      try {
        return await runSessionAutoCleanupNow({ force });
      } finally {
        setIsRunning(false);
      }
    },
    [],
  );

  React.useEffect(() => {
    if (!enabled) {
      return;
    }

    if (!autoRun) {
      return;
    }
    if (!autoDeleteEnabled || autoDeleteAfterDays <= 0) {
      return;
    }
    if (candidates.length === 0) {
      return;
    }
    const now = Date.now();
    if (autoDeleteLastRunAt && now - autoDeleteLastRunAt < AUTO_DELETE_INTERVAL_MS) {
      return;
    }
    if (isCleanupActive()) return;
    // runSessionAutoCleanupNow never rejects (thrown loads become partial),
    // so the auto-run effect cannot produce an unhandled rejection.
    void runCleanup();
  }, [
    autoDeleteAfterDays,
    autoDeleteEnabled,
    autoDeleteLastRunAt,
    autoRun,
    candidates.length,
    enabled,
    runCleanup,
  ]);

  return {
    candidates,
    isRunning,
    runCleanup,
    keepRecentCount: AUTO_DELETE_KEEP_RECENT,
    action: sessionRetentionAction,
  };
};
