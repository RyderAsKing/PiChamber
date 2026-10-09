import {
  aliasSyntheticUserIfPersisted,
  createReducerPartMap,
  createReducerState,
  type PiReducerSessionState,
} from '@/lib/pi/event-reducer';
import { PiRequestError } from '@/lib/pi/client';
import type { PiSession, PiSessionId, PiSessionLifecycleState } from '@/lib/pi/types';
import { normalizePath } from '@/lib/pathNormalization';
import {
  initialCatalog,
  upsertStubRecord,
  type LiveSessionLifecycle,
  type LiveSessionRecord,
  type PiSessionCatalogState,
} from '@/sync/pi-session-catalog';
import {
  FOCUS_RETRY_DELAY_MS,
  type PiSessionStoreState,
} from './pi-session-store-types';

/**
 * Narrow the reducer's `PiSessionLifecycleState` to the catalog's
 * `LiveSessionLifecycle`. The reducer carries `'interrupted'` for sessions
 * whose assistant turn ended without a final tool (e.g. daemon crash); the
 * catalog treats those as `'idle'` because the session is no longer
 * running. Any unknown future state falls back to `'idle'` rather than
 * claiming authoritative activity.
 */
export const catalogLifecycleFromReducer = (
  lifecycle: PiSessionLifecycleState
): LiveSessionLifecycle => {
  if (lifecycle === 'busy' || lifecycle === 'retry') return lifecycle;
  if (lifecycle === 'error') return 'error';
  return 'idle';
};

/**
 * Extract the catalog lifecycle a stub row should carry when an event
 * arrives for an unlisted session. `session.lifecycle` is the authoritative
 * source; `assistant.message.start` implies busy; everything else returns
 * `undefined` so we do not synthesize stubs from token deltas.
 */
export const lifecycleFromEvent = (
  event: { name: string; payload: unknown }
): LiveSessionLifecycle | undefined => {
  if (event.name === 'session.lifecycle') {
    const state = event.payload && typeof event.payload === 'object'
      ? (event.payload as { state?: unknown }).state
      : undefined;
    if (state === 'busy' || state === 'retry' || state === 'error') return state;
    if (state === 'idle') return 'idle';
    return undefined;
  }
  if (event.name === 'assistant.message.start') return 'busy';
  if (event.name === 'session.error') return 'error';
  return undefined;
};

export const asError = (error: unknown): PiRequestError =>
  error instanceof PiRequestError
    ? error
    : new PiRequestError(
        'DAEMON_REQUEST_FAILED',
        error instanceof Error ? error.message : undefined
      );

export const isInvalidSessionError = (error: unknown): error is PiRequestError =>
  error instanceof PiRequestError && error.code === 'INVALID_SESSION';

export const isSessionInUseError = (error: unknown): error is PiRequestError =>
  error instanceof PiRequestError && error.code === 'SESSION_IN_USE';

export const isSessionRuntimeConflictError = (
  error: unknown
): error is PiRequestError =>
  error instanceof PiRequestError && error.code === 'SESSION_RUNTIME_CONFLICT';

export const delayBeforeRetry = async (): Promise<void> => {
  if (FOCUS_RETRY_DELAY_MS <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, FOCUS_RETRY_DELAY_MS));
};

export const initialSessionStoreState = (
  catalog: PiSessionCatalogState = initialCatalog()
): PiSessionStoreState => ({
  directory: null,
  sessions: [],
  selectedSessionId: null,
  reducer: createReducerState(),
  connection: 'loading',
  error: null,
  showArchived: false,
  hydratedSessionIds: new Set(),
  sessionLoadErrorById: new Map(),
  focusPending: false,
  sessionsListStatus: 'idle',
  catalog,
  syncReadiness: 'ready',
  syncRecovery: { directories: [], residents: [] },
});

/**
 * Build a `LiveSessionRecord` from a server-confirmed `PiSession` for
 * catalog seeding. Preserves an existing row's `lifecycle` and
 * `hydrated` flag so the event-driven mirrors win over the listing's
 * snapshot of the moment. An omitted `messageCount` is unknown and
 * preserves the existing count instead of clearing it.
 */
export const createRecordFromPiSession = (
  session: PiSession,
  catalog: PiSessionCatalogState,
  options?: { now?: number }
): LiveSessionRecord => {
  const now = options?.now ?? Date.now();
  const existing = catalog.byId.get(session.id);
  const directory = normalizePath(session.directory) ?? session.directory;
  const isArchived =
    typeof session.timeArchived === 'number'
      ? session.timeArchived > 0
      : Boolean(session.archived);
  return {
    id: session.id,
    directory,
    parentId: session.parentId ?? null,
    title: session.title ?? '',
    archived: isArchived,
    createdAt: session.createdAt,
    updatedAt:
      typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt)
        ? session.updatedAt
        : now,
    ...(typeof session.messageCount === 'number'
      ? { messageCount: session.messageCount }
      : existing?.messageCount !== undefined ? { messageCount: existing.messageCount } : {}),
    lifecycle: existing?.lifecycle ?? 'idle',
    hydrated: existing?.hydrated ?? false,
    // Pending input is event-driven like lifecycle: a locally observed
    // summary newer than this seed wins over unknown.
    ...(existing?.pendingInput !== undefined ? { pendingInput: existing.pendingInput } : {}),
  };
};

/**
 * Adopt a session detail's authoritative `messageCount` into the catalog.
 * The daemon always reports the total transcript length on details, so
 * hydration is the backfill path for rows first learned from
 * pending-input stubs or lighter listings that omit the count. An absent
 * or non-numeric value is unknown: it keeps the current value, never
 * infers emptiness and never clears a known count. Reference-stable when
 * nothing changes.
 */
export const applyDetailMessageCount = (
  state: PiSessionCatalogState,
  sessionId: PiSessionId,
  directory: string,
  messageCount: unknown,
): PiSessionCatalogState => {
  if (typeof messageCount !== 'number' || !Number.isSafeInteger(messageCount) || messageCount < 0) {
    return state;
  }
  const existing = state.byId.get(sessionId);
  if (existing) {
    if (existing.messageCount === messageCount) return state;
    const nextById = new Map(state.byId);
    nextById.set(sessionId, { ...existing, messageCount });
    return { ...state, byId: nextById };
  }
  const stubbed = upsertStubRecord(state, sessionId, directory, 'idle');
  const stub = stubbed.byId.get(sessionId);
  if (!stub || stub.messageCount === messageCount) return stubbed;
  const nextById = new Map(stubbed.byId);
  nextById.set(sessionId, { ...stub, messageCount });
  return { ...stubbed, byId: nextById };
};

export const mergeHydratedSession = (
  fetched: PiReducerSessionState,
  existing: PiReducerSessionState | undefined,
  options: { localSendPending?: boolean } = {}
): PiReducerSessionState => {
  if (!existing) return fetched;
  if (existing.sessionId !== fetched.sessionId) return fetched;
  // A live local turn is overlaid onto a detail that still reports the turn
  // running. A detail at or past the local cursor that reports the turn
  // settled is authoritative instead: it settles a turn whose lifecycle
  // events this client missed. A send the daemon has not yet taken keeps the
  // local turn, since the detail may predate it.
  const fetchedSettled =
    fetched.lifecycle !== 'busy'
    && fetched.lifecycle !== 'retry'
    && fetched.streamingMessages.size === 0
    && fetched.lastSequence >= existing.lastSequence
    && options.localSendPending !== true;
  const liveTurn =
    (existing.lifecycle === 'busy' || existing.lifecycle === 'retry')
    && !fetchedSettled;
  const preserveExisting =
    liveTurn || existing.lastSequence > fetched.lastSequence;
  // A fetch can finish behind an already accepted live extension event. The
  // detail response has no way to represent that newer event, so do not let
  // stale hydration erase the status that the user is looking at.
  const preserveExistingExtensionState = existing.lastSequence > fetched.lastSequence;
  const preservePagedHistory = fetched.hasMoreBefore === true && existing.messages.size > 0;
  if (existing.messages.size === 0 && !preserveExisting) return fetched;
  const session: PiReducerSessionState = {
    ...fetched,
    ...(preservePagedHistory && existing.hasMoreBefore !== undefined
      ? {
          hasMoreBefore: existing.hasMoreBefore,
          beforeCursor: existing.beforeCursor,
        }
      : {}),
    lifecycle: preserveExisting ? existing.lifecycle : fetched.lifecycle,
    lastSequence: Math.max(fetched.lastSequence, existing.lastSequence),
    messages: new Map(fetched.messages),
    partOrder: new Map(fetched.partOrder),
    parts: createReducerPartMap(fetched.parts),
    toolsByCallId: new Map(fetched.toolsByCallId),
    streamingMessages: new Set(
      preserveExisting ? existing.streamingMessages : fetched.streamingMessages
    ),
    queue:
      existing.queue.steering > 0 || existing.queue.followUp > 0
        ? existing.queue
        : fetched.queue,
    ...(existing.model && (preserveExisting || !fetched.model)
      ? { model: existing.model }
      : {}),
    ...(existing.thinking && (preserveExisting || !fetched.thinking)
      ? { thinking: existing.thinking }
      : {}),
    ...(preserveExistingExtensionState
      ? {
          extensionStatuses: existing.extensionStatuses,
          extensionWidgets: existing.extensionWidgets,
          extensionDialogs: existing.extensionDialogs,
          extensionPanels: existing.extensionPanels,
          extensionApps: existing.extensionApps,
          extensionTitle: existing.extensionTitle,
          ...(existing.extensionWorking ? { extensionWorking: existing.extensionWorking } : {}),
          ...(existing.extensionDraftTracked ? { extensionDraftTracked: true } : {}),
        }
      : {}),
    // These fields are local live state rather than part of the session detail
    // response. Hydration must not reset them, regardless of fetched sequence.
    extensionNotices: existing.extensionNotices,
    extensionErrors: existing.extensionErrors,
    extensionCatalogRevision: existing.extensionCatalogRevision,
    sessionTreeRevision: existing.sessionTreeRevision,
    extensionEditor: existing.extensionEditor,
    extensionEditorOps: existing.extensionEditorOps,
    // The pre-echo marker is likewise local send state. The detail response
    // never carries it; keep it so a hydrate racing the user echo does not
    // reopen the window. The selector still self-resolves once the fetched
    // transcript contains the echoed user message.
    ...(existing.awaitingPromptEcho !== undefined
      ? { awaitingPromptEcho: existing.awaitingPromptEcho }
      : {}),
  };
  if (preserveExisting || preservePagedHistory) {
    for (const [id, message] of existing.messages) {
      if (preserveExisting || !session.messages.has(id)) {
        aliasSyntheticUserIfPersisted(session, id, message);
      }
    }
    for (const [id, order] of existing.partOrder) {
      if (!preserveExisting && session.partOrder.has(id)) continue;
      session.partOrder.set(id, order);
      for (const partId of order) {
        const part = existing.parts.get(partId);
        if (part) session.parts.set(partId, part);
      }
    }
    for (const [callId, messageId] of existing.toolsByCallId) {
      if (preserveExisting || !session.toolsByCallId.has(callId)) {
        session.toolsByCallId.set(callId, messageId);
      }
    }
  }
  return session;
};
