import React from 'react';

import { useUIStore } from '@/stores/useUIStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useGitStore, useGitStatus, useIsGitRepo, useGitLoadingStatus } from '@/stores/useGitStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';

import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { isImageFile } from '@/lib/toolHelpers';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { DiffViewToggle } from '@/components/chat/message/DiffViewToggle';
import type { DiffViewMode } from '@/components/chat/message/types';
import { useDeviceInfo } from '@/lib/device';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from "@/components/icon/Icon";
import { getContextFileOpenFailureMessage, validateContextFileOpen } from '@/lib/contextFileOpenGuard';
import { toAbsoluteFilePath } from '@/lib/path-utils';
import { sessionEvents } from '@/lib/sessionEvents';
import { findDiffScrollAnchor, getRestoredDiffScrollTop, type DiffScrollAnchor } from './diffScrollAnchor';
import { fileDiffFromPatch } from '@/lib/diff/patchFileDiff';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessageRecords } from '@/sync/sync-context';
import type { ToolPart } from '@/lib/chat/types';
import { extractChangedFiles } from '@/components/chat/changedFiles';
import { projectTurnRecords } from '@/components/chat/lib/turns/projectTurnRecords';
import { getFirstChangedModifiedLineFromPatch } from './diffPatchUtils';
import { normalizePath } from '@/lib/pathNormalization';
import {
    isNewStatusFile,
    isStagedStatusFile,
    isWorkingStatusFile,
} from './git/gitStatusPredicates';
import { describeGitChange } from './git/gitChangeDescriptors';
import { ChangeScopeSelector } from './diff/ChangeScopeSelector';
import { FileList } from './diff/FileList';
import { MultiFileDiffEntry } from './diff/MultiFileDiffEntry';
import type {
    DiffContextMode,
    DiffData,
    DiffScope,
    FileEntry,
    TurnSnapshotDiff,
} from './diff/diffTypes';
import { createTextDiffDataFromPatch, formatDiffTotals } from './diff/diffFormatters';
import { DEFAULT_CONTEXT_DIFF_LINES } from './diff/diffConstants';

export type { DiffScope };

// Minimum width for side-by-side diff view (px)
const SIDE_BY_SIDE_MIN_WIDTH = 1100;
const STACKED_DIFF_MOUNT_MARGIN = 300;

// Perf: limit concurrent expanded diffs in stacked view.
// Expanding many diffs mounts many Pierre instances + lots of DOM.
const getStackedViewDefaultExpandedCount = (fileCount: number): number => {
    if (fileCount <= 6) return fileCount;
    if (fileCount <= 12) return 6;
    if (fileCount <= 25) return 4;
    return 2;
};

const toAbsolutePath = (directory: string, filePath: string): string => {
    return toAbsoluteFilePath(directory, filePath);
};

const getFirstChangedModifiedLine = (original: string, modified: string): number => {
    const originalLines = original.split('\n');
    const modifiedLines = modified.split('\n');
    const sharedLength = Math.min(originalLines.length, modifiedLines.length);

    for (let index = 0; index < sharedLength; index += 1) {
        if (originalLines[index] !== modifiedLines[index]) {
            return index + 1;
        }
    }

    if (modifiedLines.length > originalLines.length) {
        return originalLines.length + 1;
    }

    if (originalLines.length > modifiedLines.length) {
        return Math.max(1, modifiedLines.length);
    }

    return 1;
};

const listTurnDiffs = (value: unknown): TurnSnapshotDiff[] => {
    if (!Array.isArray(value)) return [];
    return value.filter((diff): diff is TurnSnapshotDiff => {
        if (!diff || typeof diff !== 'object') return false;
        return typeof (diff as TurnSnapshotDiff).file === 'string';
    });
};

const parseRangeDiff = (value: string): TurnSnapshotDiff[] => {
    const chunks = value.split(/^diff --git /m).slice(1);
    return chunks.flatMap((chunk) => {
        const [header = ''] = chunk.split('\n', 1);
        const separator = header.lastIndexOf(' b/');
        if (separator <= 2) return [];

        const fromPath = header.slice(2, separator);
        const toPath = header.slice(separator + 3).trim();
        const body = `diff --git ${chunk}`;
        const status = body.includes('\nnew file mode ')
            ? 'added'
            : body.includes('\ndeleted file mode ')
                ? 'deleted'
                : body.includes('\nrename from ')
                    ? 'renamed'
                    : 'modified';
        let additions = 0;
        let deletions = 0;
        for (const line of body.split('\n')) {
            if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
            if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
        }

        return [{
            file: status === 'deleted' ? fromPath : toPath,
            status,
            additions,
            deletions,
            patch: body,
        }];
    });
};

const statusToGitCode = (status?: string): string => {
    if (status === 'added') return 'A';
    if (status === 'deleted') return 'D';
    return 'M';
};

interface DiffViewProps {
    hideStackedFileSidebar?: boolean;
    stackedDefaultCollapsedAll?: boolean;
    pinSelectedFileHeaderToTopOnNavigate?: boolean;
    showOpenInEditorAction?: boolean;
    diffScope?: DiffScope;
    onDiffScopeChange?: (scope: Extract<DiffScope, 'all' | 'working' | 'staged' | 'turn' | 'branch'>) => void;
    branchBase?: string | null;
    branchHead?: string | null;
    targetFilePath?: string | null;
    /** Render diff content flush with the container edges (no outer padding). */
    flushContent?: boolean;
}

export const DiffView: React.FC<DiffViewProps> = ({
    hideStackedFileSidebar = false,
    stackedDefaultCollapsedAll = false,
    pinSelectedFileHeaderToTopOnNavigate = false,
    showOpenInEditorAction = false,
    diffScope = 'all',
    onDiffScopeChange,
    branchBase = null,
    branchHead = null,
    targetFilePath = null,
    flushContent = false,
}) => {
    const { git, files } = useRuntimeAPIs();
    const effectiveDirectory = useEffectiveDirectory();
    const { screenWidth, isMobile } = useDeviceInfo();

    const isGitRepo = useIsGitRepo(effectiveDirectory ?? null);
    const status = useGitStatus(effectiveDirectory ?? null);
    const isLoadingStatus = useGitLoadingStatus(effectiveDirectory ?? null);
    const setActiveDirectory = useGitStore((state) => state.setActiveDirectory);
    const ensureStatus = useGitStore((state) => state.ensureStatus);
    const fetchStatus = useGitStore((state) => state.fetchStatus);
    const clearDiffCache = useGitStore((state) => state.clearDiffCache);
    const setDiff = useGitStore((state) => state.setDiff);
    const [displayFile, setDisplayFile] = React.useState<string | null>(null);
    const [displayFileStaged, setDisplayFileStaged] = React.useState(false);
    const [pinnedStackedTarget, setPinnedStackedTarget] = React.useState<string | null>(null);
    const [expandedFiles, setExpandedFiles] = React.useState<Set<string>>(() => new Set());
    const [mountedStackedFiles, setMountedStackedFiles] = React.useState<Set<string>>(() => new Set());
    const [loadFullFiles, setLoadFullFiles] = React.useState(false);
    const [scrollRequestNonce, setScrollRequestNonce] = React.useState(0);
    const [fileDiffRefreshNonce, setFileDiffRefreshNonce] = React.useState<Map<string, number>>(() => new Map());
    const [activeDiffScope, setActiveDiffScope] = React.useState(diffScope);
    const [branchDiffs, setBranchDiffs] = React.useState<TurnSnapshotDiff[]>([]);
    const [branchDiffError, setBranchDiffError] = React.useState<string | null>(null);
    const [branchDiffLoading, setBranchDiffLoading] = React.useState(false);

    React.useEffect(() => {
        setActiveDiffScope(diffScope);
    }, [diffScope]);

    const pendingDiffFile = useUIStore((state) => state.pendingDiffFile);
    const pendingDiffStaged = useUIStore((state) => state.pendingDiffStaged);
    const pendingDiffScope = useUIStore((state) => state.pendingDiffScope);
    const setPendingDiffFile = useUIStore((state) => state.setPendingDiffFile);
    const diffLayoutPreference = useUIStore((state) => state.diffLayoutPreference);
    const diffFileLayout = useUIStore((state) => state.diffFileLayout);
    const setDiffFileLayout = useUIStore((state) => state.setDiffFileLayout);
    const diffWrapLinesStore = useUIStore((state) => state.diffWrapLines);
    const setDiffWrapLines = useUIStore((state) => state.setDiffWrapLines);
    const openContextFileAtLine = useUIStore((state) => state.openContextFileAtLine);
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const sessionMessageRecords = useSessionMessageRecords(currentSessionId ?? '', effectiveDirectory ?? undefined);
    const diffWrapLines = diffWrapLinesStore;
    const forcedStaged = activeDiffScope === 'staged' ? true : activeDiffScope === 'working' ? false : null;
    const activeDiffStaged = forcedStaged ?? displayFileStaged;

    const isMobileLayout = isMobile || screenWidth <= 768;
    const showFileSidebar = !hideStackedFileSidebar && !isMobileLayout && screenWidth >= 1024;
    const diffScrollRef = React.useRef<HTMLElement | null>(null);
    const fileSectionRefs = React.useRef(new Map<string, HTMLDivElement | null>());
    const pendingScrollTargetRef = React.useRef<string | null>(null);
    const pendingScrollFrameRef = React.useRef<number | null>(null);
    const shouldPinAfterAlignRef = React.useRef(false);
    const visibleSyncFrameRef = React.useRef<number | null>(null);
    const stackedStateScopeRef = React.useRef<string | null>(null);
    const lastScrollAnchorRef = React.useRef<DiffScrollAnchor | null>(null);
    const pendingScrollAnchorRestoreRef = React.useRef<DiffScrollAnchor | null>(null);

    const captureScrollAnchor = React.useCallback((): DiffScrollAnchor | null => {
        const scrollRoot = diffScrollRef.current;
        if (!scrollRoot) return null;

        const rootTop = scrollRoot.getBoundingClientRect().top;
        const sections: Array<{ path: string; top: number }> = [];
        for (const [path, node] of fileSectionRefs.current) {
            if (node) sections.push({ path, top: node.getBoundingClientRect().top });
        }
        return findDiffScrollAnchor(rootTop, sections);
    }, []);

    const cancelPendingScrollAlignment = React.useCallback(() => {
        pendingScrollTargetRef.current = null;
        shouldPinAfterAlignRef.current = false;
        setPinnedStackedTarget(null);
        if (pendingScrollFrameRef.current !== null) {
            window.cancelAnimationFrame(pendingScrollFrameRef.current);
            pendingScrollFrameRef.current = null;
        }
    }, []);

    const expandStackedFile = React.useCallback((path: string) => {
        setExpandedFiles((previous) => {
            if (previous.has(path)) {
                return previous;
            }
            const next = new Set(previous);
            next.add(path);
            return next;
        });
    }, []);

    const lastTurnDiffs = React.useMemo<TurnSnapshotDiff[]>(() => {
        const projection = projectTurnRecords(sessionMessageRecords, {
            showTextJustificationActivity: false,
            showTurnChangedFiles: true,
            mergeHiddenUserTurns: true,
        });

        for (let index = projection.turns.length - 1; index >= 0; index -= 1) {
            const turn = projection.turns[index];
            if (!turn) continue;

            const toolParts = turn.activityParts
                .map((activity) => activity.part)
                .filter((part): part is ToolPart => part.type === 'tool');
            const changedFiles = extractChangedFiles(toolParts);
            if (changedFiles.length > 0) {
                return changedFiles.map((file) => ({
                    file: file.path,
                    status: 'modified',
                    additions: file.additions,
                    deletions: file.deletions,
                    patch: file.patch,
                }));
            }

            const summaryDiffs = listTurnDiffs(
                (turn.userMessage.info as { summary?: { diffs?: unknown } }).summary?.diffs,
            );
            if (summaryDiffs.length > 0) {
                return summaryDiffs;
            }
        }

        return [];
    }, [sessionMessageRecords]);

    React.useEffect(() => {
        if (
            activeDiffScope !== 'branch'
            || !effectiveDirectory
            || !branchBase
            || !branchHead
            || !git.getGitRangeDiff
        ) {
            setBranchDiffs([]);
            setBranchDiffError(null);
            setBranchDiffLoading(false);
            return;
        }

        let cancelled = false;
        setBranchDiffLoading(true);
        setBranchDiffError(null);
        void git.getGitRangeDiff(effectiveDirectory, {
            base: branchBase,
            head: branchHead,
            contextLines: DEFAULT_CONTEXT_DIFF_LINES,
        }).then((response) => {
            if (cancelled) return;
            setBranchDiffs(parseRangeDiff(response.diff ?? ''));
            setBranchDiffLoading(false);
        }).catch((error) => {
            if (cancelled) return;
            setBranchDiffs([]);
            setBranchDiffLoading(false);
            setBranchDiffError(error instanceof Error ? error.message : String(error));
        });

        return () => {
            cancelled = true;
        };
    }, [activeDiffScope, branchBase, branchHead, effectiveDirectory, git]);

    const lastTurnDiffData = React.useMemo(() => {
        const map = new Map<string, DiffData>();
        for (const diff of lastTurnDiffs) {
            if (!diff.file) continue;
            if (typeof diff.patch === 'string') {
                map.set(diff.file, createTextDiffDataFromPatch(diff.file, diff.patch, 'patch'));
                continue;
            }
            map.set(diff.file, {
                original: diff.before ?? '',
                modified: diff.after ?? '',
                contextMode: 'full',
            });
        }
        return map;
    }, [lastTurnDiffs]);

    const branchDiffData = React.useMemo(() => {
        const map = new Map<string, DiffData>();
        for (const diff of branchDiffs) {
            if (!diff.file || typeof diff.patch !== 'string') continue;
            map.set(diff.file, createTextDiffDataFromPatch(diff.file, diff.patch, 'patch'));
        }
        return map;
    }, [branchDiffs]);

    const changedFiles: FileEntry[] = React.useMemo(() => {
        if (activeDiffScope === 'turn' || activeDiffScope === 'branch') {
            const source = activeDiffScope === 'branch' ? branchDiffs : lastTurnDiffs;
            return source
                .map((diff) => ({
                    path: diff.file ?? '',
                    index: '',
                    working_dir: statusToGitCode(diff.status),
                    insertions: diff.additions ?? 0,
                    deletions: diff.deletions ?? 0,
                    isNew: diff.status === 'added',
                }))
                .filter((file) => file.path)
                .sort((a, b) => a.path.localeCompare(b.path));
        }

        if (!status?.files) return [];
        const diffStats = status.diffStats ?? {};
        const includeFile = activeDiffScope === 'staged'
            ? isStagedStatusFile
            : activeDiffScope === 'working'
                ? isWorkingStatusFile
                : () => true;

        return status.files
            .filter(includeFile)
            .map((file) => ({
                ...file,
                insertions: diffStats[file.path]?.insertions ?? 0,
                deletions: diffStats[file.path]?.deletions ?? 0,
                isNew: isNewStatusFile(file),
            }))
            .sort((a, b) => a.path.localeCompare(b.path));
    }, [activeDiffScope, branchDiffs, lastTurnDiffs, status]);

    const workingFileCount = React.useMemo(() => {
        if (!status?.files) return 0;
        return status.files.filter(isWorkingStatusFile).length;
    }, [status]);

    const stagedFileCount = React.useMemo(() => {
        if (!status?.files) return 0;
        return status.files.filter(isStagedStatusFile).length;
    }, [status]);

    const turnFileCount = lastTurnDiffs.length;
    const allFileCount = status?.files?.length ?? 0;
    const branchFileCount = branchDiffs.length;

    const changedFilePathsKey = React.useMemo(
        () => changedFiles.map((file) => file.path).join('\0'),
        [changedFiles],
    );

    React.useEffect(() => {
        const paths = changedFilePathsKey ? changedFilePathsKey.split('\0') : [];
        const pathSet = new Set(paths);
        const scopeKey = `${effectiveDirectory ?? ''}:${activeDiffScope}:${stackedDefaultCollapsedAll ? 'collapsed' : 'default'}`;
        const shouldInitialize = stackedStateScopeRef.current !== scopeKey;
        stackedStateScopeRef.current = scopeKey;

        setExpandedFiles((previous) => {
            if (shouldInitialize) {
                const defaultExpandedCount = stackedDefaultCollapsedAll
                    ? 0
                    : getStackedViewDefaultExpandedCount(paths.length);
                return new Set(paths.slice(0, defaultExpandedCount));
            }

            let changed = false;
            const next = new Set<string>();
            for (const path of previous) {
                if (!pathSet.has(path)) {
                    changed = true;
                    continue;
                }
                next.add(path);
            }
            return changed ? next : previous;
        });

        setMountedStackedFiles((previous) => {
            if (shouldInitialize) {
                return new Set();
            }

            let changed = false;
            const next = new Set<string>();
            for (const path of previous) {
                if (!pathSet.has(path)) {
                    changed = true;
                    continue;
                }
                next.add(path);
            }
            return changed ? next : previous;
        });
    }, [activeDiffScope, changedFilePathsKey, effectiveDirectory, stackedDefaultCollapsedAll]);

    const syncVisibleStackedFiles = React.useCallback(() => {
        visibleSyncFrameRef.current = null;
        const scrollRoot = diffScrollRef.current;
        if (!scrollRoot) return;

        const rootRect = scrollRoot.getBoundingClientRect();
        const top = rootRect.top - STACKED_DIFF_MOUNT_MARGIN;
        const bottom = rootRect.bottom + STACKED_DIFF_MOUNT_MARGIN;
        const next: Record<string, boolean> = {};
        const sectionPositions: Array<{ path: string; top: number }> = [];

        for (const [path, node] of fileSectionRefs.current) {
            if (!node) continue;
            const rect = node.getBoundingClientRect();
            sectionPositions.push({ path, top: rect.top });
            if (!expandedFiles.has(path)) continue;
            if (rect.bottom < top || rect.top > bottom) continue;
            next[path] = true;
        }
        lastScrollAnchorRef.current = findDiffScrollAnchor(rootRect.top, sectionPositions);

        setMountedStackedFiles((previous) => {
            let changed = false;
            const mounted = new Set(previous);
            for (const path of Object.keys(next)) {
                if (mounted.has(path)) continue;
                mounted.add(path);
                changed = true;
            }
            return changed ? mounted : previous;
        });
    }, [expandedFiles]);

    const queueVisibleStackedFilesSync = React.useCallback(() => {
        if (typeof window === 'undefined') return;
        if (visibleSyncFrameRef.current !== null) return;
        visibleSyncFrameRef.current = window.requestAnimationFrame(syncVisibleStackedFiles);
    }, [syncVisibleStackedFiles]);

    React.useEffect(() => {
        const scrollRoot = diffScrollRef.current;
        if (!scrollRoot) return;

        queueVisibleStackedFilesSync();
        scrollRoot.addEventListener('scroll', queueVisibleStackedFilesSync, { passive: true });
        window.addEventListener('resize', queueVisibleStackedFilesSync);

        return () => {
            scrollRoot.removeEventListener('scroll', queueVisibleStackedFilesSync);
            window.removeEventListener('resize', queueVisibleStackedFilesSync);
            if (visibleSyncFrameRef.current !== null) {
                window.cancelAnimationFrame(visibleSyncFrameRef.current);
                visibleSyncFrameRef.current = null;
            }
        };
    }, [changedFiles, expandedFiles, queueVisibleStackedFilesSync]);

    const getLayoutForFile = React.useCallback((file: FileEntry): 'inline' | 'side-by-side' => {
        const override = diffFileLayout[file.path];
        if (override) return override;

        if (diffLayoutPreference === 'inline') {
            return 'inline';
        }

        if (diffLayoutPreference === 'side-by-side') {
            return 'side-by-side';
        }

        const isNarrow = screenWidth < SIDE_BY_SIDE_MIN_WIDTH;
        if (file.isNew || isNarrow) {
            return 'inline';
        }

        return 'side-by-side';
    }, [diffFileLayout, diffLayoutPreference, screenWidth]);

    const currentLayoutForAllFiles = React.useMemo<'inline' | 'side-by-side' | null>(() => {
        if (changedFiles.length === 0) return null;
        return changedFiles.every((file) => getLayoutForFile(file) === 'side-by-side')
            ? 'side-by-side'
            : 'inline';
    }, [changedFiles, getLayoutForFile]);

    // Ensure git status on mount
    React.useEffect(() => {
        if (effectiveDirectory) {
            setActiveDirectory(effectiveDirectory);
            void ensureStatus(effectiveDirectory, git);
        }
    }, [effectiveDirectory, setActiveDirectory, ensureStatus, git]);

    React.useEffect(() => {
        if (!effectiveDirectory) {
            return;
        }

        return sessionEvents.onGitRefreshHint((hint) => {
            if (normalizePath(hint.directory) !== normalizePath(effectiveDirectory)) {
                return;
            }
            if (hint.paths?.length) {
                pendingScrollAnchorRestoreRef.current = captureScrollAnchor() ?? lastScrollAnchorRef.current;
                clearDiffCache(effectiveDirectory, hint.paths);
                setFileDiffRefreshNonce((previous) => {
                    const next = new Map(previous);
                    for (const path of hint.paths ?? []) {
                        next.set(path, (next.get(path) ?? 0) + 1);
                    }
                    return next;
                });
            }
            void fetchStatus(effectiveDirectory, git, { silent: true });
        });
    }, [captureScrollAnchor, clearDiffCache, effectiveDirectory, fetchStatus, git]);

    React.useLayoutEffect(() => {
        const anchor = pendingScrollAnchorRestoreRef.current;
        if (!anchor) return;
        pendingScrollAnchorRestoreRef.current = null;

        const scrollRoot = diffScrollRef.current;
        const node = fileSectionRefs.current.get(anchor.path);
        if (!scrollRoot || !node) return;

        const rootTop = scrollRoot.getBoundingClientRect().top;
        const currentTopOffset = node.getBoundingClientRect().top - rootTop;
        scrollRoot.scrollTop = getRestoredDiffScrollTop(
            scrollRoot.scrollTop,
            anchor.topOffset,
            currentTopOffset,
            scrollRoot.scrollHeight - scrollRoot.clientHeight,
        );
        lastScrollAnchorRef.current = anchor;
    }, [fileDiffRefreshNonce]);

    // Handle pending diff file from external navigation
    React.useEffect(() => {
        if (activeDiffScope !== 'all' && !pendingDiffScope) {
            return;
        }

        if (pendingDiffFile) {
            if (pendingDiffScope) {
                setActiveDiffScope(pendingDiffScope);
            }
            setDisplayFile(pendingDiffFile);
            setDisplayFileStaged(pendingDiffScope === 'staged' || (!pendingDiffScope && pendingDiffStaged));
            setPendingDiffFile(null);
            shouldPinAfterAlignRef.current = true;
            pendingScrollTargetRef.current = pendingDiffFile;
            expandStackedFile(pendingDiffFile);
            setScrollRequestNonce((value) => value + 1);
        }
    }, [activeDiffScope, expandStackedFile, pendingDiffFile, pendingDiffScope, pendingDiffStaged, setPendingDiffFile]);

    React.useEffect(() => {
        if (activeDiffScope === 'all') {
            return;
        }

        const normalizedTarget = targetFilePath?.trim();
        if (!normalizedTarget) {
            return;
        }

        setDisplayFile(normalizedTarget);
        setDisplayFileStaged(activeDiffScope === 'staged');

        shouldPinAfterAlignRef.current = true;
        pendingScrollTargetRef.current = normalizedTarget;
        expandStackedFile(normalizedTarget);
        setScrollRequestNonce((value) => value + 1);
    }, [activeDiffScope, expandStackedFile, targetFilePath]);

    React.useEffect(() => {
        if (!displayFile) {
            return;
        }

        const stillExists = changedFiles.some((file) => file.path === displayFile);
        if (!stillExists) {
            setDisplayFile(null);
            setDisplayFileStaged(false);
        }
    }, [changedFiles, displayFile]);

    const registerSectionRef = React.useCallback((path: string, node: HTMLDivElement | null) => {
        const map = fileSectionRefs.current;
        if (node) {
            map.set(path, node);
        } else {
            map.delete(path);
        }
        queueVisibleStackedFilesSync();
    }, [queueVisibleStackedFilesSync]);

    const handleStackedEntryExpandedChange = React.useCallback((path: string, expanded: boolean) => {
        cancelPendingScrollAlignment();
        setExpandedFiles((previous) => {
            const hasPath = previous.has(path);
            if (expanded === hasPath) {
                return previous;
            }
            const next = new Set(previous);
            if (expanded) {
                next.add(path);
            } else {
                next.delete(path);
            }
            return next;
        });
        if (!expanded) {
            setMountedStackedFiles((previous) => {
                if (!previous.has(path)) return previous;
                const next = new Set(previous);
                next.delete(path);
                return next;
            });
        }
        queueVisibleStackedFilesSync();
    }, [cancelPendingScrollAlignment, queueVisibleStackedFilesSync]);

    const handleExpandOrCollapseAll = React.useCallback(() => {
        cancelPendingScrollAlignment();
        setExpandedFiles((previous) => {
            if (previous.size > 0) {
                return new Set();
            }
            return new Set(changedFiles.map((file) => file.path));
        });
        setMountedStackedFiles(new Set());
        queueVisibleStackedFilesSync();
    }, [cancelPendingScrollAlignment, changedFiles, queueVisibleStackedFilesSync]);

    const scrollToFile = React.useCallback((path: string): boolean => {
        const node = fileSectionRefs.current.get(path);
        const scrollRoot = diffScrollRef.current;
        if (!node || !scrollRoot) {
            return false;
        }

        const scrollOffset = node.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top;
        scrollRoot.scrollTo({ top: scrollRoot.scrollTop + scrollOffset, behavior: 'auto' });
        return true;
    }, []);

    React.useEffect(() => {
        const target = pendingScrollTargetRef.current;
        if (!target) return;

        let attempts = 0;
        const maxAttempts = 20;
        let cancelled = false;

        const cancelPending = (clearPinnedTarget = true) => {
            if (cancelled) {
                return;
            }
            cancelled = true;
            pendingScrollTargetRef.current = null;
            shouldPinAfterAlignRef.current = false;
            if (clearPinnedTarget) {
                setPinnedStackedTarget(null);
            }
            if (pendingScrollFrameRef.current !== null) {
                window.cancelAnimationFrame(pendingScrollFrameRef.current);
                pendingScrollFrameRef.current = null;
            }
        };

        const tryAlign = () => {
            if (cancelled) {
                pendingScrollFrameRef.current = null;
                return;
            }
            const currentTarget = pendingScrollTargetRef.current;
            if (!currentTarget) {
                cancelPending();
                pendingScrollFrameRef.current = null;
                return;
            }

            const result = scrollToFile(currentTarget);
            if (!result) {
                attempts += 1;
                if (attempts < maxAttempts) {
                    pendingScrollFrameRef.current = window.requestAnimationFrame(tryAlign);
                } else {
                    cancelPending();
                    pendingScrollFrameRef.current = null;
                }
                return;
            }

            if (pinSelectedFileHeaderToTopOnNavigate && shouldPinAfterAlignRef.current) {
                setPinnedStackedTarget(currentTarget);
                cancelPending(false);
                return;
            }
            cancelPending();
        };

        pendingScrollFrameRef.current = window.requestAnimationFrame(tryAlign);

        return () => {
            cancelled = true;
            if (pendingScrollFrameRef.current !== null) {
                window.cancelAnimationFrame(pendingScrollFrameRef.current);
                pendingScrollFrameRef.current = null;
            }
        };
    }, [pinSelectedFileHeaderToTopOnNavigate, scrollRequestNonce, scrollToFile]);

    const handleSelectFile = React.useCallback((value: string) => {
        void value;
    }, []);

    const handleSelectFileAndScroll = React.useCallback((value: string) => {
        cancelPendingScrollAlignment();

        setDisplayFile(value);
        setDisplayFileStaged(false);
        shouldPinAfterAlignRef.current = true;
        pendingScrollTargetRef.current = value;
        expandStackedFile(value);
        setScrollRequestNonce((nonce) => nonce + 1);
        scrollToFile(value);
    }, [cancelPendingScrollAlignment, expandStackedFile, scrollToFile]);

    const handleHeaderLayoutChange = React.useCallback((mode: DiffViewMode) => {
        const nextLayout: 'inline' | 'side-by-side' =
            mode === 'side-by-side' ? 'side-by-side' : 'inline';

        changedFiles.forEach((file) => {
            setDiffFileLayout(file.path, nextLayout);
        });
    }, [changedFiles, setDiffFileLayout]);

    const [openingEditorFilePath, setOpeningEditorFilePath] = React.useState<string | null>(null);

    const openFileInEditorAtChange = React.useCallback(async (filePath: string, cachedDiffData: DiffData | null) => {
        if (!effectiveDirectory || !filePath) {
            return;
        }

        setOpeningEditorFilePath(filePath);
        const runtimeKey = getRuntimeKey();
        try {
            let targetLine: number | null = null;

            if (cachedDiffData?.patch && !cachedDiffData.isBinary && !isImageFile(filePath)) {
                targetLine = getFirstChangedModifiedLineFromPatch(cachedDiffData.patch);
            } else if (cachedDiffData && cachedDiffData.contextMode === 'full' && !cachedDiffData.isBinary && !isImageFile(filePath)) {
                targetLine = getFirstChangedModifiedLine(cachedDiffData.original, cachedDiffData.modified);
            }

            if (targetLine === null) {
                try {
                    const patchResponse = await git.getGitDiff(effectiveDirectory, {
                        path: filePath,
                        staged: activeDiffStaged,
                        contextLines: 3,
                    });
                    targetLine = getFirstChangedModifiedLineFromPatch(patchResponse.diff);
                } catch {
                    targetLine = null;
                }
            }

            let diffForNavigation = cachedDiffData;
            if (targetLine === null || !diffForNavigation) {
                const response = await git.getGitFileDiff(effectiveDirectory, { path: filePath, staged: activeDiffStaged });
                diffForNavigation = {
                    original: response.original ?? '',
                    modified: response.modified ?? '',
                    isBinary: response.isBinary,
                };
                if (!activeDiffStaged) {
                    setDiff(effectiveDirectory, filePath, diffForNavigation, runtimeKey);
                }
            }

            const resolvedTargetLine = targetLine ?? ((diffForNavigation.isBinary || isImageFile(filePath))
                ? 1
                : getFirstChangedModifiedLine(diffForNavigation.original, diffForNavigation.modified));

            const absolutePath = toAbsolutePath(effectiveDirectory, filePath);
            const openValidation = await validateContextFileOpen(files, absolutePath, { directory: effectiveDirectory });
            if (!openValidation.ok) {
                toast.error(getContextFileOpenFailureMessage(openValidation.reason));
                return;
            }

            openContextFileAtLine(
                effectiveDirectory,
                absolutePath,
                resolvedTargetLine,
                1,
            );
        } finally {
            setOpeningEditorFilePath((current) => (current === filePath ? null : current));
        }
    }, [activeDiffStaged, effectiveDirectory, files, git, openContextFileAtLine, setDiff]);

    const renderStackedDiffView = () => {
        if (!effectiveDirectory) return null;

        const getFileStaged = (path: string) => {
            if (forcedStaged !== null) {
                return forcedStaged;
            }
            return displayFileStaged && path === displayFile;
        };

        return (
            <div className={cn('flex min-w-0 flex-1 min-h-0 h-full', flushContent ? 'gap-0' : 'gap-3 px-3 pb-3 pt-2')}>
                {showFileSidebar && (
                    <section className="hidden lg:flex w-72 flex-col rounded-xl border border-border/60 bg-background/70 overflow-hidden">
                        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/40">
                            <span className="typography-ui-header font-semibold text-foreground">{"Files"}</span>
                            <span className="typography-meta text-muted-foreground">{changedFiles.length}</span>
                        </div>
                        <FileList
                            changedFiles={changedFiles}
                            selectedFile={null}
                            onSelectFile={handleSelectFileAndScroll}
                        />
                    </section>
                )}
                <div className="relative flex-1 min-w-0 min-h-0 h-full">
                    <ScrollableOverlay
                        ref={diffScrollRef}
                        outerClassName="min-h-0 h-full"
                        className="[overflow-anchor:none] pb-16"
                        disableHorizontal
                        observeMutations={false}
                        preventOverscroll
                        data-diff-virtual-root
                    >
                        <div className="flex flex-col [overflow-anchor:none]" data-diff-virtual-content>
                            {changedFiles.map((file) => (
                                <MultiFileDiffEntry
                                    key={`${file.path}:${fileDiffRefreshNonce.get(file.path) ?? 0}`}
                                    directory={effectiveDirectory}
                                    file={file}
                                    layout={getLayoutForFile(file)}
                                    wrapLines={diffWrapLines}
                                    isSelected={false}
                                    isExpanded={expandedFiles.has(file.path)}
                                    isMounted={mountedStackedFiles.has(file.path) || file.path === pinnedStackedTarget}
                                    onSelect={handleSelectFile}
                                    onExpandedChange={handleStackedEntryExpandedChange}
                                    registerSectionRef={registerSectionRef}
                                    showOpenInEditorAction={showOpenInEditorAction && activeDiffScope !== 'turn' && activeDiffScope !== 'branch'}
                                    isOpeningInEditor={openingEditorFilePath === file.path}
                                    onOpenInEditor={(filePath, diffData) => {
                                        void openFileInEditorAtChange(filePath, diffData);
                                    }}
                                    staged={getFileStaged(file.path)}
                                    showFileActions={activeDiffScope !== 'turn' && activeDiffScope !== 'branch'}
                                    loadFullFiles={loadFullFiles}
                                    initialDiffData={
                                        activeDiffScope === 'turn'
                                            ? lastTurnDiffData.get(file.path) ?? null
                                            : activeDiffScope === 'branch'
                                                ? branchDiffData.get(file.path) ?? null
                                                : null
                                    }
                                />
                            ))}
                        </div>
                    </ScrollableOverlay>
                </div>
            </div>
        );
    };

    const renderContent = () => {

        if (!effectiveDirectory) {
            return (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {"Select a session directory to view diffs"}
                </div>
            );
        }

        if (activeDiffScope !== 'turn' && isLoadingStatus && !status) {
            return (
                <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Icon name="loader-4" className="size-4 animate-spin" />
                    {"Loading repository status..."}
                </div>
            );
        }

        if (activeDiffScope !== 'turn' && activeDiffScope !== 'branch' && isGitRepo === false) {
            return (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {"Not a git repository. Use the Git tab to initialize or change directories."}
                </div>
            );
        }

        if (activeDiffScope === 'branch' && branchDiffLoading) {
            return (
                <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Icon name="loader-4" className="size-4 animate-spin" />
                    {"Loading branch changes..."}
                </div>
            );
        }

        if (activeDiffScope === 'branch' && branchDiffError) {
            return (
                <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-muted-foreground">
                    {`Failed to load branch changes: ${branchDiffError}`}
                </div>
            );
        }

        if (changedFiles.length === 0) {
            return (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {activeDiffScope === 'turn' ? "No last turn changes to display" : "Working tree clean, no changes to display"}
                </div>
            );
        }

        return renderStackedDiffView();
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background">
            <div className="@container/diff-toolbar flex min-w-0 items-center gap-2 px-3 py-2 bg-background">
                {(isGitRepo !== false || activeDiffScope === 'turn')
                    && (activeDiffScope === 'all' || activeDiffScope === 'working' || activeDiffScope === 'staged' || activeDiffScope === 'turn' || activeDiffScope === 'branch') ? (
                        <ChangeScopeSelector
                            scope={activeDiffScope}
                            isGitRepo={isGitRepo}
                            branchAvailable={Boolean(branchBase && branchHead)}
                            allCount={allFileCount}
                            workingCount={workingFileCount}
                            stagedCount={stagedFileCount}
                            turnCount={turnFileCount}
                            branchCount={branchFileCount}
                            onScopeChange={(scope) => {
                                setActiveDiffScope(scope);
                                onDiffScopeChange?.(scope);
                            }}
                        />
                    ) : (
                        <div className="flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground shrink-0">
                            <span className="typography-ui-label font-semibold text-foreground">
                                {isLoadingStatus && !status
                                    ? "Loading changes..."
                                    : (changedFiles.length === 1
                                        ? `${changedFiles.length} file changed`
                                        : `${changedFiles.length} files changed`)}
                            </span>
                        </div>
                    )}
                {changedFiles.length > 0 && (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleExpandOrCollapseAll}
                        className={cn(
                            'diff-toolbar__expand-button h-7 flex-shrink-0 gap-1 px-1.5 text-muted-foreground hover:text-foreground',
                            'ml-auto',
                        )}
                        title={expandedFiles.size > 0 ? "Collapse all" : "Expand all"}
                    >
                        <Icon
                            name="expand-up-down"
                            className="size-4"
                        />
                        <span className="diff-toolbar__expand-label typography-ui-label">
                            {expandedFiles.size > 0 ? "Collapse all" : "Expand all"}
                        </span>
                    </Button>
                )}
                {changedFiles.length > 0 && activeDiffScope !== 'turn' && activeDiffScope !== 'branch' && (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setLoadFullFiles((value) => !value)}
                                aria-pressed={loadFullFiles}
                                aria-label={loadFullFiles ? "Unload full files" : "Load full files"}
                                className={cn(
                                    'h-7 w-7 flex-shrink-0 p-0 text-muted-foreground hover:text-foreground',
                                    loadFullFiles && 'bg-interactive-selection text-interactive-selection-foreground',
                                )}
                            >
                                <Icon name="file-download" className="size-4" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                            <p>{loadFullFiles ? "Unload full files" : "Load full files"}</p>
                        </TooltipContent>
                    </Tooltip>
                )}
                {changedFiles.length > 0 && (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDiffWrapLines(!diffWrapLinesStore)}
                        className={cn(
                            'h-5 w-5 p-0 transition-opacity',
                            diffWrapLines ? 'text-foreground opacity-100' : 'text-muted-foreground opacity-60 hover:opacity-100'
                        )}
                        title={diffWrapLines ? "Disable line wrap" : "Enable line wrap"}
                    >
                        <Icon name="text-wrap" className="size-4" />
                    </Button>
                )}
                {currentLayoutForAllFiles && (
                    <DiffViewToggle
                        mode={currentLayoutForAllFiles === 'side-by-side' ? 'side-by-side' : 'unified'}
                        onModeChange={handleHeaderLayoutChange}
                    />
                )}
            </div>



            {renderContent()}
        </div>
    );
};
