/* eslint-disable */
import { getPiSessionStore } from '@/apps/pi-session-store';
import type { Session } from '@/lib/chat/types';
import { piSessionToUiSession } from '@/lib/chat/pi-to-renderable';

export type ArchiveSessionsOptions = Record<string, unknown>;
export type DeleteSessionOptions = Record<string, unknown>;
export type DeleteSessionsOptions = Record<string, unknown>;
export type UnarchiveSessionsOptions = Record<string, unknown>;

const store = () => getPiSessionStore();

export async function createSession(
  title?: string,
  directoryOverride?: string | null,
  _parentID?: string | null,
  creationOptions?: { model?: { providerId: string; modelId: string }; thinking?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' }
): Promise<Session | null> {
  const newId = await store().create(title, {
    ...(directoryOverride ? { directory: directoryOverride } : {}),
    ...(creationOptions?.model ? { model: creationOptions.model } : {}),
    ...(creationOptions?.thinking ? { thinking: creationOptions.thinking } : {}),
  });
  const selected = store().getState().sessions.find((item) => item.session.id === newId || item.session.id === store().getState().selectedSessionId);
  return selected ? piSessionToUiSession(selected.session) : null;
}

export async function deleteSession(id: string, _options?: any): Promise<boolean> {
  await store().remove(id);
  return true;
}

export async function deleteSessions(ids: string[], _options?: any): Promise<{ deletedIds: string[]; failedIds: string[] }> {
  const deletedIds: string[] = [];
  const failedIds: string[] = [];
  for (const id of ids) {
    try {
      await store().remove(id);
      deletedIds.push(id);
    } catch {
      failedIds.push(id);
    }
  }
  return { deletedIds, failedIds };
}

export async function archiveSession(id: string): Promise<boolean> {
  await store().archive(id, true);
  return true;
}

export async function archiveSessions(ids: string[], _options?: any): Promise<{ archivedIds: string[]; failedIds: string[] }> {
  for (const id of ids) await store().archive(id, true);
  return { archivedIds: ids, failedIds: [] };
}

export async function unarchiveSession(id: string): Promise<boolean> {
  await store().archive(id, false);
  return true;
}

export async function unarchiveSessions(ids: string[], _options?: any): Promise<{ restoredIds: string[]; failedIds: string[] }> {
  for (const id of ids) await store().archive(id, false);
  return { restoredIds: ids, failedIds: [] };
}

export async function updateSessionTitle(sessionId: string, title: string): Promise<void> {
  await store().rename(sessionId, title);
}

export async function shareSession(_id?: string): Promise<any> { return null; }
export async function unshareSession(_id?: string): Promise<any> { return null; }
export async function optimisticSend() {}
export async function refetchSessionMessages(_id?: string): Promise<void> {}
export async function revertToMessage(sessionId: string, messageId: string): Promise<void> {
  await store().navigate(sessionId, messageId);
}
export async function unrevertSession(_id?: string): Promise<void> {}
export async function forkFromMessage(sessionId: string, _messageId?: string): Promise<void> {
  await store().fork(sessionId);
}
export async function fetchMessagesForSession(_sessionId?: string, _directory?: string | null) { return []; }
export function rememberRuntimeLiveStatus(_args?: any) {}
export function setContextObligatoryMessage(..._args: unknown[]) {}
export async function respondToPermission(..._args: unknown[]) {}
export async function respondToQuestion(..._args: unknown[]) {}
export async function rejectQuestion(..._args: unknown[]) {}
export function isQuestionRequestNotFoundError(_error?: unknown) { return false; }
export async function dismissOpenPermissionsForSession(_sessionId: string): Promise<boolean> { return false; }
export async function dismissOpenQuestionsForSession(_sessionId: string): Promise<boolean> { return false; }
export async function waitForConnectionOrThrow(): Promise<void> {
  const snapshot = store().getState();
  if (snapshot.connection === 'ready') return;
  throw snapshot.error ?? new Error('Pi runtime is unavailable');
}
export async function setLinkedIssue(..._args: unknown[]): Promise<void> {}
export function abortCurrentOperation(sessionId?: string) {
  if (sessionId) void store().abort(sessionId);
}
export function getSessionLastAssistantModel(..._args: unknown[]) { return null; }

export function setOptimisticRefs(
  _add?: unknown,
  _remove?: unknown,
  _confirm?: unknown,
) {}
