import React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { ProjectEntry } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { formatDirectoryName } from '@/lib/utils';
import { useGitBranches, useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { buildAvailableWorktreesByProject, useWorktreeStore } from '@/stores/useWorktreeStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { normalizePath } from '../attachments/filePaths';

const GLOBAL_PROJECT_ID = '__home__';
const GLOBAL_PROJECT_LABEL = "Don't work in a repository";

const getGlobalProjectPath = (homeDirectory: string | null | undefined): string | null => {
  const normalized = normalizePath(homeDirectory ?? null);
  if (normalized) return normalized;
  // Fallback sentinel that DirectoryStore expands to the real home.
  return '~';
};

import { buildLocalDraftBranchOptions, shouldRefreshDraftBranchesOnDraftEntry } from './draftTargetBranches';

export interface DraftTargetProject {
    id: string;
    ownerProjectId: string;
    kind: 'project' | 'worktree';
    path: string;
    branch?: string | null;
    label?: string;
    icon?: string | null;
    color?: string | null;
    iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
    iconBackground?: string | null;
}

/** A project's display name, falling back to its directory name. */
export function getProjectDisplayLabel(project: { label?: string; path: string }): string {
    return project.label?.trim() || formatDirectoryName(project.path);
}

export function useDraftTarget(enabled: boolean) {
    const registeredProjects = useProjectsStore((state) => state.projects);
    const worktreeProjects = useWorktreeStore((state) => state.projects);
    const availableWorktreesByProject = React.useMemo(
        () => buildAvailableWorktreesByProject(registeredProjects, { projects: worktreeProjects }),
        [registeredProjects, worktreeProjects],
    );
    const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
    const projects = React.useMemo<DraftTargetProject[]>(() => {
        const base = registeredProjects.flatMap((project) => {
            const root: DraftTargetProject = {
                ...project,
                id: project.id,
                ownerProjectId: project.id,
                kind: 'project',
            };
            const worktrees = availableWorktreesByProject.get(normalizePath(project.path) ?? project.path) ?? [];
            return [
                root,
                ...worktrees.map((worktree): DraftTargetProject => ({
                    id: `worktree:${project.id}:${worktree.path}`,
                    ownerProjectId: project.id,
                    kind: 'worktree',
                    path: worktree.path,
                    branch: worktree.branch,
                    label: worktree.branch || (worktree.detached ? 'Detached HEAD' : worktree.name),
                })),
            ];
        });
        const globalPath = getGlobalProjectPath(homeDirectory);
        if (!globalPath) return base;
        // Avoid duplicating if a project already points at the home directory.
        const already = base.some((entry) => normalizePath(entry.path) === normalizePath(globalPath));
        if (already) return base;
        const globalEntry: DraftTargetProject = {
            id: GLOBAL_PROJECT_ID,
            ownerProjectId: GLOBAL_PROJECT_ID,
            kind: 'project',
            path: globalPath,
            label: GLOBAL_PROJECT_LABEL,
        };
        return [globalEntry, ...base];
    }, [availableWorktreesByProject, registeredProjects, homeDirectory]);
    const activeProjectId = useProjectsStore((state) => state.activeProjectId);
    const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const currentSessionDirectory = useSessionUIStore((s) => s.currentSessionDirectory);
    const setNewSessionDraftTarget = useSessionUIStore((s) => s.setNewSessionDraftTarget);
    const isDraftOpen = Boolean(newSessionDraft?.open);
    const fetchBranches = useGitStore((state) => state.fetchBranches);
    const { git: runtimeGit } = useRuntimeAPIs();

    const selectedDraftProject = React.useMemo(() => {
        if (isDraftOpen) {
            const explicitDirectory = normalizePath(newSessionDraft?.directoryOverride ?? null);
            const explicit = newSessionDraft?.selectedProjectId
                ? projects.find((project) => (
                    project.ownerProjectId === newSessionDraft.selectedProjectId
                    && (!explicitDirectory || normalizePath(project.path) === explicitDirectory)
                )) ?? projects.find((project) => project.id === newSessionDraft.selectedProjectId) ?? null
                : null;
            if (explicit) return explicit;
            // Global draft without an explicit project id (e.g. "~" from persistence):
            // resolve by directory alone so the label does not flicker.
            if (explicitDirectory) {
                const byDir = projects.find((project) => normalizePath(project.path) === explicitDirectory) ?? null;
                if (byDir) return byDir;
            }
        } else if (currentSessionId) {
            const sessionDirectory = normalizePath(currentSessionDirectory ?? null);
            const globalPath = getGlobalProjectPath(homeDirectory);
            if (globalPath && sessionDirectory && normalizePath(globalPath) === sessionDirectory) {
                const global = projects.find((project) => project.ownerProjectId === GLOBAL_PROJECT_ID) ?? null;
                if (global) return global;
            }
            const fromSession = resolveProjectForSessionDirectory(
                registeredProjects as ProjectEntry[],
                availableWorktreesByProject,
                currentSessionDirectory,
            );
            if (fromSession) {
                const sessionDirectory = normalizePath(currentSessionDirectory ?? null);
                return projects.find((project) => (
                    project.ownerProjectId === fromSession.id
                    && normalizePath(project.path) === sessionDirectory
                )) ?? projects.find((project) => project.id === fromSession.id) ?? null;
            }
        }

        const active = activeProjectId
            ? projects.find((project) => project.id === activeProjectId) ?? null
            : null;
        return active ?? projects[0] ?? null;
    }, [
        activeProjectId,
        availableWorktreesByProject,
        currentSessionDirectory,
        currentSessionId,
        homeDirectory,
        isDraftOpen,
        newSessionDraft?.directoryOverride,
        newSessionDraft?.selectedProjectId,
        projects,
        registeredProjects,
    ]);

    const selectedDraftProjectPath = React.useMemo(
        () => normalizePath(selectedDraftProject?.path ?? null),
        [selectedDraftProject?.path],
    );
    const selectedDraftDirectory = React.useMemo(() => {
        if (isDraftOpen) {
            return normalizePath(newSessionDraft?.directoryOverride ?? null) ?? selectedDraftProjectPath;
        }
        return normalizePath(currentSessionDirectory ?? null) ?? selectedDraftProjectPath;
    }, [currentSessionDirectory, isDraftOpen, newSessionDraft?.directoryOverride, selectedDraftProjectPath]);
    const selectedOwnerProject = selectedDraftProject
        ? registeredProjects.find((project) => project.id === selectedDraftProject.ownerProjectId) ?? null
        : null;
    const selectedDraftProjectRoot = normalizePath(selectedOwnerProject?.path ?? null);
    const draftProjectLabel = selectedDraftProject ? getProjectDisplayLabel(selectedDraftProject) : null;

    React.useEffect(() => {
        if (!enabled || !isDraftOpen || !activeProjectId) return;
        if (newSessionDraft?.selectedProjectId === activeProjectId) return;
        const project = projects.find((entry) => entry.id === activeProjectId);
        if (!project) return;
        setNewSessionDraftTarget({
            projectId: project.id,
            directoryOverride: project.path,
            branchIntent: null,
            worktreeIntent: null,
        });
    }, [activeProjectId, enabled, isDraftOpen, newSessionDraft?.selectedProjectId, projects, setNewSessionDraftTarget]);

    const selectedDirectoryIsGitRepo = useIsGitRepo(selectedDraftDirectory);
    const selectedDirectoryStatusBranch = useGitStore((state) => (
        selectedDraftDirectory
            ? state.directories.get(selectedDraftDirectory)?.status?.current?.trim() || null
            : null
    ));
    const selectedDirectoryBranches = useGitBranches(isDraftOpen ? selectedDraftDirectory : null);
    const [isDiscoveringDraftBranches, setIsDiscoveringDraftBranches] = React.useState(false);

    React.useEffect(() => {
        const cachedBranches = selectedDraftDirectory
            ? useGitStore.getState().directories.get(selectedDraftDirectory)?.branches ?? null
            : null;
        if (!shouldRefreshDraftBranchesOnDraftEntry({
            enabled,
            draftOpen: isDraftOpen,
            directory: selectedDraftDirectory,
            gitAvailable: Boolean(runtimeGit),
            isGitRepository: selectedDirectoryIsGitRepo === true,
            hasCachedBranches: cachedBranches !== null,
        })) {
            setIsDiscoveringDraftBranches(false);
            return;
        }
        if (!selectedDraftDirectory || !runtimeGit) return;

        let cancelled = false;
        // Cached branches paint immediately, but every draft entry revalidates
        // them because agents and terminals can create refs outside this store.
        setIsDiscoveringDraftBranches(cachedBranches === null);
        void fetchBranches(selectedDraftDirectory, runtimeGit).finally(() => {
            if (!cancelled) setIsDiscoveringDraftBranches(false);
        });
        return () => { cancelled = true; };
    }, [
        enabled,
        fetchBranches,
        isDraftOpen,
        runtimeGit,
        selectedDirectoryIsGitRepo,
        selectedDraftDirectory,
    ]);

    const currentBranch = selectedDirectoryBranches?.current?.trim() || selectedDirectoryStatusBranch;
    const explicitBranch = isDraftOpen
        ? newSessionDraft?.worktreeIntent?.startRef?.trim() || newSessionDraft?.branchIntent?.branch?.trim() || null
        : null;
    const selectedBranchName = explicitBranch ?? currentBranch;

    const draftBranchItems = React.useMemo(
        () => isDraftOpen
            ? buildLocalDraftBranchOptions(selectedDirectoryBranches?.all, explicitBranch)
            : [],
        [explicitBranch, isDraftOpen, selectedDirectoryBranches?.all],
    );

    const selectedDraftBranchLabel = selectedBranchName ?? (selectedDirectoryIsGitRepo === true ? 'Detached HEAD' : null);
    const shouldShowDraftBranchSelector = selectedDirectoryIsGitRepo === true
        && Boolean(selectedDraftBranchLabel || draftBranchItems.length > 0 || isDiscoveringDraftBranches);

    const handleDraftProjectChange = React.useCallback((projectId: string) => {
        if (!isDraftOpen) return;
        const project = projects.find((entry) => entry.id === projectId);
        const nextDirectory = normalizePath(project?.path ?? null);
        if (!project || !nextDirectory) return;
        if (project.ownerProjectId === GLOBAL_PROJECT_ID) {
            // Global sessions live at ~ and must not change the active project.
            setNewSessionDraftTarget({
                projectId: GLOBAL_PROJECT_ID,
                directoryOverride: nextDirectory,
                branchIntent: null,
                worktreeIntent: null,
            });
            return;
        }
        if (activeProjectId !== project.ownerProjectId) setActiveProjectIdOnly(project.ownerProjectId);
        setNewSessionDraftTarget({
            projectId: project.ownerProjectId,
            directoryOverride: nextDirectory,
            branchIntent: null,
            worktreeIntent: null,
        });
    }, [activeProjectId, isDraftOpen, projects, setActiveProjectIdOnly, setNewSessionDraftTarget]);

    const handleDraftBranchChange = React.useCallback((branch: string) => {
        if (!isDraftOpen || !selectedDraftDirectory) return;
        const nextBranch = branch.trim();
        if (!nextBranch || nextBranch.startsWith('remotes/')) return;
        if (newSessionDraft?.worktreeIntent && selectedDraftProjectRoot) {
            setNewSessionDraftTarget({
                branchIntent: null,
                worktreeIntent: {
                    runtimeKey: getRuntimeKey(),
                    projectRoot: selectedDraftProjectRoot,
                    sourceDirectory: selectedDraftDirectory,
                    startRef: nextBranch,
                },
            });
            return;
        }
        setNewSessionDraftTarget({
            worktreeIntent: null,
            branchIntent: {
                runtimeKey: getRuntimeKey(),
                directory: selectedDraftDirectory,
                branch: nextBranch,
            },
        });
    }, [isDraftOpen, newSessionDraft?.worktreeIntent, selectedDraftDirectory, selectedDraftProjectRoot, setNewSessionDraftTarget]);

    const handleWorktreeModeChange = React.useCallback((enabled: boolean) => {
        if (!isDraftOpen || !selectedDraftDirectory || !selectedDraftProjectRoot || !selectedBranchName) return;
        if (enabled) {
            setNewSessionDraftTarget({
                branchIntent: null,
                worktreeIntent: {
                    runtimeKey: getRuntimeKey(),
                    projectRoot: selectedDraftProjectRoot,
                    sourceDirectory: selectedDraftDirectory,
                    startRef: selectedBranchName,
                },
            });
            return;
        }
        setNewSessionDraftTarget({
            worktreeIntent: null,
            branchIntent: selectedBranchName === currentBranch ? null : {
                runtimeKey: getRuntimeKey(),
                directory: selectedDraftDirectory,
                branch: selectedBranchName,
            },
        });
    }, [currentBranch, isDraftOpen, selectedBranchName, selectedDraftDirectory, selectedDraftProjectRoot, setNewSessionDraftTarget]);

    return {
        projects,
        selectedDraftProject,
        selectedDraftProjectPath,
        selectedDraftProjectRoot,
        draftProjectLabel,
        selectedDraftDirectory,
        selectedDraftBranchLabel,
        selectedBranchName,
        currentBranch,
        draftBranchItems,
        isDiscoveringDraftBranches,
        shouldShowDraftBranchSelector,
        worktreeMode: Boolean(isDraftOpen && newSessionDraft?.worktreeIntent),
        handleDraftProjectChange,
        handleDraftBranchChange,
        handleWorktreeModeChange,
    };
}
