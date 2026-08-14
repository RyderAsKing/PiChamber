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

export const resolveProjectForSessionDirectory = (
  projects: ProjectEntry[],
  _availableWorktrees?: unknown,
  directory?: string | null,
): ProjectEntry | null => {
  const targetDir = typeof _availableWorktrees === 'string' ? _availableWorktrees : directory;
  return resolveProjectForDirectory(projects, targetDir ?? null);
};

export const resolveDraftProjectForDirectory = resolveProjectForSessionDirectory;
