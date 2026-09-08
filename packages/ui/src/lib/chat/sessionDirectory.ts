import type { Session } from '@/lib/chat/types';
import { normalizePath } from '@/lib/pathNormalization';

/**
 * Resolve the owning directory for a global/UI session.
 *
 * Preserves the `useGlobalSessionsStore` wrapper semantics:
 * `normalizePath(directory) ?? normalizePath(project.worktree)`.
 * Returns `null` when neither yields a normalized path.
 */
export const resolveGlobalSessionDirectory = (session: Session): string | null => {
  const record = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };

  return (
    normalizePath(record.directory ?? null) ??
    normalizePath(record.project?.worktree ?? null)
  );
};
