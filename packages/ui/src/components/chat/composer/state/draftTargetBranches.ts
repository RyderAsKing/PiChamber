type DraftBranchOption = { value: string; label: string };

export const shouldRefreshDraftBranchesOnDraftEntry = (input: {
    enabled: boolean;
    draftOpen: boolean;
    directory: string | null;
    gitAvailable: boolean;
    isGitRepository: boolean;
    hasCachedBranches: boolean;
}): boolean => input.enabled
    && input.draftOpen
    && Boolean(input.directory)
    && input.gitAvailable
    && input.isGitRepository;

export const buildLocalDraftBranchOptions = (
    allBranches: readonly string[] | null | undefined,
    selectedBranch: string | null,
): DraftBranchOption[] => {
    const options = (allBranches ?? [])
        .filter((branch) => branch.length > 0 && !branch.startsWith('remotes/'))
        .sort((left, right) => left.localeCompare(right))
        .map((branch) => ({ value: branch, label: branch }));

    if (selectedBranch && !options.some((option) => option.value === selectedBranch)) {
        options.push({ value: selectedBranch, label: selectedBranch });
    }
    return options;
};
