import type { ProjectEntry } from "@/lib/api/types";
import { normalizePath } from "@/lib/pathNormalization";

export const normalizeProjectPath = normalizePath;

export const resolveProjectForDirectory = (
  projects: ProjectEntry[],
  directory: string | null,
): ProjectEntry | null => {
  const nd = normalizeProjectPath(directory);
  if (!nd) return null;
  let best: ProjectEntry | null = null;
  for (const p of projects) {
    const pp = normalizeProjectPath(p.path);
    if (!pp) continue;
    if (nd !== pp && !nd.startsWith(`${pp}/`)) continue;
    if (!best || pp.length > (normalizeProjectPath(best.path)?.length ?? 0)) best = p;
  }
  return best;
};

type ProjectWorktreeMap = ReadonlyMap<
  string,
  readonly ({ path?: string | null } | null | undefined)[]
>;

export const resolveProjectForSessionDirectory = (
  projects: ProjectEntry[],
  availableWorktreesOrDirectory?: ProjectWorktreeMap | string | null,
  directory?: string | null,
): ProjectEntry | null => {
  const targetDir = typeof availableWorktreesOrDirectory === 'string'
    ? availableWorktreesOrDirectory
    : directory;
  const normalizedTarget = normalizeProjectPath(targetDir ?? null);
  if (!normalizedTarget) return null;

  // An explicitly registered project owns its own tree even if a linked
  // worktree from another project happens to contain the same path.
  const directProject = resolveProjectForDirectory(projects, normalizedTarget);
  if (directProject) return directProject;
  if (!(availableWorktreesOrDirectory instanceof Map)) return null;

  const projectByRoot = new Map<string, ProjectEntry>();
  for (const project of projects) {
    const root = normalizeProjectPath(project.path);
    if (root) projectByRoot.set(root, project);
  }

  let best: { project: ProjectEntry; worktreePath: string } | null = null;
  for (const [rawProjectRoot, worktrees] of availableWorktreesOrDirectory) {
    const projectRoot = normalizeProjectPath(rawProjectRoot);
    const project = projectRoot ? projectByRoot.get(projectRoot) : null;
    if (!project) continue;
    for (const worktree of worktrees ?? []) {
      const worktreePath = normalizeProjectPath(worktree?.path ?? null);
      if (!worktreePath) continue;
      if (normalizedTarget !== worktreePath && !normalizedTarget.startsWith(`${worktreePath}/`)) continue;
      if (!best || worktreePath.length > best.worktreePath.length) best = { project, worktreePath };
    }
  }
  return best?.project ?? null;
};
