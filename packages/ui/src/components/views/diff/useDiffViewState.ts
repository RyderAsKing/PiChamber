import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useGitStore, useGitStatus, useIsGitRepo, useGitLoadingStatus } from '@/stores/useGitStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { toast } from '@/components/ui';
import { isImageFile } from '@/lib/toolHelpers';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { DiffViewMode } from '@/components/chat/message/types';
import { useDeviceInfo } from '@/lib/device';
import { getContextFileOpenFailureMessage, validateContextFileOpen } from '@/lib/contextFileOpenGuard';
import { sessionEvents } from '@/lib/sessionEvents';
import { findDiffScrollAnchor, getRestoredDiffScrollTop, type DiffScrollAnchor } from '../diffScrollAnchor';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessageRecords } from '@/sync/sync-context';
import type { ToolPart } from '@/lib/chat/types';
import { extractChangedFiles } from '@/components/chat/changedFiles';
import { projectTurnRecords } from '@/components/chat/lib/turns/projectTurnRecords';
import { getFirstChangedModifiedLineFromPatch } from '../diffPatchUtils';
import { normalizePath } from '@/lib/pathNormalization';
import {
  isNewStatusFile,
  isStagedStatusFile,
  isWorkingStatusFile,
} from '../git/gitStatusPredicates';
import type {
  DiffData,
  DiffScope,
  FileEntry,
  TurnSnapshotDiff,
} from './diffTypes';
import { createTextDiffDataFromPatch } from './diffFormatters';
import { DEFAULT_CONTEXT_DIFF_LINES } from './diffConstants';
import {
  SIDE_BY_SIDE_MIN_WIDTH,
  STACKED_DIFF_MOUNT_MARGIN,
  getStackedViewDefaultExpandedCount,
  toAbsolutePath,
  getFirstChangedModifiedLine,
  listTurnDiffs,
  parseRangeDiff,
  statusToGitCode,
} from './diffTurnUtils';

export interface UseDiffViewStateOptions {
  hideStackedFileSidebar?: boolean;
  stackedDefaultCollapsedAll?: boolean;
  pinSelectedFileHeaderToTopOnNavigate?: boolean;
  diffScope?: DiffScope;
  branchBase?: string | null;
  branchHead?: string | null;
  targetFilePath?: string | null;
}

export function useDiffViewState(options: UseDiffViewStateOptions) {
  const {
    hideStackedFileSidebar = false,
    stackedDefaultCollapsedAll = false,
    pinSelectedFileHeaderToTopOnNavigate = false,
    diffScope = 'all',
    branchBase = null,
    branchHead = null,
    targetFilePath = null,
  } = options;

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
        (turn.userMessage.info as { summary?: { diffs?: unknown } }).summary?.diffs
      );
      if (summaryDiffs.length > 0) {
        return summaryDiffs;
      }
    }

    return [];
  }, [sessionMessageRecords]);

  React.useEffect(() => {
    if (
      activeDiffScope !== 'branch' ||
      !effectiveDirectory ||
      !branchBase ||
      !branchHead ||
      !git.getGitRangeDiff
    ) {
      setBranchDiffs([]);
      setBranchDiffError(null);
      setBranchDiffLoading(false);
      return;
    }

    let cancelled = false;
    setBranchDiffLoading(true);
    setBranchDiffError(null);
    void git
      .getGitRangeDiff(effectiveDirectory, {
        base: branchBase,
        head: branchHead,
        contextLines: DEFAULT_CONTEXT_DIFF_LINES,
      })
      .then((response) => {
        if (cancelled) return;
        setBranchDiffs(parseRangeDiff(response.diff ?? ''));
        setBranchDiffLoading(false);
      })
      .catch((error) => {
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
    const includeFile =
      activeDiffScope === 'staged'
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
    [changedFiles]
  );

  React.useEffect(() => {
    const paths = changedFilePathsKey ? changedFilePathsKey.split('\0') : [];
    const pathSet = new Set(paths);
    const scopeKey = `${effectiveDirectory ?? ''}:${activeDiffScope}:${
      stackedDefaultCollapsedAll ? 'collapsed' : 'default'
    }`;
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

  const getLayoutForFile = React.useCallback(
    (file: FileEntry): 'inline' | 'side-by-side' => {
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
    },
    [diffFileLayout, diffLayoutPreference, screenWidth]
  );

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
      scrollRoot.scrollHeight - scrollRoot.clientHeight
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

  const registerSectionRef = React.useCallback(
    (path: string, node: HTMLDivElement | null) => {
      const map = fileSectionRefs.current;
      if (node) {
        map.set(path, node);
      } else {
        map.delete(path);
      }
      queueVisibleStackedFilesSync();
    },
    [queueVisibleStackedFilesSync]
  );

  const handleStackedEntryExpandedChange = React.useCallback(
    (path: string, expanded: boolean) => {
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
    },
    [cancelPendingScrollAlignment, queueVisibleStackedFilesSync]
  );

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

  const handleSelectFileAndScroll = React.useCallback(
    (value: string) => {
      cancelPendingScrollAlignment();

      setDisplayFile(value);
      setDisplayFileStaged(false);
      shouldPinAfterAlignRef.current = true;
      pendingScrollTargetRef.current = value;
      expandStackedFile(value);
      setScrollRequestNonce((nonce) => nonce + 1);
      scrollToFile(value);
    },
    [cancelPendingScrollAlignment, expandStackedFile, scrollToFile]
  );

  const handleHeaderLayoutChange = React.useCallback(
    (mode: DiffViewMode) => {
      const nextLayout: 'inline' | 'side-by-side' = mode === 'side-by-side' ? 'side-by-side' : 'inline';

      changedFiles.forEach((file) => {
        setDiffFileLayout(file.path, nextLayout);
      });
    },
    [changedFiles, setDiffFileLayout]
  );

  const [openingEditorFilePath, setOpeningEditorFilePath] = React.useState<string | null>(null);

  const openFileInEditorAtChange = React.useCallback(
    async (filePath: string, cachedDiffData: DiffData | null) => {
      if (!effectiveDirectory || !filePath) {
        return;
      }

      setOpeningEditorFilePath(filePath);
      const runtimeKey = getRuntimeKey();
      try {
        let targetLine: number | null = null;

        if (cachedDiffData?.patch && !cachedDiffData.isBinary && !isImageFile(filePath)) {
          targetLine = getFirstChangedModifiedLineFromPatch(cachedDiffData.patch);
        } else if (
          cachedDiffData &&
          cachedDiffData.contextMode === 'full' &&
          !cachedDiffData.isBinary &&
          !isImageFile(filePath)
        ) {
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
          const response = await git.getGitFileDiff(effectiveDirectory, {
            path: filePath,
            staged: activeDiffStaged,
          });
          diffForNavigation = {
            original: response.original ?? '',
            modified: response.modified ?? '',
            isBinary: response.isBinary,
          };
          if (!activeDiffStaged) {
            setDiff(effectiveDirectory, filePath, diffForNavigation, runtimeKey);
          }
        }

        const resolvedTargetLine =
          targetLine ??
          (diffForNavigation.isBinary || isImageFile(filePath)
            ? 1
            : getFirstChangedModifiedLine(diffForNavigation.original, diffForNavigation.modified));

        const absolutePath = toAbsolutePath(effectiveDirectory, filePath);
        const openValidation = await validateContextFileOpen(files, absolutePath, {
          directory: effectiveDirectory,
        });
        if (!openValidation.ok) {
          toast.error(getContextFileOpenFailureMessage(openValidation.reason));
          return;
        }

        openContextFileAtLine(effectiveDirectory, absolutePath, resolvedTargetLine, 1);
      } finally {
        setOpeningEditorFilePath((current) => (current === filePath ? null : current));
      }
    },
    [activeDiffStaged, effectiveDirectory, files, git, openContextFileAtLine, setDiff]
  );

  return {
    git,
    files,
    effectiveDirectory,
    screenWidth,
    isMobile,
    isGitRepo,
    status,
    isLoadingStatus,
    activeDiffScope,
    setActiveDiffScope,
    branchDiffs,
    branchDiffError,
    branchDiffLoading,
    diffWrapLines,
    setDiffWrapLines,
    forcedStaged,
    displayFileStaged,
    displayFile,
    pinnedStackedTarget,
    expandedFiles,
    mountedStackedFiles,
    loadFullFiles,
    setLoadFullFiles,
    fileDiffRefreshNonce,
    showFileSidebar,
    diffScrollRef,
    lastTurnDiffData,
    branchDiffData,
    changedFiles,
    workingFileCount,
    stagedFileCount,
    turnFileCount,
    allFileCount,
    branchFileCount,
    currentLayoutForAllFiles,
    openingEditorFilePath,
    registerSectionRef,
    handleStackedEntryExpandedChange,
    handleExpandOrCollapseAll,
    handleSelectFile,
    handleSelectFileAndScroll,
    handleHeaderLayoutChange,
    openFileInEditorAtChange,
    getLayoutForFile,
  };
}
