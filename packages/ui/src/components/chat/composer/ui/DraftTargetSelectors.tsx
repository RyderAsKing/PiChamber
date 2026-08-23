import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { useTabletLayout } from '@/lib/device';
import { useUIStore } from '@/stores/useUIStore';
import type { Theme } from '@/types/theme';
import { getProjectDisplayLabel, type DraftTargetProject } from '../state/useDraftTarget';

const truncateWithEllipsis = (value: string, limit: number): string => {
    if (value.length <= limit) return value;
    return `${value.slice(0, limit)}...`;
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
    endAccessory?: React.ReactNode;
    onProjectChange: (projectId: string) => void;
    onBranchChange: (branch: string) => void;
    theme: Theme;
}

/** A project's icon plus its name. */
export function ProjectLabel({ project }: { project: DraftTargetProject; theme: Theme }) {
    const isMobileRaw = useUIStore((state) => state.isMobile);
    const { enabled: isTabletLayout } = useTabletLayout();
    const isMobile = isMobileRaw && !isTabletLayout;
    const rawLabel = getProjectDisplayLabel(project);
    const label = isMobile ? truncateWithEllipsis(rawLabel, 20) : rawLabel;
    return (
        <span className="inline-flex min-w-0 items-center gap-1.5">
            <Icon name="folder" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-muted-foreground">{label}</span>
        </span>
    );
}

const draftSelectTriggerClassName =
    'h-7 min-w-0 w-fit max-w-[48vw] gap-1 border-transparent bg-transparent px-1.5 text-muted-foreground typography-micro font-normal hover:bg-transparent hover:text-foreground data-[popup-open]:bg-transparent [&_svg]:size-3.5 [&_svg]:opacity-70 sm:max-w-[20rem]';

const BranchValue = ({ label }: { label: string | null }) => (
    <span className="inline-flex min-w-0 items-center gap-1.5">
        <Icon name="git-branch" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{label ?? 'Branch'}</span>
    </span>
);

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
        endAccessory,
        onProjectChange,
        onBranchChange,
        theme,
    } = props;

    return (
        <div className="mb-3 flex min-w-0 w-full items-center justify-between gap-2 pl-2 pr-1">
            <div className="flex min-w-0 items-center gap-1">
                {showProjectSelector ? (
                    <Select value={selectedProject.id} onValueChange={onProjectChange}>
                        <SelectTrigger size="sm" className={draftSelectTriggerClassName}>
                            <SelectValue>
                                <ProjectLabel project={selectedProject} theme={theme} />
                            </SelectValue>
                        </SelectTrigger>
                        <SelectContent className="w-max min-w-48">
                            {projects.map((project) => (
                                <SelectItem key={project.id} value={project.id} className="max-w-[24rem] truncate">
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
                                <BranchValue label={selectedBranchLabel} />
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
                    <div className="inline-flex h-7 min-w-0 max-w-[20rem] items-center px-1.5 typography-micro text-muted-foreground">
                        <BranchValue label={selectedBranchLabel} />
                    </div>
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
        'selectedProject' | 'selectedBranchLabel' | 'branchInteractive' | 'showBranchSelector' | 'showProjectSelector' | 'endAccessory' | 'theme'
    > & { onOpenPicker: (picker: 'project' | 'branch') => void },
) {
    const {
        selectedProject,
        selectedBranchLabel,
        branchInteractive,
        showBranchSelector,
        showProjectSelector = true,
        endAccessory,
        theme,
        onOpenPicker,
    } = props;
    const { enabled: isTabletForBranch } = useTabletLayout();
    const displayBranchLabel = selectedBranchLabel
        ? (isTabletForBranch ? selectedBranchLabel : truncateWithEllipsis(selectedBranchLabel, 26))
        : null;

    return (
        <div className="mb-1.5 flex min-w-0 w-full items-center justify-between gap-2 pl-2 pr-1">
            <div className="flex min-w-0 items-center gap-x-2">
                {showProjectSelector ? (
                    <button
                        type="button"
                        className="inline-flex h-7 min-w-0 max-w-[42vw] flex-shrink cursor-pointer items-center gap-1 rounded-lg px-1.5 typography-micro font-medium text-foreground/80 hover:bg-[var(--interactive-hover)]"
                        onClick={() => onOpenPicker('project')}
                    >
                        <ProjectLabel project={selectedProject} theme={theme} />
                        <Icon name="arrow-down-s" className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                    </button>
                ) : null}
                {showBranchSelector && branchInteractive ? (
                    <button
                        type="button"
                        className="inline-flex h-7 min-w-0 max-w-[48vw] flex-shrink cursor-pointer items-center gap-1 rounded-lg px-1.5 typography-micro font-medium text-foreground/80 hover:bg-[var(--interactive-hover)]"
                        onClick={() => onOpenPicker('branch')}
                    >
                        <Icon name="git-branch" className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                        <span className="truncate">{displayBranchLabel ?? 'Branch'}</span>
                        <Icon name="arrow-down-s" className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                    </button>
                ) : showBranchSelector ? (
                    <div className="inline-flex h-7 min-w-0 max-w-[48vw] items-center gap-1 px-1.5 typography-micro text-muted-foreground">
                        <Icon name="git-branch" className="h-3 w-3 shrink-0" />
                        <span className="truncate">{displayBranchLabel ?? 'Branch'}</span>
                    </div>
                ) : null}
            </div>
            {endAccessory ? <div className="min-w-0 shrink-0">{endAccessory}</div> : null}
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
                                    className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2 text-left typography-ui-label transition-colors hover:bg-[var(--interactive-hover)] ${
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
