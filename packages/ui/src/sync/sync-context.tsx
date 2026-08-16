/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any */
import { useMemo } from 'react';
import { getPiSessionStore, type PiSessionStoreState } from '@/apps/pi-session-store';
import { piListItemToUiSession, piProjectedToRecords, mapPart } from '@/lib/chat/pi-to-renderable';
import type { Message, Part, PermissionRequest, QuestionRequest, Session, SessionStatus } from '@/lib/chat/types';
import { projectSession, type PiReducerMessage, type PiReducerSessionState } from '@/lib/pi/event-reducer';
import { usePiSessionSnapshot, usePiSessionStore } from './pi-session-context';
import { piLiveStatusSignature } from './pi-session-live';
import { mapPiSessionList } from './sync-refs';
import { INITIAL_STATE, type State } from './types';

const IDLE: SessionStatus = { type: 'idle' };
const BUSY: SessionStatus = { type: 'busy' };
const RETRY: SessionStatus = { type: 'retry' };
const EMPTY_PERMISSIONS: PermissionRequest[] = [];
const EMPTY_QUESTIONS: QuestionRequest[] = [];
const EMPTY_USER_HISTORY: string[] = [];
const EMPTY_MESSAGE_RECORDS: ReturnType<typeof piProjectedToRecords> = [];
const READY_LOAD_STATE = { loading: false, complete: true, status: 'ready' as const, cursor: undefined, error: null as string | null };

const statusesFromSignature = (signature: string): Record<string, SessionStatus> => {
  if (!signature) return {};
  const statuses: Record<string, SessionStatus> = {};
  for (const part of signature.split('|')) {
    const splitAt = part.lastIndexOf(':');
    const sessionId = part.slice(0, splitAt);
    const kind = part.slice(splitAt + 1);
    statuses[sessionId] = kind === 'retry' ? RETRY : BUSY;
  }
  return statuses;
};

const directoryStateFromPi = (state: PiSessionStoreState): State => ({
  ...INITIAL_STATE,
  status: 'complete',
  session: mapPiSessionList(state.sessions),
  sessionTotal: state.sessions.length,
});

const sessionStatusFromReducer = (session: PiReducerSessionState | undefined): SessionStatus => {
  if (!session) return IDLE;
  if (session.lifecycle === 'busy' || session.lifecycle === 'retry') {
    return session.lifecycle === 'retry' ? RETRY : BUSY;
  }
  return IDLE;
};

export function useGlobalSessionStatus(sessionID: string, directory?: string): SessionStatus {
  return useSessionStatus(sessionID, directory);
}
export function useAllSessionStatuses(): Record<string, SessionStatus> {
  const signature = usePiSessionSnapshot((state) => piLiveStatusSignature(state.reducer.bySession));
  return useMemo(() => statusesFromSignature(signature), [signature]);
}
export function useAllLiveSessions(): Session[] {
  const sessions = usePiSessionSnapshot((state) => state.sessions);
  return mapPiSessionList(sessions);
}
export function setActiveSession(directory: string, sessionId: string) {
  const store = getPiSessionStore();
  if (directory && store.getState().directory !== directory) {
    void store.open(directory, sessionId);
    return;
  }
  void store.select(sessionId);
}
export function setExternallyViewedSession(_directory: string, _sessionId: string, _viewed: boolean) {}

const buildPiDirectoryState = (): State => directoryStateFromPi(getPiSessionStore().getState());

const piDirectoryChildStore = {
  subscribe: (listener: () => void) => getPiSessionStore().subscribe(listener),
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
  return usePiSessionSnapshot((state) => selector(directoryStateFromPi(state)), isEqual);
}

export function useSessionMessages(sessionID: string, _directory?: string) {
  return useSessionMessageRecords(sessionID).map((record) => record.info);
}

export function useSessionMessagesResolved(_sessionID: string, _directory?: string): boolean {
  return true;
}

export function useSessionParts(messageID: string, _directory?: string): Part[] {
  const bySession = usePiSessionSnapshot((state) => state.reducer.bySession);
  const session = useMemo(() => {
    if (!messageID) return null;
    for (const candidate of bySession.values()) {
      if (candidate.messages.has(messageID)) return candidate;
    }
    return null;
  }, [bySession, messageID]);
  return useMemo(() => {
    if (!messageID || !session) return [];
    const message = session.messages.get(messageID);
    if (!message) return [];
    const order = session.partOrder.get(messageID) ?? [];
    if (order.length > 0) {
      const parts: Part[] = [];
      for (const partId of order) {
        const part = session.parts.get(partId);
        if (part) {
          parts.push(
            mapPart({
              id: part.id,
              type: part.type,
              text: part.text,
              streaming: part.streaming,
              ...(part.tool ? { tool: part.tool } : {}),
              ...(part.attachment ? { attachment: part.attachment } : {}),
            }),
          );
        }
      }
      return parts;
    }
    const fallback: Part[] = [];
    if (message.thinking) {
      fallback.push({ id: `${message.id}:thinking`, type: 'reasoning', text: message.thinking });
    }
    if (message.text) {
      fallback.push({ id: `${message.id}:text`, type: 'text', text: message.text });
    }
    return fallback;
  }, [messageID, session]);
}

export function useSessionStatus(sessionID: string, _directory?: string): SessionStatus {
  const bySession = usePiSessionSnapshot((state) => state.reducer.bySession);
  return sessionStatusFromReducer(sessionID ? bySession.get(sessionID) : undefined);
}

export function useSessionPermissions(_sessionID: string, _directory?: string): PermissionRequest[] {
  return EMPTY_PERMISSIONS;
}
export function useSessionQuestions(_sessionID: string, _directory?: string): QuestionRequest[] {
  return EMPTY_QUESTIONS;
}
export function useSessionQuestionCount(_scopes?: unknown) { return 0; }
export function useSessions(): Session[] {
  return useAllLiveSessions();
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
  const sessions = usePiSessionSnapshot((state) => state.sessions);
  const item = sessionID ? sessions.find((entry) => entry.session.id === sessionID) ?? null : null;
  return item ? piListItemToUiSession(item) : undefined;
}

export function useSessionDirectory(sessionID?: string | null): string | undefined {
  const sessions = usePiSessionSnapshot((state) => state.sessions);
  const directory = usePiSessionSnapshot((state) => state.directory);
  return (sessionID ? sessions.find((entry) => entry.session.id === sessionID)?.session.directory : undefined)
    ?? directory
    ?? undefined;
}
export function useSyncDirectory(): string {
  return usePiSessionSnapshot((state) => state.directory ?? '');
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
  const hydratedSessionIds = usePiSessionSnapshot((state) => state.hydratedSessionIds);
  const selectedSessionId = usePiSessionSnapshot((state) => state.selectedSessionId);
  const connection = usePiSessionSnapshot((state) => state.connection);
  const error = usePiSessionSnapshot((state) => state.error);
  return useMemo(() => {
    if (!sessionID) return READY_LOAD_STATE;
    const isHydrated = hydratedSessionIds.has(sessionID);
    const isLoading = !isHydrated && (selectedSessionId === sessionID || connection === 'loading');
    const isError = connection === 'error' && error !== null;
    return {
      loading: isLoading,
      complete: isHydrated,
      status: isError ? ('error' as const) : isLoading ? ('loading' as const) : ('ready' as const),
      cursor: undefined,
      error: isError ? (error?.message ?? 'Session load failed') : null,
    };
  }, [connection, error, hydratedSessionIds, selectedSessionId, sessionID]);
}

export function useChildStoreManager() {
  return piChildStoreManager;
}

export function buildSessionMessageRecordsSnapshot(_state?: any, _sessionId?: any) { return { list: [] as any[] }; }

export function useSessionRenderable(sessionID: string, _directory?: string): boolean {
  const hydratedSessionIds = usePiSessionSnapshot((state) => state.hydratedSessionIds);
  return !sessionID || hydratedSessionIds.has(sessionID);
}

export function useUserMessageHistory(sessionID: string): string[] {
  const bySession = usePiSessionSnapshot((state) => state.reducer.bySession);
  return useMemo(() => {
    const session = sessionID ? bySession.get(sessionID) : undefined;
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
  }, [bySession, sessionID]);
}

export function useSessionMessageRecords(
  sessionID: string,
  _directory?: string,
  _options?: {
    enabled?: boolean;
    suspendPartUpdates?: boolean;
    suspendPartUpdatesForMessageId?: string | null;
  },
) {
  const bySession = usePiSessionSnapshot((state) => state.reducer.bySession);
  const session = sessionID ? bySession.get(sessionID) ?? null : null;
  return useMemo(() => (
    session ? piProjectedToRecords(projectSession(session)) : EMPTY_MESSAGE_RECORDS
  ), [session]);
}

export function useSessionMessageCount(sessionID: string, _directory?: string): number {
  const bySession = usePiSessionSnapshot((state) => state.reducer.bySession);
  const session = sessionID ? bySession.get(sessionID) : undefined;
  return session ? session.messages.size : 0;
}

export function useEnsureSessionMessages(sessionID: string, _directory?: string, enabled = true) {
  const store = usePiSessionStore();
  if (enabled && sessionID && store.getState().selectedSessionId !== sessionID) {
    void store.select(sessionID);
  }
}
