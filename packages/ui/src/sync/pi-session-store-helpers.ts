import {
  aliasSyntheticUserIfPersisted,
  createReducerPartMap,
  createReducerState,
  type PiReducerSessionState,
} from '@/lib/pi/event-reducer';
import { PiRequestError } from '@/lib/pi/client';
import type { PiSession, PiSessionLifecycleState } from '@/lib/pi/types';
import { normalizePath } from '@/lib/pathNormalization';
import {
  initialCatalog,
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
});

/**
 * Build a `LiveSessionRecord` from a server-confirmed `PiSession` for
 * catalog seeding. Preserves an existing row's `lifecycle` and
 * `hydrated` flag so the event-driven mirrors win over the listing's
 * snapshot of the moment.
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
      : {}),
    lifecycle: existing?.lifecycle ?? 'idle',
    hydrated: existing?.hydrated ?? false,
  };
};

export const mergeHydratedSession = (
  fetched: PiReducerSessionState,
  existing: PiReducerSessionState | undefined
): PiReducerSessionState => {
  if (!existing) return fetched;
  if (existing.sessionId !== fetched.sessionId) return fetched;
  const liveTurn =
    existing.lifecycle === 'busy' || existing.lifecycle === 'retry';
  const preserveExisting =
    liveTurn || existing.lastSequence > fetched.lastSequence;
  if (existing.messages.size === 0 && !preserveExisting) return fetched;

  const session: PiReducerSessionState = {
    ...fetched,
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
  };
  if (preserveExisting) {
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
    for (const [callId, messageId] of existing.toolsByCallId)
      session.toolsByCallId.set(callId, messageId);
  }
  return session;
};
