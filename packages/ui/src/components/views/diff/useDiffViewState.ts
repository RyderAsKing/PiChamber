import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useGitStore, useGitStatus, useIsGitRepo, useGitLoadingStatus } from '@/stores/useGitStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { DiffViewMode } from '@/components/chat/message/types';
import { useDeviceInfo } from '@/lib/device';
import { sessionEvents } from '@/lib/sessionEvents';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessageRecords } from '@/sync/sync-context';
import { normalizePath } from '@/lib/pathNormalization';
import {
  isNewStatusFile,
  isStagedStatusFile,
  isWorkingStatusFile,
} from '../git/gitStatusPredicates';
import type {
  DiffScope,
  FileEntry,
} from './diffTypes';
import {
  SIDE_BY_SIDE_MIN_WIDTH,
  getStackedViewDefaultExpandedCount,
  statusToGitCode,
} from './diffTurnUtils';
import { useBranchAndTurnDiffs } from './useBranchAndTurnDiffs';
import { useDiffScrollManager } from './useDiffScrollManager';
import { useDiffEditorOpener } from './useDiffEditorOpener';

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
  const [expandedFiles, setExpandedFiles] = React.useState<Set<string>>(() => new Set());
  const [mountedStackedFiles, setMountedStackedFiles] = React.useState<Set<string>>(() => new Set());
  const [loadFullFiles, setLoadFullFiles] = React.useState(false);
  const [scrollRequestNonce, setScrollRequestNonce] = React.useState(0);
  const [fileDiffRefreshNonce, setFileDiffRefreshNonce] = React.useState<Map<string, number>>(() => new Map());
  const [activeDiffScope, setActiveDiffScope] = React.useState(diffScope);

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
  const stackedStateScopeRef = React.useRef<string | null>(null);

  const {
    branchDiffs,
    branchDiffError,
    branchDiffLoading,
    lastTurnDiffs,
    lastTurnDiffData,
    branchDiffData,
  } = useBranchAndTurnDiffs({
    activeDiffScope,
    effectiveDirectory,
    branchBase,
    branchHead,
    git,
    sessionMessageRecords,
  });

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

  const {
    diffScrollRef,
    pinnedStackedTarget,
    pendingScrollTargetRef,
    shouldPinAfterAlignRef,
    pendingScrollAnchorRestoreRef,
    lastScrollAnchorRef,
    captureScrollAnchor,
    cancelPendingScrollAlignment,
    queueVisibleStackedFilesSync,
    registerSectionRef,
    scrollToFile,
  } = useDiffScrollManager({
    pinSelectedFileHeaderToTopOnNavigate,
    scrollRequestNonce,
    changedFiles,
    expandedFiles,
    setMountedStackedFiles,
    fileDiffRefreshNonce,
  });

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

  const changedFilePathsKey = React.useMemo(
    () => changedFiles.map((file) => file.path).join('\0'),
    [changedFiles],
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
  }, [activeDiffScope, changedFilePathsKey, effectiveDirectory, setMountedStackedFiles, stackedDefaultCollapsedAll]);

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
    [diffFileLayout, diffLayoutPreference, screenWidth],
  );

  const currentLayoutForAllFiles = React.useMemo<'inline' | 'side-by-side' | null>(() => {
    if (changedFiles.length === 0) return null;
    return changedFiles.every((file) => getLayoutForFile(file) === 'side-by-side')
      ? 'side-by-side'
      : 'inline';
  }, [changedFiles, getLayoutForFile]);

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
  }, [
    captureScrollAnchor,
    clearDiffCache,
    effectiveDirectory,
    fetchStatus,
    git,
    lastScrollAnchorRef,
    pendingScrollAnchorRestoreRef,
  ]);

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
  }, [
    activeDiffScope,
    expandStackedFile,
    pendingDiffFile,
    pendingDiffScope,
    pendingDiffStaged,
    pendingScrollTargetRef,
    setPendingDiffFile,
    shouldPinAfterAlignRef,
  ]);

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
  }, [activeDiffScope, expandStackedFile, pendingScrollTargetRef, shouldPinAfterAlignRef, targetFilePath]);

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
    [cancelPendingScrollAlignment, queueVisibleStackedFilesSync, setMountedStackedFiles],
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
  }, [cancelPendingScrollAlignment, changedFiles, queueVisibleStackedFilesSync, setMountedStackedFiles]);

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
    [
      cancelPendingScrollAlignment,
      expandStackedFile,
      pendingScrollTargetRef,
      scrollToFile,
      shouldPinAfterAlignRef,
    ],
  );

  const handleHeaderLayoutChange = React.useCallback(
    (mode: DiffViewMode) => {
      const nextLayout: 'inline' | 'side-by-side' = mode === 'side-by-side' ? 'side-by-side' : 'inline';

      changedFiles.forEach((file) => {
        setDiffFileLayout(file.path, nextLayout);
      });
    },
    [changedFiles, setDiffFileLayout],
  );

  const { openingEditorFilePath, openFileInEditorAtChange } = useDiffEditorOpener({
    effectiveDirectory,
    activeDiffStaged,
    git,
    files,
    setDiff,
    openContextFileAtLine,
  });

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
