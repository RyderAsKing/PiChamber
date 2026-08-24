import type { Session } from '@/lib/chat/types';

type GlobalSessionRecord = Session & {
  project?: {
    id: string;
    name?: string;
    worktree?: string;
  } | null;
};

const isArchivedSession = (session: GlobalSessionRecord): boolean => Boolean(session.time?.archived);

/**
 * Split Pi's inclusive session catalog into active and archived buckets.
 * Restored sessions carry `time.archived === 0`, which is intentionally active.
 */
export const splitGlobalSessionsByArchived = <T extends GlobalSessionRecord>(
  sessions: T[],
): { active: T[]; archived: T[] } => {
  const active: T[] = [];
  const archived: T[] = [];
  for (const session of sessions) {
    if (isArchivedSession(session)) archived.push(session);
    else active.push(session);
  }
  return { active, archived };
};
