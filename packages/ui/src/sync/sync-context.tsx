/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any */
import { useMemo } from 'react';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { piProjectedToRecords, mapPart } from '@/lib/chat/pi-to-renderable';
import type { Message, Part, PermissionRequest, QuestionRequest, Session, SessionStatus } from '@/lib/chat/types';
import { projectSession } from '@/lib/pi/event-reducer';
import { usePiSessionSnapshot, usePiSessionStore } from './pi-session-context';
import { INITIAL_STATE, type State } from './types';

const IDLE: SessionStatus = { type: 'idle' };
const EMPTY_PERMISSIONS: PermissionRequest[] = [];
const EMPTY_QUESTIONS: QuestionRequest[] = [];

export function useGlobalSessionStatus(_sessionId: string): SessionStatus | undefined {
  return undefined;
}
export function useAllSessionStatuses(): Record<string, SessionStatus> {
  return {};
}
export function useAllLiveSessions(): Session[] {
  const state = usePiSessionSnapshot();
  return state.sessions.map((item) => ({
    id: item.session.id,
    directory: item.session.directory,
    title: item.session.title,
    time: { created: item.session.createdAt, updated: item.session.updatedAt },
  }));
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

const mapPiSessions = (): Session[] =>
  getPiSessionStore().getState().sessions.map((item) => ({
    id: item.session.id,
    directory: item.session.directory,
    title: item.session.title,
    time: { created: item.session.createdAt, updated: item.session.updatedAt },
  }));

const buildPiDirectoryState = (): State => ({
  ...INITIAL_STATE,
  status: 'complete',
  session: mapPiSessions(),
  sessionTotal: getPiSessionStore().getState().sessions.length,
});

const piDirectoryChildStore = {
  subscribe: (listener: () => void) => getPiSessionStore().subscribe(listener),
  getState: buildPiDirectoryState,
};

export function useDirectoryStore(_directory?: string, _options?: { bootstrap?: boolean }) {
  return piDirectoryChildStore;
}

export function useDirectorySync<T>(selector: (state: any) => T): T {
  usePiSessionSnapshot();
  return selector(buildPiDirectoryState());
}

export function useSessionMessages(sessionID: string, _directory?: string) {
  return useSessionMessageRecords(sessionID).map((record) => record.info);
}

export function useSessionMessagesResolved(_sessionID: string, _directory?: string): boolean {
  return true;
}

export function useSessionParts(messageID: string, _directory?: string): Part[] {
  const state = usePiSessionSnapshot();
  return useMemo(() => {
    if (!messageID) return [];
    for (const session of state.reducer.bySession.values()) {
      const message = session.messages.get(messageID);
      if (message) {
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
      }
    }
    return [];
  }, [messageID, state.reducer]);
}

export function useSessionStatus(sessionID: string, _directory?: string): SessionStatus {
  const state = usePiSessionSnapshot();
  const session = state.reducer.bySession.get(sessionID);
  if (!session) return IDLE;
  if (session.lifecycle === 'busy' || session.lifecycle === 'retry') return { type: session.lifecycle };
  if (session.lifecycle === 'interrupted') return { type: 'idle' };
  return IDLE;
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
  const state = usePiSessionSnapshot();
  const item = state.sessions.find((entry) => entry.session.id === sessionID);
  if (!item) return undefined;
  return {
    id: item.session.id,
    directory: item.session.directory,
    title: item.session.title,
    time: { created: item.session.createdAt, updated: item.session.updatedAt },
  };
}
export function useSessionDirectory(sessionID?: string | null): string | undefined {
  const state = usePiSessionSnapshot();
  return state.sessions.find((entry) => entry.session.id === sessionID)?.session.directory ?? state.directory ?? undefined;
}
export function useSyncDirectory(): string {
  return usePiSessionSnapshot().directory ?? '';
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

export function useSessionMessageLoadState(_sessionID: string, _directory?: string) {
  return { loading: false, complete: true, status: 'ready' as const, cursor: undefined, error: null as string | null };
}

export function useChildStoreManager() {
  return piChildStoreManager;
}

export function buildSessionMessageRecordsSnapshot(_state?: any, _sessionId?: any) { return { list: [] as any[] }; }

export function useSessionRenderable(_sessionID: string, _directory?: string): boolean {
  return true;
}

export function useUserMessageHistory(sessionID: string): string[] {
  return useSessionMessageRecords(sessionID)
    .filter((record) => record.info.role === 'user')
    .map((record) => record.parts.filter((part) => part.type === 'text').map((part) => part.text ?? '').join(''))
    .filter(Boolean);
}

export function useSessionMessageRecords(sessionID: string, _directory?: string) {
  const store = usePiSessionStore();
  const state = usePiSessionSnapshot();
  return useMemo(() => {
    const session = state.reducer.bySession.get(sessionID);
    return piProjectedToRecords(session ? projectSession(session) : store.selected()?.sessionId === sessionID ? store.selected() : null);
  }, [sessionID, state.reducer, store]);
}

export function useSessionMessageCount(sessionID: string): number {
  return useSessionMessageRecords(sessionID).length;
}

export function useEnsureSessionMessages(sessionID: string, _directory?: string, enabled = true) {
  const store = usePiSessionStore();
  if (enabled && sessionID && store.getState().selectedSessionId !== sessionID) {
    void store.select(sessionID);
  }
}
