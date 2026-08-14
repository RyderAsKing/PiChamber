/* eslint-disable */
import { getPiSessionStore } from '@/apps/pi-session-store';
import { piListItemToUiSession } from '@/lib/chat/pi-to-renderable';
import type { Config, Message, Session } from '@/lib/chat/types';

export function setSyncRefs() {}
export function registerSessionDirectory() {}
export function getSyncChildStores() {
  return { children: new Map(), getState: () => undefined };
}
export function getDirectoryState(...args: unknown[]) {
  void args;
  return undefined as undefined | {
    session_status?: Record<string, unknown>;
    [key: string]: unknown;
  };
}
export function getSyncConfig(): Config | undefined {
  return undefined;
}
export function subscribeToSyncConfigChanges() {
  return () => {};
}
export function emitSyncConfigChanged() {}
export function getSyncSessions(): Session[] {
  return getPiSessionStore().getState().sessions.map(piListItemToUiSession);
}
export function getAllSyncSessions(): Session[] {
  return getSyncSessions();
}
export function getAllSyncSessionMap(): ReadonlyMap<string, Session> {
  const map = new Map<string, Session>();
  for (const session of getSyncSessions()) map.set(session.id, session);
  return map;
}
export function getSyncSessionDirectory(sessionId: string): string | null {
  return getPiSessionStore().getState().sessions.find((item) => item.session.id === sessionId)?.session.directory ?? getPiSessionStore().getState().directory;
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
export function getSyncSessionStatus() {
  return undefined;
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
