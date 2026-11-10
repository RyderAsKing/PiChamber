import { toast } from '@/components/ui';
import { isSessionPinned, useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * Archive from the sidebar: no confirmation, a toast that names what went
 * and offers Undo. Archiving unpins; Undo unarchives the same sessions and
 * restores their pins. The archive itself is optimistic in the session store,
 * which rolls a row back when its write fails.
 */

interface SessionArchiveTarget {
  sessionId: string;
  directory: string | null;
  /** Forks that are not archived yet; they go and come back with the session. */
  forkIds: readonly string[];
}

const sessionsLabel = (count: number) => (count === 1 ? '1 session' : `${count} sessions`);

const setPinned = (target: SessionArchiveTarget, pinned: boolean) => {
  if (!target.directory) return;
  const pins = useSessionPinnedStore.getState();
  if (isSessionPinned(pins.ids, target.directory, target.sessionId) === pinned) return;
  pins.toggle({ directory: target.directory, sessionId: target.sessionId });
};

export const archiveSessionsWithUndo = async (
  targets: readonly SessionArchiveTarget[],
  options: { title?: string } = {},
): Promise<void> => {
  if (targets.length === 0) return;
  const pins = useSessionPinnedStore.getState();
  const wasPinned = new Set(
    targets
      .filter((target) => isSessionPinned(pins.ids, target.directory, target.sessionId))
      .map((target) => target.sessionId),
  );
  for (const target of targets) if (wasPinned.has(target.sessionId)) setPinned(target, false);
  const restorePins = (restore: readonly SessionArchiveTarget[]) => {
    for (const target of restore) if (wasPinned.has(target.sessionId)) setPinned(target, true);
  };

  const ids = [...new Set(targets.flatMap((target) => [target.sessionId, ...target.forkIds]))];
  let result: { archivedIds: string[]; failedIds: string[] };
  try {
    result = await useSessionUIStore.getState().archiveSessions(ids);
  } catch (error) {
    console.warn('[session-archive] archive failed', error);
    result = { archivedIds: [], failedIds: ids };
  }

  const archivedIds = new Set(result.archivedIds);
  const archivedTargets = targets.filter((target) => archivedIds.has(target.sessionId));
  restorePins(targets.filter((target) => !archivedIds.has(target.sessionId)));

  if (archivedTargets.length === 0) {
    // A fork that archived without its session is put back, so nothing
    // half-archived stays behind.
    if (archivedIds.size > 0) void useSessionUIStore.getState().unarchiveSessions([...archivedIds]);
    toast.error(targets.length === 1 ? 'Could not archive the session' : 'Could not archive the sessions');
    return;
  }

  const single = targets.length === 1 && options.title;
  const message = single ? `Archived “${options.title}”` : `Archived ${sessionsLabel(archivedTargets.length)}`;
  const undoIds = result.archivedIds;
  toast.success(message, {
    action: {
      label: 'Undo',
      onClick: () => {
        restorePins(archivedTargets);
        void useSessionUIStore.getState().unarchiveSessions(undoIds)
          .then(({ failedIds }) => {
            if (failedIds.length > 0) {
              toast.error(undoIds.length === 1 ? 'Could not unarchive the session' : 'Could not unarchive the sessions');
            }
          })
          .catch((error) => {
            console.warn('[session-archive] undo failed', error);
            toast.error(undoIds.length === 1 ? 'Could not unarchive the session' : 'Could not unarchive the sessions');
          });
      },
    },
  });

  // Counts forks too: a fork that stayed behind is still in the list.
  const failedCount = ids.length - archivedIds.size;
  if (failedCount > 0) toast.error(`Could not archive ${sessionsLabel(failedCount)}`);
};
