/* eslint-disable */
import { getPiSessionStore } from '@/apps/pi-session-store';
import { piListItemToUiSession } from '@/lib/chat/pi-to-renderable';
import type { Config, Message, Session } from '@/lib/chat/types';
import type { PiSessionListItem } from '@/lib/pi/protocol';
import { listLiveSessionRecordsFromCatalog, listUiSessionsFromCatalog } from './pi-session-catalog';
import type { State } from './types';

export function setSyncRefs() {}
export function getDirectoryState(...args: unknown[]): Pick<State, 'session_status' | 'message'> | undefined {
  void args;
  return undefined;
}
export function getSyncConfig(_directory?: string): Config | undefined {
  void _directory;
  return undefined;
}
type SyncConfigListener = (directory: string, config: Config) => void;
export function subscribeToSyncConfigChanges(_listener?: SyncConfigListener) {
  void _listener;
  return () => {};
}
export function emitSyncConfigChanged() {}
let mappedSessionListCache: { source: readonly PiSessionListItem[]; mapped: Session[] } | null = null;

export function mapPiSessionList(sessions: readonly PiSessionListItem[]): Session[] {
  if (mappedSessionListCache && mappedSessionListCache.source === sessions) {
    return mappedSessionListCache.mapped;
  }
  const mapped = sessions.map(piListItemToUiSession);
  mappedSessionListCache = { source: sessions, mapped };
  return mapped;
}

export function getSyncSessions(): Session[] {
  return listUiSessionsFromCatalog(getPiSessionStore().getState().catalog, { archived: false });
}
export function getAllSyncSessions(): Session[] {
  const catalog = getPiSessionStore().getState().catalog;
  return [
    ...listUiSessionsFromCatalog(catalog, { archived: false }),
    ...listUiSessionsFromCatalog(catalog, { archived: true }),
  ];
}
export function getAllSyncSessionMap(): ReadonlyMap<string, Session> {
  const map = new Map<string, Session>();
  for (const session of getSyncSessions()) map.set(session.id, session);
  return map;
}
export function getSyncSessionDirectory(sessionId: string): string | null {
  const state = getPiSessionStore().getState();
  return state.catalog.byId.get(sessionId)?.directory
    ?? state.sessions.find((item) => item.session.id === sessionId)?.session.directory
    ?? state.directory;
}
export function getActiveSyncSessions(): Array<{ id: string; title: string | null; directory: string }> {
  return listLiveSessionRecordsFromCatalog(getPiSessionStore().getState().catalog).map((record) => ({
    id: record.id,
    title: record.title.trim() || null,
    directory: record.directory,
  }));
}
export function getSyncMessages(sessionId: string, _directory?: string): Message[] {
  void sessionId;
  void _directory;
  return [];
}
export function getSyncSessionMaterializationStatus(_sessionId?: string, _directory?: string) {
  return { hasMessages: true, renderable: true, missingPartMessageIDs: [] as string[] };
}
export function getSyncParts(_messageId?: string, _directory?: string): any[] {
  return [];
}
export function resolveSessionDirectory(_sessionId?: string | null, _wt?: any, selected?: string | null): string | null {
  return selected ?? null;
}
export function resolveSessionDirectoryFromSources(..._args: any[]): string | null {
  return null;
}
export function refetchSessionMessages(_sessionId?: string): Promise<void> {
  return Promise.resolve();
}
export function unrevertSessionAction(_sessionId?: string): Promise<void> {
  return Promise.resolve();
}
export function forkFromMessageAction(_sessionId?: string, _messageId?: string): Promise<void> {
  return Promise.resolve();
}
