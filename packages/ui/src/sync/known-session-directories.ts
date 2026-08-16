/**
 * Shared helper for the set of directories the sidebar / feeder / catalog
 * consider "known". Built from `useProjectsStore.projects[].path` plus the
 * discovered worktree paths in `useSessionUIStore.availableWorktreesByProject`.
 *
 * Dedupe is case-insensitive so a project and a worktree on the same path
 * with different trailing-slash or letter-case conventions collapse into
 * one entry. Values keep filesystem casing: the catalog feeder passes them
 * to `GET /api/pi/sessions?directory=`, and the daemon `stat`s that path
 * on case-sensitive hosts (Linux/WSL). Lowercasing the RPC argument made
 * every list call 400 when stored projects used mixed case.
 *
 * Lives in `@/sync` (not `@/components/session`) because both the React
 * sidebar and the headless catalog feeder need the same answer.
 */

import { normalizePath } from '@/lib/pathNormalization';

export const knownSessionDirectoryKey = (value?: string | null): string | null =>
  normalizePath(value)?.toLowerCase() ?? null;

const addKnownDirectory = (directories: Map<string, string>, path?: string | null): void => {
  const normalized = normalizePath(path ?? null);
  if (!normalized) return;
  const key = normalized.toLowerCase();
  if (!directories.has(key)) directories.set(key, normalized);
};

export const buildKnownSessionDirectories = (
  projects: ReadonlyArray<{ path?: string | null }>,
  availableWorktreesByProject?:
    | ReadonlyMap<string, ReadonlyArray<{ path?: string | null } | null | undefined> | null | undefined>
    | Map<string, ReadonlyArray<{ path?: string | null } | null | undefined> | null | undefined>
    | null,
  options?: { includeWorktrees?: boolean },
): Set<string> => {
  const directories = new Map<string, string>();
  for (const project of projects) {
    addKnownDirectory(directories, project?.path);
  }
  if (options?.includeWorktrees === false || !availableWorktreesByProject) {
    return new Set(directories.values());
  }
  for (const worktrees of availableWorktreesByProject.values()) {
    if (!worktrees) continue;
    for (const worktree of worktrees) {
      addKnownDirectory(directories, worktree?.path);
    }
  }
  return new Set(directories.values());
};
