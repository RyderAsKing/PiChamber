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
import type { Theme } from '@/types/theme';
import { getProjectDisplayLabel, type DraftTargetProject } from '../state/useDraftTarget';

export interface BranchOption {
    value: string;
    label: string;
    pending?: boolean;
}

export interface DraftTargetProps {
    projects: readonly DraftTargetProject[];
    selectedProject: DraftTargetProject;
    selectedDirectory: string | null;
    selectedBranchLabel: string | null;
    selectedBranchIsKnown: boolean;
    projectRootBranchOption: BranchOption | null;
    worktreeBranchOptions?: readonly BranchOption[];
    branchItems: readonly BranchOption[];
    showBranchSelector: boolean;
    showProjectSelector?: boolean;
    endAccessory?: React.ReactNode;
    onProjectChange: (projectId: string) => void;
    onDirectoryChange: (directory: string) => void;
    theme: Theme;
}

/** A project's icon plus its name. */
export function ProjectLabel({ project }: { project: DraftTargetProject; theme: Theme }) {
    return (
        <span className="inline-flex min-w-0 items-center gap-1.5">
            <Icon name="folder" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-muted-foreground">{getProjectDisplayLabel(project)}</span>
        </span>
    );
}

const draftSelectTriggerClassName =
    'h-7 min-w-0 w-fit max-w-[48vw] gap-1 border-transparent bg-transparent px-1.5 text-muted-foreground typography-micro font-normal hover:bg-transparent hover:text-foreground data-[popup-open]:bg-transparent [&_svg]:size-3.5 [&_svg]:opacity-70 sm:max-w-[20rem]';

/** Desktop inline selects for the project and (when git) its branch. */
export function DraftTargetSelectors(props: DraftTargetProps) {
    
    const {
        projects,
        selectedProject,
        selectedDirectory,
        selectedBranchLabel,
        selectedBranchIsKnown,
        projectRootBranchOption,
        showBranchSelector,
        showProjectSelector = true,
        endAccessory,
        onProjectChange,
        onDirectoryChange,
        theme,
    } = props;

    return (
        <div className="mb-3 flex min-w-0 w-full items-center justify-between gap-2 pl-2 pr-1">
            <div className="flex min-w-0 items-center gap-1">
            {showProjectSelector ? (
            <Select
                value={selectedProject.id}
                onValueChange={onProjectChange}
            >
                <SelectTrigger
                    size="sm"
                    className={draftSelectTriggerClassName}
                >
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

            {showBranchSelector ? (
                <Select
                    value={selectedDirectory ?? projectRootBranchOption?.value}
                    onValueChange={onDirectoryChange}
                >
                    <SelectTrigger
                        size="sm"
                        className={draftSelectTriggerClassName}
                    >
                        <SelectValue>
                            {selectedBranchLabel ?? "Branch"}
                        </SelectValue>
                    </SelectTrigger>
                    <SelectContent className="w-max min-w-48">
                        {projectRootBranchOption ? (
                            <SelectGroup>
                                <SelectLabel>{"Project root"}</SelectLabel>
                                <SelectItem key={projectRootBranchOption.value} value={projectRootBranchOption.value} className="max-w-[24rem] truncate">
                                    {projectRootBranchOption.label}
                                </SelectItem>
                            </SelectGroup>
                        ) : null}
                        {selectedDirectory && !selectedBranchIsKnown ? (
                            <SelectItem value={selectedDirectory} className="max-w-[24rem] truncate">
                                {selectedBranchLabel}
                            </SelectItem>
                        ) : null}
                    </SelectContent>
                </Select>
            ) : null}
            </div>
            {endAccessory ? (
                <div className="min-w-0 shrink-0">
                    {endAccessory}
                </div>
            ) : null}
        </div>
    );
}

/** Mobile: buttons that open the bottom sheets below. */
export function MobileDraftTargetTriggers(
    props: Pick<DraftTargetProps, 'selectedProject' | 'selectedBranchLabel' | 'showBranchSelector' | 'showProjectSelector' | 'endAccessory' | 'theme'>
        & { onOpenPicker: (picker: 'project' | 'branch') => void },
) {
    
    const { selectedProject, selectedBranchLabel, showBranchSelector, showProjectSelector = true, endAccessory, theme, onOpenPicker } = props;

    return (
        <div className="mb-1.5 flex min-w-0 w-full items-center justify-between gap-2 pl-2 pr-1">
            <div className="flex min-w-0 items-center gap-x-2">
            {showProjectSelector ? (
            <button
                type="button"
                className="inline-flex h-7 min-w-0 max-w-[42vw] flex-shrink cursor-pointer items-center gap-1 rounded-lg px-1.5 typography-micro font-medium text-foreground/80 hover:bg-[var(--interactive-hover)]"
                onClick={() => onOpenPicker('project')}
            >
                {<ProjectLabel project={selectedProject} theme={theme} />}
                <Icon name="arrow-down-s" className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
            </button>
            ) : null}
            {showBranchSelector ? (
                <button
                    type="button"
                    className="inline-flex h-7 min-w-0 max-w-[42vw] flex-shrink cursor-pointer items-center gap-1 rounded-lg px-1.5 typography-micro font-medium text-foreground/80 hover:bg-[var(--interactive-hover)]"
                    onClick={() => onOpenPicker('branch')}
                >
                    <Icon name="git-branch" className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                    <span className="truncate">{selectedBranchLabel ?? "Branch"}</span>
                    <Icon name="arrow-down-s" className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                </button>
            ) : null}
            </div>
            {endAccessory ? (
                <div className="min-w-0 shrink-0">
                    {endAccessory}
                </div>
            ) : null}
        </div>
    );
}

/** Mobile bottom sheet pickers for project / branch selection. */
export function MobileDraftTargetSheets(
    props: DraftTargetProps & {
        openPicker: 'project' | 'branch' | null;
        onOpenPickerChange: (picker: 'project' | 'branch' | null) => void;
    },
) {
    
    const {
        projects,
        selectedProject,
        selectedDirectory,
        selectedBranchLabel,
        selectedBranchIsKnown,
        projectRootBranchOption,
        onProjectChange,
        onDirectoryChange,
        theme,
        openPicker,
        onOpenPickerChange,
        showProjectSelector = true,
        showBranchSelector,
    } = props;

    const [projectSearch, setProjectSearch] = React.useState('');
    const [branchSearch, setBranchSearch] = React.useState('');

    React.useEffect(() => {
        if (openPicker !== 'project') setProjectSearch('');
        if (openPicker !== 'branch') setBranchSearch('');
    }, [openPicker]);

    const filteredProjects = React.useMemo(() => {
        const query = projectSearch.trim().toLowerCase();
        if (!query) return projects;
        return projects.filter((project) =>
            getProjectDisplayLabel(project).toLowerCase().includes(query) ||
            project.path.toLowerCase().includes(query)
        );
    }, [projectSearch, projects]);

    return (
        <>
            <MobileOverlayPanel
                open={showProjectSelector && openPicker === 'project'}
                onClose={() => onOpenPickerChange(null)}
                title={"Project"}
            >
                <div className="flex flex-col py-1">
                    {projects.length > 5 ? (
                        <div className="px-3 pb-2 pt-1">
                            <Input
                                value={projectSearch}
                                onChange={(e) => setProjectSearch(e.target.value)}
                                placeholder={"Search projects..."}
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
                                    {isSelected ? (
                                        <Icon name="check" className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                                    ) : null}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </MobileOverlayPanel>

            <MobileOverlayPanel
                open={showBranchSelector && openPicker === 'branch'}
                onClose={() => onOpenPickerChange(null)}
                title={"Branch"}
            >
                <div className="flex flex-col py-1">
                    <div className="max-h-[60vh] overflow-y-auto px-2">
                        {(() => {
                            const selectedValue = selectedDirectory ?? projectRootBranchOption?.value ?? null;
                            const query = branchSearch.trim().toLowerCase();
                            const matches = (label: string) => !query || label.toLowerCase().includes(query);
                            const renderRow = (value: string, label: string, key?: string) => (
                                <button
                                    key={key ?? value}
                                    type="button"
                                    onClick={() => {
                                        onDirectoryChange(value);
                                        onOpenPickerChange(null);
                                    }}
                                    className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2 text-left typography-ui-label transition-colors hover:bg-[var(--interactive-hover)] ${
                                        value === selectedValue ? 'bg-[var(--interactive-hover)] font-medium text-foreground' : 'text-foreground/80'
                                    }`}
                                >
                                    <span className="truncate">{label}</span>
                                    {value === selectedValue ? (
                                        <Icon name="check" className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                                    ) : null}
                                </button>
                            );
                            return (
                                <>
                                    {projectRootBranchOption && matches(projectRootBranchOption.label) ? (
                                        <>
                                            <div className="px-2 pb-1 pt-1.5 text-muted-foreground typography-meta">
                                                {"Project root"}
                                            </div>
                                            {renderRow(projectRootBranchOption.value, projectRootBranchOption.label)}
                                        </>
                                    ) : null}
                                    {selectedDirectory && !selectedBranchIsKnown && matches(selectedBranchLabel ?? '')
                                        ? renderRow(selectedDirectory, selectedBranchLabel ?? selectedDirectory, 'unknown-current')
                                        : null}
                                </>
                            );
                        })()}
                    </div>
                </div>
            </MobileOverlayPanel>
        </>
    );
}

