/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any */
import { useMemo, useRef } from 'react';
import { getPiSessionStore, type PiSessionStoreState } from '@/apps/pi-session-store';
import { piProjectedToRecords, mapPart } from '@/lib/chat/pi-to-renderable';
import type { Message, Part, PermissionRequest, QuestionRequest, Session, SessionStatus } from '@/lib/chat/types';
import { projectSession, type PiReducerMessage, type PiReducerMessagePart, type PiReducerSessionState } from '@/lib/pi/event-reducer';
import type { PiCompactionInfo, PiRetryInfo } from '@/lib/pi/types';
import { usePiSessionSnapshot, usePiSessionStore } from './pi-session-context';
import { mapPiSessionList } from './sync-refs';
import {
  catalogLiveSessionIdsKey,
  listUiSessionsFromCatalog,
  liveSessionRecordToUiSession,
  uiSessionListEqual,
  type LiveSessionLifecycle,
} from './pi-session-catalog';
import { selectStreamingAssistantMessageId, shouldReuseSuspendedRecords, shouldReuseUserHistory } from './suspend-live-tail-records';
import { INITIAL_STATE, type State } from './types';

const IDLE: SessionStatus = { type: 'idle' };
const BUSY: SessionStatus = { type: 'busy' };
const RETRY: SessionStatus = { type: 'retry' };
const retryStatusByInfo = new WeakMap<PiRetryInfo, SessionStatus>();
const EMPTY_PERMISSIONS: PermissionRequest[] = [];
const EMPTY_QUESTIONS: QuestionRequest[] = [];
const EMPTY_USER_HISTORY: string[] = [];
const EMPTY_MESSAGE_RECORDS: ReturnType<typeof piProjectedToRecords> = [];
const READY_LOAD_STATE = { loading: false, complete: true, status: 'ready' as const, cursor: undefined, error: null as string | null };
const EMPTY_PARTS: Part[] = [];
const liveMappedParts = new WeakMap<PiReducerMessagePart, Part>();
const TOPIC_CATALOG = 'catalog';
const TOPIC_CHROME = 'chrome';
/** Build the per-session topic key for `usePiSessionSnapshot`. */
const sessionTopic = (sessionId: string) => `session:${sessionId}` as const;

const directoryStateFromPi = (state: PiSessionStoreState): State => ({
  ...INITIAL_STATE,
  status: 'complete',
  session: mapPiSessionList(state.sessions),
  sessionTotal: state.sessions.length,
});

const sessionStatusFromLifecycle = (
  lifecycle: LiveSessionLifecycle | undefined,
  retry?: PiRetryInfo,
): SessionStatus => {
  if (lifecycle === 'busy') return BUSY;
  if (lifecycle !== 'retry') return IDLE;
  if (!retry) return RETRY;
  const cached = retryStatusByInfo.get(retry);
  if (cached) return cached;
  const status: SessionStatus = { type: 'retry', ...retry };
  retryStatusByInfo.set(retry, status);
  return status;
};

export function useCatalogUiSessions(options?: { archived?: boolean; directory?: string | null }): Session[] {
  const archived = options?.archived ?? false;
  const directory = options?.directory;
  return usePiSessionSnapshot(
    (state) => listUiSessionsFromCatalog(state.catalog, { archived, directory }),
    uiSessionListEqual,
    TOPIC_CATALOG,
  );
}

export function useGlobalSessionStatus(sessionID: string, directory?: string): SessionStatus {
  return useSessionStatus(sessionID, directory);
}
export function useAllSessionStatuses(): Record<string, SessionStatus> {
  const signature = usePiSessionSnapshot((state) => catalogLiveSessionIdsKey(state.catalog), undefined, TOPIC_CATALOG);
  const catalog = usePiSessionSnapshot((state) => state.catalog, undefined, TOPIC_CATALOG);
  return useMemo(() => {
    if (!signature) return {};
    const statuses: Record<string, SessionStatus> = {};
    for (const part of signature.split('|')) {
      const record = catalog.byId.get(part);
      statuses[part] = sessionStatusFromLifecycle(record?.lifecycle);
    }
    return statuses;
  }, [catalog, signature]);
}
export function useAllLiveSessions(): Session[] {
  return useCatalogUiSessions({ archived: false });
}
export function setActiveSession(directory: string, sessionId: string) {
  // Cross-folder select is a runtime-cluster focus change, never a
  // teardown. `select` itself focuses the new directory without disposing
  // the stream or dropping other folders' hydrated transcripts.
  void getPiSessionStore().select(sessionId, directory || undefined);
}
export function setExternallyViewedSession(_directory: string, _sessionId: string, _viewed: boolean) {}

const buildPiDirectoryState = (): State => directoryStateFromPi(getPiSessionStore().getState());

const piDirectoryChildStore = {
  // Topic-scoped subscribe: legacy callers that consume this child store
  // (e.g. `useDirectorySync`) only need chrome — directory focus,
  // session list status, connection, error. Token deltas on background
  // sessions should not wake that path.
  subscribe: (listener: () => void) => getPiSessionStore().subscribe(listener, TOPIC_CHROME),
  getState: buildPiDirectoryState,
};

export function useDirectoryStore(_directory?: string, _options?: { bootstrap?: boolean }) {
  return piDirectoryChildStore;
}

export function useDirectorySync<T>(
  selector: (state: any) => T,
  _directory?: string,
  isEqual?: (a: T, b: T) => boolean,
): T {
  // The child-store path subscribes on `chrome` only — directory focus,
  // session list status, connection. Token deltas on background sessions
  // must not wake callers of this hook.
  return usePiSessionSnapshot((state) => selector(directoryStateFromPi(state)), isEqual, TOPIC_CHROME);
}

export function useSessionMessages(sessionID: string, _directory?: string) {
  const records = useSessionMessageRecords(sessionID);
  return useMemo(() => records.map((record) => record.info), [records]);
}

export function useSessionMessagesResolved(_sessionID: string, _directory?: string): boolean {
  return true;
}

/**
 * Live-tail part lookup. Pass a `sessionId` whenever the caller knows it so
 * the hook subscribes to a single session's reducer entry rather than the
 * whole cluster map (and never scans all sessions on every event).
 */
export function useSessionParts(
  sessionId: string | null | undefined,
  messageID: string,
  directory?: string,
): Part[] {
  // Narrow subscription: subscribe to that one session's reducer record
  // only. When the caller doesn't know the session id (legacy
  // single-arg form), fall back to a broadcast scan — the legacy path
  // cannot be topic-narrowed because it has no session id to scope to.
  const narrow = usePiSessionSnapshot(
    (state) => (sessionId ? state.reducer.bySession.get(sessionId) ?? null : null),
    undefined,
    sessionId ? sessionTopic(sessionId) : '*',
  );
  // Legacy scan: subscribe to the cluster map and walk every session. The
  // topic stays broadcast (`*`) only when the caller has no id to narrow
  // on. When the caller does pass a session id the selector returns
  // `null`, but it must still sit on `session:{id}` — a leftover
  // `*` subscription wakes this hook on every catalog chrome flip even
  // though it has nothing to return for background sessions.
  const bySession = usePiSessionSnapshot(
    (state) => (sessionId ? null : state.reducer.bySession),
    undefined,
    sessionId ? sessionTopic(sessionId) : '*',
  );
  const legacyScan = useMemo(() => {
    if (sessionId) return null;
    if (!messageID || directory !== undefined) return null;
    if (!bySession) return null;
    for (const candidate of bySession.values()) {
      if (candidate.messages.has(messageID)) return candidate;
    }
    return null;
  }, [bySession, messageID, sessionId, directory]);
  const session = narrow ?? legacyScan;
  return useMemo(() => {
    if (!messageID || !session) return EMPTY_PARTS;
    const message = session.messages.get(messageID);
    if (!message) return EMPTY_PARTS;
    const order = session.partOrder.get(messageID) ?? [];
    if (order.length > 0) {
      const parts: Part[] = [];
      for (const partId of order) {
        const part = session.parts.get(partId);
        if (!part) continue;
        const cached = liveMappedParts.get(part);
        if (cached) {
          parts.push(cached);
          continue;
        }
        const mapped = mapPart({
          id: part.id,
          type: part.type,
          text: part.text,
          streaming: part.streaming,
          ...(part.tool ? { tool: part.tool } : {}),
          ...(part.attachment ? { attachment: part.attachment } : {}),
        }, { full: true });
        liveMappedParts.set(part, mapped);
        parts.push(mapped);
      }
      return parts;
    }
    const fallback: Part[] = [];
    if (message.thinking) {
      fallback.push({ id: `${message.id}:thinking`, type: 'reasoning', text: message.thinking, streaming: false });
    }
    if (message.text) {
      fallback.push({ id: `${message.id}:text`, type: 'text', text: message.text });
    }
    return fallback;
  }, [messageID, session]);
}

export function useSessionStatus(sessionID: string, _directory?: string): SessionStatus {
  const catalogById = usePiSessionSnapshot((state) => state.catalog.byId, undefined, TOPIC_CATALOG);
  if (!sessionID) return IDLE;
  const record = catalogById.get(sessionID);
  return sessionStatusFromLifecycle(record?.lifecycle, record?.retry);
}

export function useSessionCompaction(sessionID: string): PiCompactionInfo | null {
  return usePiSessionSnapshot(
    (state) => (sessionID ? state.reducer.bySession.get(sessionID)?.compaction ?? null : null),
    undefined,
    sessionID ? sessionTopic(sessionID) : '*',
  );
}

export function useSessionPermissions(_sessionID: string, _directory?: string): PermissionRequest[] {
  return EMPTY_PERMISSIONS;
}
export function useSessionQuestions(_sessionID: string, _directory?: string): QuestionRequest[] {
  return EMPTY_QUESTIONS;
}
export function useSessionQuestionCount(_scopes?: unknown) { return 0; }
export function useSessions(): Session[] {
  // Directory pointer lives on `chrome`; the catalog-driven list comes
  // from `useCatalogUiSessions` on `catalog`. Both are needed because
  // `refreshDirectoryCatalog` success is catalog-only — chrome-only
  // would miss list/title/membership updates.
  const directory = usePiSessionSnapshot((state) => state.directory, undefined, TOPIC_CHROME);
  return useCatalogUiSessions({ archived: false, directory: directory || null });
}
export function useScopedBlockingPermissions(): PermissionRequest[] {
  return EMPTY_PERMISSIONS;
}
export function useScopedBlockingQuestions(): QuestionRequest[] {
  return EMPTY_QUESTIONS;
}
export function useParentSession(): Session | null {
  return null;
}
export function useSession(sessionID?: string | null, _directory?: string): Session | undefined {
  const record = usePiSessionSnapshot(
    (state) => (sessionID ? state.catalog.byId.get(sessionID) ?? null : null),
    undefined,
    TOPIC_CATALOG,
  );
  return record ? liveSessionRecordToUiSession(record) : undefined;
}

export function useSessionDirectory(sessionID?: string | null): string | undefined {
  const recordDirectory = usePiSessionSnapshot(
    (state) => (sessionID ? state.catalog.byId.get(sessionID)?.directory : undefined),
    undefined,
    TOPIC_CATALOG,
  );
  const directory = usePiSessionSnapshot((state) => state.directory, undefined, TOPIC_CHROME);
  return recordDirectory ?? directory ?? undefined;
}
export function useSyncDirectory(): string {
  return usePiSessionSnapshot((state) => state.directory ?? '', undefined, TOPIC_CHROME);
}
const noopUnsubscribe = () => undefined;
const piChildStoreManager = {
  children: new Map<string, unknown>(),
  getState: () => undefined,
  setBootstrapDemand: (_owner?: string, _demand?: unknown) => undefined,
  clearBootstrapDemand: (_owner?: string) => undefined,
  subscribeBootstrap: (_notify: () => void) => noopUnsubscribe,
  getBootstrapState: (_directory?: string) => 'ready' as const,
  getBootstrapFailure: (_directory?: string) => undefined as string | undefined,
  requestBootstrap: (_options?: unknown) => undefined,
  ensureChild: (_directory?: string, _options?: unknown) => piDirectoryChildStore,
};

export function useSessionMessageLoadState(sessionID: string, _directory?: string) {
  // Load state is a chrome signal — it depends on `hydratedSessionIds`,
  // `selectedSessionId`, `connection`, and `error`. Token deltas on
  // background sessions must not wake the loader math.
  const hydratedSessionIds = usePiSessionSnapshot((state) => state.hydratedSessionIds, undefined, TOPIC_CHROME);
  const selectedSessionId = usePiSessionSnapshot((state) => state.selectedSessionId, undefined, TOPIC_CHROME);
  const connection = usePiSessionSnapshot((state) => state.connection, undefined, TOPIC_CHROME);
  const error = usePiSessionSnapshot((state) => state.error, undefined, TOPIC_CHROME);
  const sessionLoadErrorById = usePiSessionSnapshot((state) => state.sessionLoadErrorById, undefined, TOPIC_CHROME);
  return useMemo(() => {
    if (!sessionID) return READY_LOAD_STATE;
    const isHydrated = hydratedSessionIds.has(sessionID);
    if (isHydrated) return READY_LOAD_STATE;
    const sessionError = sessionLoadErrorById.get(sessionID)
      ?? (connection === 'error' && error ? error : null);
    if (sessionError) {
      return {
        loading: false,
        complete: false,
        status: 'error' as const,
        cursor: undefined,
        error: sessionError.message ?? 'Session load failed',
      };
    }
    const isLoading = selectedSessionId === sessionID || connection === 'loading';
    return {
      loading: isLoading,
      complete: false,
      status: isLoading ? ('loading' as const) : ('ready' as const),
      cursor: undefined,
      error: null,
    };
  }, [connection, error, hydratedSessionIds, selectedSessionId, sessionID, sessionLoadErrorById]);
}

export function useChildStoreManager() {
  return piChildStoreManager;
}

export function buildSessionMessageRecordsSnapshot(_state?: any, _sessionId?: any) { return { list: [] as any[] }; }

export function useSessionRenderable(sessionID: string, _directory?: string): boolean {
  const hydratedSessionIds = usePiSessionSnapshot((state) => state.hydratedSessionIds, undefined, TOPIC_CHROME);
  return !sessionID || hydratedSessionIds.has(sessionID);
}

export function useUserMessageHistory(sessionID: string): string[] {
  // Subscribe narrowly to one session's reducer record — other sessions'
  // events won't invalidate the memo. Assistant token deltas keep the same
  // published session for this hook so the composer does not walk every
  // historical user turn on each token.
  const session = usePiSessionSnapshot(
    (state) => (sessionID ? state.reducer.bySession.get(sessionID) ?? null : null),
    (previous, next) => {
      if (Object.is(previous, next)) return true;
      if (!previous || !next) return false;
      return shouldReuseUserHistory(previous, next);
    },
    sessionID ? sessionTopic(sessionID) : '*',
  );
  return useMemo(() => {
    if (!session) return EMPTY_USER_HISTORY;
    const history: string[] = [];
    const seen = new Set<string>();
    const users: PiReducerMessage[] = [];
    for (const message of session.messages.values()) {
      if (message.role !== 'user' || seen.has(message.id)) continue;
      seen.add(message.id);
      users.push(message);
    }
    users.sort((a, b) => a.createdAt - b.createdAt);
    for (const message of users) {
      const order = session.partOrder.get(message.id) ?? [];
      const text = order.length > 0
        ? order
          .map((partId) => session.parts.get(partId))
          .filter((part) => part?.type === 'text')
          .map((part) => part?.text ?? '')
          .join('')
        : (message.text ?? '');
      if (text) history.push(text);
    }
    return history;
  }, [session]);
}

export function useSessionStreamingMessageId(sessionID: string): string | null {
  return usePiSessionSnapshot(
    (state) => selectStreamingAssistantMessageId(
      sessionID ? state.reducer.bySession.get(sessionID) ?? null : null,
    ),
    Object.is,
    sessionID ? sessionTopic(sessionID) : '*',
  );
}

export function useSessionMessageRecords(
  sessionID: string,
  _directory?: string,
  options?: {
    /** Set `false` to rebuild records on every part delta. Default freezes the live tail. */
    suspendPartUpdates?: boolean;
    suspendPartUpdatesForMessageId?: string | null;
  },
) {
  const suspendPartUpdates = options?.suspendPartUpdates !== false;
  const explicitSuspendMessageId = options?.suspendPartUpdatesForMessageId ?? null;
  // Subscribe to one session's reducer entry; other sessions' stream
  // events keep the same reference so React skips recomputation.
  // Live-tail text/thinking/tool-part updates freeze the published records
  // array so ChatContainer, the composer, and the status row do not
  // re-project the whole transcript on every token. The live tail overlays
  // parts from `useSessionParts`.
  const session = usePiSessionSnapshot(
    (state) => (sessionID ? state.reducer.bySession.get(sessionID) ?? null : null),
    (previous, next) => {
      if (Object.is(previous, next)) return true;
      if (!suspendPartUpdates || !previous || !next) return false;
      const suspendMessageId = explicitSuspendMessageId ?? selectStreamingAssistantMessageId(next);
      if (!suspendMessageId) return false;
      return shouldReuseSuspendedRecords(previous, next, suspendMessageId);
    },
    sessionID ? sessionTopic(sessionID) : '*',
  );
  const previousRef = useRef<{
    sessionId: string;
    session: PiReducerSessionState;
    projection: ReturnType<typeof projectSession>;
    records: ReturnType<typeof piProjectedToRecords>;
  } | null>(null);

  return useMemo(() => {
    if (!session) {
      previousRef.current = null;
      return EMPTY_MESSAGE_RECORDS;
    }

    const previous = previousRef.current;
    const suspendMessageId = explicitSuspendMessageId ?? selectStreamingAssistantMessageId(session);
    if (
      suspendPartUpdates
      && suspendMessageId
      && previous
      && previous.sessionId === sessionID
      && shouldReuseSuspendedRecords(previous.session, session, suspendMessageId)
    ) {
      previousRef.current = {
        sessionId: sessionID,
        session,
        projection: previous.projection,
        records: previous.records,
      };
      return previous.records;
    }

    const projection = projectSession(
      session,
      previous && previous.sessionId === sessionID
        ? { session: previous.session, projection: previous.projection }
        : null,
    );
    const records = piProjectedToRecords(projection);
    const previousRecords = previous?.records;
    const reusedRecords = previousRecords
      && previousRecords.length === records.length
      && previousRecords.every((record, index) => record === records[index])
      ? previousRecords
      : records;
    previousRef.current = { sessionId: sessionID, session, projection, records: reusedRecords };
    return reusedRecords;
  }, [explicitSuspendMessageId, session, sessionID, suspendPartUpdates]);
}

export function useSessionReducerPart(
  sessionId: string | null | undefined,
  partId: string | null | undefined,
  enabled: boolean,
): Part | null {
  const part = usePiSessionSnapshot(
    (state) => {
      if (!enabled || !sessionId || !partId) return null;
      return state.reducer.bySession.get(sessionId)?.parts.get(partId) ?? null;
    },
    undefined,
    enabled && sessionId ? sessionTopic(sessionId) : TOPIC_CHROME,
  );
  return useMemo(() => {
    if (!enabled || !part) return null;
    return mapPart({
      id: part.id,
      type: part.type,
      text: part.text,
      streaming: part.streaming,
      ...(part.tool ? { tool: part.tool } : {}),
      ...(part.attachment ? { attachment: part.attachment } : {}),
    }, { full: true });
  }, [enabled, part]);
}

export function useSessionMessageCount(sessionID: string, _directory?: string): number {
  return usePiSessionSnapshot(
    (state) => (sessionID ? state.reducer.bySession.get(sessionID)?.messages.size ?? 0 : 0),
    undefined,
    sessionID ? sessionTopic(sessionID) : '*',
  );
}

export function useEnsureSessionMessages(sessionID: string, _directory?: string, enabled = true) {
  const store = usePiSessionStore();
  if (!enabled || !sessionID) return;
  // Background hydrations (e.g. child sessions inside a tool call) must
  // not change `selectedSessionId` or directory focus: they would steal
  // the visible chat. The store's `ensureHydrated` hydrates the session
  // if it isn't already resident and is otherwise a no-op.
  void store.ensureHydrated(sessionID);
}
