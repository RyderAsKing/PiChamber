/* eslint-disable */
import type { Session } from '@/lib/chat/types';
import { normalizePath } from '@/lib/pathNormalization';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';

const isGlobalSessionDirectory = (directory: string | null): boolean => {
  if (!directory) return false;
  const normalized = normalizePath(directory);
  if (!normalized) return false;
  if (normalized === '~') return true;
  try {
    const rawHome = getDeferredSafeStorage().getItem('homeDirectory');
    if (typeof rawHome === 'string' && rawHome.trim().length > 0) {
      const homeNormalized = normalizePath(rawHome);
      if (homeNormalized && normalized === homeNormalized) return true;
    }
  } catch { /* ignored */ }
  try {
    if (typeof window !== 'undefined' && typeof (window as unknown as { __PICHAMBER_HOME__?: string }).__PICHAMBER_HOME__ === 'string') {
      const candidate = (window as unknown as { __PICHAMBER_HOME__?: string }).__PICHAMBER_HOME__;
      const homeNormalized = candidate ? normalizePath(candidate) : null;
      if (homeNormalized && normalized === homeNormalized) return true;
    }
  } catch { /* ignored */ }
  return false;
};

type Project = {
  id: string;
  normalizedPath: string;
};

type Worktree = {
  path: string;
};

export type DirectoryOwner = {
  projectId: string;
  projectRoot: string;
  scopeDirectory: string;
  kind: 'project' | 'worktree';
};

export type SessionOwnershipIndex = {
  bySessionId: Map<string, DirectoryOwner>;
  sessionsByProject: Map<string, Session[]>;
  archivedSessionsByProject: Map<string, Session[]>;
  sessionsByScope: Map<string, Set<string>>;
  directoryResolutions: number;
};

const shouldReplaceOwner = (existing: DirectoryOwner | undefined, candidate: DirectoryOwner): boolean => {
  if (!existing) return true;
  if (candidate.kind !== existing.kind) {
    return candidate.kind === 'project';
  }
  if (candidate.projectRoot.length !== existing.projectRoot.length) {
    return candidate.projectRoot.length > existing.projectRoot.length;
  }
  return candidate.projectId.localeCompare(existing.projectId) < 0;
};

const setOwner = (owners: Map<string, DirectoryOwner>, directory: string, candidate: DirectoryOwner): void => {
  if (shouldReplaceOwner(owners.get(directory), candidate)) {
    owners.set(directory, candidate);
  }
};

const resolveSessionDirectory = (session: Session): string | null => {
  const record = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };
  return normalizePath(record.directory) ?? normalizePath(record.project?.worktree);
};

const getParentDirectory = (directory: string): string | null => {
  if (directory === '/' || /^[A-Z]:$/.test(directory)) {
    return null;
  }
  const separator = directory.lastIndexOf('/');
  if (separator < 0) return null;
  if (separator === 0) return '/';
  if (separator === 2 && /^[A-Z]:\//.test(directory)) return directory.slice(0, 2);
  return directory.slice(0, separator);
};

export const createSessionOwnershipIndex = (
  sessions: Session[],
  projects: Project[],
  availableWorktreesByProject?: Map<string, any[]> | null,
  archivedSessions: Session[] = [],
): SessionOwnershipIndex => {
  const ownerByDirectory = new Map<string, DirectoryOwner>();
  const projectByRoot = new Map<string, Project>();

  for (const project of projects) {
    const projectRoot = normalizePath(project.normalizedPath);
    if (!projectRoot) continue;
    const existingProject = projectByRoot.get(projectRoot);
    if (!existingProject || project.id.localeCompare(existingProject.id) < 0) {
      projectByRoot.set(projectRoot, project);
    }
    setOwner(ownerByDirectory, projectRoot, {
      projectId: project.id,
      projectRoot,
      scopeDirectory: projectRoot,
      kind: 'project',
    });
  }

  if (availableWorktreesByProject) {
    for (const [projectPath, worktrees] of availableWorktreesByProject) {
      const projectRoot = normalizePath(projectPath);
      const project = projectRoot ? projectByRoot.get(projectRoot) : undefined;
      if (!project || !projectRoot) continue;
      for (const worktree of worktrees || []) {
        const directory = normalizePath(worktree?.path);
        if (!directory) continue;
        setOwner(ownerByDirectory, directory, {
          projectId: project.id,
          projectRoot,
          scopeDirectory: directory,
          kind: 'worktree',
        });
      }
    }
  }

  const resolvedOwners = new Map<string, DirectoryOwner | null>();
  const bySessionId = new Map<string, DirectoryOwner>();
  const sessionsByProject = new Map<string, Session[]>();
  const archivedSessionsByProject = new Map<string, Session[]>();
  const sessionsByScope = new Map<string, Set<string>>();

  const resolveOwner = (directory: string | null): DirectoryOwner | null => {
    if (!directory) return null;
    if (resolvedOwners.has(directory)) {
      return resolvedOwners.get(directory) ?? null;
    }

    const visited: string[] = [];
    let current: string | null = directory;
    let owner: DirectoryOwner | null = null;
    while (current) {
      if (resolvedOwners.has(current)) {
        owner = resolvedOwners.get(current) ?? null;
        break;
      }
      visited.push(current);
      owner = ownerByDirectory.get(current) ?? null;
      if (owner) break;
      current = getParentDirectory(current);
    }
    for (const visitedDirectory of visited) {
      resolvedOwners.set(visitedDirectory, owner);
    }
    return owner;
  };

  const bucket = (
    input: Session[],
    target: Map<string, Session[]>,
    scopeTarget?: Map<string, Set<string>>,
  ): void => {
    for (const session of input) {
      const directory = resolveSessionDirectory(session);
      if (isGlobalSessionDirectory(directory)) {
        // Global/home sessions (cwd ~) appear in every folder.
        if (projects.length === 0) continue;
        // Pick first project's owner for bySessionId so detail pages still
        // resolve; the session is attached to every project's bucket.
        let firstOwner: DirectoryOwner | null = null;
        for (const project of projects) {
          const projectRoot = normalizePath(project.normalizedPath);
          if (!projectRoot) continue;
          const owner = ownerByDirectory.get(projectRoot);
          if (!owner) continue;
          if (!firstOwner) firstOwner = owner;
          const projectSessions = target.get(owner.projectId);
          if (projectSessions) {
            if (!projectSessions.some((entry) => entry.id === session.id)) {
              projectSessions.push(session);
            }
          } else {
            target.set(owner.projectId, [session]);
          }
          if (scopeTarget) {
            const scopeSessions = scopeTarget.get(owner.scopeDirectory);
            if (scopeSessions) {
              scopeSessions.add(session.id);
            } else {
              scopeTarget.set(owner.scopeDirectory, new Set([session.id]));
            }
          }
        }
        if (firstOwner) bySessionId.set(session.id, firstOwner);
        continue;
      }
      const owner = resolveOwner(directory);
      if (!owner) continue;
      bySessionId.set(session.id, owner);
      const projectSessions = target.get(owner.projectId);
      if (projectSessions) {
        projectSessions.push(session);
      } else {
        target.set(owner.projectId, [session]);
      }
      if (!scopeTarget) continue;
      const scopeSessions = scopeTarget.get(owner.scopeDirectory);
      if (scopeSessions) {
        scopeSessions.add(session.id);
      } else {
        scopeTarget.set(owner.scopeDirectory, new Set([session.id]));
      }
    }
  };

  bucket(sessions, sessionsByProject, sessionsByScope);
  bucket(archivedSessions, archivedSessionsByProject);

  return {
    bySessionId,
    sessionsByProject,
    archivedSessionsByProject,
    sessionsByScope,
    directoryResolutions: resolvedOwners.size,
  };
};
