import React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { ProjectEntry } from '@/lib/api/types';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { formatDirectoryName } from '@/lib/utils';
import { useGitBranches, useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { normalizePath } from '../attachments/filePaths';

/** How long a cached branch list is served before it is refreshed. */
const BRANCHES_SWR_TTL_MS = 30_000;

export interface DraftTargetProject {
    id: string;
    path: string;
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
    const projects = useProjectsStore((state) => state.projects) as DraftTargetProject[];
    const activeProjectId = useProjectsStore((state) => state.activeProjectId);
    const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const currentSessionDirectory = useSessionUIStore((s) => s.currentSessionDirectory);
    const setNewSessionDraftTarget = useSessionUIStore((s) => s.setNewSessionDraftTarget);
    const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
    const isDraftOpen = Boolean(newSessionDraft?.open);
    const fetchGitStatus = useGitStore((state) => state.fetchStatus);
    const { git: runtimeGit } = useRuntimeAPIs();

    const selectedDraftProject = React.useMemo(() => {
        if (isDraftOpen) {
            const explicit = newSessionDraft?.selectedProjectId
                ? projects.find((project) => project.id === newSessionDraft.selectedProjectId) ?? null
                : null;
            if (explicit) {
                return explicit;
            }
        } else if (currentSessionId) {
            const fromSession = resolveProjectForSessionDirectory(
                projects as ProjectEntry[],
                undefined,
                currentSessionDirectory,
            );
            if (fromSession) {
                return fromSession as DraftTargetProject;
            }
        }

        const active = activeProjectId
            ? projects.find((project) => project.id === activeProjectId) ?? null
            : null;
        if (active) {
            return active;
        }

        return projects[0] ?? null;
    }, [
        activeProjectId,
        currentSessionDirectory,
        currentSessionId,
        isDraftOpen,
        newSessionDraft?.selectedProjectId,
        projects,
    ]);

    const selectedDraftProjectPath = React.useMemo(
        () => normalizePath(selectedDraftProject?.path ?? null),
        [selectedDraftProject?.path],
    );
    const draftProjectLabel = selectedDraftProject ? getProjectDisplayLabel(selectedDraftProject) : null;

    React.useEffect(() => {
        if (!enabled || !isDraftOpen || !activeProjectId) {
            return;
        }
        if (newSessionDraft?.selectedProjectId === activeProjectId) {
            return;
        }
        const project = projects.find((entry) => entry.id === activeProjectId);
        if (!project) {
            return;
        }
        setNewSessionDraftTarget({
            projectId: project.id,
            directoryOverride: project.path,
        });
    }, [activeProjectId, enabled, isDraftOpen, newSessionDraft?.selectedProjectId, projects, setNewSessionDraftTarget]);

    const selectedDraftProjectBranches = useGitBranches(selectedDraftProjectPath);
    const selectedDraftProjectBranchesFetchedAt = useGitStore(
        (s) => (selectedDraftProjectPath ? s.directories.get(selectedDraftProjectPath)?.lastBranchesFetch ?? 0 : 0),
    );
    const selectedDraftProjectIsGitRepo = useIsGitRepo(selectedDraftProjectPath);
    const hasDraftBranchList = Boolean(selectedDraftProjectBranches?.all);
    const fetchBranches = useGitStore((state) => state.fetchBranches);
    const [isDiscoveringDraftBranches, setIsDiscoveringDraftBranches] = React.useState(false);

    React.useEffect(() => {
        if (!enabled || !selectedDraftProjectPath || !runtimeGit || selectedDraftProjectIsGitRepo !== null) {
            return;
        }

        void fetchGitStatus(selectedDraftProjectPath, runtimeGit, { silent: true });
    }, [fetchGitStatus, runtimeGit, selectedDraftProjectIsGitRepo, selectedDraftProjectPath, enabled]);

    React.useEffect(() => {
        if (!enabled || !selectedDraftProjectPath || !selectedDraftProject || !runtimeGit || selectedDraftProjectIsGitRepo !== true) {
            setIsDiscoveringDraftBranches(false);
            return;
        }

        const isStale =
            !selectedDraftProjectBranchesFetchedAt ||
            Date.now() - selectedDraftProjectBranchesFetchedAt > BRANCHES_SWR_TTL_MS;

        if (hasDraftBranchList && !isStale) {
            setIsDiscoveringDraftBranches(false);
            return;
        }

        let cancelled = false;
        setIsDiscoveringDraftBranches(!hasDraftBranchList);

        void fetchBranches(selectedDraftProjectPath, runtimeGit)
            .finally(() => {
                if (!cancelled) {
                    setIsDiscoveringDraftBranches(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [fetchBranches, runtimeGit, selectedDraftProject, selectedDraftProjectBranchesFetchedAt, hasDraftBranchList, selectedDraftProjectIsGitRepo, selectedDraftProjectPath, enabled]);

    const selectedDraftProjectCurrentBranch = selectedDraftProjectBranches?.current?.trim() ?? '';

    const projectRootBranchOption = React.useMemo(() => {
        if (!selectedDraftProject) {
            return null;
        }
        const value = normalizePath(selectedDraftProject.path);
        if (!value) {
            return null;
        }
        if (!selectedDraftProjectCurrentBranch) {
            return null;
        }
        return {
            value,
            label: selectedDraftProjectCurrentBranch,
        };
    }, [selectedDraftProject, selectedDraftProjectCurrentBranch]);

    const selectedDraftDirectory = React.useMemo(() => {
        if (isDraftOpen) {
            return normalizePath(newSessionDraft?.directoryOverride ?? null) ?? selectedDraftProjectPath;
        }
        return normalizePath(currentSessionDirectory ?? null) ?? selectedDraftProjectPath;
    }, [currentSessionDirectory, isDraftOpen, newSessionDraft?.directoryOverride, selectedDraftProjectPath]);

    const draftBranchItems = React.useMemo(() => {
        const baseItems: Array<{ value: string; label: string }> = [];
        if (projectRootBranchOption) {
            baseItems.push(projectRootBranchOption);
        }
        if (!selectedDraftDirectory) {
            return baseItems;
        }
        if (baseItems.some((option) => option.value === selectedDraftDirectory)) {
            return baseItems;
        }
        return [
            ...baseItems,
            { value: selectedDraftDirectory, label: formatDirectoryName(selectedDraftDirectory) },
        ];
    }, [projectRootBranchOption, selectedDraftDirectory]);

    const selectedDraftBranchLabel = React.useMemo(() => {
        const selectedValue = selectedDraftDirectory ?? draftBranchItems[0]?.value ?? null;
        if (!selectedValue) {
            return null;
        }
        return draftBranchItems.find((item) => item.value === selectedValue)?.label ?? formatDirectoryName(selectedValue);
    }, [draftBranchItems, selectedDraftDirectory]);

    const selectedDraftBranchIsKnown = React.useMemo(() => {
        if (!selectedDraftDirectory) {
            return true;
        }
        return projectRootBranchOption?.value === selectedDraftDirectory;
    }, [projectRootBranchOption?.value, selectedDraftDirectory]);

    const shouldShowDraftBranchSelector = React.useMemo(() => {
        if (selectedDraftProjectIsGitRepo !== true) {
            return false;
        }
        if (isDiscoveringDraftBranches) {
            return false;
        }
        return Boolean(projectRootBranchOption);
    }, [isDiscoveringDraftBranches, projectRootBranchOption, selectedDraftProjectIsGitRepo]);

    const applyComposerTarget = React.useCallback((projectId: string, directory: string) => {
        if (activeProjectId !== projectId) {
            setActiveProjectIdOnly(projectId);
        }
        if (isDraftOpen) {
            setNewSessionDraftTarget({
                projectId,
                directoryOverride: directory,
            }, { force: true });
            return;
        }
        openNewSessionDraft({
            selectedProjectId: projectId,
            directoryOverride: directory,
        });
    }, [activeProjectId, isDraftOpen, openNewSessionDraft, setActiveProjectIdOnly, setNewSessionDraftTarget]);

    const handleDraftProjectChange = React.useCallback((projectId: string) => {
        const project = projects.find((entry) => entry.id === projectId);
        if (!project) {
            return;
        }
        const nextDirectory = normalizePath(project.path);
        if (!nextDirectory) {
            return;
        }
        if (selectedDraftProject?.id === projectId && selectedDraftDirectory === nextDirectory) {
            return;
        }
        applyComposerTarget(projectId, nextDirectory);
    }, [applyComposerTarget, projects, selectedDraftDirectory, selectedDraftProject?.id]);

    const handleDraftDirectoryChange = React.useCallback((directory: string) => {
        if (!selectedDraftProject) {
            return;
        }
        const nextDirectory = normalizePath(directory);
        if (!nextDirectory || selectedDraftDirectory === nextDirectory) {
            return;
        }
        applyComposerTarget(selectedDraftProject.id, nextDirectory);
    }, [applyComposerTarget, selectedDraftDirectory, selectedDraftProject]);

    return {
        projects,
        selectedDraftProject,
        selectedDraftProjectPath,
        draftProjectLabel,
        selectedDraftDirectory,
        selectedDraftBranchLabel,
        selectedDraftBranchIsKnown,
        projectRootBranchOption,
        worktreeBranchOptions: [] as Array<{ value: string; label: string; kind: 'worktree'; pending?: boolean }>,
        draftBranchItems,
        shouldShowDraftBranchSelector,
        handleDraftProjectChange,
        handleDraftDirectoryChange,
    };
}
