import { getPiSessionStore } from '@/apps/pi-session-store';
import type { Session } from '@/lib/chat/types';
import { piSessionToUiSession } from '@/lib/chat/pi-to-renderable';
import type { PiThinkingLevel } from '@/lib/pi/types';

export type ArchiveSessionsOptions = Record<string, unknown>;
export type DeleteSessionOptions = Record<string, unknown>;
export type DeleteSessionsOptions = Record<string, unknown>;
export type UnarchiveSessionsOptions = Record<string, unknown>;

const store = () => getPiSessionStore();

export async function createSession(
  title?: string,
  directoryOverride?: string | null,
  _parentID?: string | null,
  creationOptions?: { model?: { providerId: string; modelId: string }; thinking?: PiThinkingLevel }
): Promise<Session | null> {
  void _parentID;
  const newId = await store().create(title, {
    ...(directoryOverride ? { directory: directoryOverride } : {}),
    ...(creationOptions?.model ? { model: creationOptions.model } : {}),
    ...(creationOptions?.thinking ? { thinking: creationOptions.thinking } : {}),
  });
  const selected = store().getState().sessions.find((item) => item.session.id === newId || item.session.id === store().getState().selectedSessionId);
  return selected ? piSessionToUiSession(selected.session) : null;
}

export async function deleteSession(id: string, _options?: unknown): Promise<boolean> {
  void _options;
  await store().remove(id);
  return true;
}

export async function deleteSessions(ids: string[], _options?: unknown): Promise<{ deletedIds: string[]; failedIds: string[] }> {
  void _options;
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

export async function archiveSessions(ids: string[], _options?: unknown): Promise<{ archivedIds: string[]; failedIds: string[] }> {
  void _options;
  for (const id of ids) await store().archive(id, true);
  return { archivedIds: ids, failedIds: [] };
}

export async function unarchiveSession(id: string): Promise<boolean> {
  await store().archive(id, false);
  return true;
}

export async function unarchiveSessions(ids: string[], _options?: unknown): Promise<{ restoredIds: string[]; failedIds: string[] }> {
  void _options;
  for (const id of ids) await store().archive(id, false);
  return { restoredIds: ids, failedIds: [] };
}

export async function updateSessionTitle(sessionId: string, title: string): Promise<void> {
  await store().rename(sessionId, title);
}

export async function shareSession(_id?: string): Promise<null> {
  void _id;
  return null;
}

export async function unshareSession(_id?: string): Promise<null> {
  void _id;
  return null;
}

export async function optimisticSend(): Promise<void> {}

export async function refetchSessionMessages(_id?: string): Promise<void> {
  void _id;
}

export async function revertToMessage(sessionId: string, messageId: string): Promise<void> {
  const detail = await store().navigate(sessionId, messageId) as unknown as { navigation?: { editorText?: string } } | undefined;
  const editorText = detail?.navigation?.editorText;
  if (typeof editorText === 'string' && editorText.length > 0) {
    try {
      const { useInputStore } = await import('@/sync/input-store');
      useInputStore.getState().setPendingRevertText(editorText);
    } catch {
      // ignore: input store may be unavailable during hydration
    }
  }
}

export async function restoreRevertedMessage(sessionId: string, messageId: string): Promise<void> {
  const { getRevertNavigation } = await import('@/sync/revert-navigation-store');
  if (!getRevertNavigation(sessionId)) throw new Error('No reverted conversation is available to restore.');
  await store().navigate(sessionId, messageId);
}

export async function unrevertSession(sessionId: string): Promise<void> {
  const { getRevertNavigation } = await import('@/sync/revert-navigation-store');
  const target = getRevertNavigation(sessionId)?.previousLeafId;
  if (!target) throw new Error('No reverted conversation is available to restore.');
  await store().navigate(sessionId, target);
}

export async function forkFromMessage(sessionId: string, messageId?: string): Promise<void> {
  await store().fork(sessionId, messageId);
}

export async function fetchMessagesForSession(_sessionId?: string, _directory?: string | null): Promise<never[]> {
  void _sessionId;
  void _directory;
  return [];
}

export function rememberRuntimeLiveStatus(_args?: unknown): void {
  void _args;
}

export async function dismissOpenPermissionsForSession(_sessionId: string): Promise<boolean> {
  void _sessionId;
  return false;
}

export async function dismissOpenQuestionsForSession(_sessionId: string): Promise<boolean> {
  void _sessionId;
  return false;
}

export async function waitForConnectionOrThrow(): Promise<void> {
  const snapshot = store().getState();
  if (snapshot.connection === 'ready') return;
  throw snapshot.error ?? new Error('Pi runtime is unavailable');
}

export async function setLinkedIssue(..._args: unknown[]): Promise<void> {
  void _args;
}

export function abortCurrentOperation(sessionId?: string): void {
  if (sessionId) void store().abort(sessionId);
}

export function getSessionLastAssistantModel(..._args: unknown[]): null {
  void _args;
  return null;
}

export function setOptimisticRefs(
  _add?: (input: unknown) => unknown,
  _remove?: (input: unknown) => unknown,
  _confirm?: (input: unknown) => unknown,
): void {
  void _add;
  void _remove;
  void _confirm;
}
