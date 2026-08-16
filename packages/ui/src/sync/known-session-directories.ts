/**
 * Shared helper for the set of directories the sidebar / feeder / catalog
 * consider "known". Built from `useProjectsStore.projects[].path` plus the
 * discovered worktree paths in `useSessionUIStore.availableWorktreesByProject`.
 *
 * Lower-cased to match the sidebar's existing dedupe (a project and a
 * worktree on the same path with different trailing-slash conventions
 * collapse into one entry). Sidebar callers historically filtered with
 * `normalizePath(...).toLowerCase()`; we keep that contract here so the
 * catalog feeder and the sidebar agree on the directory set without
 * re-implementing the comparison.
 *
 * Lives in `@/sync` (not `@/components/session`) because both the React
 * sidebar and the headless catalog feeder need the same answer.
 */

import { normalizePath } from '@/lib/pathNormalization';

export const buildKnownSessionDirectories = (
  projects: ReadonlyArray<{ path?: string | null }>,
  availableWorktreesByProject?:
    | ReadonlyMap<string, ReadonlyArray<{ path?: string | null } | null | undefined> | null | undefined>
    | Map<string, ReadonlyArray<{ path?: string | null } | null | undefined> | null | undefined>
    | null,
  options?: { includeWorktrees?: boolean },
): Set<string> => {
  const directories = new Set<string>();
  for (const project of projects) {
    const normalized = normalizePath(project?.path ?? null)?.toLowerCase();
    if (normalized) directories.add(normalized);
  }
  if (options?.includeWorktrees === false || !availableWorktreesByProject) {
    return directories;
  }
  for (const worktrees of availableWorktreesByProject.values()) {
    if (!worktrees) continue;
    for (const worktree of worktrees) {
      const normalized = normalizePath(worktree?.path ?? null)?.toLowerCase();
      if (normalized) directories.add(normalized);
    }
  }
  return directories;
};