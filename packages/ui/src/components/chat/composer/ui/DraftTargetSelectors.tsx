import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { toast } from '@/components/ui';
import { useTransientValue } from '@/hooks/useTransientValue';
import { copyTextToClipboard } from '@/lib/clipboard';
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Theme } from '@/types/theme';
import { getProjectDisplayLabel, type DraftTargetProject } from '../state/useDraftTarget';

const FOLDER_LABEL_MAX_LENGTH = 20;
const BRANCH_LABEL_MAX_LENGTH = 24;

const truncateWithEllipsis = (value: string, maxLength: number): string => {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength - 1)}…`;
};

interface BranchOption {
    value: string;
    label: string;
}

export interface DraftTargetProps {
    projects: readonly DraftTargetProject[];
    selectedProject: DraftTargetProject;
    selectedBranchName: string | null;
    selectedBranchLabel: string | null;
    branchOptions: readonly BranchOption[];
    branchInteractive: boolean;
    branchLoading?: boolean;
    showBranchSelector: boolean;
    showProjectSelector?: boolean;
    showWorktreeSelector?: boolean;
    worktreeMode?: boolean;
    endAccessory?: React.ReactNode;
    onProjectChange: (projectId: string) => void;
    onBranchChange: (branch: string) => void;
    onWorktreeModeChange?: (enabled: boolean) => void;
    theme: Theme;
}

/** A project's icon plus its name. */
export function ProjectLabel({
    project,
    maxCharacters,
}: {
    project: DraftTargetProject;
    theme: Theme;
    maxCharacters?: number;
}) {
    const rawLabel = getProjectDisplayLabel(project);
    const label = maxCharacters ? truncateWithEllipsis(rawLabel, maxCharacters) : rawLabel;
    const isGlobal = project.id === '__home__' || project.ownerProjectId === '__home__';
    return (
        <span className="inline-flex min-w-0 items-center gap-1.5" title={rawLabel}>
            <Icon name={project.kind === 'worktree' ? 'git-branch' : isGlobal ? 'home' : 'folder'} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-muted-foreground">{label}</span>
        </span>
    );
}

const draftSelectTriggerClassName =
    'h-7 min-w-0 w-fit max-w-[48vw] gap-1 border-transparent bg-transparent px-1.5 text-muted-foreground typography-micro font-normal hover:bg-transparent hover:text-foreground data-[popup-open]:bg-transparent [&_svg]:size-3.5 [&_svg]:opacity-70 sm:max-w-[20rem]';

const WorktreeModeToggle = ({
    checked,
    onChange,
    showCheck = true,
    chromeLess = false,
}: {
    checked: boolean;
    onChange?: (enabled: boolean) => void;
    showCheck?: boolean;
    chromeLess?: boolean;
}) => (
    <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
            <Button
                variant={chromeLess ? 'ghost' : 'chip'}
                size="xs"
                className={chromeLess
                    ? 'min-w-0 max-w-[48vw] shrink aria-pressed:bg-interactive-hover aria-pressed:text-foreground sm:max-w-none'
                    : 'min-w-0 max-w-[48vw] shrink sm:max-w-none'}
                aria-pressed={checked}
                onClick={() => onChange?.(!checked)}
            >
                <Icon name="git-branch" className="size-3.5" />
                <span className="truncate">New worktree</span>
                {checked && showCheck ? <Icon name="check" className="size-3.5" /> : null}
            </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} className="max-w-72">
            Starts from the selected branch's latest commit. Uncommitted changes are not copied.
        </TooltipContent>
    </Tooltip>
);

const BranchValue = ({ label, startFrom = false }: { label: string | null; startFrom?: boolean }) => {
    const displayLabel = label ? truncateWithEllipsis(label, BRANCH_LABEL_MAX_LENGTH) : 'Branch';
    return (
        <span className="inline-flex min-w-0 items-center gap-1.5" title={label ?? undefined}>
            <Icon name="git-branch" className="size-3.5 shrink-0 text-muted-foreground" />
            {startFrom && label ? <span className="shrink-0 text-muted-foreground/70">from</span> : null}
            <span className="truncate">{displayLabel}</span>
        </span>
    );
};

function BranchCopyButton({ branchName }: { branchName: string | null }) {
    const { value: copied, show } = useTransientValue(false, 2000);
    const handleCopy = React.useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        event.preventDefault();
        if (!branchName) return;
        const result = await copyTextToClipboard(branchName);
        if (result.ok) {
            show(true);
        } else {
            toast.error('Failed to copy');
        }
    }, [branchName, show]);
    if (!branchName) return null;
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label="Copy branch name"
                    onClick={(event) => { void handleCopy(event); }}
                >
                    {copied
                        ? <Icon name="check" className="size-3.5 text-[color:var(--status-success)]" />
                        : <Icon name="file-copy" className="size-3.5" />}
                </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{copied ? 'Copied' : 'Copy branch name'}</TooltipContent>
        </Tooltip>
    );
}

/** Desktop project selector and branch target. Existing sessions render a read-only branch label. */
export function DraftTargetSelectors(props: DraftTargetProps) {
    const {
        projects,
        selectedProject,
        selectedBranchName,
        selectedBranchLabel,
        branchOptions,
        branchInteractive,
        branchLoading,
        showBranchSelector,
        showProjectSelector = true,
        showWorktreeSelector = false,
        worktreeMode = false,
        endAccessory,
        onProjectChange,
        onBranchChange,
        onWorktreeModeChange,
        theme,
    } = props;

    return (
        <div className="mb-3 flex min-w-0 w-full items-center justify-between gap-2 pl-2 pr-1">
            <div className="flex min-w-0 items-center gap-1">
                {showProjectSelector ? (
                    <Select value={selectedProject.id} onValueChange={onProjectChange}>
                        <SelectTrigger size="sm" className={draftSelectTriggerClassName}>
                            <SelectValue>
                                <ProjectLabel project={selectedProject} theme={theme} maxCharacters={FOLDER_LABEL_MAX_LENGTH} />
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent className="w-max min-w-48">
                            {projects.map((project) => (
                                <SelectItem
                                    key={project.id}
                                    value={project.id}
                                    className={project.kind === 'worktree' ? 'max-w-[24rem] truncate pl-7' : 'max-w-[24rem] truncate'}
                                >
                                    <ProjectLabel project={project} theme={theme} />
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                ) : null}

                {showBranchSelector && branchInteractive ? (
                    <Select
                        value={selectedBranchName ?? undefined}
                        onValueChange={onBranchChange}
                        disabled={Boolean(branchLoading && branchOptions.length === 0)}
                    >
                        <SelectTrigger size="sm" className={draftSelectTriggerClassName}>
                            <SelectValue>
                                <BranchValue label={selectedBranchLabel} startFrom={worktreeMode} />
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent className="w-max min-w-56">
                            <SelectGroup>
                                <SelectLabel>{branchLoading ? 'Loading branches...' : 'Local branches'}</SelectLabel>
                                {branchOptions.map((branch) => (
                                    <SelectItem key={branch.value} value={branch.value} className="max-w-[28rem] truncate">
                                        {branch.label}
                                    </SelectItem>
                                ))}
                            </SelectGroup>
                        </SelectContent>
                    </Select>
                ) : showBranchSelector ? (
                    <div className="inline-flex h-7 min-w-0 max-w-[20rem] items-center gap-0.5 px-1.5 typography-micro text-muted-foreground">
                        <BranchValue label={selectedBranchLabel} startFrom={worktreeMode} />
                        <BranchCopyButton branchName={selectedBranchName} />
                    </div>
                ) : null}

                {showWorktreeSelector ? (
                    <WorktreeModeToggle checked={worktreeMode} onChange={onWorktreeModeChange} />
                ) : null}
            </div>
            {endAccessory ? <div className="min-w-0 shrink-0">{endAccessory}</div> : null}
        </div>
    );
}

/** Mobile project and branch labels. Only draft branches open a picker. */
export function MobileDraftTargetTriggers(
    props: Pick<
        DraftTargetProps,
        'selectedProject' | 'selectedBranchName' | 'selectedBranchLabel' | 'branchInteractive' | 'showBranchSelector' | 'showProjectSelector' | 'showWorktreeSelector' | 'worktreeMode' | 'onWorktreeModeChange' | 'endAccessory' | 'theme'
    > & { onOpenPicker: (picker: 'project' | 'branch') => void },
) {
    const {
        selectedProject,
        selectedBranchName,
        selectedBranchLabel,
        branchInteractive,
        showBranchSelector,
        showProjectSelector = true,
        showWorktreeSelector = false,
        worktreeMode = false,
        onWorktreeModeChange,
        endAccessory,
        theme,
        onOpenPicker,
    } = props;
    const displayBranchLabel = selectedBranchLabel
        ? truncateWithEllipsis(selectedBranchLabel, BRANCH_LABEL_MAX_LENGTH)
        : null;

    return (
        <div className="mb-1.5 flex min-w-0 w-full flex-col gap-0.5 pl-2 pr-1">
            {showWorktreeSelector ? (
                <div className="flex w-full justify-end">
                    <WorktreeModeToggle
                        checked={worktreeMode}
                        onChange={onWorktreeModeChange}
                        showCheck={false}
                        chromeLess
                    />
                </div>
            ) : null}
            <div className="flex min-w-0 w-full items-center gap-x-1">
                {showProjectSelector ? (
                    <button
                        type="button"
                        className="inline-flex h-7 min-w-0 max-w-[44%] shrink cursor-pointer items-center gap-1 rounded-lg px-1.5 typography-micro font-medium text-foreground/80 hover:bg-[var(--interactive-hover)]"
                        onClick={() => onOpenPicker('project')}
                    >
                        <ProjectLabel project={selectedProject} theme={theme} maxCharacters={FOLDER_LABEL_MAX_LENGTH} />
                        <Icon name="arrow-down-s" className="h-3 w-3 shrink-0 text-muted-foreground" />
                    </button>
                ) : null}
                {showBranchSelector && branchInteractive ? (
                    <button
                        type="button"
                        className={`inline-flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-lg px-1.5 typography-micro font-medium text-foreground/80 hover:bg-[var(--interactive-hover)] ${showProjectSelector ? 'ml-auto max-w-[54%] shrink' : 'flex-1'}`}
                        onClick={() => onOpenPicker('branch')}
                        title={selectedBranchLabel ?? undefined}
                    >
                        <Icon name="git-branch" className="h-3 w-3 shrink-0 text-muted-foreground" />
                        {worktreeMode && displayBranchLabel ? <span className="shrink-0 text-muted-foreground/70">from</span> : null}
                        <span className="truncate">{displayBranchLabel ?? 'Branch'}</span>
                        <Icon name="arrow-down-s" className="h-3 w-3 shrink-0 text-muted-foreground" />
                    </button>
                ) : showBranchSelector ? (
                    <div
                        className={`inline-flex h-7 min-w-0 items-center gap-1 px-1.5 typography-micro text-muted-foreground ${showProjectSelector ? 'ml-auto max-w-[54%] shrink' : 'flex-1'}`}
                        title={selectedBranchLabel ?? undefined}
                    >
                        <Icon name="git-branch" className="h-3 w-3 shrink-0" />
                        {worktreeMode && displayBranchLabel ? <span className="shrink-0 text-muted-foreground/70">from</span> : null}
                        <span className="truncate">{displayBranchLabel ?? 'Branch'}</span>
                        <BranchCopyButton branchName={selectedBranchName} />
                    </div>
                ) : null}
            </div>
            {!showProjectSelector && endAccessory ? (
                <div className="flex w-full justify-end px-1.5">{endAccessory}</div>
            ) : null}
        </div>
    );
}

/** Mobile bottom sheets for the interactive new-session project and branch targets. */
export function MobileDraftTargetSheets(
    props: DraftTargetProps & {
        openPicker: 'project' | 'branch' | null;
        onOpenPickerChange: (picker: 'project' | 'branch' | null) => void;
        query?: string;
        onQueryChange?: (query: string) => void;
    },
) {
    const {
        projects,
        selectedProject,
        selectedBranchName,
        branchOptions,
        branchInteractive,
        onProjectChange,
        onBranchChange,
        theme,
        openPicker,
        onOpenPickerChange,
        showProjectSelector = true,
        showBranchSelector,
        query = '',
        onQueryChange,
    } = props;
    const [projectSearch, setProjectSearch] = React.useState('');

    React.useEffect(() => {
        if (openPicker !== 'project') setProjectSearch('');
        if (openPicker !== 'branch') onQueryChange?.('');
    }, [onQueryChange, openPicker]);

    const filteredProjects = React.useMemo(() => {
        const normalizedQuery = projectSearch.trim().toLowerCase();
        if (!normalizedQuery) return projects;
        return projects.filter((project) =>
            getProjectDisplayLabel(project).toLowerCase().includes(normalizedQuery)
            || project.path.toLowerCase().includes(normalizedQuery),
        );
    }, [projectSearch, projects]);
    const filteredBranches = React.useMemo(() => {
        const normalizedQuery = query.trim().toLowerCase();
        if (!normalizedQuery) return branchOptions;
        return branchOptions.filter((branch) => branch.label.toLowerCase().includes(normalizedQuery));
    }, [branchOptions, query]);

    return (
        <>
            <MobileOverlayPanel
                open={showProjectSelector && openPicker === 'project'}
                onClose={() => onOpenPickerChange(null)}
                title="Project"
            >
                <div className="flex flex-col py-1">
                    {projects.length > 5 ? (
                        <div className="px-3 pb-2 pt-1">
                            <Input
                                value={projectSearch}
                                onChange={(event) => setProjectSearch(event.target.value)}
                                placeholder="Search projects..."
                                className="h-8 typography-meta"
                                autoFocus
                            />
                        </div>
                    ) : null}
                    <div className="max-h-[60vh] overflow-y-auto px-2">
                        {filteredProjects.map((project) => {
                            const isSelected = project.id === selectedProject.id;
                            return (
                                <button
                                    key={project.id}
                                    type="button"
                                    onClick={() => {
                                        onProjectChange(project.id);
                                        onOpenPickerChange(null);
                                    }}
                                    className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2 text-left typography-ui-label transition-colors hover:bg-[var(--interactive-hover)] ${project.kind === 'worktree' ? 'pl-7 ' : ''}${
                                        isSelected ? 'bg-[var(--interactive-hover)] font-medium text-foreground' : 'text-foreground/80'
                                    }`}
                                >
                                    <ProjectLabel project={project} theme={theme} />
                                    {isSelected ? <Icon name="check" className="h-4 w-4 shrink-0 text-muted-foreground" /> : null}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </MobileOverlayPanel>

            <MobileOverlayPanel
                open={branchInteractive && showBranchSelector && openPicker === 'branch'}
                onClose={() => onOpenPickerChange(null)}
                title="Branch"
            >
                <div className="flex flex-col py-1">
                    {branchOptions.length > 5 ? (
                        <div className="px-3 pb-2 pt-1">
                            <Input
                                value={query}
                                onChange={(event) => onQueryChange?.(event.target.value)}
                                placeholder="Search branches..."
                                className="h-8 typography-meta"
                                autoFocus
                            />
                        </div>
                    ) : null}
                    <div className="max-h-[60vh] overflow-y-auto px-2">
                        {filteredBranches.map((branch) => {
                            const isSelected = branch.value === selectedBranchName;
                            return (
                                <button
                                    key={branch.value}
                                    type="button"
                                    onClick={() => {
                                        onBranchChange(branch.value);
                                        onOpenPickerChange(null);
                                    }}
                                    className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2 text-left typography-ui-label transition-colors hover:bg-[var(--interactive-hover)] ${
                                        isSelected ? 'bg-[var(--interactive-hover)] font-medium text-foreground' : 'text-foreground/80'
                                    }`}
                                >
                                    <span className="truncate">{branch.label}</span>
                                    {isSelected ? <Icon name="check" className="h-4 w-4 shrink-0 text-muted-foreground" /> : null}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </MobileOverlayPanel>
        </>
    );
}
