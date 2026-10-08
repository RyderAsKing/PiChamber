/* eslint-disable */
import { getPiSessionStore } from '@/apps/pi-session-store';
import type { Message, Session } from '@/lib/chat/types';
import { listLiveSessionRecordsFromCatalog, listUiSessionsFromCatalog, selectSessionsNeedingInput, type PiSessionCatalogState, type SessionNeedingInput } from './pi-session-catalog';

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
export function getSyncParts(_messageId?: string, _directory?: string): any[] {
  return [];
}
/** Imperative read of every session waiting for the user, oldest waiter
 *  first. The result is memoized per catalog identity, so repeated reads
 *  without a catalog change return a stable reference. */
const needingInputCache = new WeakMap<PiSessionCatalogState, ReadonlyArray<SessionNeedingInput>>();
export function getSessionsNeedingInput(): ReadonlyArray<SessionNeedingInput> {
  const catalog = getPiSessionStore().getState().catalog;
  const cached = needingInputCache.get(catalog);
  if (cached) return cached;
  const next = selectSessionsNeedingInput(catalog);
  needingInputCache.set(catalog, next);
  return next;
}
