import { getPiSessionStore } from '@/apps/pi-session-store';
import type { Session } from '@/lib/chat/types';
import { piSessionToUiSession } from '@/lib/chat/pi-to-renderable';
import type { PiThinkingLevel } from '@/lib/pi/types';
import { useInputStore } from '@/sync/input-store';
import { getRevertNavigation } from '@/sync/revert-navigation-store';

export type ArchiveSessionsOptions = Record<string, unknown>;
export type DeleteSessionOptions = Record<string, unknown>;
export type DeleteSessionsOptions = Record<string, unknown>;
export type UnarchiveSessionsOptions = Record<string, unknown>;

const store = () => getPiSessionStore();

export async function createSession(
  title?: string,
  directoryOverride?: string | null,
  _parentID?: string | null,
  creationOptions?: {
    model?: { providerId: string; modelId: string };
    thinking?: PiThinkingLevel;
    select?: boolean;
  }
): Promise<Session | null> {
  void _parentID;
  const newId = await store().create(title, {
    ...(directoryOverride ? { directory: directoryOverride } : {}),
    ...(creationOptions?.model ? { model: creationOptions.model } : {}),
    ...(creationOptions?.thinking ? { thinking: creationOptions.thinking } : {}),
    ...(creationOptions?.select === false ? { select: false } : {}),
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
  try {
    await store().archive(id, true);
    return true;
  } catch {
    return false;
  }
}

/**
 * Archives or unarchives every id at once (each row changes optimistically
 * when its call starts; the server serializes the writes) and reports each
 * failure, so one failed session does not hide the rest.
 */
const setArchivedMany = async (ids: string[], archived: boolean): Promise<{ done: string[]; failed: string[] }> => {
  const results = await Promise.allSettled(ids.map((id) => store().archive(id, archived)));
  const done: string[] = [];
  const failed: string[] = [];
  results.forEach((result, index) => (result.status === 'fulfilled' ? done : failed).push(ids[index]!));
  return { done, failed };
};

export async function archiveSessions(ids: string[], _options?: unknown): Promise<{ archivedIds: string[]; failedIds: string[] }> {
  void _options;
  const { done, failed } = await setArchivedMany(ids, true);
  return { archivedIds: done, failedIds: failed };
}

export async function unarchiveSession(id: string): Promise<boolean> {
  try {
    await store().archive(id, false);
    return true;
  } catch {
    return false;
  }
}

export async function unarchiveSessions(ids: string[], _options?: unknown): Promise<{ restoredIds: string[]; failedIds: string[] }> {
  void _options;
  const { done, failed } = await setArchivedMany(ids, false);
  return { restoredIds: done, failedIds: failed };
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

export async function revertToMessage(sessionId: string, messageId: string): Promise<void> {
  const detail = await store().navigate(sessionId, messageId) as unknown as { navigation?: { editorText?: string } } | undefined;
  const editorText = detail?.navigation?.editorText;
  if (typeof editorText === 'string' && editorText.length > 0) {
    try {
      useInputStore.getState().setPendingRevertText(editorText);
    } catch {
      // ignore: input store may be unavailable during hydration
    }
  }
}

export async function restoreRevertedMessage(sessionId: string, messageId: string): Promise<void> {
  if (!getRevertNavigation(sessionId)) throw new Error('No reverted conversation is available to restore.');
  await store().navigate(sessionId, messageId);
}

export async function unrevertSession(sessionId: string): Promise<void> {
  const target = getRevertNavigation(sessionId)?.previousLeafId;
  if (!target) throw new Error('No reverted conversation is available to restore.');
  await store().navigate(sessionId, target);
}

export async function forkFromMessage(sessionId: string, messageId?: string): Promise<void> {
  await store().fork(sessionId, messageId);
}

export async function waitForConnectionOrThrow(): Promise<void> {
  const snapshot = store().getState();
  if (snapshot.connection === 'ready') return;
  throw snapshot.error ?? new Error('Pi runtime is unavailable');
}

export async function compactSession(sessionId: string, customInstructions?: string): Promise<void> {
  await store().compact(sessionId, customInstructions);
}

export async function abortShellCommand(sessionId: string): Promise<void> {
  await store().abortBash(sessionId);
}

export function abortCurrentOperation(sessionId?: string): void {
  if (sessionId) void store().abort(sessionId);
}
