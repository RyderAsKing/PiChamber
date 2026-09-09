import type { PiRequestError } from '@/lib/pi/client';
import type { PiSessionListItem } from '@/lib/pi/protocol';
import type { PiReducerState } from '@/lib/pi/event-reducer';
import type { PiSessionCatalogState } from '@/sync/pi-session-catalog';
import type { PiSessionId } from '@/lib/pi/types';

export type PiSessionTopic =
  | `session:${PiSessionId}`
  | 'catalog'
  | 'chrome'
  | 'dialogs'
  | '*';

export const TOPIC_BROADCAST = '*';
export const TOPIC_CATALOG = 'catalog';
export const TOPIC_DIALOGS = 'dialogs';
export const TOPIC_CHROME = 'chrome';

export type PiConnectionState = 'loading' | 'ready' | 'unavailable' | 'error';
export type PiSessionsListStatus = 'idle' | 'loading' | 'ready' | 'failed';

/** Synchronization readiness is separate from transport connectivity.
 *  `connection: 'ready'` means the stream/health is alive — a heartbeat is
 *  NOT proof that the cluster's baseline is current. `syncReadiness` is
 *  `'recovering'` while reconnect recovery obligations (directory catalog
 *  reconciliations and affected resident re-hydrations after a replay miss
 *  or stream-epoch change) are still outstanding. */
export type PiSyncReadiness = 'ready' | 'recovering';

/** Outstanding reconnect-recovery scopes, mirrored into state for
 *  observability. A failed scope stays listed: partial success is never
 *  reported as complete, and the obligation is retried on later recovery
 *  passes. */
export interface PiSyncRecoveryScopes {
  directories: readonly string[];
  residents: readonly PiSessionId[];
}

export type PiSendStatus = 'confirming' | 'accepted' | 'outcome-unknown' | 'rejected';

/**
 * Explicit user-visible send acceptance for one session's latest intent.
 *
 * - `confirming`: the request was dispatched but the response was lost.
 *   The exact `sessions.sendReceipt` lookup is still outstanding. The turn
 *   stays optimistically busy; unrelated live activity never settles it.
 * - `accepted`: the exact receipt (or the direct send response) proved the
 *   daemon owns the intent. Turn progress is owned by the event stream.
 * - `outcome-unknown`: the receipt said `expired`/`unknown`, the epoch went
 *   stale, or the payload was rejected as mismatched/expired. The optimistic
 *   busy is cleared so the chat is not stuck working forever. The copy in
 *   `title`/`action` is user-visible: check history first, then use an
 *   explicit new intent. Never auto-resends.
 * - `rejected`: the daemon authoritatively declined this attempt before
 *   execution. Safe to retry with the same configuration as a new intent.
 */
export interface PiSendRecord {
  status: PiSendStatus;
  operationId: string;
  kind: 'prompt' | 'steer' | 'followUp';
  streamEpoch?: string;
  runtimeKey: string;
  messageId?: string;
  updatedAt: number;
  /** User-visible title (Sentence case, no secrets or IDs). */
  title: string;
  /** User-visible safe next action (never "retry automatically"). */
  action: string;
}

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
  /**
   * Per-session hydrate failures. A missing or unreadable session must not
   * take the cluster to `connection: 'error'` (that looks like a daemon
   * outage) and must not leave the chat on the PiChamber logo forever.
   * `useSessionMessageLoadState` maps this to the existing
   * "Session could not be loaded" block.
   */
  sessionLoadErrorById: ReadonlyMap<PiSessionId, PiRequestError>;
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
  /** Runtime-scoped live catalog — metadata for every Pi session this
   *  runtime has surfaced, kept in lockstep with the SSE event stream
   *  and per-directory listings. Transcripts stay in `reducer.bySession`
   *  (LRU-capped); the catalog is metadata-only. See
   *  `pi-session-catalog.ts` for membership, lifecycle, and reference-
   *  hygiene rules. */
  catalog: PiSessionCatalogState;
  /** Sync readiness, separate from `connection`. See `PiSyncReadiness`. */
  syncReadiness: PiSyncReadiness;
  /** Outstanding reconnect-recovery obligations. See `PiSyncRecoveryScopes`. */
  syncRecovery: PiSyncRecoveryScopes;
  /**
   * Explicit per-session send acceptance, keyed by session id.
   * Read via `getSendState()` / `useSendState()`; the chat renders
   * `outcome-unknown` instead of a stuck working indicator. Cleared on
   * delete and runtime reset alongside optimistic maps. Absence means no
   * send is being tracked for that session.
   */
  sendStateById: ReadonlyMap<PiSessionId, PiSendRecord>;
}

export type Listener = () => void;

/** Soft cap for resident transcripts kept in `reducer.bySession`. Idle
 *  transcripts can be evicted; `lastSequence` survives the eviction so
 *  reconnect/rehydrate resumes without rewinding past accepted events. */
export const PI_TRANSCRIPT_EVICTION_SOFT_CAP = 16;

/** Bounded concurrency for reconnect-recovery residents (matches the
 *  catalog refresh scheduler). */
export const PI_SYNC_RECOVERY_CONCURRENCY = 2;

/** Bounded automatic retry passes per recovery cycle. A scope that keeps
 *  failing stays recorded as an obligation and is retried on the next
 *  stream-health signal or reconnect instead of looping forever. */
export const PI_SYNC_RECOVERY_MAX_ATTEMPTS = 5;

/** Single automatic retry delay for transient focus-list failures. Short
 *  enough that the chat loader does not visibly stall, long enough that we
 *  do not pile onto a 5xx storm. */
export const FOCUS_RETRY_DELAY_MS = 300;

export const RECOVERABLE_CONNECTION_CODES = new Set([
  'DAEMON_UNAVAILABLE',
  'DAEMON_TIMEOUT',
  'DAEMON_START_TIMEOUT',
  'DAEMON_REQUEST_FAILED',
]);

export interface PendingFocus {
  directory: string;
  expected: number;
  /** Session id the caller wants selected after the focus resolves. */
  preferredSessionId?: PiSessionId | null;
}
