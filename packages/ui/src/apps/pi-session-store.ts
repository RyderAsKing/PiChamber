import {
  applyPiEvent,
  dismissExtensionDialog,
  hydrateSessionFromDetail,
  projectSession,
  createReducerPartMap,
  createReducerState,
  type PiProjectedSession,
  type PiReducerSessionState,
  type PiReducerState,
} from '@/lib/pi/event-reducer';
import { mapWithConcurrency } from '@/lib/concurrency';
import { bootstrapPiDirectory, type PiBootstrapHealth } from '@/lib/pi/bootstrap';
import { recordMobileDiagnosticError } from '@/lib/mobile-error-log';
import { createBrowserUuid } from '@/lib/uuid';
import { PiRequestError, piClient, type PiClientScope } from '@/lib/pi/client';
import { reconnectPiSession } from '@/lib/pi/reconnect';
import { PiStreamCadence } from '@/lib/pi/stream-cadence';
import { invalidateCommandCatalogCache } from '@/lib/pi/commandCatalog';
import { createPiEventStream, type PiStreamHandle } from '@/lib/pi/transport';
import type { PiSessionEvent, PiSessionListItem } from '@/lib/pi/protocol';
import type { PiSession, PiSessionId, PiSessionLifecycleState, PiThinkingLevel } from '@/lib/pi/types';
import { resolveCreateThinking } from '@/lib/pi/thinking';
import { deriveSessionTitle } from '@/lib/chat/deriveSessionTitle';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { notifyRuntimeAuthExpired } from '@/lib/runtime-auth';
import { getPiSessionCatalogCache, type PiSessionCatalogCache } from '@/sync/pi-session-catalog-cache';
import { useConfigStore } from '@/stores/useConfigStore';
import { invalidateSkillsLoadCache, useSkillsStore } from '@/stores/useSkillsStore';
import { adoptServerRunTiming, observeSessionActivityTiming, removeSessionActivityTiming } from '@/sync/session-activity-timing';
import { observeSessionActivityEvent, raiseSessionOrderingBaselines, removeSessionOrdering } from '@/sync/session-ordering';
import { notifySessionTurnComplete } from '@/sync/notification-store';
import { cleanupPersistedSessionState } from '@/sync/session-deletion-cleanup';
import { clearAllRevertNavigations, clearRevertNavigation, getRevertNavigation, setRevertNavigation } from '@/sync/revert-navigation-store';
import {
  applyArchiveChange,
  applyDirectoryListWithReconciliation,
  applyHydratedChange,
  applyLifecycleChange,
  applyTitleChange,
  initialCatalog,
  liveSessionRecordToUiSession,
  markDirectoryFailed,
  markDirectoryLoading,
  mapDirectoriesWithRefreshSlot,
  removeRecord,
  upsertRecord,
  upsertStubRecord,
  touchRecordUpdatedAt,
  type LiveSessionRecord,
  type PiSessionCatalogState,
} from '@/sync/pi-session-catalog';

import {
  type PiSessionTopic,
  TOPIC_BROADCAST,
  TOPIC_CATALOG,
  TOPIC_DIALOGS,
  TOPIC_CHROME,
  type PiConnectionState,
  type PiSessionsListStatus,
  type PiSessionStoreState,
  type PiSyncReadiness,
  type Listener,
  PI_TRANSCRIPT_EVICTION_SOFT_CAP,
  PI_SYNC_RECOVERY_CONCURRENCY,
  PI_SYNC_RECOVERY_MAX_ATTEMPTS,
  RECOVERABLE_CONNECTION_CODES,
  type PendingFocus,
} from '@/sync/pi-session-store-types';
import {
  catalogLifecycleFromReducer,
  lifecycleFromEvent,
  asError,
  isInvalidSessionError,
  isSessionInUseError,
  isSessionRuntimeConflictError,
  delayBeforeRetry,
  initialSessionStoreState,
  createRecordFromPiSession,
  mergeHydratedSession,
} from '@/sync/pi-session-store-helpers';

export {
  TOPIC_BROADCAST,
  TOPIC_CATALOG,
  TOPIC_DIALOGS,
  TOPIC_CHROME,
  PI_TRANSCRIPT_EVICTION_SOFT_CAP,
  catalogLifecycleFromReducer,
  lifecycleFromEvent,
  asError,
  isInvalidSessionError,
  isSessionInUseError,
  isSessionRuntimeConflictError,
  delayBeforeRetry,
};

export type {
  PiSessionTopic,
  PiConnectionState,
  PiSessionsListStatus,
  PiSessionStoreState,
};

let sharedStore: PiSessionStore | null = null;

export const getPiSessionStore = (): PiSessionStore => {
  sharedStore ??= new PiSessionStore();
  return sharedStore;
};

const viteHot = (import.meta as ImportMeta & { hot?: { dispose: (cb: () => void) => void } }).hot;
if (viteHot) {
  viteHot.dispose(() => {
    sharedStore?.dispose();
    sharedStore = null;
  });
}

/** One connected Pi runtime. The store owns a runtime-wide cluster:
 *  a single event stream, a `reducer.bySession` map, `hydratedSessionIds`, and
 *  a `directory` focus pointer for the sidebar/create flow. The cluster lives
 *  until a runtime switch, `clear()`, or `dispose()`. Switching the focused
 *  project is a pointer change; it never disposes the stream or drops
 *  hydrated sessions. Every async completion is generation- and runtime-
 *  guarded so a stale hydrate cannot commit into a new runtime/focus.
 */
export class PiSessionStore {
  private state: PiSessionStoreState;
  private listenersByTopic = new Map<string, Set<Listener>>();
  private stream: { dispose: () => void } | null = null;
  /** Identifies the currently owned stream so callbacks from a replaced
   *  connection cannot change connection chrome. */
  private streamGeneration = 0;
  /** Advances when the owned transport reconnects while an explicit
   *  snapshot recovery may still be in flight. */
  private streamReadyRevision = 0;
  /** Advances only on bootstrap / reconnect / runtime switch / dispose —
   *  guards every async completion that may still be in flight when the
   *  cluster is torn down or restarted. */
  private runtimeGeneration = 0;
  /** Most-recent directory focus. Used to reject overlapping focus promises
   *  so a stale `selectProject` / `listSessions` cannot commit while a newer
   *  focus is already in flight. */
  private focusGeneration = 0;
  private recovering = false;
  private pendingFocus: PendingFocus | null = null;
  private pendingPreferredSessionId: PiSessionId | null = null;
  private hydratedSessionIds = new Set<PiSessionId>();
  private activityPhaseById = new Map<PiSessionId, 'active' | 'settled'>();
  private pendingPromptById = new Set<PiSessionId>();
  private promptGenerationById = new Map<PiSessionId, number>();
  /** Monotonic clock of last access per resident session. Updated on
   *  `select`, successful `commitHydratedSession`, accepted events, and
   *  explicit `touchLastAccess`. Eviction walks ascending order so the
   *  longest-idle transcript is dropped first when the cap is exceeded. */
  private lastAccessById = new Map<PiSessionId, number>();
  private lastAccessClock = 0;
  /** Last selected session per directory. Updated on `select()` and used
   *  by `start` / `focusProject` to pre-seed the warm path's preferred id
   *  when no other hint is supplied. Cleared on `dispose` /
   *  `resetForRuntime`. Private — callers pass the hint explicitly when
   *  they have a better one (sidebar / project picker history). */
  private lastSelectedByDirectory = new Map<string, PiSessionId>();
  /** Per-directory refresh generation. Bumped every time a directory's
   *  list starts; stale completions (a slow RPC returning after a newer
   *  refresh has begun, or after a runtime switch) commit nothing. Cleared
   *  on `dispose` / `clear` / `resetForRuntime`. */
  private directoryRefreshGenerationByDirectory = new Map<string, number>();
  /** Committed deletions for the active runtime. A tombstone survives its
   *  echo so an in-flight list, detail, or history response started before
   *  the deletion cannot resurrect the session. Archive and directory moves
   *  keep the session id and never enter this set. Cleared on runtime
   *  switch, clear, and dispose alongside every other runtime-scoped map. */
  private deletedSessionIds = new Set<PiSessionId>();
  private static readonly MAX_DELETED_SESSION_TOMBSTONES = 4_096;
  /** True when the session was authoritatively deleted on this runtime. */
  isDeleted = (sessionId: PiSessionId): boolean => this.deletedSessionIds.has(sessionId);
  /** Test seam: observe committed tombstones without reaching into privates. */
  deletedSessionCountForTests = (): number => this.deletedSessionIds.size;
  private providerRefreshRevisionByDirectory = new Map<string, number>();
  private providerRefreshTaskByDirectory = new Map<string, Promise<void>>();
  private evictionScheduled = false;
  /** Sessions currently being re-fetched because a live event arrived after
   *  their transcript was dropped. Dedupes overlapping prompt/event hydrates. */
  private restoringTranscriptById = new Set<PiSessionId>();
  /** In-flight `getSession` hydrates keyed by session id. Sidebar select,
   *  ChatContainer `ensureHydrated`, and Strict Mode remounts share one
   *  request so overlapping opens cannot race the daemon runtime registry. */
  private hydrateInflightById = new Map<PiSessionId, Promise<void>>();
  /** Older-message page requests share one in-flight request per session. */
  private historyInflightById = new Map<PiSessionId, Promise<boolean>>();
  /** Per-session navigation generation. Bumped on every `navigate` so a stale
   *  `hydrate` that started before the navigation cannot restore the old tail
   *  after the authoritative truncation. */
  private navigationGenerationById = new Map<PiSessionId, number>();
  private navigationCounter = 0;
  /** Stream lifetime of the connected daemon. `null` until the first verified
   *  source (health, event, or stamped response) establishes it. A different
   *  value means the daemon restarted and the sequence space reset. */
  private streamEpoch: string | null = null;
  /** Epochs retired by a verified transition. Snapshots, events, and stamped
   *  responses from a retired lifetime are rejected — epochs are opaque, so
   *  retirement (not ordering) is what prevents a stale frame from
   *  downgrading an established baseline. */
  private retiredStreamEpochs = new Set<string>();
  /** Reconnect-recovery obligations (replay miss / epoch change): known
   *  directory catalogs to re-list and affected residents to re-hydrate.
   *  Mirrored into `state.syncRecovery`; a failed scope stays listed so
   *  partial success is never reported as complete. */
  private recoveryDirectories = new Set<string>();
  private recoveryResidents = new Set<PiSessionId>();
  private recoveryRunning = false;
  /** Incremented for every authoritative recovery signal. A pass only drains
   *  scopes when no newer signal arrived while its reads were in flight. */
  private recoveryRevision = 0;
  private recoveryAttempt = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Adopt the stream epoch from a verified source. Returns `true` when the
   *  value is new information (first contact or a change). The displaced
   *  epoch is recorded as retired so late frames or responses stamped with
   *  it can never downgrade the baseline. */
  private adoptStreamEpoch(epoch: string | undefined | null): boolean {
    if (typeof epoch !== 'string' || epoch.length === 0) return false;
    if (this.streamEpoch === epoch) return false;
    if (this.streamEpoch !== null) this.retiredStreamEpochs.add(this.streamEpoch);
    this.streamEpoch = epoch;
    return true;
  }
  /** True when a stamped response may be committed. A response whose
   *  `streamEpoch` differs from the established epoch — or that was retired
   *  by a verified transition — was generated by a previous daemon process
   *  (stale sequence space) and must be rejected; an unstamped response
   *  cannot be verified and is accepted as today. Accepts `unknown` so
   *  history-page payloads without a stamped epoch still type-check
   *  (unstamped responses are accepted only until an epoch-capable daemon
   *  establishes the first epoch). */
  private isResponseEpochCurrent(response: unknown): boolean {
    const epoch = typeof (response as { streamEpoch?: unknown } | null | undefined)?.streamEpoch === 'string' && ((response as { streamEpoch: string }).streamEpoch.length > 0) ? (response as { streamEpoch: string }).streamEpoch : undefined;
    if (!epoch) return this.streamEpoch === null;
    if (this.retiredStreamEpochs.has(epoch)) return false;
    if (this.streamEpoch === null) {
      this.streamEpoch = epoch;
      return true;
    }
    return epoch === this.streamEpoch;
  }
  /**
   * A verified stream-epoch change (daemon restart) invalidates every
   * resident transcript and per-session cursor in one cluster-level reset:
   * the new daemon's sequence space is unrelated to the old one, so old
   * cursors and live transcript rows are incompatible. Optimistic UI state
   * (pending prompts, drafts, attachments, navigation intent) is owned by
   * dedicated stores and preserved; catalog metadata survives and is
   * re-validated by the recovery pass. Returns the ids that were
   * hydrated before the reset so recovery can re-fetch them.
   */
  private resetForEpochChange(): Set<PiSessionId> {
    const previouslyHydrated = new Set(this.hydratedSessionIds);
    this.hydratedSessionIds.clear();
    this.restoringTranscriptById.clear();
    this.hydrateInflightById.clear();
    this.historyInflightById.clear();
    // Stale history completions reject through navigation generation too.
    for (const [id, gen] of this.navigationGenerationById) this.navigationGenerationById.set(id, gen + 1);
    return previouslyHydrated;
  }
  /**
   * Queue reconnect-recovery obligations. `directories: 'all-known'` re-lists
   * every directory the catalog knows (a replay miss or epoch change can
   * hide creates and deletions in any of them); explicit scopes add targeted
   * work. Additive and idempotent; starts a bounded recovery pass.
   */
  private queueSyncRecovery(scope: { directories?: 'all-known' | Iterable<string>; residents?: Iterable<PiSessionId> }): void {
    let requested = false;
    let added = false;
    if (scope.directories === 'all-known') {
      for (const directory of this.state.catalog.listStatusByDirectory.keys()) {
        if (!directory) continue;
        requested = true;
        if (!this.recoveryDirectories.has(directory)) {
          this.recoveryDirectories.add(directory);
          added = true;
        }
      }
    } else if (scope.directories) {
      for (const directory of scope.directories) {
        const normalized = normalizePath(directory);
        if (!normalized) continue;
        requested = true;
        if (!this.recoveryDirectories.has(normalized)) {
          this.recoveryDirectories.add(normalized);
          added = true;
        }
      }
    }
    if (scope.residents) {
      for (const resident of scope.residents) {
        if (!resident) continue;
        requested = true;
        if (!this.recoveryResidents.has(resident)) {
          this.recoveryResidents.add(resident);
          added = true;
        }
      }
    }
    if (!requested) return;
    // Even when every scope was already present, a newer resync/epoch signal
    // means an in-flight read must not drain that obligation as if it covered
    // the newer baseline.
    this.recoveryRevision += 1;
    this.recoveryAttempt = 0;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    if (added) this.publishSyncRecoveryState();
    void this.runSyncRecovery();
  }
  /** Mirror the obligation sets into state. `syncReadiness` is `'recovering'`
   *  while obligations (or an active retry cycle) exist. */
  private publishSyncRecoveryState(): void {
    const directories = [...this.recoveryDirectories];
    const residents = [...this.recoveryResidents];
    const readiness: PiSyncReadiness = directories.length === 0 && residents.length === 0 ? 'ready' : 'recovering';
    const previous = this.state.syncRecovery;
    const unchanged = readiness === this.state.syncReadiness
      && previous.directories.length === directories.length
      && previous.residents.length === residents.length
      && directories.every((directory, index) => previous.directories[index] === directory)
      && residents.every((resident, index) => previous.residents[index] === resident);
    if (unchanged) return;
    this.state = {
      ...this.state,
      syncReadiness: readiness,
      syncRecovery: { directories, residents },
    };
    this.emitChrome();
  }
  /** Reset all recovery state (runtime switch, clear, dispose). */
  private clearSyncRecovery(): void {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.recoveryDirectories.clear();
    this.recoveryResidents.clear();
    this.recoveryRunning = false;
    this.recoveryRevision += 1;
    this.recoveryAttempt = 0;
    this.publishSyncRecoveryState();
  }
  /**
   * Run one bounded recovery pass: affected residents first (the selected
   * session outranks the rest), then known directory catalogs — each under
   * bounded concurrency with full generation/runtime/epoch guards. A failed
   * scope keeps its obligation (partial success is never complete), and a
   * bounded backoff retry cycle re-runs remaining scopes; once the cycle's
   * attempts are exhausted the obligations stay parked and visible until
   * the next stream-health signal or reconnect re-queues them.
   */
  private async runSyncRecovery(): Promise<void> {
    if (this.recoveryRunning) return;
    if (this.recoveryDirectories.size === 0 && this.recoveryResidents.size === 0) {
      this.publishSyncRecoveryState();
      return;
    }
    this.recoveryRunning = true;
    const expected = this.runtimeGeneration;
    const runtimeKey = getRuntimeKey();
    const expectedEpoch = this.streamEpoch;
    const recoveryRevision = this.recoveryRevision;
    const passIsCurrent = () => expected === this.runtimeGeneration
      && runtimeKey === getRuntimeKey()
      && expectedEpoch === this.streamEpoch
      && recoveryRevision === this.recoveryRevision;
    try {
      // 1. Affected residents. The selected session recovers first; every
      //    other resident follows under bounded concurrency. Live events
      //    and user mutations keep overlaying: fetched details commit
      //    through `commitHydratedSession`, which preserves newer resident
      //    content and already loaded older history pages.
      const selected = this.state.selectedSessionId;
      const orderedResidents = [...this.recoveryResidents].sort((a, b) => (a === selected ? -1 : b === selected ? 1 : 0));
      await mapWithConcurrency(orderedResidents, PI_SYNC_RECOVERY_CONCURRENCY, async (sessionId) => {
        if (!passIsCurrent()) return;
        if (!this.recoveryResidents.has(sessionId)) return;
        if (this.isDeleted(sessionId)) {
          this.recoveryResidents.delete(sessionId);
          return;
        }
        const directory = this.resolveSessionDirectory(sessionId) ?? this.state.directory ?? undefined;
        if (!directory) return; // obligation retained until the session's directory is known
        try {
          const detail = await piClient.getSession(sessionId, { directory, runtimeKey });
          if (!passIsCurrent()) return;
          if (detail.session.id !== sessionId) return;
          if (this.isDeleted(sessionId)) {
            this.recoveryResidents.delete(sessionId);
            return;
          }
          // A stale-epoch response predates the daemon restart; keep the
          // obligation so the next pass re-reads from the current daemon.
          if (!this.isResponseEpochCurrent(detail) || !passIsCurrent()) return;
          const current = this.state.reducer.bySession.get(sessionId);
          if (!current || current.lastSequence <= detail.lastSequence) {
            if ((detail.lifecycle === 'busy' || detail.lifecycle === 'retry') && typeof (detail as { runStartedAt?: number }).runStartedAt === 'number') {
              adoptServerRunTiming(detail.session.id, (detail as { runStartedAt: number }).runStartedAt, (detail as { serverNow?: number }).serverNow);
            }
            this.commitHydratedSession(this.sessionFromDetail(detail));
          }
          this.recoveryResidents.delete(sessionId);
        } catch (error) {
          if (passIsCurrent() && isInvalidSessionError(error)) {
            // A replay miss can hide the deletion event. The authoritative
            // detail 404 is equivalent evidence: commit the deletion and
            // drain this resident instead of parking an impossible retry.
            this.commitDeletion(sessionId, directory);
            this.recoveryResidents.delete(sessionId);
          }
          // Other failures keep the retry obligation; partial success is not empty.
        }
        this.publishSyncRecoveryState();
      });
      if (!passIsCurrent()) return;
      // 2. Known directory catalogs. `refreshDirectoryCatalog` preserves
      //    prior rows on failure and marks the directory `'failed'` —
      //    failure stays scoped, never an empty success.
      const focusedDirectory = this.state.directory ? normalizePath(this.state.directory) : null;
      const orderedDirectories = [...this.recoveryDirectories].sort((a, b) => (a === focusedDirectory ? -1 : b === focusedDirectory ? 1 : 0));
      await mapWithConcurrency(orderedDirectories, PI_SYNC_RECOVERY_CONCURRENCY, async (directory) => {
        if (!passIsCurrent()) return;
        if (!this.recoveryDirectories.has(directory)) return;
        try {
          const result = await this.refreshDirectoryCatalog(directory);
          // A failed or superseded listing keeps its obligation (partial
          // success is not complete); only a current successful refresh
          // drains the scope.
          if (result.ok && passIsCurrent()) this.recoveryDirectories.delete(directory);
        } catch {
          // Failure keeps the retry obligation.
        }
        this.publishSyncRecoveryState();
      });
    } finally {
      this.recoveryRunning = false;
      if (
        expected === this.runtimeGeneration
        && runtimeKey === getRuntimeKey()
        && (this.recoveryDirectories.size > 0 || this.recoveryResidents.size > 0)
        && (recoveryRevision !== this.recoveryRevision || expectedEpoch !== this.streamEpoch)
      ) {
        void this.runSyncRecovery();
      }
    }
    if (expected !== this.runtimeGeneration || runtimeKey !== getRuntimeKey()) return;
    this.publishSyncRecoveryState();
    if (this.recoveryDirectories.size > 0 || this.recoveryResidents.size > 0) {
      if (recoveryRevision !== this.recoveryRevision || expectedEpoch !== this.streamEpoch) {
        // A newer authoritative signal superseded this pass. Start its pass
        // immediately rather than charging it as a failed retry.
        void this.runSyncRecovery();
        return;
      }
      // Bounded backoff retry for the failed scopes.
      this.recoveryAttempt += 1;
      if (this.recoveryAttempt <= PI_SYNC_RECOVERY_MAX_ATTEMPTS) {
        const delayMs = Math.min(16_000, 1_000 * 2 ** (this.recoveryAttempt - 1));
        if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
        this.recoveryTimer = setTimeout(() => {
          this.recoveryTimer = null;
          void this.runSyncRecovery();
        }, delayMs);
      }
      // Attempts exhausted: obligations stay parked until the next
      // stream-health signal or reconnect re-queues them.
    }
  }
  /** Missed-deletion baseline entry point (see
   *  `useAuthoritativeSessionCleanup`): a session present in an established
   *  complete authoritative catalog baseline but omitted from a later
   *  complete snapshot was deleted while no replay window covered it.
   *  Funneling through the shared commit adds a tombstone so an in-flight
   *  list, detail, or history response started before the daemon-side
   *  deletion cannot resurrect the row. Idempotent for duplicates. */
  commitMissedDeletion = (sessionId: PiSessionId, directory: string): boolean =>
    this.commitDeletion(sessionId, directory);
  /**
   * Shared deletion commit. Every deletion path (local `remove()`, accepted
   * `404` on hydrate, explicit `session.deleted` event, missed-deletion
   * baseline) funnels through here so catalog, transcript, selection, live
   * activity, and persisted drafts stay consistent. The tombstone is added
   * first so late completions that started before the deletion cannot
   * resurrect the row. Persisted cleanup is runtime+directory+session
   * scoped; stale-runtime or global identities are ignored by the helper.
   * The accepted-404 hydrate path passes `keepSelection` so the failed id
   * stays selected and the chat keeps showing its load error while the
   * tombstone still blocks resurrection.
   */
  private commitDeletion(
    sessionId: PiSessionId,
    directory?: string,
    options?: { keepSelection?: boolean },
  ): boolean {
    if (!sessionId) return false;
    const wasDeleted = this.deletedSessionIds.has(sessionId);
    this.deletedSessionIds.add(sessionId);
    let evictedTombstone: PiSessionId | undefined;
    if (this.deletedSessionIds.size > PiSessionStore.MAX_DELETED_SESSION_TOMBSTONES) {
      evictedTombstone = this.deletedSessionIds.values().next().value;
      if (evictedTombstone) this.deletedSessionIds.delete(evictedTombstone);
    }
    const recordDirectory = directory
      ?? this.state.catalog.byId.get(sessionId)?.directory
      ?? this.state.sessions.find((item) => item.session.id === sessionId)?.session.directory
      ?? this.state.reducer.bySession.get(sessionId)?.directory;
    if (recordDirectory && recordDirectory !== 'global') {
      try {
        cleanupPersistedSessionState({ runtimeKey: getRuntimeKey(), directory: recordDirectory, sessionId });
      } catch {
        // Persisted cleanup is best-effort; the in-memory tombstone still guards resurrection.
      }
    }
    removeSessionActivityTiming(sessionId);
    removeSessionOrdering(sessionId);
    clearRevertNavigation(sessionId);
    this.navigationGenerationById.delete(sessionId);
    this.historyInflightById.delete(sessionId);
    this.hydrateInflightById.delete(sessionId);
    this.restoringTranscriptById.delete(sessionId);
    const hadResident = this.state.reducer.bySession.has(sessionId)
      || this.hydratedSessionIds.has(sessionId)
      || this.state.catalog.byId.has(sessionId)
      || this.state.sessions.some((item) => item.session.id === sessionId);
    const sessions = this.state.sessions.filter((item) => item.session.id !== sessionId);
    const selectedSessionId = !options?.keepSelection && this.state.selectedSessionId === sessionId
      ? (sessions.find((item) => !item.session.archived)?.session.id ?? null)
      : this.state.selectedSessionId;
    const nextBySession = new Map(this.state.reducer.bySession);
    nextBySession.delete(sessionId);
    const nextLastSequence = new Map(this.state.reducer.lastSequence);
    // Tombstones and retained deletion cursors share the same memory bound.
    if (evictedTombstone) nextLastSequence.delete(evictedTombstone);
    // Preserve the deletion cursor when the event already advanced it; otherwise keep the prior cursor.
    const eventCursor = this.state.reducer.lastSequence.get(sessionId);
    if (eventCursor !== undefined) nextLastSequence.set(sessionId, eventCursor);
    else nextLastSequence.delete(sessionId);
    this.hydratedSessionIds.delete(sessionId);
    this.activityPhaseById.delete(sessionId);
    this.pendingPromptById.delete(sessionId);
    this.promptGenerationById.delete(sessionId);
    this.lastAccessById.delete(sessionId);
    const nextCatalog = removeRecord(this.state.catalog, sessionId);
    const catalogChanged = nextCatalog !== this.state.catalog;
    const selectionChanged = selectedSessionId !== this.state.selectedSessionId;
    if (!hadResident && wasDeleted && !catalogChanged && !selectionChanged) return false;
    this.state = {
      ...this.state,
      sessions,
      selectedSessionId,
      hydratedSessionIds: new Set(this.hydratedSessionIds),
      reducer: { bySession: nextBySession, lastSequence: nextLastSequence },
      catalog: nextCatalog,
    };
    const topics: string[] = [`session:${sessionId}`, TOPIC_CHROME];
    if (catalogChanged) topics.push(TOPIC_CATALOG);
    this.emit(topics);
    return true;
  }
  /** Drop tombstoned sessions from an authoritative list response so a
   *  request that started before a committed deletion cannot resurrect the
   *  catalog row or re-enter the focused list. Tombstones are runtime-scoped
   *  and cleared on runtime switch, so a same-ID session on another runtime
   *  is unaffected. */
  private filterDeletedListItems(sessions: PiSessionListItem[]): PiSessionListItem[] {
    if (this.deletedSessionIds.size === 0) return sessions;
    return sessions.filter((item) => !this.deletedSessionIds.has(item.session.id));
  }
  private readonly cadence = new PiStreamCadence((events) => this.commitEvents(events));
  private readonly catalogCache: PiSessionCatalogCache;
  private unsubscribeRuntime: () => void;

  constructor(catalogCache: PiSessionCatalogCache = getPiSessionCatalogCache()) {
    this.catalogCache = catalogCache;
    this.state = initialSessionStoreState(this.readCachedCatalog(getRuntimeKey()));
    this.unsubscribeRuntime = subscribeRuntimeEndpointChanged((detail) => {
      if (detail.runtimeKey === detail.previousRuntimeKey) {
        this.reconnectAfterTransportSwitch();
        return;
      }
      this.resetForRuntime();
    });
  }

  /** Runtime generation. Stale after `clear()`/`dispose()`/`resetForRuntime()`/reconnect. */
  getRuntimeGeneration = (): number => this.runtimeGeneration;
  /** Directory-focus generation. Stale after a newer focusProject call replaces it. */
  getFocusGeneration = (): number => this.focusGeneration;
  /** True once the runtime-wide cluster is attached: either the stream
   *  is wired, or the runtime health probe + initial list already
   *  flipped `connection` to `'ready'`. Folder changes after this point
   *  route through `focusProject`, never `start`. */
  hasClusterAttached = (): boolean => this.stream !== null || this.state.connection === 'ready';

  getState = () => this.state;
  /**
   * Subscribe to store commits. Production hooks must pass an explicit
   * topic so a token delta in one session does not wake every chat
   * transcript selector; tests and legacy callers may omit the topic to
   * receive every commit (broadcast).
   */
  subscribe = (listener: Listener, topic: string = TOPIC_BROADCAST): (() => void) => {
    let set = this.listenersByTopic.get(topic);
    if (!set) {
      set = new Set();
      this.listenersByTopic.set(topic, set);
    }
    set.add(listener);
    return () => {
      const bucket = this.listenersByTopic.get(topic);
      if (bucket) bucket.delete(listener);
    };
  };
  private resetLiveRuntimeState(): void {
    this.providerRefreshRevisionByDirectory.clear();
    this.deletedSessionIds.clear();
    this.runtimeGeneration += 1;
    this.focusGeneration += 1;
    this.pendingFocus = null;
    this.pendingPreferredSessionId = null;
    this.hydratedSessionIds.clear();
    this.activityPhaseById.clear();
    this.pendingPromptById.clear();
    this.promptGenerationById.clear();
    this.lastAccessById.clear();
    this.lastAccessClock = 0;
    this.lastSelectedByDirectory.clear();
    this.directoryRefreshGenerationByDirectory.clear();
    // The outgoing runtime's daemon (and its stream lifetime) no longer
    // applies; the incoming runtime establishes a fresh epoch.
    this.streamEpoch = null;
    this.retiredStreamEpochs.clear();
    this.clearSyncRecovery();
    this.evictionScheduled = false;
    this.restoringTranscriptById.clear();
    this.hydrateInflightById.clear();
    this.historyInflightById.clear();
    this.cadence.dispose();
    this.stream?.dispose();
    this.stream = null;
    this.streamGeneration += 1;
    this.streamReadyRevision += 1;
  }
  /** Raise frozen ordering baselines from an authoritative directory snapshot.
   *  Monotonic: live ranks are never demoted. */
  private raiseOrderingBaselinesForDirectory(directory: string): void {
    const normalized = normalizePath(directory);
    if (!normalized) return;
    const ids = this.state.catalog.byDirectory.get(normalized);
    if (!ids || ids.length === 0) return;
    const sessions = [];
    for (const id of ids) {
      const record = this.state.catalog.byId.get(id);
      if (!record || record.archived) continue;
      sessions.push(liveSessionRecordToUiSession(record));
    }
    if (sessions.length > 0) raiseSessionOrderingBaselines(sessions);
  }

  dispose = () => {
    this.catalogCache.flush();
    this.resetLiveRuntimeState();
    this.unsubscribeRuntime();
    clearAllRevertNavigations();
    this.navigationGenerationById.clear();
    this.navigationCounter = 0;
    // Broadcast the reset so any mounted consumer sees the empty state
    // before the listener sets are torn down.
    this.state = initialSessionStoreState();
    this.emitBroadcast();
    this.listenersByTopic.clear();
  };
  setShowArchived = (showArchived: boolean) => {
    if (showArchived === this.state.showArchived) return;
    this.state = { ...this.state, showArchived };
    this.emitChrome();
  };
  clearError = () => {
    if (!this.state.error) return;
    this.state = { ...this.state, error: null };
    this.emitChrome();
  };
  reportError = (error: unknown) => {
    const reported = asError(error);
    this.state = { ...this.state, error: reported, connection: 'error' };
    this.emitChrome();
    this.ensureConnectionRecovery(reported);
  };
  /**
   * Keep a transport-owned backoff loop alive even when the first runtime
   * probe failed before the cluster could attach its normal event stream.
   * Once the SSE endpoint accepts a connection, restart authoritative
   * bootstrap instead of treating the stream itself as session state.
   */
  private ensureConnectionRecovery(error: PiRequestError) {
    if (this.stream || !RECOVERABLE_CONNECTION_CODES.has(error.code)) return;
    const expected = this.runtimeGeneration;
    const runtimeKey = getRuntimeKey();
    const streamGeneration = this.streamGeneration + 1;
    this.streamGeneration = streamGeneration;
    const fromSequence = this.streamCursor();
    let recoveryStream: PiStreamHandle | null = null;
    recoveryStream = createPiEventStream({
      onEvent: () => {},
      onAuthRequired: () => this.handleStreamAuthRequired(),
      onReconnect: () => {
        if (
          expected !== this.runtimeGeneration
          || runtimeKey !== getRuntimeKey()
          || streamGeneration !== this.streamGeneration
          || this.stream !== recoveryStream
        ) return;
        recoveryStream?.dispose();
        this.stream = null;
        this.streamGeneration += 1;
        this.streamReadyRevision += 1;
        const { directory, selectedSessionId } = this.state;
        void this.start({
          ...(directory ? { directory } : {}),
          ...(selectedSessionId ? { sessionId: selectedSessionId } : {}),
        });
      },
    }, {
      ...(fromSequence !== undefined ? { fromSequence } : {}),
      runtimeKey,
    });
    this.stream = recoveryStream;
  }
  /** A known authorization failure (401/403) stopped the stream's retry
   *  loop. Surface the existing auth flow (the mounted gate re-checks the
   *  session and shows its unlock screen) without clearing any local work:
   *  transcripts, drafts, and optimistic state all survive the report. */
  private handleStreamAuthRequired(): void {
    this.reportError(new PiRequestError('DAEMON_AUTH_FAILED', 'The Pi runtime rejected the client authorization.'));
    notifyRuntimeAuthExpired();
  }
  /**
   * A single session could not be hydrated. The cluster stays `ready` so
   * other chats keep working; `focusPending` clears so AppEffects can
   * settle and ChatContainer can leave the logo for the error block.
   */
  private failSessionLoad(sessionId: string, error: PiRequestError) {
    const nextErrors = new Map(this.state.sessionLoadErrorById);
    nextErrors.set(sessionId, error);
    const selectedFailed = this.state.selectedSessionId === sessionId;
    this.state = {
      ...this.state,
      sessionLoadErrorById: nextErrors,
      focusPending: selectedFailed ? false : this.state.focusPending,
    };
    this.emitChrome();
  }
  private clearSessionLoadError(sessionId: string) {
    if (!this.state.sessionLoadErrorById.has(sessionId)) return;
    const nextErrors = new Map(this.state.sessionLoadErrorById);
    nextErrors.delete(sessionId);
    this.state = { ...this.state, sessionLoadErrorById: nextErrors };
    this.emitChrome();
  }
  clear = () => {
    this.resetLiveRuntimeState();
    this.state = { ...initialSessionStoreState(), connection: 'ready' };
    clearAllRevertNavigations();
    this.navigationGenerationById.clear();
    this.navigationCounter = 0;
    // Broadcast the empty state so mounted UI hears the reset; listener
    // sets stay intact so the cluster can be rebuilt without resubscribing.
    this.emitBroadcast();
  };

  // Catalog refresh — per-directory listings populate `state.catalog` with
  // metadata for every known session. Failures preserve prior rows and flip
  // the directory's `listStatusByDirectory` entry to `'failed'`; other
  // directories are untouched. The at-most-2 in-flight scheduler lives in
  // `pi-session-catalog.ts` and is owned by the catalog (`PiSessionStore` is
  // the single mutation authority).

  /**
   * Refresh the catalog for a single directory. A successful list replaces
   * that directory's membership; other directories are untouched. Failure
   * keeps the prior catalog rows for the directory and marks it `'failed'`,
   * so the sidebar / archive pages can still render the directory with its
   * last known state — failure is not empty success.
   */
  async refreshDirectoryCatalog(directory: string): Promise<{ ok: true } | { ok: false; error: PiRequestError }> {
    const normalized = normalizePath(directory);
    if (!normalized) return { ok: false, error: asError(new PiRequestError('INVALID_ARGUMENT', 'directory is required')) };
    const runtimeKey = getRuntimeKey();
    // Per-directory generation. A newer call to `refreshDirectoryCatalog`
    // for the same directory bumps the generation and a slow completion
    // from the previous call commits nothing. This keeps a stale RPC
    // from clobbering a fresher snapshot while the scheduler still
    // permits up to two listings in flight at once.
    const generation = (this.directoryRefreshGenerationByDirectory.get(normalized) ?? 0) + 1;
    this.directoryRefreshGenerationByDirectory.set(normalized, generation);
    const startedRuntimeGeneration = this.runtimeGeneration;
    // Baseline snapshot for mutation reconciliation: every catalog mutation
    // that commits after this line (rename/archive/remove/create/detail
    // upserts/stream-event metadata) is newer than the listing and must
    // survive it per session. Held in this operation's closure, so its
    // lifetime is exactly the RPC duration.
    const baseline = this.state.catalog;
    const nextLoadingCatalog = markDirectoryLoading(this.state.catalog, normalized);
    if (nextLoadingCatalog !== this.state.catalog) {
      this.state = {
        ...this.state,
        catalog: nextLoadingCatalog,
      };
      this.emit([TOPIC_CATALOG]);
    }
    try {
      const result = await piClient.listSessions({ directory: normalized, runtimeKey });
      // Three guards, in order: stale per-directory generation, runtime
      // switch, runtime-key drift.
      if (this.directoryRefreshGenerationByDirectory.get(normalized) !== generation) return { ok: true };
      if (startedRuntimeGeneration !== this.runtimeGeneration) return { ok: true };
      if (runtimeKey !== getRuntimeKey()) return { ok: true };
      // A response generated by a previous daemon process predates the
      // current stream epoch; treat it like a transient list failure so
      // prior rows survive and the directory keeps its retry path.
      if (!this.isResponseEpochCurrent(result)) {
        throw new PiRequestError('DAEMON_REQUEST_FAILED', 'Session list predates the current stream epoch');
      }
      const listedSessions = this.filterDeletedListItems(result.sessions);
      const nextCatalog = applyDirectoryListWithReconciliation(baseline, this.state.catalog, normalized, listedSessions, Date.now(), this.deletedSessionIds);
      if (nextCatalog !== this.state.catalog) {
        this.state = { ...this.state, catalog: nextCatalog };
        this.emit([TOPIC_CATALOG]);
        this.raiseOrderingBaselinesForDirectory(normalized);
      }
      return { ok: true };
    } catch (error) {
      if (this.directoryRefreshGenerationByDirectory.get(normalized) !== generation) return { ok: true };
      if (startedRuntimeGeneration !== this.runtimeGeneration) return { ok: true };
      if (runtimeKey !== getRuntimeKey()) return { ok: true };
      const requestError = asError(error);
      const failedCatalog = markDirectoryFailed(this.state.catalog, normalized);
      const focusedDirectory = normalizePath(this.state.directory) === normalized;
      const topics: string[] = [];
      if (failedCatalog !== this.state.catalog) {
        this.state = { ...this.state, catalog: failedCatalog };
        topics.push(TOPIC_CATALOG);
      }
      if (focusedDirectory) {
        this.state = { ...this.state, error: requestError };
        topics.push(TOPIC_CHROME);
      }
      if (topics.length > 0) this.emit(topics);
      return { ok: false, error: requestError };
    }
  }

  /**
   * Refresh the catalog for many directories concurrently. Schedules at
   * most two listings in flight at any moment. Each directory's success/failure
   * is independent; a failed directory does not affect the others.
   */
  async refreshAllDirectoryCatalogs(directories: Iterable<string>): Promise<void> {
    const ordered = [...new Set(directories)].map((directory) => normalizePath(directory)).filter((directory): directory is string => Boolean(directory));
    if (ordered.length === 0) return;
    await mapDirectoriesWithRefreshSlot(ordered, (directory) => this.refreshDirectoryCatalog(directory));
  }

  async start(options: {
    directory?: string | null;
    sessionId?: PiSessionId | null;
    /** The caller already knows the session belongs to `directory`. */
    sessionDirectoryKnown?: boolean;
  } = {}): Promise<void> {
    // Once the cluster is attached on this runtime (or has reached
    // `connection: 'ready'` even before the stream handle is assigned),
    // any further folder change is a focus change — it must NEVER
    // re-bootstrap, dispose the stream, or bump `runtimeGeneration`. The
    // stream has its own reconnect lifecycle; first-attach must keep its
    // own `connection: 'loading'` while the SSE plug is in flight, but
    // the moment that gate lifts a project click takes the focus path.
    if (
      this.hasClusterAttached()
      && this.state.connection !== 'error'
      && this.state.connection !== 'unavailable'
    ) {
      await this.focusProject(options.directory ?? null, options.sessionId ?? null);
      return;
    }
    try {
      const requestedDirectory = typeof options.directory === 'string' && options.directory.trim() ? options.directory : null;
      // A provided cwd is enough to attach. `open` lists that folder, hydrates
      // the id once, and only then `getSession`s if the id lives elsewhere.
      // Probing `getSession` here first downloaded the whole transcript just
      // to learn `directory`, then `open` downloaded it again.
      if (requestedDirectory) {
        await this.open(requestedDirectory, options.sessionId);
        return;
      }
      if (options.sessionId && !options.sessionDirectoryKnown) {
        try {
          const detail = await piClient.getSession(options.sessionId, { directory: requestedDirectory ?? undefined, runtimeKey: getRuntimeKey() });
          if (detail?.session?.directory) {
            await this.open(detail.session.directory, options.sessionId);
            return;
          }
        } catch {
          // Session lookup failed, fall through to directory resolution
        }
      }
      const projects = await piClient.listProjects({ runtimeKey: getRuntimeKey() });
      const directory = projects.projects.find((project) => project.selected)?.directory ?? projects.projects[0]?.directory;
      if (!directory) {
        await this.connectWithoutProject();
        return;
      }
      await this.open(directory, options.sessionId);
    } catch (error) { this.reportError(error); }
  }

  /**
   * Probe the daemon and mark the cluster connected without adopting a
   * filesystem cwd as the visible project. Used on first launch / when the
   * PiChamber project list is empty so chrome is not stuck on `loading`.
   */
  async connectWithoutProject(): Promise<void> {
    if (
      this.hasClusterAttached()
      && this.state.connection !== 'error'
      && this.state.connection !== 'unavailable'
    ) {
      await this.focusProject(null, null);
      return;
    }
    const expected = ++this.runtimeGeneration;
    this.focusGeneration = expected;
    this.pendingFocus = null;
    this.pendingPreferredSessionId = null;
    this.state = {
      ...this.state,
      directory: null,
      sessions: [],
      selectedSessionId: null,
      connection: 'loading',
      sessionsListStatus: 'idle',
      focusPending: false,
      error: null,
    };
    this.emitChrome();
    try {
      const health = await piClient.health({ runtimeKey: getRuntimeKey() });
      if (expected !== this.runtimeGeneration) return;
      if (health.state !== 'ready') {
        throw new PiRequestError(health.error?.code ?? 'DAEMON_UNAVAILABLE', health.error?.message);
      }
      this.state = {
        ...this.state,
        directory: null,
        sessions: [],
        selectedSessionId: null,
        connection: 'ready',
        sessionsListStatus: 'idle',
        focusPending: false,
        error: null,
      };
      this.emitChrome();
    } catch (error) {
      if (expected === this.runtimeGeneration) this.reportError(error);
    }
  }

  /** Switch the sidebar/create flow's directory pointer and that folder's
   *  session list without touching the live event stream or the resident
   *  session cluster. While the list is in flight, `focusPending` is true
   *  and `sessionsListStatus` is `'loading'`; the chat uses those flags to
   *  keep its existing view visible and the sidebar empty, so a folder
   *  switch cannot flash the bare `ChatEmptyState`.
   *
   *  If the preferred id is already in `hydratedSessionIds` (warm
   *  folder), we select it immediately and run the list in the background
   *  — the user sees their remembered session with no loader. If the list
   *  fails after the single automatic retry, status flips to `'failed'`
   *  but the cluster, the stream, and other folders' transcripts all
   *  survive; the chat's "Try again" re-runs `focusProject`.
   */
  async focusProject(directory: string | null, preferredSessionId?: PiSessionId | null): Promise<void> {
    const nextDirectory = typeof directory === 'string' && directory.trim() ? directory.trim() : null;
    const sameDirectory = normalizePath(nextDirectory) === normalizePath(this.state.directory);
    const desiredSessionId = preferredSessionId ?? null;
    if (sameDirectory) {
      if (!desiredSessionId || desiredSessionId === this.state.selectedSessionId) return;
      await this.select(desiredSessionId);
      return;
    }
    if (!nextDirectory) {
      // Clearing the focus without bringing down the cluster would leave the
      // sidebar list empty while background runs keep streaming. Surface the
      // focus pointer as null but keep the cluster untouched so a later
      // focus does not need to re-attach anything.
      this.state = {
        ...this.state,
        directory: null,
        sessions: [],
        sessionsListStatus: 'idle',
        focusPending: false,
        error: null,
      };
      this.emitChrome();
      return;
    }
    // Warm path: the preferred session is already hydrated. Select it
    // immediately and let the list resolve in the background so the chat
    // skips the loader on a known-good folder switch. The cluster pointer
    // and `sessionsListStatus` still update so the sidebar catches up.
    const expected = ++this.focusGeneration;
    this.pendingFocus = { directory: nextDirectory, expected, preferredSessionId: desiredSessionId };
    this.pendingPreferredSessionId = desiredSessionId;
    const warmAlready = !!desiredSessionId && this.hydratedSessionIds.has(desiredSessionId);
    this.state = {
      ...this.state,
      directory: nextDirectory,
      sessions: [],
      selectedSessionId: warmAlready ? desiredSessionId : (desiredSessionId ?? null),
      sessionsListStatus: 'loading',
      focusPending: !warmAlready,
      error: null,
    };
    this.emitChrome();
    if (warmAlready) {
      this.touchLastAccess(desiredSessionId as PiSessionId);
    }
    await this.resolveFocus(expected, nextDirectory);
  }

  private async resolveFocus(expected: number, directory: string): Promise<void> {
    const runtimeKey = getRuntimeKey();
    const startedRuntimeGeneration = this.runtimeGeneration;
    const baseline = this.state.catalog;
    const desiredSessionId = this.pendingPreferredSessionId;
    let resolvedDirectory = directory;
    try {
      try {
        const selected = await piClient.selectProject(directory, { runtimeKey });
        if (expected !== this.focusGeneration || startedRuntimeGeneration !== this.runtimeGeneration) return;
        resolvedDirectory = selected.directory;
        if (normalizePath(resolvedDirectory) !== normalizePath(this.state.directory)) {
          this.state = { ...this.state, directory: resolvedDirectory };
          this.emitChrome();
        }
      } catch (error) {
        // Transient selectProject failures are retried once. A persistent
        // failure becomes a `'failed'` focus slice and `state.error` —
        // never a cluster-wide `connection: 'error'`.
        if (!this.shouldRetryFocusError(error)) throw error;
        await delayBeforeRetry();
        if (expected !== this.focusGeneration || startedRuntimeGeneration !== this.runtimeGeneration) return;
        const selectedRetry = await piClient.selectProject(directory, { runtimeKey });
        resolvedDirectory = selectedRetry.directory;
        if (normalizePath(resolvedDirectory) !== normalizePath(this.state.directory)) {
          this.state = { ...this.state, directory: resolvedDirectory };
          this.emitChrome();
        }
      }
      const result = await this.fetchFocusListWithRetry(resolvedDirectory, expected, startedRuntimeGeneration, runtimeKey);
      if (result.kind === 'stale') return;
      if (result.kind === 'failed') {
        this.failFocus(expected, result.error);
        return;
      }
      const listPayload = { sessions: this.filterDeletedListItems(result.payload.sessions) };
      if (expected !== this.focusGeneration || startedRuntimeGeneration !== this.runtimeGeneration) return;
      let matchedSession = desiredSessionId
        ? listPayload.sessions.find((item) => item.session.id === desiredSessionId)
        : undefined;
      if (desiredSessionId && !matchedSession && !this.isDeleted(desiredSessionId)) {
        try {
          const detail = await piClient.getSession(desiredSessionId, { directory: resolvedDirectory, runtimeKey });
          if (detail?.session?.id) {
            if (
              detail.session.directory
              && normalizePath(detail.session.directory) !== normalizePath(resolvedDirectory)
              && expected === this.focusGeneration
            ) {
              // Session lives in a different folder than the one we just
              // focused; recurse rather than corrupt the new folder's list.
              await this.focusProject(detail.session.directory, desiredSessionId);
              return;
            }
            listPayload.sessions.unshift({ session: detail.session, updatedAt: detail.session.updatedAt });
            matchedSession = { session: detail.session, updatedAt: detail.session.updatedAt };
          }
        } catch {
          // Keep the requested id selected; hydrate() records a per-session
          // load error so the chat can leave the logo instead of spinning.
        }
      }
      if (expected !== this.focusGeneration || startedRuntimeGeneration !== this.runtimeGeneration) return;
      const desiredCanRemainSelected = desiredSessionId && !this.isDeleted(desiredSessionId);
      const nextSelectedSessionId = matchedSession?.session.id
        ?? (desiredCanRemainSelected ? desiredSessionId : (
          listPayload.sessions.find((item) => !item.session.archived)?.session.id
          ?? listPayload.sessions[0]?.session.id
          ?? null
        ));
      this.pendingPreferredSessionId = null;
      const nextCatalog = applyDirectoryListWithReconciliation(baseline, this.state.catalog, resolvedDirectory, listPayload.sessions, Date.now(), this.deletedSessionIds);
      const catalogChanged = nextCatalog !== this.state.catalog;
      this.state = {
        ...this.state,
        sessions: listPayload.sessions,
        selectedSessionId: nextSelectedSessionId,
        sessionsListStatus: 'ready',
        focusPending: !!nextSelectedSessionId && !this.hydratedSessionIds.has(nextSelectedSessionId),
        error: null,
        catalog: nextCatalog,
      };
      const listTopics: string[] = [TOPIC_CHROME];
      if (catalogChanged) listTopics.push(TOPIC_CATALOG);
      this.emit(listTopics);
      if (catalogChanged) this.raiseOrderingBaselinesForDirectory(resolvedDirectory);
      if (nextSelectedSessionId) this.touchLastAccess(nextSelectedSessionId);
      if (nextSelectedSessionId && !this.hydratedSessionIds.has(nextSelectedSessionId)) {
        await this.hydrate(nextSelectedSessionId, this.runtimeGeneration);
        if (expected === this.focusGeneration) {
          // The hydrate may have flipped focusPending back through
          // commitHydratedSession; reconcile against actual state.
          if (
            this.state.focusPending
            && this.state.selectedSessionId === nextSelectedSessionId
            && this.hydratedSessionIds.has(nextSelectedSessionId)
          ) {
            this.state = { ...this.state, focusPending: false };
            this.emitChrome();
          }
        }
      } else if (
        nextSelectedSessionId
        && this.hydratedSessionIds.has(nextSelectedSessionId)
        && this.state.focusPending
      ) {
        this.state = { ...this.state, focusPending: false };
        this.emitChrome();
      }
    } catch (error) {
      if (expected === this.focusGeneration && startedRuntimeGeneration === this.runtimeGeneration) {
        this.failFocus(expected, asError(error));
      }
    } finally {
      if (expected === this.focusGeneration && this.pendingFocus?.expected === expected) {
        this.pendingFocus = null;
      }
    }
  }

  /** False-empty guard: a list failure is recorded as `'failed'` rather
   *  than `sessions: []`, and the error stays attached to the focused
   *  slice only. The cluster `connection` is not flipped. */
  private failFocus(expected: number, error: PiRequestError) {
    if (expected !== this.focusGeneration) return;
    this.state = {
      ...this.state,
      sessions: [],
      sessionsListStatus: 'failed',
      focusPending: false,
      error,
    };
    this.emitChrome();
  }

  /** Classify which errors are transient enough to retry once before we
   *  commit a `failed` focus state. Server 5xx and explicit daemon
   *  unavailability qualify; a 4xx (except 408/429) or a malformed
   *  response should not be retried because it is not going to disappear
   *  on its own. */
  private shouldRetryFocusError(error: unknown): boolean {
    if (error instanceof PiRequestError) {
      if (error.code === 'DAEMON_UNAVAILABLE') return true;
      const status = (error as { status?: number }).status;
      if (typeof status === 'number' && status >= 500 && status < 600) return true;
      if (status === 408 || status === 429) return true;
      return false;
    }
    return true;
  }

  private async fetchFocusListWithRetry(
    resolvedDirectory: string,
    expected: number,
    startedRuntimeGeneration: number,
    runtimeKey: string,
  ): Promise<
    | { kind: 'stale' }
    | { kind: 'failed'; error: PiRequestError }
    | { kind: 'ok'; payload: { sessions: PiSessionListItem[] } }
  > {
    try {
      const result = await piClient.listSessions({ directory: resolvedDirectory, runtimeKey });
      if (expected !== this.focusGeneration || startedRuntimeGeneration !== this.runtimeGeneration) return { kind: 'stale' };
      // A stale-epoch list predates the daemon restart; retry once, then
      // surface a scoped failure rather than committing old membership.
      if (!this.isResponseEpochCurrent(result)) {
        throw new PiRequestError('DAEMON_REQUEST_FAILED', 'Session list predates the current stream epoch');
      }
      return { kind: 'ok', payload: result };
    } catch (error) {
      if (!this.shouldRetryFocusError(error)) {
        return { kind: 'failed', error: asError(error) };
      }
      await delayBeforeRetry();
      if (expected !== this.focusGeneration || startedRuntimeGeneration !== this.runtimeGeneration) return { kind: 'stale' };
      try {
        const result = await piClient.listSessions({ directory: resolvedDirectory, runtimeKey });
        if (expected !== this.focusGeneration || startedRuntimeGeneration !== this.runtimeGeneration) return { kind: 'stale' };
        if (!this.isResponseEpochCurrent(result)) {
          throw new PiRequestError('DAEMON_REQUEST_FAILED', 'Session list predates the current stream epoch');
        }
        return { kind: 'ok', payload: result };
      } catch (retryError) {
        return { kind: 'failed', error: asError(retryError) };
      }
    }
  }

  async open(directory: string, preferredSessionId?: PiSessionId | null): Promise<void> {
    // First-attach / runtime-switch bootstrap path. If the cluster already
    // covers the connected runtime (stream up OR `connection: 'ready'`
    // between health probe and stream assignment), a directory change is a
    // focus change — see `start` and `focusProject`. `open` remains the
    // right entry for the very first project discovery (no probe, no
    // cluster) and for legacy callers that intentionally want a full
    // cluster rebuild.
    if (
      this.hasClusterAttached()
      && this.state.connection !== 'error'
      && this.state.connection !== 'unavailable'
    ) {
      if (normalizePath(directory) === normalizePath(this.state.directory)) {
        if (preferredSessionId && preferredSessionId !== this.state.selectedSessionId) {
          await this.select(preferredSessionId);
        }
        return;
      }
      await this.focusProject(directory, preferredSessionId ?? null);
      return;
    }
    if (directory === this.state.directory && this.state.connection === 'loading') {
      if (preferredSessionId && preferredSessionId !== this.state.selectedSessionId) {
        this.pendingPreferredSessionId = preferredSessionId;
        this.state = { ...this.state, selectedSessionId: preferredSessionId, error: null };
        this.emitChrome();
      }
      return;
    }
    if (directory === this.state.directory && this.state.connection === 'ready') {
      if (preferredSessionId && preferredSessionId !== this.state.selectedSessionId) await this.select(preferredSessionId);
      return;
    }
    this.providerRefreshRevisionByDirectory.clear();
    const expected = ++this.runtimeGeneration;
    this.focusGeneration = expected;
    this.pendingFocus = null;
    this.pendingPreferredSessionId = preferredSessionId ?? null;
    this.hydratedSessionIds.clear();
    this.activityPhaseById.clear();
    this.pendingPromptById.clear();
    this.promptGenerationById.clear();
    this.lastAccessById.clear();
    this.lastAccessClock = 0;
    this.lastSelectedByDirectory.clear();
    this.directoryRefreshGenerationByDirectory.clear();
    // This is a same-runtime cluster rebuild, not a runtime switch. Keep
    // deletion tombstones so late reads from the displaced cluster cannot
    // resurrect sessions that were already authoritatively removed.
    this.evictionScheduled = false;
    this.restoringTranscriptById.clear();
    this.hydrateInflightById.clear();
    this.historyInflightById.clear();
    this.cadence.dispose();
    this.stream?.dispose(); this.stream = null;
    this.state = {
      ...this.state,
      directory,
      selectedSessionId: preferredSessionId ?? null,
      connection: 'loading',
      hydratedSessionIds: new Set(),
      reducer: {
        bySession: new Map(this.state.reducer.bySession),
        lastSequence: new Map(this.state.reducer.lastSequence),
      },
    };
    this.emitChrome();
    const runtimeKey = getRuntimeKey();
    const baseline = this.state.catalog;
    try {
      const selected = await piClient.selectProject(directory, { runtimeKey });
      if (expected !== this.runtimeGeneration) return;
      const scope: PiClientScope = { directory: selected.directory, runtimeKey };
      if (selected.directory !== directory) {
        this.state = { ...this.state, directory: selected.directory };
        this.emitChrome();
      }
      const health = await piClient.health(scope);
      if (expected !== this.runtimeGeneration) return;
      if (health.state !== 'ready') throw new PiRequestError(health.error?.code ?? 'DAEMON_UNAVAILABLE', health.error?.message);
      // First attach establishes the stream lifetime; without it cursors
      // cannot survive a daemon restart.
      this.adoptStreamEpoch((health as { streamEpoch?: string }).streamEpoch);
      const initialHealth: Extract<PiBootstrapHealth, { state: 'ready' }> = {
        state: 'ready',
        protocolVersion: health.protocolVersion,
        capabilities: [...health.capabilities],
        ...(typeof health.streamEpoch === 'string' ? { streamEpoch: health.streamEpoch } : {}),
      };
      const result = await piClient.listSessions(scope);
      if (expected !== this.runtimeGeneration) return;
      // A stale-epoch first-attach list predates the daemon restart.
      if (!this.isResponseEpochCurrent(result)) {
        throw new PiRequestError('DAEMON_REQUEST_FAILED', 'Session list predates the current stream epoch');
      }
      // Filter tombstones once, before matched-session lookup, so a deleted
      // session can neither be matched, selected, nor re-entered the catalog.
      const listedSessions = this.filterDeletedListItems(result.sessions);
      const desiredSessionId = this.pendingPreferredSessionId ?? preferredSessionId;
      let matchedSession = desiredSessionId ? listedSessions.find((item) => item.session.id === desiredSessionId) : undefined;
      if (desiredSessionId && !matchedSession && !this.isDeleted(desiredSessionId)) {
        try {
          const detail = await piClient.getSession(desiredSessionId, { directory, runtimeKey });
          if (detail?.session?.directory && detail.session.directory !== directory) {
            if (expected !== this.runtimeGeneration) return;
            await this.open(detail.session.directory, desiredSessionId);
            return;
          }
          if (detail?.session?.id) {
            listedSessions.unshift({ session: detail.session, updatedAt: detail.session.updatedAt });
            matchedSession = { session: detail.session, updatedAt: detail.session.updatedAt };
          }
        } catch {
          // Keep the requested id selected; hydrate() records a per-session
          // load error so the chat can leave the logo instead of spinning.
        }
      }
      const desiredCanRemainSelected = desiredSessionId && !this.isDeleted(desiredSessionId);
      const selectedSessionId = matchedSession?.session.id
        ?? (desiredCanRemainSelected ? desiredSessionId : (
          listedSessions.find((item) => !item.session.archived)?.session.id
          ?? listedSessions[0]?.session.id
          ?? null
        ));
      this.pendingPreferredSessionId = null;
      // First-attach: the cluster owns this runtime the moment its list
      // resolves. A folder click during list → hydrate → stream-attach
      // must focus, not dispose. `commitHydratedSession` keeps
      // `connection` untouched; we flip to `'ready'` here so the cluster
      // is considered attached before SSE is plugged.
      const nextCatalog = applyDirectoryListWithReconciliation(baseline, this.state.catalog, selected.directory, listedSessions, Date.now(), this.deletedSessionIds);
      const catalogChanged = nextCatalog !== this.state.catalog;
      this.state = {
        ...this.state,
        sessions: listedSessions,
        selectedSessionId,
        connection: 'ready',
        catalog: nextCatalog,
      };
      const openTopics: string[] = [TOPIC_CHROME];
      if (catalogChanged) openTopics.push(TOPIC_CATALOG);
      this.emit(openTopics);
      if (catalogChanged) this.raiseOrderingBaselinesForDirectory(selected.directory);
      if (selectedSessionId) {
        await this.hydrate(selectedSessionId, expected, undefined, {
          initialHealth,
          initialSessions: listedSessions,
        });
      }
    } catch (error) { if (expected === this.runtimeGeneration) this.reportError(error); }
  }

  async select(sessionId: PiSessionId, targetDirectory?: string): Promise<void> {
    if (!sessionId) return;
    const sessionDir = targetDirectory
      ?? this.state.reducer.bySession.get(sessionId)?.directory
      ?? this.state.sessions.find((item) => item.session.id === sessionId)?.session.directory;
    if (sessionDir && normalizePath(sessionDir) !== normalizePath(this.state.directory)) {
      // Cross-folder select: stay inside the live cluster. `open` is a no-op
      // (focus) when the stream is attached; `focusProject` only swaps the
      // pointer, never disposes the stream.
      if (this.stream !== null) {
        await this.focusProject(sessionDir, sessionId);
        return;
      }
      await this.open(sessionDir, sessionId);
      return;
    }
    if (this.state.connection === 'loading') {
      if (this.state.selectedSessionId === sessionId) {
        return;
      }
      this.pendingPreferredSessionId = sessionId;
      this.state = { ...this.state, selectedSessionId: sessionId, error: null };
      this.emitChrome();
      return;
    }
    if (!this.state.directory) {
      // No focused project yet — let `start` figure out which one owns
      // this session rather than triggering a bootstrap from here.
      await this.focusProject(null, sessionId);
      return;
    }
    if (sessionId === this.state.selectedSessionId) {
      this.touchLastAccess(sessionId);
      const resident = this.state.reducer.bySession.get(sessionId);
      if (!this.hydratedSessionIds.has(sessionId) || !resident) {
        await this.hydrate(sessionId, this.runtimeGeneration);
      }
      this.scheduleIdleEviction();
      return;
    }
    // Remember the last selection per folder so `start({directory})`
    // (no session hint) can pre-seed the focus's preferred id.
    if (this.state.directory) {
      this.lastSelectedByDirectory.set(this.state.directory, sessionId);
    }
    this.cadence.flush();
    this.state = { ...this.state, selectedSessionId: sessionId, error: null, focusPending: false };
    this.emitChrome();
    this.touchLastAccess(sessionId);
    const resident = this.state.reducer.bySession.get(sessionId);
    if (this.stream && this.hydratedSessionIds.has(sessionId) && resident) {
      this.scheduleIdleEviction();
      return;
    }
    await this.hydrate(sessionId, this.runtimeGeneration);
  }

  /** Last selection the cluster recorded for this directory. Returns
   *  `null` for folders the user has not focused yet or after a runtime
   *  switch. Used by `PiSessionProvider` to seed the focus path with a
   *  preferred id so warm folder switches can skip the chat loader. */
  lastSelectedSessionForDirectory(directory: string | null): PiSessionId | null {
    if (!directory) return null;
    return this.lastSelectedByDirectory.get(directory) ?? null;
  }

  /** Hydrate a resident session without changing `selectedSessionId` or
   *  the directory focus pointer. Used by chat surfaces that need a
   *  transcript for a session the user is not actively looking at
   *  (background child sessions inside a tool call). The call is a
   *  no-op when the session is already hydrated. */
  async ensureHydrated(sessionId: string): Promise<void> {
    if (!sessionId) return;
    const resident = this.state.reducer.bySession.get(sessionId);
    if (this.hydratedSessionIds.has(sessionId) && resident) {
      this.touchLastAccess(sessionId);
      return;
    }
    await this.hydrate(sessionId, this.runtimeGeneration);
  }

  async create(title?: string, options?: {
    directory?: string;
    model?: { providerId: string; modelId: string };
    thinking?: PiThinkingLevel;
    select?: boolean;
  }): Promise<string> {
    const directory = options?.directory || this.directory(); const expected = this.runtimeGeneration;
    let model = options?.model;
    let thinking = options?.thinking;
    if (!model || (!thinking && !useConfigStore.getState().isInitialized)) {
      // Callers outside the initialized composer still need an authoritative
      // settings read. A failure must abort creation rather than silently use
      // an unknown default selection.
      const settings = await piClient.getSettings({ directory, runtimeKey: getRuntimeKey() });
      model ??= settings.pichamber.defaultModel;
      thinking = resolveCreateThinking({
        thinking,
        model,
        defaultThinkingByModel: settings.pichamber.defaultThinkingByModel,
        defaultThinking: settings.pichamber.defaultThinking,
      });
    } else if (!thinking) {
      // The composer can only supply a model after config initialization. Reuse
      // that authoritative settings snapshot instead of serializing another
      // settings request ahead of session creation.
      const config = useConfigStore.getState();
      thinking = resolveCreateThinking({
        model,
        defaultThinkingByModel: config.settingsDefaultThinkingByModel,
        defaultThinking: config.settingsDefaultThinking,
      });
    }
    const detail = await piClient.createSession({
      cwd: directory,
      ...(title ? { title } : {}),
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
    }, { directory, runtimeKey: getRuntimeKey() });
    if (expected !== this.runtimeGeneration) return detail.session.id;
    this.state = {
      ...this.state,
      sessions: [{ session: detail.session, updatedAt: detail.session.updatedAt }, ...this.state.sessions],
      selectedSessionId: options?.select === false ? this.state.selectedSessionId : detail.session.id,
    };
    // Seed the catalog with the freshly created row before hydration so
    // sidebar / header surfaces see the new session without waiting for
    // the SSE echo. `upsertRecord` is a no-op when the row already exists
    // (e.g. a parallel event arrived first).
    const nextCatalog = upsertRecord(this.state.catalog, this.recordFromPiSession(detail.session));
    const catalogChanged = nextCatalog !== this.state.catalog;
    this.state = { ...this.state, catalog: nextCatalog };
    const createTopics: string[] = [TOPIC_CHROME];
    if (catalogChanged) createTopics.push(TOPIC_CATALOG);
    this.emit(createTopics);
    await this.hydrate(detail.session.id, expected, detail);
    return detail.session.id;
  }

  async rename(sessionId: string, title: string) {
    const expected = this.runtimeGeneration;
    const runtimeKey = getRuntimeKey();
    await piClient.renameSession({ sessionId, title }, this.scope());
    // A runtime switch while the RPC was in flight must not mutate the new
    // runtime's catalog with the old runtime's confirmation.
    if (expected !== this.runtimeGeneration || runtimeKey !== getRuntimeKey()) return;
    const now = Date.now();
    const nextCatalog = applyTitleChange(this.state.catalog, sessionId, title, now);
    const catalogChanged = nextCatalog !== this.state.catalog;
    this.state = {
      ...this.state,
      sessions: this.state.sessions.map((item) => item.session.id === sessionId ? { ...item, session: { ...item.session, title } } : item),
      catalog: nextCatalog,
    };
    const topics: string[] = [TOPIC_CHROME];
    if (catalogChanged) topics.push(TOPIC_CATALOG);
    this.emit(topics);
  }
  private resolveSessionDirectory(sessionId: string, explicitDirectory?: string): string | undefined {
    return explicitDirectory
      ?? this.state.catalog.byId.get(sessionId)?.directory
      ?? this.state.sessions.find((item) => item.session.id === sessionId)?.session.directory;
  }
  async archive(sessionId: string, archived: boolean, directory?: string) {
    const expected = this.runtimeGeneration;
    const runtimeKey = getRuntimeKey();
    const sessionDir = this.resolveSessionDirectory(sessionId, directory);
    await piClient.archiveSession({ sessionId, archived }, this.scope(sessionDir));
    if (expected !== this.runtimeGeneration || runtimeKey !== getRuntimeKey()) return;
    const now = Date.now();
    const nextCatalog = applyArchiveChange(this.state.catalog, sessionId, archived, now);
    const catalogChanged = nextCatalog !== this.state.catalog;
    this.state = {
      ...this.state,
      sessions: this.state.sessions.map((item) => item.session.id === sessionId ? { ...item, session: { ...item.session, archived } } : item),
      catalog: nextCatalog,
    };
    const topics: string[] = [TOPIC_CHROME];
    if (catalogChanged) topics.push(TOPIC_CATALOG);
    this.emit(topics);
  }
  async remove(sessionId: string, directory?: string) {
    const expected = this.runtimeGeneration;
    const runtimeKey = getRuntimeKey();
    const sessionDir = this.resolveSessionDirectory(sessionId, directory);
    // `deleteSession` treats 404 as success, so an already-deleted session still commits locally.
    await piClient.deleteSession({ sessionId, ignoreMissing: true }, sessionDir ? this.scope(sessionDir) : this.scope());
    if (expected !== this.runtimeGeneration || runtimeKey !== getRuntimeKey()) return;
    const selectedBefore = this.state.selectedSessionId;
    this.commitDeletion(sessionId, sessionDir);
    const selectedAfter = this.state.selectedSessionId;
    if (selectedAfter && selectedAfter !== selectedBefore) await this.hydrate(selectedAfter, expected);
  }
  async fork(sessionId: string, messageId?: string) {
    // Capture original title before fork so we can label the new branch.
    const originalTitle =
      this.state.sessions.find((item) => item.session.id === sessionId)?.session.title ??
      this.state.catalog.byId.get(sessionId)?.title ??
      '';
    const expected = this.runtimeGeneration;
    const runtimeKey = getRuntimeKey();
    const detail = await piClient.forkSession({ sessionId, ...(messageId ? { messageId } : {}) }, this.scope());
    if (expected !== this.runtimeGeneration || runtimeKey !== getRuntimeKey()) return;
    this.upsertAndHydrate(detail);
    // Make the fork obvious in the sidebar / header. Keep the original title
    // and append " (Fork)" once — don't double-append on repeated forks.
    const newTitleRaw = detail.session.title?.trim() || originalTitle.trim() || 'Untitled';
    if (!newTitleRaw.includes('(Fork)')) {
      const forkTitle = `${newTitleRaw} (Fork)`;
      // Fire-and-forget rename; the detail is already shown optimistically.
      void this.rename(detail.session.id, forkTitle).catch(() => {});
    }
  }
  async clone(sessionId: string) {
    const expected = this.runtimeGeneration;
    const runtimeKey = getRuntimeKey();
    const detail = await piClient.cloneSession({ sessionId }, this.scope());
    if (expected !== this.runtimeGeneration || runtimeKey !== getRuntimeKey()) return;
    this.upsertAndHydrate(detail);
  }
  async navigate(sessionId: string, messageId: string) {
    // Capture the pre-navigation active branch for the dock. Use the
    // reducer's current messages so we preserve ordering without
    // comparing entry IDs (which are random hex). Fetch failure must
    // not synthesize an empty abandoned branch.
    const previous = this.state.reducer.bySession.get(sessionId);
    const previousMessages = previous ? [...previous.messages.values()] : [];
    const previousPreviewById = new Map<string, string>();
    for (const msg of previousMessages) {
      const text = typeof (msg as { text?: string }).text === 'string' ? (msg as { text?: string }).text!.trim() : '';
      if (text) previousPreviewById.set(msg.id, text);
    }
    const expected = this.runtimeGeneration;
    // Bump per-session navigation generation so a stale hydrate that
    // started before this navigate cannot restore the old tail afterwards.
    const navGen = (this.navigationGenerationById.get(sessionId) ?? 0) + 1;
    this.navigationGenerationById.set(sessionId, navGen);
    this.navigationCounter = Math.max(this.navigationCounter, navGen);
    // Invalidate any in-flight hydrate for this session — its fetched
    // transcript is now stale (it was the pre-revert branch).
    this.hydrateInflightById.delete(sessionId);
    this.historyInflightById.delete(sessionId);
    try {
      const detail = await piClient.navigateSession(sessionId, messageId, this.scope());
      // If another navigate raced and bumped the generation, or the
      // runtime switched, this result is stale — discard it.
      if ((this.navigationGenerationById.get(sessionId) ?? 0) !== navGen) return detail;
      if (expected !== this.runtimeGeneration) return detail;
      // A detail generated by a previous daemon process predates the
      // current stream epoch; its sequence space is incompatible.
      if (!this.isResponseEpochCurrent(detail)) return detail;
      // Authoritative truncated commit — do not merge the old tail back in.
      const hydrated = this.sessionFromDetail(detail);
      this.commitNavigationSession(hydrated);
      const navigation = (detail as unknown as { navigation?: { targetEntryId: string; previousLeafId: string | null; newLeafId: string | null; editorText?: string } }).navigation;
      if (navigation && typeof navigation.targetEntryId === 'string' && detail.hasMoreBefore !== true) {
        const newIds = new Set(detail.messages.map((entry) => entry.message.id));
        const currentAbandoned = previousMessages
          .filter((msg) => !newIds.has(msg.id))
          .map((msg) => {
            const preview = (previousPreviewById.get(msg.id) ?? '').replace(/\s+/g, ' ').slice(0, 120) || '[No text]';
            const role = (msg as { role?: string }).role === 'assistant' ? 'assistant' as const : 'user' as const;
            return { id: msg.id, role, preview };
          });
        // Accumulate with any previously abandoned tail so the dock shows the
        // full discarded branch after successive reverts (e.g. revert to 6 then
        // to 3 should show 3..10, not just 3..5). Order is preserved.
        const oldNav = getRevertNavigation(sessionId);
        const seen = new Set(currentAbandoned.map((entry) => entry.id));
        const combined = [...currentAbandoned];
        for (const entry of oldNav?.abandoned ?? []) {
          if (!newIds.has(entry.id) && !seen.has(entry.id)) {
            combined.push(entry);
            seen.add(entry.id);
          }
        }
        if (combined.length === 0) {
          clearRevertNavigation(sessionId);
        } else {
          setRevertNavigation(
            sessionId,
            oldNav ? { ...navigation, previousLeafId: oldNav.previousLeafId } : navigation,
            combined,
          );
        }
      }
      return detail;
    } catch (error) {
      // On failure, roll back the generation bump so a later hydrate
      // is not incorrectly considered stale. Preserve existing state.
      const current = this.navigationGenerationById.get(sessionId);
      if (current === navGen) {
        if (navGen <= 1) this.navigationGenerationById.delete(sessionId);
        else this.navigationGenerationById.set(sessionId, navGen - 1);
      }
      throw error;
    }
  }
  async prompt(
    sessionId: string,
    text: string,
    delivery: 'prompt' | 'steer' | 'followUp',
    attachments?: Array<{ id: string }>,
    options?: { knownEmptyTranscript?: boolean; operationId?: string; directory?: string; runtimeKey?: string },
  ) {
    const expected = this.runtimeGeneration;
    const runtimeKey = options?.runtimeKey ?? getRuntimeKey();
    const scope = { directory: this.resolveSessionDirectory(sessionId, options?.directory), runtimeKey };
    if (runtimeKey !== getRuntimeKey()) throw new Error('Runtime changed before sending message.');
    let existing = this.state.reducer.bySession.get(sessionId);
    const hasAuthoritativeCreatedEmptyTranscript =
      options?.knownEmptyTranscript === true
      && this.hydratedSessionIds.has(sessionId)
      && existing !== undefined
      && existing.messages.size === 0;
    // Existing sessions with a missing or blank resident row must restore the
    // append-only log before going busy. A just-created session is the narrow
    // exception: its creation detail authoritatively established an empty log.
    if ((!existing || existing.messages.size === 0) && !hasAuthoritativeCreatedEmptyTranscript) {
      await this.hydrate(sessionId, expected);
      if (expected !== this.runtimeGeneration || runtimeKey !== getRuntimeKey()) {
        throw new Error('Runtime changed before sending message.');
      }
      existing = this.state.reducer.bySession.get(sessionId);
    }
    // LAN HTTP contexts expose getRandomValues but not randomUUID. Prepare
    // the ID before publishing busy state so random-source failures cannot
    // strand a prompt that was never sent. Keep the existing UUID v4 format.
    const operationId = options?.operationId ?? createBrowserUuid();
    const input = { sessionId, text, operationId, messageId: `msg_${operationId}`, ...(attachments?.length ? { attachments } : {}) };
    const nextSession: PiReducerSessionState = existing
      ? { ...existing, lifecycle: 'busy' }
      : {
          sessionId,
          directory: this.state.directory
            ?? this.state.sessions.find((item) => item.session.id === sessionId)?.session.directory
            ?? '',
          lastSequence: this.state.reducer.lastSequence.get(sessionId) ?? -1,
          lifecycle: 'busy',
          messages: new Map(),
          partOrder: new Map(),
          parts: createReducerPartMap(),
          toolsByCallId: new Map(),
          streamingMessages: new Set(),
          queue: { steering: 0, followUp: 0 },
          extensionStatuses: new Map(),
          extensionWidgets: new Map(),
          extensionDialogs: [],
          extensionNotices: [],
          extensionErrors: [],
          extensionPanels: new Map(),
          extensionApps: new Map(),
        };
    const nextBySession = new Map(this.state.reducer.bySession);
    nextBySession.set(sessionId, nextSession);
    this.state = { ...this.state, reducer: { ...this.state.reducer, bySession: nextBySession } };
    const generation = (this.promptGenerationById.get(sessionId) ?? 0) + 1;
    this.promptGenerationById.set(sessionId, generation);
    this.pendingPromptById.add(sessionId);
    this.promoteSession(sessionId, 'active', { reorder: true });
    this.touchSessionList(sessionId);
    const promptedAt = Date.now();
    const nextCatalog = touchRecordUpdatedAt(
      applyLifecycleChange(this.state.catalog, sessionId, 'busy'),
      sessionId,
      promptedAt,
      {
        directory: nextSession.directory || this.state.directory || '',
        lifecycle: 'busy',
      },
    );
    const catalogChanged = nextCatalog !== this.state.catalog;
    this.state = { ...this.state, catalog: nextCatalog };
    const promptTopics: string[] = [`session:${sessionId}`, TOPIC_CHROME];
    if (catalogChanged) promptTopics.push(TOPIC_CATALOG);
    this.emit(promptTopics);
    try {
      let result;
      if (delivery === 'steer') result = await piClient.sendSteer(input, scope);
      else if (delivery === 'followUp') result = await piClient.sendFollowUp(input, scope);
      else result = await piClient.sendPrompt(input, scope);
      // Sending on the new branch commits it — stale revert/redo becomes
      // invalid. The old branch remains discoverable via GET /tree.
      clearRevertNavigation(sessionId);
      if (delivery === 'prompt' && text.trimStart().startsWith('/')) {
        // Native extension commands can finish without an assistant turn. The
        // lifecycle/model events normally settle the optimistic row, but a
        // command sent while the event stream is attaching can fall entirely
        // inside that gap. Reconcile only while this prompt is still pending;
        // ordinary slash prompts leave pending state as soon as their agent
        // turn starts and therefore pay no snapshot request.
        void this.reconcileAcceptedSlashPrompt(sessionId, generation, expected);
      }
      return result;
    } catch (error) {
      recordMobileDiagnosticError('prompt-send', error);
      if (expected !== this.runtimeGeneration || runtimeKey !== getRuntimeKey()) throw error;
      if (isSessionInUseError(error)) {
        // Another PiChamber instance owns this session. Record the chrome
        // signal so the composer locks for this session until a later
        // successful hydrate clears it; the transcript itself is preserved.
        this.failSessionLoad(sessionId, error);
      }
      if (this.promptGenerationById.get(sessionId) === generation) {
        this.pendingPromptById.delete(sessionId);
        const current = this.state.reducer.bySession.get(sessionId);
        if (current?.lifecycle === 'busy' && current.streamingMessages.size === 0) {
          const reverted = new Map(this.state.reducer.bySession);
          reverted.set(sessionId, { ...current, lifecycle: 'error' });
          this.state = { ...this.state, reducer: { ...this.state.reducer, bySession: reverted } };
          this.promoteSession(sessionId, 'settled');
          // The reducer record changed (lifecycle: error); chrome also
          // flips via the next selector read. Catalog is unchanged.
          this.emit([`session:${sessionId}`, TOPIC_CHROME]);
        }
      }
      throw error;
    }
  }
  private async reconcilePendingPromptSnapshot(
    sessionId: PiSessionId,
    generation: number,
    expectedRuntimeGeneration: number,
  ): Promise<boolean> {
    const resident = this.state.reducer.bySession.get(sessionId);
    const directory = resident?.directory
      ?? this.state.sessions.find((item) => item.session.id === sessionId)?.session.directory
      ?? this.directory();
    try {
      const detail = await piClient.getSession(sessionId, {
        directory,
        runtimeKey: getRuntimeKey(),
      });
      if (
        expectedRuntimeGeneration !== this.runtimeGeneration
        || this.promptGenerationById.get(sessionId) !== generation
        || detail.session.id !== sessionId
      ) {
        return false;
      }
      const currentSequence = this.state.reducer.lastSequence.get(sessionId)
        ?? this.state.reducer.bySession.get(sessionId)?.lastSequence
        ?? -1;
      if (currentSequence > detail.lastSequence) return false;
      if (
        (detail.lifecycle === 'busy' || detail.lifecycle === 'retry')
        && typeof detail.runStartedAt === 'number'
      ) {
        adoptServerRunTiming(detail.session.id, detail.runStartedAt, detail.serverNow);
      }
      const settled = detail.lifecycle !== 'busy'
        && detail.lifecycle !== 'retry'
        && detail.isStreaming !== true;
      if (settled) {
        this.pendingPromptById.delete(sessionId);
        const current = this.state.reducer.bySession.get(sessionId);
        if (current?.lifecycle === 'busy' || current?.lifecycle === 'retry') {
          const bySession = new Map(this.state.reducer.bySession);
          bySession.set(sessionId, { ...current, lifecycle: 'idle' });
          this.state = {
            ...this.state,
            reducer: { ...this.state.reducer, bySession },
          };
        }
      }
      this.commitHydratedSession(this.sessionFromDetail(detail));
      return settled;
    } catch {
      // The event stream remains primary. A failed fallback must preserve
      // the optimistic/live state rather than turning failure into idle.
      return false;
    }
  }

  private async reconcileAcceptedSlashPrompt(
    sessionId: PiSessionId,
    generation: number,
    expectedRuntimeGeneration: number,
  ): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 750));
    if (
      expectedRuntimeGeneration !== this.runtimeGeneration
      || this.promptGenerationById.get(sessionId) !== generation
      || !this.pendingPromptById.has(sessionId)
    ) {
      return;
    }

    if (!(await this.reconcilePendingPromptSnapshot(sessionId, generation, expectedRuntimeGeneration))) return;
    // A non-streaming extension can continue mutating model/thinking/UI state
    // briefly after it first appears idle. Take one bounded final snapshot so
    // a client that missed the whole event burst still converges.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    if (
      expectedRuntimeGeneration !== this.runtimeGeneration
      || this.promptGenerationById.get(sessionId) !== generation
    ) {
      return;
    }
    await this.reconcilePendingPromptSnapshot(sessionId, generation, expectedRuntimeGeneration);
  }

  abort = (sessionId: string) => piClient.abortSession({ sessionId }, this.scope());
  compact = (sessionId: string, customInstructions?: string) => piClient.compactSession({
    sessionId,
    ...(customInstructions ? { customInstructions } : {}),
  }, this.scope());
  setModel = (sessionId: string, providerId: string, modelId: string) => piClient.setSessionModel({ sessionId, model: { providerId, modelId } }, this.scope());
  setThinking = (sessionId: string, thinking: PiThinkingLevel) => piClient.setSessionThinking({ sessionId, thinking }, this.scope());
  tree = (sessionId: string) => piClient.getSessionTree(sessionId, this.scope());
  providers = () => piClient.listProviders({ runtimeKey: getRuntimeKey() });
  upload = (input: { filename: string; mime: string; base64: string }) => piClient.createAttachment(input, this.scope());
  uploadFile = (file: Blob, input: { filename: string; mime: string; signal?: AbortSignal }) => piClient.uploadAttachment(file, input, this.scope());
  deleteUpload = (id: string) => piClient.deleteAttachment(id, this.scope());
  selected(): PiProjectedSession | null { const id = this.state.selectedSessionId; const session = id ? this.state.reducer.bySession.get(id) : undefined; return session ? projectSession(session) : null; }

  /** Consume a live editor replacement once so remount/revisit cannot replay it. */
  consumeExtensionEditor(sessionId: PiSessionId, sequence: number): void {
    const current = this.state.reducer.bySession.get(sessionId);
    if (current?.extensionEditor?.sequence !== sequence) return;
    const bySession = new Map(this.state.reducer.bySession);
    bySession.set(sessionId, { ...current, extensionEditor: undefined });
    this.state = { ...this.state, reducer: { ...this.state.reducer, bySession } };
    this.emit([`session:${sessionId}`]);
  }

  /** Remove an answered extension dialog from the pending queue (no-op if absent). */
  dismissExtensionDialog(sessionId: PiSessionId, requestId: string): void {
    const nextReducer = dismissExtensionDialog(this.state.reducer, sessionId, requestId);
    if (nextReducer === this.state.reducer) return;
    this.state = { ...this.state, reducer: nextReducer };
    this.emit([`session:${sessionId}`, TOPIC_DIALOGS]);
  }

  private sessionFromDetail(detail: Awaited<ReturnType<typeof piClient.getSession>>) {
    return hydrateSessionFromDetail(detail).session;
  }

  async loadOlderMessages(sessionId: PiSessionId): Promise<boolean> {
    const inFlight = this.historyInflightById.get(sessionId);
    if (inFlight) return inFlight;
    const resident = this.state.reducer.bySession.get(sessionId);
    if (!resident?.hasMoreBefore || !resident.beforeCursor) return false;
    // A committed deletion is authoritative; never start (or continue) a
    // history page for a tombstoned session.
    if (this.isDeleted(sessionId)) return false;
    const expectedRuntime = this.runtimeGeneration;
    const expectedNavigation = this.navigationGenerationById.get(sessionId) ?? 0;
    const expectedCursor = resident.beforeCursor;
    const runtimeKey = getRuntimeKey();
    const task = piClient.getSessionMessages(sessionId, { before: expectedCursor }, {
      directory: resident.directory,
      runtimeKey,
    }).then((detail) => {
      if (expectedRuntime !== this.runtimeGeneration || runtimeKey !== getRuntimeKey()) return false;
      if ((this.navigationGenerationById.get(sessionId) ?? 0) !== expectedNavigation) return false;
      const current = this.state.reducer.bySession.get(sessionId);
      if (!current || current.beforeCursor !== expectedCursor || detail.session.id !== sessionId) return false;
      // A deletion committed while the page request was in flight wins over
      // the response; merging here would resurrect the transcript row.
      if (this.isDeleted(sessionId)) return false;
      // A page generated by a previous daemon process predates the current
      // stream epoch; its sequence space and cursor are incompatible.
      if (!this.isResponseEpochCurrent(detail)) return false;
      const page = hydrateSessionFromDetail(detail).session;
      const messages = new Map(page.messages);
      for (const [id, message] of current.messages) messages.set(id, message);
      const partOrder = new Map(page.partOrder);
      for (const [id, order] of current.partOrder) partOrder.set(id, order);
      const parts = createReducerPartMap(page.parts);
      for (const [id, part] of current.parts) parts.set(id, part);
      const toolsByCallId = new Map(page.toolsByCallId);
      for (const [callId, messageId] of current.toolsByCallId) toolsByCallId.set(callId, messageId);
      const merged: PiReducerSessionState = {
        ...current,
        messages,
        partOrder,
        parts,
        toolsByCallId,
        hasMoreBefore: page.hasMoreBefore === true,
        beforeCursor: page.beforeCursor,
        // Historical pages do not claim coverage of intervening live events.
        lastSequence: current.lastSequence,
      };
      const reducer = {
        bySession: new Map(this.state.reducer.bySession),
        lastSequence: new Map(this.state.reducer.lastSequence),
      };
      reducer.bySession.set(sessionId, merged);
      reducer.lastSequence.set(sessionId, merged.lastSequence);
      this.state = { ...this.state, reducer };
      this.touchLastAccess(sessionId);
      this.emit([`session:${sessionId}`]);
      return merged.hasMoreBefore === true;
    }).finally(() => {
      if (this.historyInflightById.get(sessionId) === task) this.historyInflightById.delete(sessionId);
    });
    this.historyInflightById.set(sessionId, task);
    return task;
  }

  private recordFromPiSession(session: PiSession, options?: { now?: number }): LiveSessionRecord {
    return createRecordFromPiSession(session, this.state.catalog, options);
  }

  private mergeHydratedSession(
    fetched: PiReducerSessionState,
    existing: PiReducerSessionState | undefined,
  ): PiReducerSessionState {
    return mergeHydratedSession(fetched, existing);
  }

  /** Records that a session was just touched — selected, hydrated, or
   *  received an event. Used by the deferred LRU eviction pass to keep
   *  recent activity resident and drop the longest-idle transcript when
   *  the soft cap is exceeded. The clock is a per-process counter rather
   *  than `Date.now()` so tabs hidden across boot still produce a stable
   *  total order. */
  private touchLastAccess(sessionId: PiSessionId) {
    if (!sessionId) return;
    this.lastAccessClock += 1;
    this.lastAccessById.set(sessionId, this.lastAccessClock);
  }

  /**
   * Authoritative commit for `sessions.navigate`. Unlike `commitHydratedSession`,
   * the daemon's active branch is the truth and the old tail must be discarded.
   * `mergeHydratedSession` deliberately preserves the tail for stale-hydrate
   * safety, which would make revert appear not to delete messages.
   */
  private commitNavigationSession(hydratedSession: PiReducerSessionState) {
    this.cadence.flush();
    const existing = this.state.reducer.bySession.get(hydratedSession.sessionId);
    // Keep model/thinking from existing if the detail didn't include them,
    // and keep queue if it was pending. Do not keep old messages/parts.
    const session: PiReducerSessionState = existing
      ? {
          ...hydratedSession,
          lastSequence: Math.max(hydratedSession.lastSequence, existing.lastSequence),
          ...(existing.model && !hydratedSession.model ? { model: existing.model } : {}),
          ...(existing.thinking && !hydratedSession.thinking ? { thinking: existing.thinking } : {}),
          queue: existing.queue.steering > 0 || existing.queue.followUp > 0 ? existing.queue : hydratedSession.queue,
        }
      : hydratedSession;
    const reducer: PiReducerState = {
      bySession: new Map(this.state.reducer.bySession),
      lastSequence: new Map(this.state.reducer.lastSequence),
    };
    reducer.bySession.set(session.sessionId, session);
    reducer.lastSequence.set(session.sessionId, session.lastSequence);
    this.hydratedSessionIds.add(session.sessionId);
    this.touchLastAccess(session.sessionId);
    const isSelectedHydrated = this.state.selectedSessionId === session.sessionId;
    const nextFocusPending = isSelectedHydrated
      ? false
      : this.state.focusPending && !this.hydratedSessionIds.has(this.state.selectedSessionId ?? '');
    let nextLoadErrors = this.state.sessionLoadErrorById;
    if (nextLoadErrors.has(session.sessionId)) {
      const updated = new Map(nextLoadErrors);
      updated.delete(session.sessionId);
      nextLoadErrors = updated;
    }
    const catalogLifecycle = catalogLifecycleFromReducer(session.lifecycle);
    let nextCatalog = this.state.catalog;
    if (!nextCatalog.byId.has(session.sessionId)) {
      nextCatalog = upsertStubRecord(nextCatalog, session.sessionId, session.directory, catalogLifecycle);
    }
    nextCatalog = applyHydratedChange(nextCatalog, session.sessionId, true);
    nextCatalog = applyLifecycleChange(nextCatalog, session.sessionId, catalogLifecycle, session.retry);
    const catalogChanged = nextCatalog !== this.state.catalog;
    this.state = {
      ...this.state,
      reducer,
      error: null,
      focusPending: nextFocusPending,
      hydratedSessionIds: new Set(this.hydratedSessionIds),
      sessionLoadErrorById: nextLoadErrors,
      catalog: nextCatalog,
    };
    const topics: string[] = [`session:${session.sessionId}`, TOPIC_CHROME];
    if (catalogChanged) topics.push(TOPIC_CATALOG);
    this.emit(topics);
    this.scheduleIdleEviction();
  }

  private commitHydratedSession(hydratedSession: PiReducerSessionState, buffered: readonly PiSessionEvent[] = []) {
    // A committed deletion is authoritative: a late hydrate must not resurrect the row.
    if (this.isDeleted(hydratedSession.sessionId)) return;
    this.cadence.flush();
    const existingSession = this.state.reducer.bySession.get(hydratedSession.sessionId);
    const session = this.mergeHydratedSession(hydratedSession, existingSession);
    if (session.lifecycle === 'busy' || session.lifecycle === 'retry') {
      observeSessionActivityTiming(session.sessionId, 'active');
    }
    let reducer: PiReducerState = {
      bySession: new Map(this.state.reducer.bySession),
      lastSequence: new Map(this.state.reducer.lastSequence),
    };
    reducer.bySession.set(session.sessionId, session);
    reducer.lastSequence.set(session.sessionId, session.lastSequence);
    for (const event of buffered) {
      const result = applyPiEvent(reducer, event);
      reducer = result.state;
      if (result.didApply) this.observeActivity(event);
    }
    this.hydratedSessionIds.add(session.sessionId);
    this.touchLastAccess(session.sessionId);
    const isSelectedHydrated = this.state.selectedSessionId === session.sessionId;
    const nextFocusPending = isSelectedHydrated
      ? false
      : this.state.focusPending && !this.hydratedSessionIds.has(this.state.selectedSessionId ?? '');
    let nextLoadErrors = this.state.sessionLoadErrorById;
    if (nextLoadErrors.has(session.sessionId)) {
      const updated = new Map(nextLoadErrors);
      updated.delete(session.sessionId);
      nextLoadErrors = updated;
    }
    // Connection chrome is owned by the bootstrap / reconnect paths, not
    // by hydration. Treat the merge as a no-op for `connection` so a
    // hydrate completion doesn't unexpectedly flip a `'loading'` window
    // back to `'ready'` ahead of the SSE plug.
    // Catalog row mirrors the reducer: `hydrated` flips to true for the
    // freshly committed transcript; `lifecycle` mirrors whatever the
    // merged reducer now holds. A buffered-event batch is folded into the
    // catalog via the same `applyCatalogFromEvents` path the SSE uses.
    let nextCatalog = this.applyCatalogFromEvents(buffered, reducer);
    const reducerSession = reducer.bySession.get(session.sessionId);
    const reducerLifecycle = reducerSession?.lifecycle;
    const catalogLifecycle = reducerLifecycle ? catalogLifecycleFromReducer(reducerLifecycle) : undefined;
    if (!nextCatalog.byId.has(session.sessionId)) {
      nextCatalog = upsertStubRecord(nextCatalog, session.sessionId, session.directory, catalogLifecycle ?? 'idle');
    }
    nextCatalog = applyHydratedChange(nextCatalog, session.sessionId, true);
    if (catalogLifecycle !== undefined) {
      nextCatalog = applyLifecycleChange(nextCatalog, session.sessionId, catalogLifecycle, reducerSession?.retry);
    }
    const catalogChanged = nextCatalog !== this.state.catalog;
    this.state = {
      ...this.state,
      reducer,
      error: null,
      focusPending: nextFocusPending,
      hydratedSessionIds: new Set(this.hydratedSessionIds),
      sessionLoadErrorById: nextLoadErrors,
      catalog: nextCatalog,
    };
    // commitHydratedSession always wraps `hydratedSessionIds` in a new
    // Set; chrome listeners must hear that flip every time. The catalog
    // emit is gated on the reference-stable helpers.
    const hydrateTopics: string[] = [`session:${session.sessionId}`, TOPIC_CHROME, TOPIC_DIALOGS];
    if (catalogChanged) hydrateTopics.push(TOPIC_CATALOG);
    this.emit(hydrateTopics);
    this.scheduleIdleEviction();
  }

  private async hydrate(
    sessionId: string,
    expected: number,
    known?: Awaited<ReturnType<typeof piClient.getSession>>,
    options?: {
      force?: boolean;
      initialHealth?: Extract<PiBootstrapHealth, { state: 'ready' }>;
      initialSessions?: readonly PiSessionListItem[];
    },
  ) {
    if (expected !== this.runtimeGeneration) return;
    // A committed deletion is authoritative: never start (or re-share) a
    // detail fetch for a tombstoned session.
    if (this.isDeleted(sessionId)) return;
    const inflight = this.hydrateInflightById.get(sessionId);
    if (inflight) return inflight;
    const pending = this.hydrateUnshared(sessionId, expected, known, options).finally(() => {
      if (this.hydrateInflightById.get(sessionId) === pending) this.hydrateInflightById.delete(sessionId);
    });
    this.hydrateInflightById.set(sessionId, pending);
    return pending;
  }

  private async hydrateUnshared(
    sessionId: string,
    expected: number,
    known?: Awaited<ReturnType<typeof piClient.getSession>>,
    options?: {
      force?: boolean;
      initialHealth?: Extract<PiBootstrapHealth, { state: 'ready' }>;
      initialSessions?: readonly PiSessionListItem[];
    },
  ) {
    if (expected !== this.runtimeGeneration) return;
    // A deletion committed while this hydrate was queued is authoritative;
    // fetching would only serve a response the commit below must reject.
    if (this.isDeleted(sessionId)) return;
    const sessionDir = this.state.sessions.find((item) => item.session.id === sessionId)?.session.directory;
    const directory = sessionDir || this.directory();
    const runtimeKey = getRuntimeKey();
    const resident = this.state.reducer.bySession.get(sessionId);
    const residentIsHydrated = Boolean(
      resident && this.hydratedSessionIds.has(sessionId)
    );
    const navGenAtStart = this.navigationGenerationById.get(sessionId) ?? 0;
    if (
      !options?.force
      && this.stream
      && residentIsHydrated
      && !known
    ) {
      if (this.state.connection !== 'ready' || this.state.error) {
        this.state = { ...this.state, connection: 'ready', error: null };
        this.emitChrome();
      }
      return;
    }
    this.clearSessionLoadError(sessionId);
    try {
      if (this.stream) {
        const detail = known ?? await piClient.getSession(sessionId, { directory, runtimeKey });
        if (expected !== this.runtimeGeneration) return;
        if (detail.session.id !== sessionId) return;
        // A detail generated by a previous daemon process predates the
        // current stream epoch; committing it would write a foreign cursor.
        if (!this.isResponseEpochCurrent(detail)) return;
        // A deletion committed while the detail request was in flight wins
        // over the response; committing here would resurrect the row.
        if (this.isDeleted(sessionId)) return;
        if ((this.navigationGenerationById.get(sessionId) ?? 0) !== navGenAtStart) return;
        if ((detail.lifecycle === 'busy' || detail.lifecycle === 'retry') && typeof (detail as { runStartedAt?: number }).runStartedAt === 'number') {
          adoptServerRunTiming(detail.session.id, (detail as { runStartedAt: number }).runStartedAt, (detail as { serverNow?: number }).serverNow);
        }
        this.commitHydratedSession(this.sessionFromDetail(detail));
        return;
      }
      const buffered: PiSessionEvent[] = [];
      let ready = false;
      const streamGeneration = this.streamGeneration + 1;
      this.streamGeneration = streamGeneration;
      const bootstrapCallbackIsCurrent = () => expected === this.runtimeGeneration
        && runtimeKey === getRuntimeKey()
        && streamGeneration === this.streamGeneration;
      const onEvent = (event: PiSessionEvent) => {
        if (!bootstrapCallbackIsCurrent()) return;
        if (!ready) buffered.push(event);
        else this.apply(event);
      };
      const bootstrap = await bootstrapPiDirectory({
        directory,
        selectedSessionId: sessionId,
        runtimeKey,
        ...(options?.initialHealth ? { initialHealth: options.initialHealth } : {}),
        ...(options?.initialSessions ? { initialSessions: options.initialSessions } : {}),
        onEvent,
        onStreamDisconnect: () => {
          if (bootstrapCallbackIsCurrent()) void this.reconnect(this.state.selectedSessionId ?? sessionId, expected, runtimeKey);
        },
        onStreamReconnect: () => this.markStreamReconnected(expected, runtimeKey, streamGeneration),
        onAuthRequired: () => {
          if (bootstrapCallbackIsCurrent()) this.handleStreamAuthRequired();
        },
      });
      if (!bootstrapCallbackIsCurrent()) {
        bootstrap.stream?.dispose();
        return;
      }
      if (bootstrap.phase === 'failed') {
        bootstrap.stream?.dispose();
        throw bootstrap.errors.at(-1)?.error
          ?? new PiRequestError('DAEMON_PROTOCOL_MISMATCH', 'The Pi runtime returned an incompatible bootstrap response.');
      }
      const bootstrapTiming = bootstrap.selectedSessionTiming;
      if (
        bootstrapTiming
        && bootstrapTiming.sessionId === sessionId
        && (bootstrapTiming.lifecycle === 'busy' || bootstrapTiming.lifecycle === 'retry')
        && typeof bootstrapTiming.runStartedAt === 'number'
      ) {
        adoptServerRunTiming(
          bootstrapTiming.sessionId,
          bootstrapTiming.runStartedAt,
          bootstrapTiming.serverNow,
        );
      }
      let hydratedSession = known
        ? this.sessionFromDetail(known)
        : bootstrap.reducerState.bySession.get(sessionId);
      // Adopt server authoritative timing when the known detail carries it.
      if (known && (known.lifecycle === 'busy' || known.lifecycle === 'retry') && typeof (known as { runStartedAt?: number }).runStartedAt === 'number') {
        adoptServerRunTiming(known.session.id, (known as { runStartedAt: number }).runStartedAt, (known as { serverNow?: number }).serverNow);
      }
      if (!hydratedSession) {
        try {
          const detail = known ?? await piClient.getSession(sessionId, { directory, runtimeKey });
          if (expected !== this.runtimeGeneration) {
            bootstrap.stream?.dispose();
            return;
          }
          if (this.isDeleted(sessionId)) {
            // The deletion landed while this detail fetch was in flight.
            bootstrap.stream?.dispose();
            return;
          }
          // The detail predates the current stream epoch.
          if (!this.isResponseEpochCurrent(detail)) {
            bootstrap.stream?.dispose();
            return;
          }
          if ((detail.lifecycle === 'busy' || detail.lifecycle === 'retry') && typeof (detail as { runStartedAt?: number }).runStartedAt === 'number') {
            adoptServerRunTiming(detail.session.id, (detail as { runStartedAt: number }).runStartedAt, (detail as { serverNow?: number }).serverNow);
          }
          hydratedSession = this.sessionFromDetail(detail);
        } catch (error) {
          // Attach the cluster stream even when the requested chat is
          // gone so a stale deep link cannot block the rest of the runtime.
          this.stream = bootstrap.stream;
          ready = true;
          if (expected === this.runtimeGeneration && (isInvalidSessionError(error) || isSessionInUseError(error))) {
            // An accepted 404 means the daemon no longer has the session:
            // commit the deletion (tombstone + persisted cleanup) directly
            // instead of depending on an event echo that may already have
            // been replayed or missed. The failed id stays selected so the
            // chat surfaces its load error.
            if (isInvalidSessionError(error)) this.commitDeletion(sessionId, directory, { keepSelection: true });
            this.failSessionLoad(sessionId, error);
            return;
          }
          bootstrap.stream?.dispose();
          this.stream = null;
          throw error;
        }
      }
      if (hydratedSession.sessionId !== sessionId) {
        bootstrap.stream?.dispose();
        return;
      }
      if (this.isDeleted(sessionId)) {
        bootstrap.stream?.dispose();
        return;
      }
      if ((this.navigationGenerationById.get(sessionId) ?? 0) !== navGenAtStart) {
        bootstrap.stream?.dispose();
        return;
      }
      this.stream = bootstrap.stream;
      this.commitHydratedSession(hydratedSession, buffered);
      ready = true;
    } catch (error) {
      if (expected !== this.runtimeGeneration) return;
      if (isInvalidSessionError(error) || isSessionInUseError(error)) {
        // An accepted 404 means the daemon no longer has the session:
        // commit the deletion (tombstone + persisted cleanup) directly
        // instead of depending on an event echo that may already have
        // been replayed or missed. The failed id stays selected so the
        // chat surfaces its load error.
        if (isInvalidSessionError(error)) this.commitDeletion(sessionId, directory, { keepSelection: true });
        this.failSessionLoad(sessionId, error);
        return;
      }
      if (isSessionRuntimeConflictError(error)) {
        try {
          const detail = await piClient.getSession(sessionId, { directory, runtimeKey });
          if (expected !== this.runtimeGeneration) return;
          if (detail.session.id !== sessionId) return;
          if (this.isDeleted(sessionId)) return;
          if (!this.isResponseEpochCurrent(detail)) return;
          if ((this.navigationGenerationById.get(sessionId) ?? 0) !== navGenAtStart) return;
          if ((detail.lifecycle === 'busy' || detail.lifecycle === 'retry') && typeof (detail as { runStartedAt?: number }).runStartedAt === 'number') {
            adoptServerRunTiming(detail.session.id, (detail as { runStartedAt: number }).runStartedAt, (detail as { serverNow?: number }).serverNow);
          }
          this.commitHydratedSession(this.sessionFromDetail(detail));
        } catch (retryError) {
          if (expected !== this.runtimeGeneration) return;
          this.failSessionLoad(sessionId, asError(retryError));
        }
        return;
      }
      this.reportError(error);
    }
  }

  private markStreamReconnected(expected: number, runtimeKey: string, streamGeneration: number) {
    if (
      expected !== this.runtimeGeneration
      || runtimeKey !== getRuntimeKey()
      || streamGeneration !== this.streamGeneration
    ) return;
    this.streamReadyRevision += 1;
    if (this.state.connection === 'ready' && !this.state.error) {
      // Stream health is NOT baseline proof. If reconnect-recovery
      // obligations are parked (failed scopes after exhausting the retry
      // cycle), a healthy stream re-queues them — it never clears or
      // supersedes them.
      if (this.recoveryDirectories.size > 0 || this.recoveryResidents.size > 0) {
        this.recoveryAttempt = 0;
        void this.runSyncRecovery();
      }
      return;
    }
    this.state = { ...this.state, connection: 'ready', error: null };
    this.emitChrome();
  }

  private async reconnect(sessionId: string, expected: number, runtimeKey: string) {
    if (this.recovering || expected !== this.runtimeGeneration) return;
    this.recovering = true;
    this.cadence.flush();
    const disconnectedStream = this.stream;
    const readyRevision = this.streamReadyRevision;
    const replacementStreamGeneration = this.streamGeneration + 1;
    const cursorAtReconnect = this.streamCursor();
    const callbackIsCurrent = () => expected === this.runtimeGeneration
      && runtimeKey === getRuntimeKey()
      && (
        this.streamGeneration === replacementStreamGeneration
        || (
          this.streamGeneration === replacementStreamGeneration - 1
          && readyRevision === this.streamReadyRevision
        )
      );
    let authRequired = false;
    try {
      // The daemon marks a snapshot with `resync: true` exactly when the
      // requested replay cursor could not be served (window expired or a
      // daemon restart reset the sequence). Observing it means the replay
      // does NOT cover the disconnect gap and recovery is required.
      let resyncObserved = false;
      const result = await reconnectPiSession({
        directory: this.directory(),
        sessionId,
        runtimeKey,
        lastKnownSequence: cursorAtReconnect,
        streamEpoch: this.streamEpoch ?? undefined,
        onEvent: (event) => {
          if (!callbackIsCurrent()) return;
          if (
            !resyncObserved
            && event.name === 'session.snapshot'
            && (event.payload as { snapshot?: { resync?: boolean } })?.snapshot?.resync === true
          ) {
            resyncObserved = true;
            // Replay miss: reconcile every known directory catalog and the
            // residents hydrated at this point. Selected session first,
            // bounded concurrency; failed scopes keep a retry obligation.
            this.queueSyncRecovery({ directories: 'all-known', residents: this.hydratedSessionIds });
          }
          this.apply(event);
        },
        onStreamDisconnect: () => {
          if (callbackIsCurrent()) void this.reconnect(this.state.selectedSessionId ?? sessionId, expected, runtimeKey);
        },
        onStreamReconnect: () => this.markStreamReconnected(expected, runtimeKey, replacementStreamGeneration),
        onAuthRequired: () => {
          if (!callbackIsCurrent()) return;
          authRequired = true;
          this.handleStreamAuthRequired();
        },
        onEpochChange: (epoch) => {
          if (!callbackIsCurrent()) return;
          // The transport only reports a stream-lifetime change after an
          // authoritative health probe verified it against the live daemon.
          // Adopt it (the displaced epoch becomes retired) and queue
          // recovery; the next snapshot (or the merged baseline below)
          // re-establishes state.
          if (this.adoptStreamEpoch(epoch)) {
            this.queueSyncRecovery({ directories: 'all-known', residents: this.hydratedSessionIds });
          }
        },
      });
      if (expected !== this.runtimeGeneration || runtimeKey !== getRuntimeKey()) {
        result.stream?.dispose();
        return;
      }
      if (readyRevision !== this.streamReadyRevision) {
        result.stream?.dispose();
        return;
      }
      if (result.phase === 'ready') {
        if (typeof result.runStartedAt === 'number') {
          adoptServerRunTiming(sessionId, result.runStartedAt, result.serverNow);
        }
        // Verified epoch change via health: the new daemon's sequence space
        // is unrelated to the old one. Reset residents and cursors BEFORE
        // merging the lower snapshot baseline so it is accepted, and queue
        // full recovery (catalogs + former residents). Optimistic UI state
        // (pending prompts, drafts, attachments, navigation) is preserved.
        let epochChanged = false;
        if (typeof result.epoch === 'string' && result.epoch.length > 0 && this.streamEpoch !== result.epoch) {
          epochChanged = this.streamEpoch !== null;
          this.adoptStreamEpoch(result.epoch);
          if (epochChanged) {
            const previousResidents = this.resetForEpochChange();
            this.state = {
              ...this.state,
              reducer: createReducerState(),
              hydratedSessionIds: new Set(this.hydratedSessionIds),
            };
            this.queueSyncRecovery({ directories: 'all-known', residents: previousResidents });
          }
        }
        disconnectedStream?.dispose();
        this.streamGeneration = replacementStreamGeneration;
        this.stream = result.stream;
        const reducer: PiReducerState = {
          bySession: new Map(this.state.reducer.bySession),
          lastSequence: new Map(this.state.reducer.lastSequence),
        };
        const mergedSessionIds: PiSessionId[] = [];
        for (const [sId, sState] of result.reducerState.bySession.entries()) {
          const merged = this.mergeHydratedSession(sState, reducer.bySession.get(sId));
          reducer.bySession.set(sId, merged);
          reducer.lastSequence.set(sId, merged.lastSequence);
          this.touchLastAccess(sId);
          mergedSessionIds.push(sId);
        }
        for (const sId of result.reducerState.bySession.keys()) this.hydratedSessionIds.add(sId);
        const reconnectCatalog = this.applyCatalogFromEvents([], reducer);
        const catalogChanged = reconnectCatalog !== this.state.catalog;
        this.state = {
          ...this.state,
          reducer,
          connection: 'ready',
          error: null,
          hydratedSessionIds: new Set(this.hydratedSessionIds),
          ...(catalogChanged ? { catalog: reconnectCatalog } : {}),
        };
        const reconnectTopics: string[] = [TOPIC_CHROME, TOPIC_DIALOGS];
        for (const id of mergedSessionIds) reconnectTopics.push(`session:${id}`);
        if (catalogChanged) reconnectTopics.push(TOPIC_CATALOG);
        this.emit(reconnectTopics);
        // Catch-up policy is replay-driven, not unconditional. A contiguous
        // same-epoch replay from this client's own cursor covers every event
        // it missed, so residents and catalogs need no reload. A replay miss
        // (`resync` snapshot) or epoch change already queued a bounded
        // recovery of known directory catalogs and affected residents above.
        this.scheduleIdleEviction();
        if (epochChanged) this.publishSyncRecoveryState();
      } else if (!authRequired) {
        this.reportError(new PiRequestError(result.error?.code ?? 'DAEMON_UNAVAILABLE', result.error?.message));
      }
    } finally { this.recovering = false; }
  }
  private apply(event: PiSessionEvent) {
    this.cadence.push(event);
  }

  private observeActivity(event: PiSessionEvent) {
    if (event.name === 'session.lifecycle') {
      const isRunning = event.payload.state === 'busy' || event.payload.state === 'retry';
      if (isRunning && typeof (event.payload as { runStartedAt?: number }).runStartedAt === 'number') {
        adoptServerRunTiming(
          event.sessionId,
          (event.payload as { runStartedAt: number }).runStartedAt,
          (event.payload as { serverNow?: number }).serverNow,
        );
      }
      this.promoteSession(event.sessionId, isRunning ? 'active' : 'settled', { notifyIfSettled: true });
    } else if (event.name === 'session.snapshot') {
      const snapshot = event.payload.snapshot as {
        isStreaming?: boolean;
        lifecycle?: PiSessionLifecycleState;
        runStartedAt?: number;
        serverNow?: number;
      };
      const isRunning = snapshot.lifecycle === 'busy'
        || snapshot.lifecycle === 'retry'
        || snapshot.isStreaming === true;
      if (isRunning && typeof snapshot.runStartedAt === 'number') {
        adoptServerRunTiming(event.sessionId, snapshot.runStartedAt, snapshot.serverNow);
      }
      this.promoteSession(event.sessionId, isRunning ? 'active' : 'settled');
    } else if (event.name === 'assistant.message.start') {
      this.promoteSession(event.sessionId, 'active');
    } else if (event.name === 'session.interrupted' || event.name === 'session.error') {
      this.promoteSession(event.sessionId, 'settled', { notifyIfSettled: true });
    }
  }

  private notePromptProgress(event: PiSessionEvent) {
    if (
      event.name === 'assistant.message.start'
      || (event.name === 'session.lifecycle' && (event.payload.state === 'busy' || event.payload.state === 'retry'))
    ) {
      this.pendingPromptById.delete(event.sessionId);
      return;
    }
    if (
      event.name === 'session.error'
      || event.name === 'session.interrupted'
      || (event.name === 'session.lifecycle' && event.payload.state !== 'busy' && event.payload.state !== 'retry')
    ) {
      this.pendingPromptById.delete(event.sessionId);
    }
  }

  private retainPendingPrompt(working: PiReducerState, sessionId: PiSessionId): PiReducerState {
    if (!this.pendingPromptById.has(sessionId)) return working;
    const session = working.bySession.get(sessionId);
    if (!session || session.lifecycle === 'busy' || session.lifecycle === 'retry') return working;
    const bySession = new Map(working.bySession);
    bySession.set(sessionId, { ...session, lifecycle: 'busy' });
    return { ...working, bySession };
  }

  private promoteSession(
    sessionId: PiSessionId,
    phase: 'active' | 'settled',
    options?: { notifyIfSettled?: boolean; reorder?: boolean },
  ) {
    const previous = this.activityPhaseById.get(sessionId);
    this.activityPhaseById.set(sessionId, phase);
    observeSessionActivityTiming(sessionId, phase);
    if (options?.reorder) observeSessionActivityEvent(sessionId, phase);
    if (
      phase === 'settled'
      && options?.notifyIfSettled
      && previous === 'active'
      && this.state.selectedSessionId !== sessionId
    ) {
      notifySessionTurnComplete(sessionId, this.state.directory ?? undefined);
    }
  }

  private touchSessionList(sessionId: PiSessionId) {
    const index = this.state.sessions.findIndex((item) => item.session.id === sessionId);
    if (index < 0) return;
    const now = Date.now();
    const current = this.state.sessions[index];
    if (!current) return;
    const next = this.state.sessions.slice();
    next.splice(index, 1);
    next.unshift({
      ...current,
      updatedAt: now,
      session: { ...current.session, updatedAt: now },
    });
    this.state = { ...this.state, sessions: next };
  }

  private requestProviderCatalogRefresh(directory: string, recordMutation = true) {
    if (recordMutation) {
      const revision = (this.providerRefreshRevisionByDirectory.get(directory) ?? 0) + 1;
      this.providerRefreshRevisionByDirectory.set(directory, revision);
    }
    if (this.providerRefreshTaskByDirectory.has(directory)) return;

    const expectedRuntimeGeneration = this.runtimeGeneration;
    let completedRevision = 0;
    const task = (async () => {
      while (expectedRuntimeGeneration === this.runtimeGeneration) {
        const targetRevision = this.providerRefreshRevisionByDirectory.get(directory) ?? 0;
        if (targetRevision <= completedRevision) return;
        try {
          await useConfigStore.getState().loadProviders({ directory, source: 'extension.catalog' });
        } finally {
          // Failure preserves the prior provider snapshot. Mark this revision
          // handled so a broken provider does not create an unbounded retry loop.
          completedRevision = targetRevision;
        }
      }
    })().catch(() => {
      // `loadProviders` normally reports failure in store state. Keep this
      // guard for injected/runtime implementations that reject instead.
    }).finally(() => {
      if (this.providerRefreshTaskByDirectory.get(directory) !== task) return;
      this.providerRefreshTaskByDirectory.delete(directory);
      const currentRevision = this.providerRefreshRevisionByDirectory.get(directory) ?? 0;
      if (
        (expectedRuntimeGeneration !== this.runtimeGeneration && currentRevision > 0)
        || currentRevision > completedRevision
      ) {
        this.requestProviderCatalogRefresh(directory, false);
      }
    });
    this.providerRefreshTaskByDirectory.set(directory, task);
  }

  private restoreTranscript(sessionId: PiSessionId) {
    if (!sessionId || this.restoringTranscriptById.has(sessionId)) return;
    this.restoringTranscriptById.add(sessionId);
    const expected = this.runtimeGeneration;
    // Force the fetch: a live event may already have created a one-turn
    // resident row, which would otherwise look like a warm transcript and
    // skip getSession. Overlay still unions the JSONL log onto that turn.
    void this.hydrate(sessionId, expected, undefined, { force: true }).finally(() => {
      this.restoringTranscriptById.delete(sessionId);
    });
  }

  private commitEvents(events: readonly PiSessionEvent[]) {
    if (events.length === 0) return;
    let working = this.state.reducer;
    let applied = false;
    let touched = false;
    const restoreIds = new Set<PiSessionId>();
    const touchedSessionIds = new Set<PiSessionId>();
    const extensionCatalogChanges = new Map<string, { providers: boolean; resources: boolean; commands: boolean }>();
    // Events accepted this batch mirror into the catalog; rejected, skipped,
    // and tombstoned events must not (see applyCatalogFromEvents).
    const acceptedEvents: PiSessionEvent[] = [];
    const deletedIds = new Map<PiSessionId, string>();
    const deletedInBatchByEpoch = new Map<string | undefined, Set<PiSessionId>>();
    for (const event of events) {
      if (event.name !== 'session.deleted') continue;
      const epoch = typeof event.streamEpoch === 'string' && event.streamEpoch.length > 0
        ? event.streamEpoch
        : undefined;
      const ids = deletedInBatchByEpoch.get(epoch) ?? new Set<PiSessionId>();
      ids.add(event.sessionId);
      deletedInBatchByEpoch.set(epoch, ids);
    }
    let epochChangedResidents: Set<PiSessionId> | null = null;
    for (const event of events) {
      // Verified stream-epoch handling. Events stamped with a retired epoch
      // were emitted by a displaced daemon lifetime — rejected wholesale,
      // snapshots included, so a stale frame can never downgrade the
      // baseline. Events stamped with a new unseen epoch are emitted by a
      // restarted daemon: only a snapshot may establish the new epoch
      // baseline; any other old/new-epoch event is rejected.
      const eventEpoch = typeof event.streamEpoch === 'string' && event.streamEpoch.length > 0
        ? event.streamEpoch
        : undefined;
      // Once an epoch-capable daemon establishes its lifetime, every live
      // frame must identify that lifetime. Marker-less late frames cannot be
      // proven current and are rejected rather than merged into the baseline.
      if (!eventEpoch && this.streamEpoch !== null) continue;
      if (eventEpoch && this.retiredStreamEpochs.has(eventEpoch)) continue;
      if (eventEpoch && this.streamEpoch !== null && eventEpoch !== this.streamEpoch) {
        if (event.name !== 'session.snapshot') continue;
        this.adoptStreamEpoch(eventEpoch);
        const previousResidents = this.resetForEpochChange();
        // The reset discards the batch's old-epoch work: cursors and rows
        // from the previous lifetime are incompatible with the new one.
        working = createReducerState();
        restoreIds.clear();
        if (epochChangedResidents) {
          for (const resident of previousResidents) epochChangedResidents.add(resident);
        } else {
          epochChangedResidents = previousResidents;
        }
        touchedSessionIds.clear();
        extensionCatalogChanges.clear();
        // Deletions accepted from the displaced epoch must not commit after
        // the reducer baseline resets to the new daemon lifetime.
        deletedIds.clear();
        acceptedEvents.length = 0;
        applied = false;
        touched = false;
      }
      if (eventEpoch) this.adoptStreamEpoch(eventEpoch);
      // Tombstone filter. Once a deletion is committed — by the local
      // initiator or an earlier echo — every later event for that session is
      // stale. Epoch handling runs first so an establishing snapshot still
      // advances the daemon lifetime even when its session remains deleted.
      if (this.deletedSessionIds.has(event.sessionId)) continue;
      // Authoritative deletion bypasses transcript restore and activity promotion. The reducer
      // already tombstones the row and advances the cursor; the catalog/session cleanup below
      // reuses the shared deletion commit so late completions cannot resurrect it.
      if (event.name === 'session.deleted') {
        const result = applyPiEvent(working, event);
        working = result.state;
        if (!result.didApply) continue;
        applied = true;
        touchedSessionIds.add(event.sessionId);
        acceptedEvents.push(event);
        // Track directory for scoped persisted cleanup; do not restore or promote.
        deletedIds.set(event.sessionId, event.directory);
        // Drop any pending restore for this session; a hydrate started before the deletion
        // must not repopulate the transcript after the tombstone lands.
        restoreIds.delete(event.sessionId);
        this.restoringTranscriptById.delete(event.sessionId);
        continue;
      }
      // A later event in this same batch deletes this session; the batch's
      // end state is deletion, so pre-deletion events must not apply into
      // the reducer (where they would briefly resurrect the row) or mirror
      // catalog state that the deletion commit is about to remove.
      if (deletedInBatchByEpoch.get(eventEpoch)?.has(event.sessionId)) continue;
      const missingBefore = !working.bySession.has(event.sessionId);
      const hadCursor = (working.lastSequence.get(event.sessionId) ?? -1) >= 0;
      const result = applyPiEvent(working, event);
      working = result.state;
      if (!result.didApply) continue;
      acceptedEvents.push(event);
      if (missingBefore && hadCursor) restoreIds.add(event.sessionId);
      if (event.name === 'session.snapshot') restoreIds.add(event.sessionId);
      applied = true;
      touchedSessionIds.add(event.sessionId);
      if (event.name === 'extension.catalog') {
        const previous = extensionCatalogChanges.get(event.directory) ?? {
          providers: false,
          resources: false,
          commands: false,
        };
        extensionCatalogChanges.set(event.directory, {
          providers: previous.providers || event.payload.providers === true,
          resources: previous.resources || event.payload.resources === true,
          commands: previous.commands || event.payload.commands === true,
        });
      }
      this.notePromptProgress(event);
      if (
        this.pendingPromptById.has(event.sessionId)
        && event.name === 'session.snapshot'
        && !event.payload.snapshot.isStreaming
      ) {
        working = this.retainPendingPrompt(working, event.sessionId);
        this.promoteSession(event.sessionId, 'active');
        continue;
      }
      this.observeActivity(event);
      // Touch last-access for every accepted event so the LRU clock
      // reflects a busy session even when the user is not looking at
      // it. Promotions and live-tail events make the session "recent"
      // enough to survive eviction until it goes idle again.
      this.lastAccessClock += 1;
      this.lastAccessById.set(event.sessionId, this.lastAccessClock);
      touched = true;
    }
    if (!applied) {
      if (epochChangedResidents) {
        // The epoch transition itself is authoritative even when the
        // establishing snapshot is a reducer no-op. Publish the reset and
        // queue recovery rather than leaving stale hydration claims behind.
        this.state = {
          ...this.state,
          reducer: working,
          hydratedSessionIds: new Set(this.hydratedSessionIds),
        };
        this.emit([TOPIC_CHROME, ...[...epochChangedResidents].map((id) => `session:${id}`)]);
        this.queueSyncRecovery({ directories: 'all-known', residents: epochChangedResidents });
      }
      return;
    }
    this.state = {
      ...this.state,
      reducer: working,
      ...(epochChangedResidents ? { hydratedSessionIds: new Set(this.hydratedSessionIds) } : {}),
    };
    // Commit authoritative deletions through the shared path so catalog,
    // sessions, selection, and persisted drafts stay consistent and the
    // tombstone guards late completions. The reducer already carries each
    // deletion cursor; `commitDeletion` preserves it.
    for (const [deletedId, deletedDirectory] of deletedIds) {
      this.commitDeletion(deletedId, deletedDirectory);
    }
    // Mirror accepted events into the catalog. Lifecycle transitions flip
    // a row's `lifecycle`; `session.updated` and the first remote user
    // message fill title. Last-prompt recency is owned by `prompt()` locally
    // and by user-message starts from other devices. Only events accepted
    // this batch mirror — a tombstoned or same-batch-deleted session, or a
    // stale-epoch event, must not resurrect a catalog row here.
    const nextCatalog = this.applyCatalogFromEvents(acceptedEvents, working);
    const catalogChanged = nextCatalog !== this.state.catalog;
    if (catalogChanged) {
      this.state = { ...this.state, catalog: nextCatalog };
    }
    const topics: string[] = [];
    if (catalogChanged) topics.push(TOPIC_CATALOG);
    if (acceptedEvents.some((event) => event.name === 'extension.dialog' || event.name === 'extension.dialog.dismiss' || event.name === 'session.snapshot')) {
      topics.push(TOPIC_DIALOGS);
    }
    for (const id of touchedSessionIds) topics.push(`session:${id}`);
    if (topics.length > 0) this.emit(topics);
    if (touched) this.scheduleIdleEviction();
    for (const sessionId of restoreIds) this.restoreTranscript(sessionId);
    if (epochChangedResidents) {
      // Verified epoch change: reconcile every known directory catalog and
      // re-fetch the residents that were hydrated before the reset. Selected
      // session first, bounded concurrency; failed scopes keep a retry
      // obligation.
      this.queueSyncRecovery({ directories: 'all-known', residents: epochChangedResidents });
    }
    for (const [directory, change] of extensionCatalogChanges) {
      if (change.providers) this.requestProviderCatalogRefresh(directory);
      if (change.commands) invalidateCommandCatalogCache(directory);
      if (change.resources) {
        invalidateSkillsLoadCache(directory);
        if (normalizePath(directory) === normalizePath(this.state.directory ?? '')) {
          void useSkillsStore.getState().loadSkills();
        }
      }
    }
  }

  /**
   * Apply accepted events to the catalog row mirror. Lifecycle / snapshot
   * events flip the catalog row's `lifecycle` field; `session.updated` writes
   * title; a remote user-message start stamps last-prompt recency and fills
   * an empty title. Helpers short-circuit on unchanged values. Walks the
   * events in order and chains helpers so a single batch of N events
   * produces at most N narrow row updates.
   *
   * When an event arrives for a session that has not yet been listed by
   * any directory's RPC, `upsertStubRecord` inserts a minimal catalog row
   * (no title, no preview) so the sidebar can render the session as busy
   * instead of painting it idle. The stub is replaced wholesale when the
   * directory's listing finally lands — `applyDirectoryListToCatalog`
   * preserves a non-idle lifecycle on that path so a stub never gets
   * downgraded to idle by a slow list.
   *
   * `session.updated` writes the title without changing last-prompt recency
   * (rename / explicit create). A user-message start from another device
   * both stamps recency and fills an empty stub title from the prompt text
   * so the sidebar does not stay on "Untitled Session" until a later list.
   */
  private applyCatalogFromEvents(
    events: readonly PiSessionEvent[],
    working: PiReducerState,
  ): PiSessionCatalogState {
    let catalog = this.state.catalog;
    for (const event of events) {
      // Defensive tombstone filter (commitEvents already filters accepted
      // events): a committed deletion owns the catalog row, so no buffered
      // or late event may stub or touch it again.
      if (this.deletedSessionIds.has(event.sessionId)) continue;
      const reducerSession = working.bySession.get(event.sessionId);
      const reducerLifecycle = reducerSession?.lifecycle;
      const stubLifecycle = lifecycleFromEvent(event);
      if (stubLifecycle !== undefined && !catalog.byId.has(event.sessionId)) {
        catalog = upsertStubRecord(catalog, event.sessionId, event.directory, stubLifecycle);
      }
      if (reducerLifecycle !== undefined) {
        catalog = applyLifecycleChange(
          catalog,
          event.sessionId,
          catalogLifecycleFromReducer(reducerLifecycle),
          reducerSession?.retry,
        );
      }
      if (event.name === 'session.updated') {
        const title = typeof event.payload.title === 'string' ? event.payload.title.trim() : '';
        if (title) {
          if (!catalog.byId.has(event.sessionId)) {
            catalog = upsertStubRecord(catalog, event.sessionId, event.directory, stubLifecycle ?? 'idle');
          }
          const existing = catalog.byId.get(event.sessionId);
          catalog = applyTitleChange(
            catalog,
            event.sessionId,
            title,
            existing?.updatedAt ?? Date.now(),
          );
        }
      }
      if (event.name === 'assistant.message.start' && event.payload.role === 'user') {
        catalog = touchRecordUpdatedAt(catalog, event.sessionId, Date.now(), {
          directory: event.directory,
          lifecycle: 'busy',
        });
        const existing = catalog.byId.get(event.sessionId);
        const derived = deriveSessionTitle(event.payload.text ?? '');
        if (derived && existing && existing.title.trim().length === 0) {
          catalog = applyTitleChange(catalog, event.sessionId, derived, existing.updatedAt);
        }
      }
    }
    return catalog;
  }

  /** Coalesce an idle-transcript eviction scan onto the next macrotask so a
   *  burst of stream events (or a hot hydrate path) never runs the eviction
   *  scan inside the commit/reducer path. The scan itself is bounded to one
   *  pass per schedule, evicts in LRU order until back under the soft cap,
   *  and only runs when transcripts actually exceed the cap. */
  private scheduleIdleEviction() {
    if (this.evictionScheduled) return;
    if (this.state.reducer.bySession.size <= PI_TRANSCRIPT_EVICTION_SOFT_CAP) return;
    this.evictionScheduled = true;
    queueMicrotask(() => {
      this.evictionScheduled = false;
      this.evictIdleTranscripts();
    });
  }

  private evictIdleTranscripts(): void {
    const bySession = this.state.reducer.bySession;
    if (bySession.size <= PI_TRANSCRIPT_EVICTION_SOFT_CAP) return;
    const protectedIds = new Set<PiSessionId>();
    if (this.state.selectedSessionId) protectedIds.add(this.state.selectedSessionId);
    for (const [sessionId, session] of bySession) {
      if (session.lifecycle === 'busy' || session.lifecycle === 'retry') protectedIds.add(sessionId);
    }
    for (const sessionId of this.pendingPromptById) protectedIds.add(sessionId);

    // LRU eviction: drop the longest-idle transcript first, but never
    // evict a protected session. Survivors keep their previous access
    // clock so the next eviction still finds them in the right order.
    const candidates: Array<[PiSessionId, number]> = [];
    for (const sessionId of bySession.keys()) {
      if (protectedIds.has(sessionId)) continue;
      const lastAccess = this.lastAccessById.get(sessionId) ?? 0;
      candidates.push([sessionId, lastAccess]);
    }
    candidates.sort((a, b) => a[1] - b[1]);

    let nextBySession: Map<PiSessionId, PiReducerSessionState> | null = null;
    let nextHydratedIds: Set<PiSessionId> | null = null;
    let nextLastAccess: Map<PiSessionId, number> | null = null;
    let nextCatalog: PiSessionCatalogState | null = null;
    const evictedIds: PiSessionId[] = [];
    let evicted = 0;
    for (const [sessionId] of candidates) {
      if (bySession.size - evicted <= PI_TRANSCRIPT_EVICTION_SOFT_CAP) break;
      if (!nextBySession) nextBySession = new Map(bySession);
      if (!nextHydratedIds) nextHydratedIds = new Set(this.hydratedSessionIds);
      if (!nextLastAccess) nextLastAccess = new Map(this.lastAccessById);
      nextBySession.delete(sessionId);
      nextHydratedIds.delete(sessionId);
      nextLastAccess.delete(sessionId);
      this.activityPhaseById.delete(sessionId);
      // The catalog row stays — only the `hydrated` pointer flips so the
      // sidebar / header can still render metadata for an evicted session.
      nextCatalog = nextCatalog ?? this.state.catalog;
      nextCatalog = applyHydratedChange(nextCatalog, sessionId, false);
      evicted += 1;
      evictedIds.push(sessionId);
    }
    if (!nextBySession || !nextHydratedIds || !nextLastAccess) return;
    this.lastAccessById = nextLastAccess;
    // Compare before the assignment so the catalog gate isn't trivially
    // true after `state.catalog` is rewritten to `nextCatalog`.
    const catalogChanged = !!nextCatalog && nextCatalog !== this.state.catalog;
    this.state = {
      ...this.state,
      reducer: { bySession: nextBySession, lastSequence: new Map(this.state.reducer.lastSequence) },
      hydratedSessionIds: nextHydratedIds,
      ...(nextCatalog ? { catalog: nextCatalog } : {}),
    };
    // Each evicted id's reducer row was dropped, so chat selectors
    // subscribed to that id must re-evaluate (they get `null` now).
    // Chrome also flips via the new `hydratedSessionIds` Set; the catalog
    // emit is gated on `applyHydratedChange` actually changing refs.
    const evictTopics: string[] = [TOPIC_CHROME];
    for (const id of evictedIds) evictTopics.push(`session:${id}`);
    if (catalogChanged) evictTopics.push(TOPIC_CATALOG);
    this.emit(evictTopics);
  }

  private async upsertAndHydrate(detail: Awaited<ReturnType<typeof piClient.getSession>>) {
    const expected = this.runtimeGeneration;
    const nextCatalog = upsertRecord(this.state.catalog, this.recordFromPiSession(detail.session));
    const catalogChanged = nextCatalog !== this.state.catalog;
    this.state = {
      ...this.state,
      sessions: [{ session: detail.session, updatedAt: detail.session.updatedAt }, ...this.state.sessions.filter((item) => item.session.id !== detail.session.id)],
      selectedSessionId: detail.session.id,
      catalog: nextCatalog,
    };
    const topics: string[] = [TOPIC_CHROME];
    if (catalogChanged) topics.push(TOPIC_CATALOG);
    this.emit(topics);
    await this.hydrate(detail.session.id, expected, detail);
  }
  private directory() { if (!this.state.directory) throw new PiRequestError('DAEMON_UNAVAILABLE'); return this.state.directory; }
  private streamCursor(): number | undefined {
    let max = -1;
    for (const sequence of this.state.reducer.lastSequence.values()) {
      if (sequence > max) max = sequence;
    }
    return max >= 0 ? max : undefined;
  }
  private scope(customDirectory?: string): PiClientScope { return { directory: customDirectory || this.directory(), runtimeKey: getRuntimeKey() }; }
  private reconnectAfterTransportSwitch(): void {
    const sessionId = this.state.selectedSessionId;
    if (!this.stream || !sessionId || !this.state.directory) return;
    void this.reconnect(sessionId, this.runtimeGeneration, getRuntimeKey());
  }
  private resetForRuntime() {
    this.catalogCache.flush();
    this.resetLiveRuntimeState();
    this.state = initialSessionStoreState(this.readCachedCatalog(getRuntimeKey()));
    clearAllRevertNavigations();
    this.navigationGenerationById.clear();
    this.navigationCounter = 0;
    // Broadcast so every subscriber sees the runtime switch before the
    // cluster rebuilds; listener sets stay intact for the new runtime.
    this.emitBroadcast();
  }
  /**
   * Notify listeners registered on any of the supplied topics, plus the
   * broadcast bucket. Each listener is invoked at most once per call.
   * The broadcast fallback keeps `subscribe()`-without-topic tests and
   * legacy callers working without forcing them onto a specific topic.
   */
  private emit(topics: readonly string[]): void {
    if (topics.length === 0) return;
    if (topics.includes(TOPIC_CATALOG)) {
      this.catalogCache.schedule(getRuntimeKey(), this.state.catalog);
    }
    const seen = new Set<Listener>();
    for (const topic of topics) {
      const bucket = this.listenersByTopic.get(topic);
      if (!bucket) continue;
      for (const listener of bucket) {
        if (seen.has(listener)) continue;
        seen.add(listener);
        listener();
      }
    }
    const broadcast = this.listenersByTopic.get(TOPIC_BROADCAST);
    if (!broadcast) return;
    for (const listener of broadcast) {
      if (seen.has(listener)) continue;
      seen.add(listener);
      listener();
    }
  }
  private readCachedCatalog(runtimeKey: string): PiSessionCatalogState {
    try {
      return this.catalogCache.read(runtimeKey) ?? initialCatalog();
    } catch {
      return initialCatalog();
    }
  }
  /** Broadcast the current state to every listener regardless of topic. */
  private emitBroadcast(): void {
    const seen = new Set<Listener>();
    for (const bucket of this.listenersByTopic.values()) {
      for (const listener of bucket) {
        if (seen.has(listener)) continue;
        seen.add(listener);
        listener();
      }
    }
  }
  /** `chrome`-only emit, gated by an `Object.is` field check. */
  private emitChrome(): void {
    // chrome topics never reference-equal on a real change; the explicit
    // call sites guard their own no-ops before invoking this helper.
    this.emit([TOPIC_CHROME]);
  }
}
