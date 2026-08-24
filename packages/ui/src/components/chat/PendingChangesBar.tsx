import React from 'react';
import { useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useUIStore } from '@/stores/useUIStore';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useTabletLayout } from '@/lib/device';
import { Icon } from "@/components/icon/Icon";
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
    type ChangedFileEntry,
    type GitChangedFile,
    extractGitChangedFiles,
    isGitFile,
} from './changedFiles';
import { ChangedFilesList } from './ChangedFilesList';
import { changedFilesPopoverClassName, changedFilesPopoverStyle } from './changedFilesPopover';

export const PendingChangesBar: React.FC<{ align?: 'start' | 'end' }> = React.memo(({ align = 'start' }) => {
    
    const [isExpanded, setIsExpanded] = React.useState(false);
    const popoverRef = React.useRef<HTMLDivElement>(null);
    const currentDirectory = useEffectiveDirectory() ?? null;
    const runtime = React.useContext(RuntimeAPIContext);
    const isGitRepo = useIsGitRepo(currentDirectory);
    const gitStatus = useGitStore((s) =>
        currentDirectory ? s.directories.get(currentDirectory)?.status ?? null : null,
    );
    const mobileActions = useMobileAppActions();
    const isMobileRaw = useUIStore((state) => state.isMobile);
    const { enabled: isTabletLayout } = useTabletLayout();
    const isMobile = isMobileRaw && !isTabletLayout;

    // Close popover when clicking outside
    React.useEffect(() => {
        if (!isExpanded) return;

        const handleClickOutside = (event: MouseEvent) => {
            if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
                setIsExpanded(false);
            }
        };

        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [isExpanded]);

    const gitChangedFiles = React.useMemo<GitChangedFile[]>(() => {
        if (!currentDirectory || isGitRepo !== true || !gitStatus || gitStatus.isClean) return [];
        return extractGitChangedFiles(gitStatus.files, gitStatus.diffStats, currentDirectory);
    }, [isGitRepo, gitStatus, currentDirectory]);

    const { totalAdded, totalRemoved } = React.useMemo(() => {
        let added = 0;
        let removed = 0;
        for (const file of gitChangedFiles) {
            added += file.insertions;
            removed += file.deletions;
        }
        return { totalAdded: added, totalRemoved: removed };
    }, [gitChangedFiles]);

    if (!currentDirectory || isGitRepo !== true) return null;
    if (gitChangedFiles.length === 0) return null;

    const handleOpenFile = (file: ChangedFileEntry) => {
        if (!currentDirectory) return;
        if (!isGitFile(file)) return;

        setIsExpanded(false);

        const absolutePath = file.path;

        // Dedicated mobile root: open the per-file diff inside the mobile Changes surface.
        if (mobileActions) {
            mobileActions.openChanges({
                diffPath: file.relativePath,
                staged: file.hasStagedChanges && !file.hasWorkingChanges,
            });
            return;
        }

        const editor = runtime?.editor;
        if (editor) {
            void editor.openFile(absolutePath);
            return;
        }

        const store = useUIStore.getState();
        const openStagedDiff = file.hasStagedChanges && !file.hasWorkingChanges;
        if (!store.isMobile) {
            store.openContextDiff(currentDirectory, file.relativePath, openStagedDiff);
            return;
        }
        store.navigateToDiff(file.relativePath, openStagedDiff);
    };

    const fileCount = gitChangedFiles.length;
    const labelHead = fileCount === 1
        ? `${fileCount} file`
        : `${fileCount} files`;
    const changesTriggerContent = (
        <>
            <Icon
                name={isMobile ? 'file-list-2' : 'git-branch'}
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            />
            <span className={cn(
                'min-w-0 shrink-0 text-foreground',
                isMobile ? 'typography-micro' : 'typography-ui-label',
            )}>
                {labelHead}
            </span>
            {!isMobile ? (
                <span className="status-row__changed-label min-w-0 typography-ui-label text-foreground truncate">
                    {"changed"}
                </span>
            ) : null}
            <span className="inline-flex shrink-0 items-baseline gap-1 text-[0.75rem] tabular-nums">
                {totalAdded > 0 ? <span style={{ color: 'var(--status-success)' }}>+{totalAdded}</span> : null}
                {totalRemoved > 0 ? <span style={{ color: 'var(--status-error)' }}>-{totalRemoved}</span> : null}
            </span>
            {isExpanded ? (
                <Icon name="arrow-up-s" className="h-3.5 w-3.5 shrink-0" />
            ) : (
                <Icon name="arrow-down-s" className="h-3.5 w-3.5 shrink-0" />
            )}
        </>
    );

    return (
        <div className="relative" ref={popoverRef}>
            {isMobile ? (
                <Button
                    variant="chip"
                    size="xs"
                    className="max-w-full"
                    onClick={() => setIsExpanded((value) => !value)}
                    aria-expanded={isExpanded}
                >
                    {changesTriggerContent}
                </Button>
            ) : (
                <button
                    type="button"
                    className="flex min-w-0 max-w-full items-center gap-1 text-left text-muted-foreground"
                    onClick={() => setIsExpanded((value) => !value)}
                    aria-expanded={isExpanded}
                >
                    {changesTriggerContent}
                </button>
            )}
            {isExpanded && (
                <div
                    style={{
                        ...changedFilesPopoverStyle,
                        maxWidth: 'min(28rem, calc(100cqw - 4ch))',
                    }}
                    className={cn(
                        changedFilesPopoverClassName,
                        "absolute bottom-full mb-1 z-50",
                        align === 'end' ? 'right-0' : 'left-0',
                        "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2",
                        "duration-150"
                    )}
                >
                    <ChangedFilesList
                        files={gitChangedFiles}
                        currentDirectory={currentDirectory}
                        onOpenFile={handleOpenFile}
                    />
                </div>
            )}
        </div>
    );
});

PendingChangesBar.displayName = 'PendingChangesBar';
