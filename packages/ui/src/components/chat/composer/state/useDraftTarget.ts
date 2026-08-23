import React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { ProjectEntry } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { formatDirectoryName } from '@/lib/utils';
import { useGitBranches, useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { normalizePath } from '../attachments/filePaths';
import { buildLocalDraftBranchOptions, shouldRefreshDraftBranchesOnDraftEntry } from './draftTargetBranches';

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
    const isDraftOpen = Boolean(newSessionDraft?.open);
    const fetchBranches = useGitStore((state) => state.fetchBranches);
    const { git: runtimeGit } = useRuntimeAPIs();

    const selectedDraftProject = React.useMemo(() => {
        if (isDraftOpen) {
            const explicit = newSessionDraft?.selectedProjectId
                ? projects.find((project) => project.id === newSessionDraft.selectedProjectId) ?? null
                : null;
            if (explicit) return explicit;
        } else if (currentSessionId) {
            const fromSession = resolveProjectForSessionDirectory(
                projects as ProjectEntry[],
                undefined,
                currentSessionDirectory,
            );
            if (fromSession) return fromSession as DraftTargetProject;
        }

        const active = activeProjectId
            ? projects.find((project) => project.id === activeProjectId) ?? null
            : null;
        return active ?? projects[0] ?? null;
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
    const selectedDraftDirectory = React.useMemo(() => {
        if (isDraftOpen) {
            return normalizePath(newSessionDraft?.directoryOverride ?? null) ?? selectedDraftProjectPath;
        }
        return normalizePath(currentSessionDirectory ?? null) ?? selectedDraftProjectPath;
    }, [currentSessionDirectory, isDraftOpen, newSessionDraft?.directoryOverride, selectedDraftProjectPath]);
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
    const explicitBranch = isDraftOpen ? newSessionDraft?.branchIntent?.branch?.trim() || null : null;
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
        if (activeProjectId !== projectId) setActiveProjectIdOnly(projectId);
        setNewSessionDraftTarget({
            projectId,
            directoryOverride: nextDirectory,
            branchIntent: null,
        });
    }, [activeProjectId, isDraftOpen, projects, setActiveProjectIdOnly, setNewSessionDraftTarget]);

    const handleDraftBranchChange = React.useCallback((branch: string) => {
        if (!isDraftOpen || !selectedDraftDirectory) return;
        const nextBranch = branch.trim();
        if (!nextBranch || nextBranch.startsWith('remotes/')) return;
        setNewSessionDraftTarget({
            branchIntent: {
                runtimeKey: getRuntimeKey(),
                directory: selectedDraftDirectory,
                branch: nextBranch,
            },
        });
    }, [isDraftOpen, selectedDraftDirectory, setNewSessionDraftTarget]);

    return {
        projects,
        selectedDraftProject,
        selectedDraftProjectPath,
        draftProjectLabel,
        selectedDraftDirectory,
        selectedDraftBranchLabel,
        selectedBranchName,
        currentBranch,
        draftBranchItems,
        isDiscoveringDraftBranches,
        shouldShowDraftBranchSelector,
        handleDraftProjectChange,
        handleDraftBranchChange,
    };
}
