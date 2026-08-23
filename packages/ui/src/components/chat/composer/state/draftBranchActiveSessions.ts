import { normalizePath } from '@/lib/pathNormalization';

export type DraftBranchActiveSession = {
    id: string;
    title: string | null;
    directory: string;
};

type ProjectTarget = {
    id: string;
    path: string;
};

type WorktreeTarget = {
    path?: string | null;
};

export const buildDraftBranchProjectDirectories = (input: {
    targetDirectory: string;
    projectId?: string | null;
    projects: readonly ProjectTarget[];
    availableWorktreesByProject: ReadonlyMap<string, readonly (WorktreeTarget | null | undefined)[]>;
}): Set<string> => {
    const targetDirectory = normalizePath(input.targetDirectory) ?? input.targetDirectory;
    const selectedProject = input.projectId
        ? input.projects.find((project) => project.id === input.projectId) ?? null
        : null;
    const owningProject = selectedProject ?? input.projects.reduce<ProjectTarget | null>((best, project) => {
        const projectPath = normalizePath(project.path);
        if (!projectPath || (targetDirectory !== projectPath && !targetDirectory.startsWith(`${projectPath}/`))) {
            return best;
        }
        const bestPath = normalizePath(best?.path ?? null);
        return !bestPath || projectPath.length > bestPath.length ? project : best;
    }, null);
    const projectPath = normalizePath(owningProject?.path ?? null);
    const directories = new Set<string>([targetDirectory]);
    if (!projectPath) return directories;

    directories.add(projectPath);
    for (const [worktreeProjectPath, worktrees] of input.availableWorktreesByProject) {
        if (normalizePath(worktreeProjectPath) !== projectPath) continue;
        for (const worktree of worktrees ?? []) {
            const worktreePath = normalizePath(worktree?.path ?? null);
            if (worktreePath) directories.add(worktreePath);
        }
    }
    return directories;
};

export const hasNewActiveSessions = (
    reviewed: readonly DraftBranchActiveSession[],
    latest: readonly DraftBranchActiveSession[],
): boolean => {
    const reviewedIds = new Set(reviewed.map((session) => session.id));
    return latest.some((session) => !reviewedIds.has(session.id));
};
