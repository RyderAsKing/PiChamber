import {
  applyPiEvent,
  createReducerState,
  hydrateSessionFromDetail,
  projectSession,
  aliasSyntheticUserIfPersisted,
  type PiProjectedSession,
  type PiReducerSessionState,
  type PiReducerState,
} from '@/lib/pi/event-reducer';
import { bootstrapPiDirectory } from '@/lib/pi/bootstrap';
import { PiRequestError, piClient, type PiClientScope } from '@/lib/pi/client';
import { reconnectPiSession } from '@/lib/pi/reconnect';
import { PiStreamCadence } from '@/lib/pi/stream-cadence';
import type { PiSessionEvent, PiSessionListItem } from '@/lib/pi/protocol';
import type { PiSessionId } from '@/lib/pi/types';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { observeSessionActivityTiming, removeSessionActivityTiming } from '@/sync/session-activity-timing';
import { observeSessionActivityEvent, removeSessionOrdering } from '@/sync/session-ordering';
import { notifySessionTurnComplete } from '@/sync/notification-store';

export type PiConnectionState = 'loading' | 'ready' | 'unavailable' | 'error';
export type PiSessionsListStatus = 'idle' | 'loading' | 'ready' | 'failed';
export interface PiSessionStoreState {
  /** Currently focused project directory. Switching folders updates this without
   *  disposing the live event stream or clearing the resident session cluster. */
  directory: string | null;
  sessions: readonly PiSessionListItem[];
  selectedSessionId: PiSessionId | null;
  reducer: PiReducerState;
  connection: PiConnectionState;
  error: PiRequestError | null;
  showArchived: boolean;
  hydratedSessionIds: ReadonlySet<PiSessionId>;
  /** True while a `focusProject` is in flight (between pointer swap and
   *  list/hydrate settle or fail). Chat uses this to keep the existing
   *  chat visible — the PiChamber logo replaces an empty draft on a cold
   *  transition, but the bare `ChatEmptyState` must never appear. */
  focusPending: boolean;
  /** Discriminates loading / ready / failed for the *focused folder's*
   *  `sessions[]`. `ready` covers both populated and authoritative-empty
   *  (zero-session new project). `failed` keeps the previous folder
   *  alive and surfaces a Try-again block in the chat rather than an
   *  empty success. */
  sessionsListStatus: PiSessionsListStatus;
}
type Listener = () => void;

/** Soft cap for resident transcripts kept in `reducer.bySession`. Idle
 *  transcripts can be evicted; `lastSequence` survives the eviction so
 *  reconnect/rehydrate resumes without rewinding past accepted events. */
export const PI_TRANSCRIPT_EVICTION_SOFT_CAP = 16;

/** Single automatic retry delay for transient focus-list failures. Short
 *  enough that the chat loader does not visibly stall, long enough that we
 *  do not pile onto a 5xx storm. */
const FOCUS_RETRY_DELAY_MS = 300;

const initial = (): PiSessionStoreState => ({
  directory: null,
  sessions: [],
  selectedSessionId: null,
  reducer: createReducerState(),
  connection: 'loading',
  error: null,
  showArchived: false,
  hydratedSessionIds: new Set(),
  focusPending: false,
  sessionsListStatus: 'idle',
});

interface PendingFocus {
  directory: string;
  expected: number;
  /** Session id the caller wants selected after the focus resolves. */
  preferredSessionId?: PiSessionId | null;
}
const asError = (error: unknown) => error instanceof PiRequestError ? error : new PiRequestError('DAEMON_REQUEST_FAILED', error instanceof Error ? error.message : undefined);

const delayBeforeRetry = async (): Promise<void> => {
  if (FOCUS_RETRY_DELAY_MS <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, FOCUS_RETRY_DELAY_MS));
};

let sharedStore: PiSessionStore | null = null;

export const getPiSessionStore = (): PiSessionStore => {
  sharedStore ??= new PiSessionStore();
  return sharedStore;
};

/** One connected Pi runtime. The store owns a runtime-wide cluster:
 *  a single event stream, a `reducer.bySession` map, `hydratedSessionIds`, and
 *  a `directory` focus pointer for the sidebar/create flow. The cluster lives
 *  until a runtime switch, `clear()`, or `dispose()`. Switching the focused
 *  project is a pointer change; it never disposes the stream or drops
 *  hydrated sessions. Every async completion is generation- and runtime-
 *  guarded so a stale hydrate cannot commit into a new runtime/focus.
 */
export class PiSessionStore {
  private state = initial();
  private listeners = new Set<Listener>();
  private stream: { dispose: () => void } | null = null;
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
  private evictionScheduled = false;
  private readonly cadence = new PiStreamCadence((events) => this.commitEvents(events));
  private unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => this.resetForRuntime());

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
  subscribe = (listener: Listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  dispose = () => {
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
    this.evictionScheduled = false;
    this.cadence.dispose();
    this.stream?.dispose();
    this.stream = null;
    this.unsubscribeRuntime();
    this.listeners.clear();
    this.state = initial();
  };
  setShowArchived = (showArchived: boolean) => { if (showArchived !== this.state.showArchived) { this.state = { ...this.state, showArchived }; this.emit(); } };
  clearError = () => { if (this.state.error) { this.state = { ...this.state, error: null }; this.emit(); } };
  reportError = (error: unknown) => { this.state = { ...this.state, error: asError(error), connection: 'error' }; this.emit(); };
  clear = () => {
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
    this.evictionScheduled = false;
    this.cadence.dispose();
    this.stream?.dispose(); this.stream = null;
    this.state = { ...initial(), connection: 'ready' };
    this.emit();
  };

  async start(options: { directory?: string | null; sessionId?: PiSessionId | null } = {}): Promise<void> {
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
      if (options.sessionId) {
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
      if (requestedDirectory) {
        await this.open(requestedDirectory, options.sessionId);
        return;
      }
      const projects = await piClient.listProjects({ runtimeKey: getRuntimeKey() });
      const directory = projects.projects.find((project) => project.selected)?.directory ?? projects.projects[0]?.directory;
      if (!directory) throw new PiRequestError('DAEMON_UNAVAILABLE');
      await this.open(directory, options.sessionId);
    } catch (error) { this.reportError(error); }
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
      this.emit();
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
    this.emit();
    if (warmAlready) {
      this.touchLastAccess(desiredSessionId as PiSessionId);
    }
    await this.resolveFocus(expected, nextDirectory);
  }

  private async resolveFocus(expected: number, directory: string): Promise<void> {
    const runtimeKey = getRuntimeKey();
    const startedRuntimeGeneration = this.runtimeGeneration;
    const desiredSessionId = this.pendingPreferredSessionId;
    let resolvedDirectory = directory;
    try {
      try {
        const selected = await piClient.selectProject(directory, { runtimeKey });
        if (expected !== this.focusGeneration || startedRuntimeGeneration !== this.runtimeGeneration) return;
        resolvedDirectory = selected.directory;
        if (normalizePath(resolvedDirectory) !== normalizePath(this.state.directory)) {
          this.state = { ...this.state, directory: resolvedDirectory };
          this.emit();
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
          this.emit();
        }
      }
      const result = await this.fetchFocusListWithRetry(resolvedDirectory, expected, startedRuntimeGeneration, runtimeKey);
      if (result.kind === 'stale') return;
      if (result.kind === 'failed') {
        this.failFocus(expected, result.error);
        return;
      }
      const listPayload = result.payload;
      if (expected !== this.focusGeneration || startedRuntimeGeneration !== this.runtimeGeneration) return;
      let matchedSession = desiredSessionId
        ? listPayload.sessions.find((item) => item.session.id === desiredSessionId)
        : undefined;
      if (desiredSessionId && !matchedSession) {
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
          // Fall back to default session if desired session doesn't exist
        }
      }
      if (expected !== this.focusGeneration || startedRuntimeGeneration !== this.runtimeGeneration) return;
      const preferredStillSelected = desiredSessionId
        ? listPayload.sessions.find((item) => item.session.id === desiredSessionId)
        : undefined;
      const nextSelectedSessionId = preferredStillSelected?.session.id
        ?? matchedSession?.session.id
        ?? listPayload.sessions.find((item) => !item.session.archived)?.session.id
        ?? listPayload.sessions[0]?.session.id
        ?? null;
      this.pendingPreferredSessionId = null;
      this.state = {
        ...this.state,
        sessions: listPayload.sessions,
        selectedSessionId: nextSelectedSessionId ?? this.state.selectedSessionId,
        sessionsListStatus: 'ready',
        focusPending: !!nextSelectedSessionId && !this.hydratedSessionIds.has(nextSelectedSessionId),
        error: null,
      };
      this.emit();
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
            this.emit();
          }
        }
      } else if (
        nextSelectedSessionId
        && this.hydratedSessionIds.has(nextSelectedSessionId)
        && this.state.focusPending
      ) {
        this.state = { ...this.state, focusPending: false };
        this.emit();
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
    this.emit();
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
        this.emit();
      }
      return;
    }
    if (directory === this.state.directory && this.state.connection === 'ready') {
      if (preferredSessionId && preferredSessionId !== this.state.selectedSessionId) await this.select(preferredSessionId);
      return;
    }
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
    this.evictionScheduled = false;
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
    this.emit();
    const runtimeKey = getRuntimeKey();
    try {
      const selected = await piClient.selectProject(directory, { runtimeKey });
      if (expected !== this.runtimeGeneration) return;
      const scope: PiClientScope = { directory: selected.directory, runtimeKey };
      if (selected.directory !== directory) {
        this.state = { ...this.state, directory: selected.directory };
        this.emit();
      }
      const health = await piClient.health(scope);
      if (expected !== this.runtimeGeneration) return;
      if (health.state !== 'ready') throw new PiRequestError(health.error?.code ?? 'DAEMON_UNAVAILABLE', health.error?.message);
      const result = await piClient.listSessions(scope);
      if (expected !== this.runtimeGeneration) return;
      const desiredSessionId = this.pendingPreferredSessionId ?? preferredSessionId;
      let matchedSession = desiredSessionId ? result.sessions.find((item) => item.session.id === desiredSessionId) : undefined;
      if (desiredSessionId && !matchedSession) {
        try {
          const detail = await piClient.getSession(desiredSessionId, { directory, runtimeKey });
          if (detail?.session?.directory && detail.session.directory !== directory) {
            if (expected !== this.runtimeGeneration) return;
            await this.open(detail.session.directory, desiredSessionId);
            return;
          }
          if (detail?.session?.id) {
            result.sessions.unshift({ session: detail.session, updatedAt: detail.session.updatedAt });
            matchedSession = { session: detail.session, updatedAt: detail.session.updatedAt };
          }
        } catch {
          // Fall back to default session if desired session doesn't exist
        }
      }
      const selectedSessionId = matchedSession?.session.id
        ?? result.sessions.find((item) => !item.session.archived)?.session.id
        ?? result.sessions[0]?.session.id
        ?? null;
      this.pendingPreferredSessionId = null;
      // First-attach: the cluster owns this runtime the moment its list
      // resolves. A folder click during list → hydrate → stream-attach
      // must focus, not dispose. `commitHydratedSession` keeps
      // `connection` untouched; we flip to `'ready'` here so the cluster
      // is considered attached before SSE is plugged.
      this.state = {
        ...this.state,
        sessions: result.sessions,
        selectedSessionId,
        connection: 'ready',
      };
      this.emit();
      if (selectedSessionId) await this.hydrate(selectedSessionId, expected);
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
      this.emit();
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
      if (!this.hydratedSessionIds.has(sessionId)) {
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
    this.emit();
    this.touchLastAccess(sessionId);
    if (this.stream && this.hydratedSessionIds.has(sessionId)) {
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
    if (this.hydratedSessionIds.has(sessionId)) {
      this.touchLastAccess(sessionId);
      return;
    }
    await this.hydrate(sessionId, this.runtimeGeneration);
  }

  async create(title?: string, options?: { directory?: string; model?: { providerId: string; modelId: string }; thinking?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' }): Promise<string> {
    const directory = options?.directory || this.directory(); const expected = this.runtimeGeneration;
    // PiChamber defaults are authoritative only when explicitly configured;
    // otherwise Pi's settings/model runtime performs its normal fallback.
    // A settings fetch failure aborts creation rather than silently creating a
    // session with an unknown default selection.
    const settings = await piClient.getSettings({ directory, runtimeKey: getRuntimeKey() });
    const detail = await piClient.createSession({
      cwd: directory,
      ...(title ? { title } : {}),
      ...(options?.model ? { model: options.model } : (settings.pichamber.defaultModel ? { model: settings.pichamber.defaultModel } : {})),
      ...(options?.thinking ? { thinking: options.thinking } : (settings.pichamber.defaultThinking ? { thinking: settings.pichamber.defaultThinking } : {})),
    }, { directory, runtimeKey: getRuntimeKey() });
    if (expected !== this.runtimeGeneration) return detail.session.id;
    this.state = { ...this.state, sessions: [{ session: detail.session, updatedAt: detail.session.updatedAt }, ...this.state.sessions], selectedSessionId: detail.session.id }; this.emit();
    await this.hydrate(detail.session.id, expected, detail);
    return detail.session.id;
  }

  async rename(sessionId: string, title: string) { await piClient.renameSession({ sessionId, title }, this.scope()); this.state = { ...this.state, sessions: this.state.sessions.map((item) => item.session.id === sessionId ? { ...item, session: { ...item.session, title } } : item) }; this.emit(); }
  async archive(sessionId: string, archived: boolean) {
    const sessionDir = this.state.sessions.find((item) => item.session.id === sessionId)?.session.directory;
    await piClient.archiveSession({ sessionId, archived }, this.scope(sessionDir));
    this.state = { ...this.state, sessions: this.state.sessions.map((item) => item.session.id === sessionId ? { ...item, session: { ...item.session, archived } } : item) };
    this.emit();
  }
  async remove(sessionId: string) {
    const expected = this.runtimeGeneration;
    await piClient.deleteSession({ sessionId, ignoreMissing: true }, this.scope());
    if (expected !== this.runtimeGeneration) return;
    removeSessionActivityTiming(sessionId);
    removeSessionOrdering(sessionId);
    const sessions = this.state.sessions.filter((item) => item.session.id !== sessionId);
    const selectedSessionId = this.state.selectedSessionId === sessionId ? sessions.find((item) => !item.session.archived)?.session.id ?? null : this.state.selectedSessionId;
    const nextBySession = new Map(this.state.reducer.bySession);
    nextBySession.delete(sessionId);
    const nextLastSequence = new Map(this.state.reducer.lastSequence);
    nextLastSequence.delete(sessionId);
    this.hydratedSessionIds.delete(sessionId);
    this.activityPhaseById.delete(sessionId);
    this.pendingPromptById.delete(sessionId);
    this.promptGenerationById.delete(sessionId);
    this.lastAccessById.delete(sessionId);
    this.state = {
      ...this.state,
      sessions,
      selectedSessionId,
      hydratedSessionIds: new Set(this.hydratedSessionIds),
      reducer: { bySession: nextBySession, lastSequence: nextLastSequence },
    };
    this.emit();
    if (selectedSessionId && selectedSessionId !== this.state.selectedSessionId) await this.hydrate(selectedSessionId, expected);
  }
  async fork(sessionId: string) { const detail = await piClient.forkSession({ sessionId }, this.scope()); this.upsertAndHydrate(detail); }
  async clone(sessionId: string) { const detail = await piClient.cloneSession({ sessionId }, this.scope()); this.upsertAndHydrate(detail); }
  async navigate(sessionId: string, messageId: string) { const detail = await piClient.navigateSession(sessionId, messageId, this.scope()); await this.hydrate(sessionId, this.runtimeGeneration, detail); }
  async prompt(sessionId: string, text: string, delivery: 'prompt' | 'steer' | 'followUp', attachments?: Array<{ id: string }>) {
    const existing = this.state.reducer.bySession.get(sessionId);
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
          parts: new Map(),
          toolsByCallId: new Map(),
          streamingMessages: new Set(),
          queue: { steering: 0, followUp: 0 },
        };
    const nextBySession = new Map(this.state.reducer.bySession);
    nextBySession.set(sessionId, nextSession);
    this.state = { ...this.state, reducer: { ...this.state.reducer, bySession: nextBySession } };
    const generation = (this.promptGenerationById.get(sessionId) ?? 0) + 1;
    this.promptGenerationById.set(sessionId, generation);
    this.pendingPromptById.add(sessionId);
    this.promoteSession(sessionId, 'active');
    this.touchSessionList(sessionId);
    this.emit();
    const input = { sessionId, text, messageId: `msg_${crypto.randomUUID()}`, ...(attachments?.length ? { attachments } : {}) };
    try {
      if (delivery === 'steer') return await piClient.sendSteer(input, this.scope());
      if (delivery === 'followUp') return await piClient.sendFollowUp(input, this.scope());
      return await piClient.sendPrompt(input, this.scope());
    } catch (error) {
      if (this.promptGenerationById.get(sessionId) === generation) {
        this.pendingPromptById.delete(sessionId);
        const current = this.state.reducer.bySession.get(sessionId);
        if (current?.lifecycle === 'busy' && current.streamingMessages.size === 0) {
          const reverted = new Map(this.state.reducer.bySession);
          reverted.set(sessionId, { ...current, lifecycle: 'error' });
          this.state = { ...this.state, reducer: { ...this.state.reducer, bySession: reverted } };
          this.promoteSession(sessionId, 'settled');
          this.emit();
        }
      }
      throw error;
    }
  }
  abort = (sessionId: string) => piClient.abortSession({ sessionId }, this.scope());
  compact = (sessionId: string) => piClient.compactSession({ sessionId }, this.scope());
  setModel = (sessionId: string, providerId: string, modelId: string) => piClient.setSessionModel({ sessionId, model: { providerId, modelId } }, this.scope());
  setThinking = (sessionId: string, thinking: 'off' | 'low' | 'medium' | 'high' | 'xhigh') => piClient.setSessionThinking({ sessionId, thinking }, this.scope());
  tree = (sessionId: string) => piClient.getSessionTree(sessionId, this.scope());
  providers = () => piClient.listProviders({ runtimeKey: getRuntimeKey() });
  upload = (input: { filename: string; mime: string; base64: string }) => piClient.createAttachment(input, this.scope());
  selected(): PiProjectedSession | null { const id = this.state.selectedSessionId; const session = id ? this.state.reducer.bySession.get(id) : undefined; return session ? projectSession(session) : null; }

  private sessionFromDetail(detail: Awaited<ReturnType<typeof piClient.getSession>>) {
    return hydrateSessionFromDetail({
      session: { id: detail.session.id, directory: detail.session.directory },
      lastSequence: detail.lastSequence,
      messages: detail.messages,
    }).session;
  }

  private mergeHydratedSession(
    fetched: PiReducerSessionState,
    existing: PiReducerSessionState | undefined,
  ): PiReducerSessionState {
    if (!existing) return fetched;
    if (existing.sessionId !== fetched.sessionId) return fetched;
    const liveTurn = existing.lifecycle === 'busy' || existing.lifecycle === 'retry';
    if (existing.messages.size === 0 && !liveTurn) return fetched;

    // Fetched fills in history the live reducer does not have. Existing wins on
    // overlapping ids so a stale getSession cannot blank a transcript the user
    // is already looking at — including when they send mid-hydrate.
    const session: PiReducerSessionState = {
      ...fetched,
      lifecycle: liveTurn ? existing.lifecycle : fetched.lifecycle,
      lastSequence: Math.max(fetched.lastSequence, existing.lastSequence),
      messages: new Map(fetched.messages),
      partOrder: new Map(fetched.partOrder),
      parts: new Map(fetched.parts),
      toolsByCallId: new Map(fetched.toolsByCallId),
      streamingMessages: new Set(liveTurn ? existing.streamingMessages : fetched.streamingMessages),
      queue: existing.queue.steering > 0 || existing.queue.followUp > 0 ? existing.queue : fetched.queue,
      ...(existing.model ? { model: existing.model } : {}),
      ...(existing.thinking ? { thinking: existing.thinking } : {}),
    };
    for (const [id, message] of existing.messages) {
      aliasSyntheticUserIfPersisted(session, id, message);
    }
    for (const [id, order] of existing.partOrder) {
      session.partOrder.set(id, order);
      for (const partId of order) {
        const part = existing.parts.get(partId);
        if (part) session.parts.set(partId, part);
      }
    }
    if (liveTurn) {
      for (const [callId, messageId] of existing.toolsByCallId) session.toolsByCallId.set(callId, messageId);
    }
    return session;
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

  private commitHydratedSession(hydratedSession: PiReducerSessionState, buffered: readonly PiSessionEvent[] = []) {
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
    // Connection chrome is owned by the bootstrap / reconnect paths, not
    // by hydration. Treat the merge as a no-op for `connection` so a
    // hydrate completion doesn't unexpectedly flip a `'loading'` window
    // back to `'ready'` ahead of the SSE plug.
    this.state = {
      ...this.state,
      reducer,
      error: null,
      focusPending: nextFocusPending,
      hydratedSessionIds: new Set(this.hydratedSessionIds),
    };
    this.emit();
    this.scheduleIdleEviction();
  }

  private async hydrate(sessionId: string, expected: number, known?: Awaited<ReturnType<typeof piClient.getSession>>) {
    if (expected !== this.runtimeGeneration) return;
    const sessionDir = this.state.sessions.find((item) => item.session.id === sessionId)?.session.directory;
    const directory = sessionDir || this.directory();
    const runtimeKey = getRuntimeKey();
    if (this.stream && this.hydratedSessionIds.has(sessionId) && !known) {
      if (this.state.connection !== 'ready' || this.state.error) {
        this.state = { ...this.state, connection: 'ready', error: null };
        this.emit();
      }
      return;
    }
    try {
      if (this.stream) {
        const detail = known ?? await piClient.getSession(sessionId, { directory, runtimeKey });
        if (expected !== this.runtimeGeneration) return;
        if (detail.session.id !== sessionId) return;
        this.commitHydratedSession(this.sessionFromDetail(detail));
        return;
      }
      const buffered: PiSessionEvent[] = [];
      let ready = false;
      const onEvent = (event: PiSessionEvent) => {
        if (expected !== this.runtimeGeneration) return;
        if (!ready) buffered.push(event);
        else this.apply(event);
      };
      const bootstrap = await bootstrapPiDirectory({
        directory,
        selectedSessionId: sessionId,
        runtimeKey,
        onEvent,
        onStreamDisconnect: () => void this.reconnect(this.state.selectedSessionId ?? sessionId, expected, runtimeKey),
      });
      if (expected !== this.runtimeGeneration) {
        bootstrap.stream?.dispose();
        return;
      }
      let hydratedSession = known
        ? this.sessionFromDetail(known)
        : bootstrap.reducerState.bySession.get(sessionId);
      if (!hydratedSession) {
        const detail = known ?? await piClient.getSession(sessionId, { directory, runtimeKey });
        if (expected !== this.runtimeGeneration) {
          bootstrap.stream?.dispose();
          return;
        }
        hydratedSession = this.sessionFromDetail(detail);
      }
      if (hydratedSession.sessionId !== sessionId) {
        bootstrap.stream?.dispose();
        return;
      }
      this.stream = bootstrap.stream;
      this.commitHydratedSession(hydratedSession, buffered);
      ready = true;
    } catch (error) { if (expected === this.runtimeGeneration) this.reportError(error); }
  }

  private async reconnect(sessionId: string, expected: number, runtimeKey: string) {
    if (this.recovering || expected !== this.runtimeGeneration) return; this.recovering = true; this.cadence.flush(); this.stream?.dispose(); this.stream = null;
    const cursorAtReconnect = this.streamCursor();
    try {
      const result = await reconnectPiSession({
        directory: this.directory(),
        sessionId,
        runtimeKey,
        lastKnownSequence: cursorAtReconnect,
        onEvent: (event) => this.apply(event),
      });
      if (expected !== this.runtimeGeneration) { result.stream?.dispose(); return; }
      if (result.phase === 'ready') {
        this.stream = result.stream;
        const reducer: PiReducerState = {
          bySession: new Map(this.state.reducer.bySession),
          lastSequence: new Map(this.state.reducer.lastSequence),
        };
        for (const [sId, sState] of result.reducerState.bySession.entries()) {
          const merged = this.mergeHydratedSession(sState, reducer.bySession.get(sId));
          reducer.bySession.set(sId, merged);
          reducer.lastSequence.set(sId, merged.lastSequence);
          this.touchLastAccess(sId);
        }
        for (const sId of result.reducerState.bySession.keys()) this.hydratedSessionIds.add(sId);
        this.state = {
          ...this.state,
          reducer,
          connection: 'ready',
          error: null,
          hydratedSessionIds: new Set(this.hydratedSessionIds),
        };
        this.emit();
        // Catch up: reconnect resumes the stream from the max cursor, so
        // any resident session whose `lastSequence` is behind that
        // cursor missed events while disconnected. Hydrate those sessions
        // again so their `lastSequence` advances; we never tear down
        // resident transcripts, only fetch fresh data for them.
        const resumedCursor = Math.max(cursorAtReconnect ?? -1, result.lastSequence);
        for (const [sId, sState] of this.state.reducer.bySession.entries()) {
          if (sId === sessionId) continue;
          if (sState.lastSequence >= resumedCursor) continue;
          if (!this.hydratedSessionIds.has(sId)) continue;
          void piClient.getSession(sId, { directory: this.directory(), runtimeKey })
            .then((detail) => {
              if (expected !== this.runtimeGeneration) return;
              const refreshed = this.sessionFromDetail(detail);
              this.commitHydratedSession(refreshed);
            })
            .catch(() => {
              /* a single session's catch-up is best-effort; the cluster
                 survives and the stream resumes anyway */
            });
        }
        this.scheduleIdleEviction();
      } else this.reportError(new PiRequestError(result.error?.code ?? 'DAEMON_UNAVAILABLE', result.error?.message));
    } finally { this.recovering = false; }
  }
  private apply(event: PiSessionEvent) {
    this.cadence.push(event);
  }

  private observeActivity(event: PiSessionEvent) {
    if (event.name === 'session.lifecycle') {
      const isRunning = event.payload.state === 'busy' || event.payload.state === 'retry';
      this.promoteSession(event.sessionId, isRunning ? 'active' : 'settled', { notifyIfSettled: true });
    } else if (event.name === 'session.snapshot') {
      const isRunning = Boolean(event.payload.snapshot.isStreaming);
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
    options?: { notifyIfSettled?: boolean },
  ) {
    const previous = this.activityPhaseById.get(sessionId);
    this.activityPhaseById.set(sessionId, phase);
    observeSessionActivityTiming(sessionId, phase);
    observeSessionActivityEvent(sessionId, phase);
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

  private commitEvents(events: readonly PiSessionEvent[]) {
    if (events.length === 0) return;
    let working = this.state.reducer;
    let applied = false;
    let touched = false;
    for (const event of events) {
      const result = applyPiEvent(working, event);
      working = result.state;
      if (!result.didApply) continue;
      applied = true;
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
    if (!applied) return;
    this.state = { ...this.state, reducer: working };
    this.emit();
    if (touched) this.scheduleIdleEviction();
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
      evicted += 1;
    }
    if (!nextBySession || !nextHydratedIds || !nextLastAccess) return;
    this.lastAccessById = nextLastAccess;
    this.state = {
      ...this.state,
      reducer: { bySession: nextBySession, lastSequence: new Map(this.state.reducer.lastSequence) },
      hydratedSessionIds: nextHydratedIds,
    };
    this.emit();
  }

  private async upsertAndHydrate(detail: Awaited<ReturnType<typeof piClient.getSession>>) { const expected = this.runtimeGeneration; this.state = { ...this.state, sessions: [{ session: detail.session, updatedAt: detail.session.updatedAt }, ...this.state.sessions.filter((item) => item.session.id !== detail.session.id)], selectedSessionId: detail.session.id }; this.emit(); await this.hydrate(detail.session.id, expected, detail); }
  private directory() { if (!this.state.directory) throw new PiRequestError('DAEMON_UNAVAILABLE'); return this.state.directory; }
  private streamCursor(): number | undefined {
    let max = -1;
    for (const sequence of this.state.reducer.lastSequence.values()) {
      if (sequence > max) max = sequence;
    }
    return max >= 0 ? max : undefined;
  }
  private scope(customDirectory?: string): PiClientScope { return { directory: customDirectory || this.directory(), runtimeKey: getRuntimeKey() }; }
  private resetForRuntime() {
    const directory = this.state.directory;
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
    this.evictionScheduled = false;
    this.cadence.dispose();
    this.stream?.dispose();
    this.stream = null;
    this.state = initial();
    this.emit();
    if (directory) void this.start({ directory });
  }
  private emit() { for (const listener of this.listeners) listener(); }
}
