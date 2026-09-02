/* eslint-disable */
import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useFireworksCelebration } from '@/contexts/FireworksContext';
import type { GitIdentityProfile, CommitFileEntry, GitStatus } from '@/lib/api/types';
import { useGitIdentitiesStore } from '@/stores/useGitIdentitiesStore';
import { useShallow } from 'zustand/react/shallow';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useGitmojiList } from '@/hooks/useGitmojiList';
import { copyTextToClipboard } from '@/lib/clipboard';
import {
  useGitStore,
  useGitStatus,
  useGitBranches,
  useGitLog,
  useGitIdentity,
  useIsGitRepo,
  useGitLoadingStatus,
  useGitLoadingLog,
} from '@/stores/useGitStore';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';

import { GitHeader } from './git/GitHeader';
import { GitViewDialogs } from './git/GitViewDialogs';
import { getGitViewSnapshot, rememberGitViewSnapshot } from './git/gitViewSnapshots';
import { CommitSection } from './git/CommitSection';
import { GitEmptyState } from './git/GitEmptyState';
import { InProgressOperationBanner } from './git/InProgressOperationBanner';
import type { OperationLogEntry } from './git/BranchIntegrationSection';
import type { GitLogDialogMode, HistoryBranchDivider } from './git/GitHistoryDialog';
import { useGitCommitFiles } from './git/useGitCommitFiles';
import { useGitBranchScope } from './git/useGitBranchScope';
import { useGitIdentities } from './git/useGitIdentities';
import { useGitConflictState } from './git/useGitConflictState';
import { createGitIndexMutationQueue, type GitIndexMutationDirection, type GitIndexMutationQueue } from './git/gitIndexMutationQueue';
import { MobileGitChrome } from './git/MobileGitChrome';
import type { GitRemote } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { sessionEvents } from '@/lib/sessionEvents';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { normalizePath } from '@/lib/pathNormalization';
import {
  isStagedStatusFile,
  isWorkingStatusFile as isUnstagedStatusFile,
} from './git/gitStatusPredicates';

const DiffView = lazyWithChunkRecovery(() => import('./DiffView').then((m) => ({ default: m.DiffView })));

type SyncAction = 'fetch' | 'pull' | 'push' | 'sync' | null;
type CommitAction = 'commit' | 'commitAndPush' | null;
type BranchOperation = 'merge' | 'rebase' | null;

const GIT_RECONCILE_DELAY_MS = 15000;

const GIT_DIFF_PRIORITY_PREFETCH_LIMIT = 40;
const GIT_DIFF_PRIORITY_BASELINE_LIMIT = 20;

type GitViewProps = {
  isActive: boolean;
  chrome?: 'desktop' | 'mobile';
  initialDiffPath?: string | null;
  initialDiffStaged?: boolean;
};

export const GitView: React.FC<GitViewProps> = ({
  isActive,
  chrome = 'desktop',
  initialDiffPath = null,
  initialDiffStaged = false,
}) => {
  const { git } = useRuntimeAPIs();
  const currentDirectory = useEffectiveDirectory();
  const currentSessionId = useSessionUIStore((s) => s.currentSessionId);

  const { profiles, globalIdentity, defaultGitIdentityId, loadProfiles, loadGlobalIdentity, loadDefaultGitIdentityId } =
    useGitIdentitiesStore(useShallow((s) => ({
      profiles: s.profiles,
      globalIdentity: s.globalIdentity,
      defaultGitIdentityId: s.defaultGitIdentityId,
      loadProfiles: s.loadProfiles,
      loadGlobalIdentity: s.loadGlobalIdentity,
      loadDefaultGitIdentityId: s.loadDefaultGitIdentityId,
    })));

  const isGitRepo = useIsGitRepo(currentDirectory ?? null);
  const status = useGitStatus(currentDirectory ?? null);
  const branches = useGitBranches(currentDirectory ?? null);
  const log = useGitLog(currentDirectory ?? null);
  const currentIdentity = useGitIdentity(currentDirectory ?? null);
  const isLoading = useGitLoadingStatus(currentDirectory ?? null);
  const isLogLoading = useGitLoadingLog(currentDirectory ?? null);
  const {
    setActiveDirectory,
    fetchAll,
    ensureAll,
    fetchStatus,
    fetchBranches,
    fetchLog,
    setLogMaxCount,
    fetchIdentity,
    prefetchDiffs,
    clearDiffCache,
    moveStatusPathsOptimistically,
    restoreStatus,
    bumpIndexRevision,
  } = useGitStore(useShallow((state) => ({
    setActiveDirectory: state.setActiveDirectory,
    fetchAll: state.fetchAll,
    ensureAll: state.ensureAll,
    fetchStatus: state.fetchStatus,
    fetchBranches: state.fetchBranches,
    fetchLog: state.fetchLog,
    setLogMaxCount: state.setLogMaxCount,
    fetchIdentity: state.fetchIdentity,
    prefetchDiffs: state.prefetchDiffs,
    clearDiffCache: state.clearDiffCache,
    moveStatusPathsOptimistically: state.moveStatusPathsOptimistically,
    restoreStatus: state.restoreStatus,
    bumpIndexRevision: state.bumpIndexRevision,
  })));

  const previousBootstrapStatusRef = React.useRef<'pending' | 'ready' | 'failed' | null>(null);
  const gitReconcileTimeoutRef = React.useRef<number | null>(null);
  const gitMutationFlushTimeoutRef = React.useRef<number | null>(null);
  const flushQueuedGitMutationsRef = React.useRef<(() => void) | null>(null);
  const mountedRef = React.useRef(true);
  React.useEffect(() => () => { mountedRef.current = false; }, []);

  const clearScheduledGitReconcile = React.useCallback(() => {
    if (gitReconcileTimeoutRef.current === null) {
      return;
    }

    window.clearTimeout(gitReconcileTimeoutRef.current);
    gitReconcileTimeoutRef.current = null;
  }, []);

  const scheduleGitReconcile = React.useCallback((directory: string) => {
    clearScheduledGitReconcile();
    gitReconcileTimeoutRef.current = window.setTimeout(() => {
      gitReconcileTimeoutRef.current = null;
      if (normalizePath(directory) !== normalizePath(currentDirectory)) {
        return;
      }
      void fetchStatus(directory, git, { silent: true });
    }, GIT_RECONCILE_DELAY_MS);
  }, [clearScheduledGitReconcile, currentDirectory, fetchStatus, git]);

  React.useEffect(() => clearScheduledGitReconcile, [clearScheduledGitReconcile]);

  const clearScheduledGitMutationFlush = React.useCallback(() => {
    if (gitMutationFlushTimeoutRef.current === null) {
      return;
    }

    window.clearTimeout(gitMutationFlushTimeoutRef.current);
    gitMutationFlushTimeoutRef.current = null;
  }, []);

  const scheduleGitMutationFlush = React.useCallback(() => {
    if (gitMutationFlushTimeoutRef.current !== null) {
      return;
    }

    gitMutationFlushTimeoutRef.current = window.setTimeout(() => {
      gitMutationFlushTimeoutRef.current = null;
      flushQueuedGitMutationsRef.current?.();
    }, 0);
  }, []);

  const runGitIndexMutation = React.useCallback(async (
    directory: string,
    direction: GitIndexMutationDirection,
    paths: string[]
  ) => {
    if (direction === 'stage') {
      if (git.stageGitFiles) {
        await git.stageGitFiles(directory, paths);
        return;
      }
      await Promise.all(paths.map((filePath) => git.stageGitFile(directory, filePath)));
      return;
    }

    if (git.unstageGitFiles) {
      await git.unstageGitFiles(directory, paths);
      return;
    }
    await Promise.all(paths.map((filePath) => git.unstageGitFile(directory, filePath)));
  }, [git]);

  const gitIndexMutationQueue = React.useMemo<GitIndexMutationQueue>(() => createGitIndexMutationQueue({
    runMutation: ({ directory, direction, paths }) => runGitIndexMutation(directory, direction, paths),
    onMutationComplete: ({ directory }) => {
      bumpIndexRevision(directory);
      scheduleGitReconcile(directory);
    },
    onMutationError: ({ directory, direction, rollback }, error) => {
      rollback?.();
      bumpIndexRevision(directory);
      scheduleGitReconcile(directory);
      const fallback = direction === 'stage'
        ? "Failed to stage changes"
        : "Failed to unstage changes";
      toast.error(error instanceof Error ? error.message : fallback);
    },
    onPathsComplete: (paths) => {
      setMovingChangePaths((previous) => {
        const updated = new Set(previous);
        paths.forEach((path) => updated.delete(path));
        return updated;
      });
    },
    scheduleFlush: scheduleGitMutationFlush,
  }), [bumpIndexRevision, runGitIndexMutation, scheduleGitMutationFlush, scheduleGitReconcile]);

  React.useEffect(() => {
    flushQueuedGitMutationsRef.current = gitIndexMutationQueue.flush;
    return () => {
      flushQueuedGitMutationsRef.current = null;
    };
  }, [gitIndexMutationQueue]);

  React.useEffect(() => () => gitIndexMutationQueue.clear(), [gitIndexMutationQueue]);

  React.useEffect(() => clearScheduledGitMutationFlush, [clearScheduledGitMutationFlush]);

  const initialSnapshot = React.useMemo(() => {
    if (!currentDirectory) return null;
    return getGitViewSnapshot(currentDirectory);
  }, [currentDirectory]);

  const settingsGitmojiEnabled = useConfigStore((state) => state.settingsGitmojiEnabled);
  const { gitmojis: gitmojiEmojis } = useGitmojiList(settingsGitmojiEnabled);

  const [commitMessage, setCommitMessage] = React.useState(
    initialSnapshot?.commitMessage ?? ''
  );
  const [isGitmojiPickerOpen, setIsGitmojiPickerOpen] = React.useState(false);
  const actionPanelScrollRef = React.useRef<HTMLDivElement | null>(null);
  const [syncAction, setSyncAction] = React.useState<SyncAction>(null);
  const [isStashesDialogOpen, setIsStashesDialogOpen] = React.useState(false);
  const [commitAction, setCommitAction] = React.useState<CommitAction>(null);
  const [logMaxCountLocal, setLogMaxCountLocal] = React.useState<number>(25);
  const [isSettingIdentity, setIsSettingIdentity] = React.useState(false);
  const { triggerFireworks } = useFireworksCelebration();

  const autoAppliedDefaultRef = React.useRef<Map<string, string>>(new Map());
  const identityApplyCountRef = React.useRef(0);

  const beginIdentityApply = React.useCallback(() => {
    identityApplyCountRef.current += 1;
    if (mountedRef.current) {
      setIsSettingIdentity(true);
    }
  }, []);

  const endIdentityApply = React.useCallback(() => {
    identityApplyCountRef.current = Math.max(0, identityApplyCountRef.current - 1);
    if (mountedRef.current && identityApplyCountRef.current === 0) {
      setIsSettingIdentity(false);
    }
  }, []);

  const [revertingPaths, setRevertingPaths] = React.useState<Set<string>>(new Set());
  const [movingChangePaths, setMovingChangePaths] = React.useState<Set<string>>(new Set());
  const [isRevertingAll, setIsRevertingAll] = React.useState(false);
  const [mobileVisibleChangePaths, setMobileVisibleChangePaths] = React.useState<string[]>([]);
  const [integrateRefreshKey, setIntegrateRefreshKey] = React.useState(0);
  const [isUpdateBranchDialogOpen, setIsUpdateBranchDialogOpen] = React.useState(false);
  const hasPendingIndexMutation = movingChangePaths.size > 0 || gitIndexMutationQueue.size() > 0 || gitIndexMutationQueue.isRunning();

  const scrollActionPanelToBottom = React.useCallback(() => {
    const scrollTarget = actionPanelScrollRef.current;
    if (!scrollTarget) return;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollTarget.scrollTo({ top: scrollTarget.scrollHeight, behavior: 'smooth' });
      });
    });
  }, []);

  const {
    expandedCommitHashes,
    commitFilesMap,
    loadingCommitHashes,
    handleCopyCommitHash,
    handleToggleCommit,
  } = useGitCommitFiles(currentDirectory, git);

  const {
    conflictDialogOpen,
    setConflictDialogOpen,
    conflictFiles,
    setConflictFiles,
    conflictOperation,
    setConflictOperation,
    persistConflictState,
    clearConflictState,
  } = useGitConflictState({ currentSessionId, currentDirectory });

  const [remotes, setRemotes] = React.useState<GitRemote[]>([]);
  const [remoteUrl, setRemoteUrl] = React.useState<string | null>(null);
  const [removingRemoteName, setRemovingRemoteName] = React.useState<string | null>(null);
  const [branchOperation, setBranchOperation] = React.useState<BranchOperation>(null);
  const [operationLogs, setOperationLogs] = React.useState<OperationLogEntry[]>([]);
  const [graphLog, setGraphLog] = React.useState<import('@/lib/api/types').GitLogResponse | null>(null);
  const [graphLogLoading, setGraphLogLoading] = React.useState(false);
  const [graphLogMaxCount, setGraphLogMaxCount] = React.useState(100);
  const [graphLogRefreshToken, setGraphLogRefreshToken] = React.useState(0);
  const [gitLogDialogMode, setGitLogDialogMode] = React.useState<GitLogDialogMode | null>(null);
  const [historyBranchDivider, setHistoryBranchDivider] = React.useState<HistoryBranchDivider>(null);
  const [stashDialogOpen, setStashDialogOpen] = React.useState(false);
  const [stashDialogOperation, setStashDialogOperation] = React.useState<'merge' | 'rebase'>('merge');
  const [stashDialogBranch, setStashDialogBranch] = React.useState('');

  React.useEffect(() => {
    if (!currentDirectory) return;
    rememberGitViewSnapshot(currentDirectory, {
      directory: currentDirectory,
      commitMessage,
    });
  }, [commitMessage, currentDirectory]);

  React.useEffect(() => {
    if (!isActive) return;
    loadProfiles();
    loadGlobalIdentity();
    loadDefaultGitIdentityId();
  }, [isActive, loadProfiles, loadGlobalIdentity, loadDefaultGitIdentityId]);

  React.useEffect(() => {
    if (!isActive) return;
    if (!currentDirectory || !git?.getRemoteUrl) {
      setRemoteUrl(null);
      return;
    }
    let cancelled = false;
    git
      .getRemoteUrl(currentDirectory)
      .then((url) => { if (!cancelled) setRemoteUrl(url); })
      .catch(() => { if (!cancelled) setRemoteUrl(null); });
    return () => { cancelled = true; };
  }, [isActive, currentDirectory, git]);

  const refreshRemotes = React.useCallback(async () => {
    if (!currentDirectory || !git?.getRemotes) {
      setRemotes([]);
      return;
    }
    try {
      const remoteList = await git.getRemotes(currentDirectory);
      if (mountedRef.current) {
        setRemotes(remoteList);
      }
    } catch {
      if (mountedRef.current) {
        setRemotes([]);
      }
    }
  }, [currentDirectory, git]);

  React.useEffect(() => {
    if (!isActive) return;
    void refreshRemotes();
  }, [isActive, refreshRemotes]);

  React.useEffect(() => {
    if (!isActive) return;
    if (currentDirectory) {
      setActiveDirectory(currentDirectory);
      void ensureAll(currentDirectory, git);
    }
  }, [isActive, currentDirectory, setActiveDirectory, ensureAll, git]);

  React.useEffect(() => {
    if (!isActive) return;
    if (!currentDirectory) {
      return;
    }

    return sessionEvents.onGitRefreshHint((hint) => {
      if (normalizePath(hint.directory) !== normalizePath(currentDirectory)) {
        return;
      }
      if (hint.paths?.length) {
        clearDiffCache(currentDirectory, hint.paths);
      }
      void fetchStatus(currentDirectory, git, { silent: true });
    });
  }, [isActive, clearDiffCache, currentDirectory, fetchStatus, git]);

  const refreshStatusAndBranches = React.useCallback(
    async (showErrors = true) => {
      if (!currentDirectory) return;

      try {
        await Promise.all([
          fetchStatus(currentDirectory, git),
          fetchBranches(currentDirectory, git),
        ]);
      } catch (err) {
        if (showErrors) {
          const message =
            err instanceof Error ? err.message : "Failed to refresh repository";
          toast.error(message);
        }
      }
    },
    [currentDirectory, git, fetchStatus, fetchBranches]
  );

  const refreshLog = React.useCallback(async () => {
    if (!currentDirectory) return;
    await fetchLog(currentDirectory, git, logMaxCountLocal);
  }, [currentDirectory, git, fetchLog, logMaxCountLocal]);

  const refreshIdentity = React.useCallback(async () => {
    if (!currentDirectory) return;
    await fetchIdentity(currentDirectory, git);
  }, [currentDirectory, git, fetchIdentity]);

  React.useEffect(() => {
    if (!isActive) return;
    if (!currentDirectory) return;
    if (!git?.hasLocalIdentity) return;
    if (isGitRepo !== true) return;

    const defaultId = typeof defaultGitIdentityId === 'string' ? defaultGitIdentityId.trim() : '';
    if (!defaultId || defaultId === 'global') return;

    const previousAttempt = autoAppliedDefaultRef.current.get(currentDirectory);
    if (previousAttempt === defaultId) return;

    let cancelled = false;

    const run = async () => {
      try {
        const hasLocal = await git.hasLocalIdentity?.(currentDirectory);
        if (cancelled) return;
        if (hasLocal === true) return;

        beginIdentityApply();
        await git.setGitIdentity(currentDirectory, defaultId);
        autoAppliedDefaultRef.current.set(currentDirectory, defaultId);
        await refreshIdentity();
      } catch (error) {
        console.warn('Failed to auto-apply default git identity:', error);
      } finally {
        if (!cancelled) {
          endIdentityApply();
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [isActive, beginIdentityApply, currentDirectory, defaultGitIdentityId, endIdentityApply, git, isGitRepo, refreshIdentity]);

  const changeEntries = React.useMemo(() => {
    if (!status) return [];
    const files = status.files ?? [];
    // GitStatus.files is already unique by `path` per the server contract;
    // a defensive dedup pass would only mask real upstream bugs.
    return [...files].sort((a, b) => a.path.localeCompare(b.path));
  }, [status]);

  const stagedChangeEntries = React.useMemo(
    () => changeEntries.filter(isStagedStatusFile),
    [changeEntries]
  );

  const unstagedChangeEntries = React.useMemo(
    () => changeEntries.filter(isUnstagedStatusFile),
    [changeEntries]
  );

  React.useEffect(() => {
    if (!currentDirectory || changeEntries.length === 0) {
      return;
    }

    const orderedPaths: string[] = [];
    const seen = new Set<string>();

    const pushPath = (path: string) => {
      if (!path || seen.has(path)) {
        return;
      }
      seen.add(path);
      orderedPaths.push(path);
    };

    stagedChangeEntries.forEach((entry) => pushPath(entry.path));
    if (chrome === 'mobile') {
      mobileVisibleChangePaths.forEach(pushPath);
    }
    changeEntries.slice(0, GIT_DIFF_PRIORITY_BASELINE_LIMIT).forEach((entry) => pushPath(entry.path));

    if (orderedPaths.length === 0) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void prefetchDiffs(currentDirectory, git, orderedPaths, { maxFiles: GIT_DIFF_PRIORITY_PREFETCH_LIMIT });
    }, 120);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [changeEntries, chrome, currentDirectory, git, mobileVisibleChangePaths, prefetchDiffs, stagedChangeEntries]);

  const getPushedRemoteName = (result?: Awaited<ReturnType<typeof git.gitPush>>) => {
    return result?.pushed[0]?.remote
      || status?.tracking?.split('/')[0]
      || effectiveRemotes.find((remote) => remote.name === 'origin')?.name
      || effectiveRemotes[0]?.name
      || 'origin';
  };

  const handleSyncAction = async (action: Exclude<SyncAction, null>, remote?: GitRemote) => {
    if (!currentDirectory) return;
    setSyncAction(action);

    try {
      const getPullOptions = (pullRemote: GitRemote) => {
        const trackingPrefix = `${pullRemote.name}/`;
        const trackedBranch = status?.tracking?.startsWith(trackingPrefix)
          ? status.tracking.slice(trackingPrefix.length)
          : undefined;
        return {
          remote: pullRemote.name,
          branch: trackedBranch,
          rebase: true,
        };
      };

      if (action === 'fetch') {
        if (!remote) {
          throw new Error('No remote available for fetch');
        }
        await git.gitFetch(currentDirectory, { remote: remote.name });
        toast.success(`Fetched from ${remote.name}`);
      } else if (action === 'pull') {
        if (!remote) {
          throw new Error('No remote available for pull');
        }
        const result = await git.gitPull(currentDirectory, getPullOptions(remote));
        toast.success(
          result.files.length === 1
            ? `Pulled ${result.files.length} file from ${remote.name}`
            : `Pulled ${result.files.length} files from ${remote.name}`
        );
      } else if (action === 'push') {
        const result = await git.gitPush(currentDirectory);
        toast.success(`Pushed to ${getPushedRemoteName(result)}`);
      } else if (action === 'sync') {
        if (!remote) {
          throw new Error('No remote available for sync');
        }
        let pulledFileCount = 0;
        let pushedChanges = false;
        await git.gitFetch(currentDirectory, { remote: remote.name });
        const afterFetch = await git.getGitStatus(currentDirectory);

        if ((afterFetch.behind ?? 0) > 0) {
          if ((afterFetch.files?.length ?? 0) > 0) {
            toast.error("Commit or stash your changes before syncing");
            return;
          }
          const pullResult = await git.gitPull(currentDirectory, getPullOptions(remote));
          pulledFileCount = pullResult.files.length;
        }

        const afterPull = await git.getGitStatus(currentDirectory);
        if ((afterPull.ahead ?? 0) > 0) {
          await git.gitPush(currentDirectory);
          pushedChanges = true;
        }
        if (pulledFileCount > 0 && pushedChanges) {
          toast.success(
            pulledFileCount === 1
              ? `Pulled ${pulledFileCount} file from ${remote.name} and pushed to upstream`
              : `Pulled ${pulledFileCount} files from ${remote.name} and pushed to upstream`
          );
        } else if (pulledFileCount > 0) {
          toast.success(
            pulledFileCount === 1
              ? `Pulled ${pulledFileCount} file from ${remote.name}`
              : `Pulled ${pulledFileCount} files from ${remote.name}`
          );
        } else if (pushedChanges) {
          toast.success(`Pushed to ${remote.name}`);
        } else {
          toast.success("Already up to date");
        }
      }

      await refreshStatusAndBranches(false);
      await refreshLog();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : `${action === 'sync' ? 'Sync Changes' : action === 'pull' ? 'Pull' : action} failed`;
      toast.error(message);
    } finally {
      setSyncAction(null);
    }
  };

  const loadMobileDiff = React.useCallback(async (path: string, staged: boolean) => {
    if (!currentDirectory) {
      throw new Error('No active directory');
    }

    const response = await git.getGitFileDiff(currentDirectory, {
      path,
      staged: staged || undefined,
    });
    return {
      original: response.original ?? '',
      modified: response.modified ?? '',
      isBinary: response.isBinary,
    };
  }, [currentDirectory, git]);

  const handleRemoveRemote = React.useCallback(async (remote: GitRemote) => {
    if (!currentDirectory) return;

    const remoteName = remote.name.trim();
    if (!remoteName) {
      toast.error("Remote name is required");
      return;
    }
    if (remoteName === 'origin') {
      toast.error("Cannot remove the origin remote");
      return;
    }

    setRemovingRemoteName(remoteName);
    try {
      await git.removeRemote(currentDirectory, { remote: remoteName });
      toast.success(`Removed remote ${remoteName}`);
      await Promise.all([
        refreshStatusAndBranches(false),
        refreshRemotes(),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to remove ${remoteName}`;
      toast.error(message);
    } finally {
      setRemovingRemoteName(null);
    }
  }, [currentDirectory, git, refreshRemotes, refreshStatusAndBranches]);

  const handleCommit = async (options: { pushAfter?: boolean } = {}) => {
    if (!currentDirectory) return;
    if (!commitMessage.trim()) {
      toast.error("Enter a commit message");
      return;
    }

    const filesToCommit = stagedChangeEntries.map((file) => file.path).sort();
    if (filesToCommit.length === 0) {
      toast.error("Stage at least one file to commit");
      return;
    }

    const action: CommitAction = options.pushAfter ? 'commitAndPush' : 'commit';
    setCommitAction(action);

    try {
      await git.createGitCommit(currentDirectory, commitMessage.trim(), {
        files: filesToCommit,
        stageFiles: [],
      });
      bumpIndexRevision(currentDirectory);
      toast.success("Commit created");
      setCommitMessage('');

      await refreshStatusAndBranches();

      if (options.pushAfter) {
        const trackingRemoteName = status?.tracking?.split('/')[0];
        const remote = effectiveRemotes.find((entry) => entry.name === trackingRemoteName) ?? effectiveRemotes[0];
        if (!remote) {
          throw new Error("No remote available");
        }

        setSyncAction('sync');
        const trackingPrefix = `${remote.name}/`;
        const trackedBranch = status?.tracking?.startsWith(trackingPrefix)
          ? status.tracking.slice(trackingPrefix.length)
          : undefined;

        await git.gitFetch(currentDirectory, { remote: remote.name });
        const afterFetch = await git.getGitStatus(currentDirectory);
        if ((afterFetch.behind ?? 0) > 0) {
          if ((afterFetch.files?.length ?? 0) > 0) {
            toast.error("Commit or stash your changes before syncing");
            await refreshStatusAndBranches(false);
            return;
          }
          await git.gitPull(currentDirectory, { remote: remote.name, branch: trackedBranch, rebase: true });
        }

        const afterPull = await git.getGitStatus(currentDirectory);
        let result: Awaited<ReturnType<typeof git.gitPush>> | undefined;
        if ((afterPull.ahead ?? 0) > 0) {
          result = await git.gitPush(currentDirectory);
        }
        toast.success(`Pushed to ${getPushedRemoteName(result)}`);
        if (chrome !== 'mobile') {
          triggerFireworks();
        }
        await refreshStatusAndBranches(false);
      } else {
        await refreshStatusAndBranches(false);
      }

      await refreshLog();
      setIntegrateRefreshKey((v) => v + 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create commit";
      toast.error(message);
    } finally {
      setCommitAction(null);
      if (options.pushAfter) {
        setSyncAction(null);
      }
    }
  };

  const handleCreateBranch = async (branchName: string, remote?: GitRemote) => {
    if (!currentDirectory || !status) return;

    const checkoutBase = status.current ?? null;
    const remoteName = remote?.name ?? 'origin';

    try {
      await git.createBranch(currentDirectory, branchName, checkoutBase ?? 'HEAD');
      toast.success(`Created branch ${branchName}`);

      // Checkout the new branch and stay on it
      await git.checkoutBranch(currentDirectory, branchName);

      let pushSucceeded = false;
      try {
        await git.gitPush(currentDirectory, {
          remote: remoteName,
          branch: branchName,
          options: ['--set-upstream'],
        });
        pushSucceeded = true;
      } catch (pushError) {
        const message =
          pushError instanceof Error
            ? pushError.message
            : `Unable to push new branch to ${remoteName}.`;
        toast.warning("Branch created locally, but failed to set upstream.", {
          description: (
            <span className="text-foreground/80 dark:text-foreground/70">
              Upstream setup failed: {message}
            </span>
          ),
        });
      }

      await refreshStatusAndBranches();
      await refreshLog();

      if (pushSucceeded) {
        toast.success(`Set upstream for ${branchName} to ${remoteName}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create branch";
      toast.error(message);
      throw err;
    }
  };

  const handleRenameBranch = async (oldName: string, newName: string) => {
    if (!currentDirectory) return;

    try {
      await git.renameBranch(currentDirectory, oldName, newName);
      toast.success(`Renamed ${oldName} to ${newName}`);
      await refreshStatusAndBranches();
      await refreshLog();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : `Failed to rename ${oldName} to ${newName}`;
      toast.error(message);
    }
  };

  const handleCheckoutBranch = async (branch: string) => {
    if (!currentDirectory) return;

    const normalized = branch.replace(/^remotes\//, '');

    if (status?.current === normalized) {
      return;
    }

    try {
      await git.checkoutBranch(currentDirectory, normalized);
      toast.success(`Checked out ${normalized}`);
      await refreshStatusAndBranches();
      await refreshLog();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : `Failed to checkout ${normalized}`;
      toast.error(message);
    }
  };

  const handleApplyIdentity = async (profile: GitIdentityProfile) => {
    if (!currentDirectory) return;
    beginIdentityApply();

    try {
      await git.setGitIdentity(currentDirectory, profile.id);
      toast.success(`Applied identity: ${profile.name}`);
      await refreshIdentity();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to apply identity";
      toast.error(message);
    } finally {
      endIdentityApply();
    }
  };

  const {
    localBranches,
    remoteBranches,
    effectiveRemotes,
    currentBranch,
    defaultBranch,
    baseBranch,
    branchScopeAvailable,
    updateTargetBranch,
  } = useGitBranchScope({
    branches,
    status,
    remotes,
    remoteUrl,
    git,
  });

  const { availableIdentities, activeIdentityProfile } = useGitIdentities({
    profiles,
    globalIdentity,
    currentIdentity,
    remoteUrl,
  });

  const stagedCount = stagedChangeEntries.length;
  const isBusy = isLoading || syncAction !== null || commitAction !== null;
  const canShowBranchWorkflows = Boolean(currentBranch);

  React.useEffect(() => {
    if (!currentDirectory || !git || !log?.all?.length || !currentBranch || !baseBranch || currentBranch === baseBranch) {
      setHistoryBranchDivider(null);
      return;
    }

    let cancelled = false;

    const resolveBranchDivider = async () => {
      try {
        const branchOnlyLog = await git.getGitLog(currentDirectory, {
          from: baseBranch,
          to: 'HEAD',
          maxCount: logMaxCountLocal,
        });

        if (cancelled) {
          return;
        }

        const branchHashes = new Set(
          (branchOnlyLog?.all ?? [])
            .map((entry) => entry.hash)
            .filter((hash) => typeof hash === 'string' && hash.length > 0)
        );

        if (branchHashes.size === 0) {
          setHistoryBranchDivider(null);
          return;
        }

        const insertBeforeIndex = log.all.findIndex((entry) => !branchHashes.has(entry.hash));
        if (insertBeforeIndex === 0) {
          setHistoryBranchDivider(null);
          return;
        }

        if (insertBeforeIndex === -1) {
          setHistoryBranchDivider({
            insertBeforeIndex: log.all.length,
            branchName: currentBranch,
            direction: 'up',
          });
          return;
        }

        setHistoryBranchDivider({
          insertBeforeIndex,
          branchName: currentBranch,
          direction: 'up',
        });
      } catch {
        if (!cancelled) {
          setHistoryBranchDivider(null);
        }
      }
    };

    void resolveBranchDivider();

    return () => {
      cancelled = true;
    };
  }, [baseBranch, currentBranch, currentDirectory, git, log, logMaxCountLocal]);

  // Clear graph log when directory changes
  React.useEffect(() => {
    setGraphLog(null);
  }, [currentDirectory]);

  React.useEffect(() => {
    if (gitLogDialogMode !== 'graph' || !currentDirectory) {
      if (gitLogDialogMode !== 'graph') setGraphLog(null);
      return;
    }
    let cancelled = false;
    setGraphLogLoading(true);
    git.getGitLog(currentDirectory, { maxCount: graphLogMaxCount, all: true })
      .then((result) => {
        if (!cancelled) setGraphLog(result);
      })
      .catch((err) => {
        console.error('Failed to fetch graph log:', err);
      })
      .finally(() => {
        if (!cancelled) setGraphLogLoading(false);
      });
    return () => { cancelled = true; };
  }, [gitLogDialogMode, currentDirectory, graphLogMaxCount, graphLogRefreshToken, git]);

  // Keep these sections stable in layout; individual cards render placeholders when unavailable.

  const moveChangePaths = React.useCallback((paths: string[], direction: GitIndexMutationDirection) => {
    if (!currentDirectory || paths.length === 0) return;
    const uniquePaths = Array.from(new Set(paths));
    setMovingChangePaths((previous) => {
      const next = new Set(previous);
      uniquePaths.forEach((path) => next.add(path));
      return next;
    });
    const previousStatus = moveStatusPathsOptimistically(currentDirectory, uniquePaths, direction);

    gitIndexMutationQueue.enqueue({
      directory: currentDirectory,
      direction,
      paths: new Set(uniquePaths),
      rollback: () => restoreStatus(currentDirectory, previousStatus),
    });

    scheduleGitMutationFlush();
  }, [currentDirectory, gitIndexMutationQueue, moveStatusPathsOptimistically, restoreStatus, scheduleGitMutationFlush]);

  const handleRevertFile = React.useCallback(
    async (filePath: string) => {
      if (!currentDirectory) return;

      setRevertingPaths((previous) => {
        const next = new Set(previous);
        next.add(filePath);
        return next;
      });

      try {
        await git.revertGitFile(currentDirectory, filePath, { scope: 'working' });
        toast.success(`Reverted ${filePath}`);
        await refreshStatusAndBranches(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to revert changes";
        toast.error(message);
      } finally {
        setRevertingPaths((previous) => {
          const next = new Set(previous);
          next.delete(filePath);
          return next;
        });
      }
    },
    [currentDirectory, refreshStatusAndBranches, git]
  );

  const handleRevertPaths = React.useCallback(
    async (paths: string[], setGlobalReverting: boolean, scope: 'all' | 'working' = 'all') => {
      if (!currentDirectory || paths.length === 0) {
        return;
      }

      const uniquePaths = Array.from(new Set(paths));
      if (isRevertingAll || uniquePaths.some((path) => revertingPaths.has(path))) {
        return;
      }

      const stagedPaths = new Set(stagedChangeEntries.map((entry) => entry.path));
      const touchesStagedIndex = scope === 'all' && uniquePaths.some((path) => stagedPaths.has(path));

      if (setGlobalReverting) {
        setIsRevertingAll(true);
      }
      setRevertingPaths((previous) => {
        const next = new Set(previous);
        uniquePaths.forEach((path) => next.add(path));
        return next;
      });

      const failed: Array<{ path: string; message: string }> = [];

      try {
        await Promise.all(uniquePaths.map(async (filePath) => {
          try {
            await git.revertGitFile(currentDirectory, filePath, { scope });
          } catch (err) {
            failed.push({
              path: filePath,
              message: err instanceof Error ? err.message : "Failed to revert changes",
            });
          }
        }));

        if (touchesStagedIndex && failed.length < uniquePaths.length) {
          bumpIndexRevision(currentDirectory);
        }

        await refreshStatusAndBranches(false);

        if (failed.length === 0) {
          toast.success(
            uniquePaths.length === 1
              ? `Reverted ${uniquePaths.length} file`
              : `Reverted ${uniquePaths.length} files`
          );
        } else if (failed.length === uniquePaths.length) {
          toast.error(failed[0]?.message || "Failed to revert changes");
        } else {
          const successCount = uniquePaths.length - failed.length;
          toast.warning(
            successCount === 1
              ? `Reverted ${successCount} file, ${failed.length} failed`
              : `Reverted ${successCount} files, ${failed.length} failed`
          );
        }
      } finally {
        setRevertingPaths((previous) => {
          const next = new Set(previous);
          uniquePaths.forEach((path) => next.delete(path));
          return next;
        });
        if (setGlobalReverting) {
          setIsRevertingAll(false);
        }
      }
    },
    [bumpIndexRevision, currentDirectory, git, isRevertingAll, refreshStatusAndBranches, revertingPaths, stagedChangeEntries]
  );

  const handleRevertAll = React.useCallback(
    async (paths: string[]) => {
      await handleRevertPaths(paths, true);
    },
    [handleRevertPaths]
  );

  const handleRevertDirectory = React.useCallback(
    async (paths: string[]) => {
      await handleRevertPaths(paths, false, 'working');
    },
    [handleRevertPaths]
  );

  const openStashes = React.useCallback(() => setIsStashesDialogOpen(true), []);

  const handleSelectGitmoji = React.useCallback((emoji: string, code: string) => {
    const token = code || emoji;
    setCommitMessage((current) => {
      const trimmed = current.trimStart();
      if (trimmed.startsWith(emoji) || (code && trimmed.startsWith(code))) {
        return current;
      }
      const prefix = token.endsWith(' ') ? token : `${token} `;
      return `${prefix}${current}`.trimStart();
    });
    setIsGitmojiPickerOpen(false);
  }, []);



  const isUncommittedChangesError = React.useCallback((error: unknown): boolean => {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    return (
      message.includes('uncommitted changes') ||
      message.includes('local changes') ||
      message.includes('your local changes would be overwritten') ||
      message.includes('please commit your changes or stash them') ||
      message.includes('cannot rebase: you have unstaged changes') ||
      message.includes('error: cannot pull with rebase')
    );
  }, []);

  // Helper to add/update operation logs
  const addOperationLog = React.useCallback((message: string, status: OperationLogEntry['status']) => {
    setOperationLogs(prev => [...prev, { message, status, timestamp: Date.now() }]);
  }, []);

  const updateLastLog = React.useCallback((status: OperationLogEntry['status'], message?: string) => {
    setOperationLogs(prev => {
      if (prev.length === 0) return prev;
      const updated = [...prev];
      updated[updated.length - 1] = {
        ...updated[updated.length - 1],
        status,
        ...(message ? { message } : {}),
      };
      return updated;
    });
  }, []);

  // Called at start of operation to reset logs
  const resetOperationLogs = React.useCallback(() => {
    setOperationLogs([]);
  }, []);

  // Called when dialog is closed to fully reset state
  const handleOperationComplete = React.useCallback(() => {
    setOperationLogs([]);
    setBranchOperation(null);
  }, []);

  const resolveIntegrationTarget = React.useCallback((branch: string) => {
    const trimmed = branch.trim();
    const knownRemoteNames = new Set(effectiveRemotes.map((remote) => remote.name));
    const slashIndex = trimmed.indexOf('/');

    if (slashIndex > 0) {
      const remote = trimmed.slice(0, slashIndex);
      const remoteBranch = trimmed.slice(slashIndex + 1);
      if (knownRemoteNames.has(remote) && remoteBranch) {
        return { branch: trimmed, remote, remoteBranch };
      }
    }

    for (const remote of effectiveRemotes) {
      const remoteCandidate = `${remote.name}/${trimmed}`;
      if (remoteBranches.includes(remoteCandidate)) {
        return { branch: remoteCandidate, remote: remote.name, remoteBranch: trimmed };
      }
    }

    return { branch: trimmed, remote: null, remoteBranch: null };
  }, [effectiveRemotes, remoteBranches]);

  const handleMerge = React.useCallback(
    async (branch: string) => {
      if (!currentDirectory) return;
      setBranchOperation('merge');
      resetOperationLogs();

      const currentBranch = status?.current;

      const target = resolveIntegrationTarget(branch);

      try {
        if (target.remote && target.remoteBranch) {
          addOperationLog(`Fetching ${target.remote}/${target.remoteBranch}...`, 'running');
          await git.gitFetch(currentDirectory, { remote: target.remote, branch: target.remoteBranch });
          updateLastLog('done', `Fetched ${target.remote}/${target.remoteBranch}`);
        }

        addOperationLog(`Merging ${target.branch} into ${currentBranch}...`, 'running');
        const result = await git.merge(currentDirectory, { branch: target.branch });

        if (result.conflict) {
          updateLastLog('error', `Merge conflicts detected`);
          setConflictFiles(result.conflictFiles ?? []);
          setConflictOperation('merge');
          setConflictDialogOpen(true);
          persistConflictState(currentDirectory, result.conflictFiles ?? [], 'merge');
        } else {
          updateLastLog('done', `Merged ${target.branch} into ${currentBranch}`);
          clearConflictState();
          addOperationLog('Refreshing repository status...', 'running');
          await refreshStatusAndBranches();
          await refreshLog();
          updateLastLog('done', 'Repository status updated');
        }
      } catch (err) {
        if (isUncommittedChangesError(err)) {
          updateLastLog('error', 'Uncommitted changes detected');
          setStashDialogOperation('merge');
          setStashDialogBranch(target.branch);
          setStashDialogOpen(true);
        } else {
          const message = err instanceof Error ? err.message : `Failed to merge ${target.branch}`;
          updateLastLog('error', message);
        }
      }
      // Note: branchOperation is cleared when dialog closes via handleOperationComplete
    },
    [currentDirectory, git, status, resolveIntegrationTarget, refreshStatusAndBranches, refreshLog, isUncommittedChangesError, persistConflictState, clearConflictState, addOperationLog, updateLastLog, resetOperationLogs]
  );

  const handleRebase = React.useCallback(
    async (branch: string) => {
      if (!currentDirectory) return;
      setBranchOperation('rebase');
      resetOperationLogs();

      const currentBranch = status?.current;

      const target = resolveIntegrationTarget(branch);

      try {
        if (target.remote && target.remoteBranch) {
          addOperationLog(`Fetching ${target.remote}/${target.remoteBranch}...`, 'running');
          await git.gitFetch(currentDirectory, { remote: target.remote, branch: target.remoteBranch });
          updateLastLog('done', `Fetched ${target.remote}/${target.remoteBranch}`);
        }

        addOperationLog(`Rebasing ${currentBranch} onto ${target.branch}...`, 'running');
        const result = await git.rebase(currentDirectory, { onto: target.branch });

        if (result.conflict) {
          updateLastLog('error', `Rebase conflicts detected`);
          setConflictFiles(result.conflictFiles ?? []);
          setConflictOperation('rebase');
          setConflictDialogOpen(true);
          persistConflictState(currentDirectory, result.conflictFiles ?? [], 'rebase');
        } else {
          updateLastLog('done', `Rebased ${currentBranch} onto ${target.branch}`);
          clearConflictState();
          addOperationLog('Refreshing repository status...', 'running');
          await refreshStatusAndBranches();
          await refreshLog();
          updateLastLog('done', 'Repository status updated');
        }
      } catch (err) {
        if (isUncommittedChangesError(err)) {
          updateLastLog('error', 'Uncommitted changes detected');
          setStashDialogOperation('rebase');
          setStashDialogBranch(target.branch);
          setStashDialogOpen(true);
        } else {
          const message = err instanceof Error ? err.message : `Failed to rebase onto ${target.branch}`;
          updateLastLog('error', message);
        }
      }
      // Note: branchOperation is cleared when dialog closes via handleOperationComplete
    },
    [currentDirectory, git, status, resolveIntegrationTarget, refreshStatusAndBranches, refreshLog, isUncommittedChangesError, persistConflictState, clearConflictState, addOperationLog, updateLastLog, resetOperationLogs]
  );

  const handleAbortConflict = React.useCallback(async () => {
    if (!currentDirectory) return;

    try {
      if (conflictOperation === 'merge') {
        await git.abortMerge(currentDirectory);
        toast.success("Merge aborted");
      } else {
        await git.abortRebase(currentDirectory);
        toast.success("Rebase aborted");
      }
      clearConflictState();
      await refreshStatusAndBranches();
      await refreshLog();
    } catch (err) {
      const message = err instanceof Error ? err.message : `Failed to abort ${conflictOperation}`;
      toast.error(message);
    }
  }, [currentDirectory, git, conflictOperation, refreshStatusAndBranches, refreshLog, clearConflictState]);

  // Count unresolved conflicts (files with 'U' status)
  const conflictCount = React.useMemo(() => {
    if (!status?.files) return 0;
    return status.files.filter((f) =>
      (f.index === 'U' || f.working_dir === 'U') ||
      (f.index === 'A' && f.working_dir === 'A') ||
      (f.index === 'D' && f.working_dir === 'D')
    ).length;
  }, [status?.files]);

  const handleContinueOperation = React.useCallback(async () => {
    if (!currentDirectory) return;

    try {
      const isMerge = !!status?.mergeInProgress?.head;
      const isRebase = !!(status?.rebaseInProgress?.headName || status?.rebaseInProgress?.onto);

      if (isMerge) {
        const result = await git.continueMerge(currentDirectory);
        if (result.conflict) {
          setConflictFiles(result.conflictFiles ?? []);
          setConflictOperation('merge');
          setConflictDialogOpen(true);
          persistConflictState(currentDirectory, result.conflictFiles ?? [], 'merge');
          toast.error("Merge conflicts detected");
        } else {
          clearConflictState();
          toast.success("Merge completed");
          await refreshStatusAndBranches();
          await refreshLog();
        }
      } else if (isRebase) {
        const result = await git.continueRebase(currentDirectory);
        if (result.conflict) {
          setConflictFiles(result.conflictFiles ?? []);
          setConflictOperation('rebase');
          setConflictDialogOpen(true);
          persistConflictState(currentDirectory, result.conflictFiles ?? [], 'rebase');
          toast.error("Rebase conflicts detected");
        } else {
          clearConflictState();
          toast.success("Rebase step completed");
          await refreshStatusAndBranches();
          await refreshLog();
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to continue operation";
      toast.error(message);
    }
  }, [currentDirectory, git, status, refreshStatusAndBranches, refreshLog, persistConflictState, clearConflictState]);

  const handleAbortOperation = React.useCallback(async () => {
    if (!currentDirectory) return;

    try {
      const isMerge = !!status?.mergeInProgress?.head;
      if (isMerge) {
        await git.abortMerge(currentDirectory);
        toast.success("Merge aborted");
      } else {
        await git.abortRebase(currentDirectory);
        toast.success("Rebase aborted");
      }
      clearConflictState();
      await refreshStatusAndBranches();
      await refreshLog();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to abort operation";
      toast.error(message);
    }
  }, [currentDirectory, git, status, refreshStatusAndBranches, refreshLog, clearConflictState]);

  const handleResolveWithAIFromBanner = React.useCallback(() => {
    if (!currentDirectory) return;

    // Determine operation type from status
    const isMerge = !!status?.mergeInProgress?.head;
    const operation = isMerge ? 'merge' : 'rebase';

    // Get conflict files from status (files with 'U' status indicate unmerged/conflicted)
    const filesWithConflicts = status?.files
      ?.filter((f) => f.index === 'U' || f.working_dir === 'U')
      .map((f) => f.path) ?? [];

    // Update conflict state and open dialog
    if (filesWithConflicts.length > 0) {
      setConflictFiles(filesWithConflicts);
    }
    setConflictOperation(operation);
    setConflictDialogOpen(true);
  }, [currentDirectory, status]);

  const handleStashAndRetry = React.useCallback(
    async (restoreAfter: boolean) => {
      if (!currentDirectory) return;

      const currentBranch = status?.current;
      const operation = stashDialogOperation;
      const branch = stashDialogBranch;
      const hadStagedChanges = (status?.files ?? []).some(isStagedStatusFile);

      // Stash changes
      try {
        await git.stash(currentDirectory, {
          message: `Auto-stash before ${operation} with ${branch}`,
          includeUntracked: true,
        });
        if (hadStagedChanges) {
          bumpIndexRevision(currentDirectory);
        }
      } catch (stashErr) {
        const msg = stashErr instanceof Error ? stashErr.message : 'Failed to stash changes';
        toast.error(msg);
        return;
      }

      let operationSucceeded = false;
      let hasConflict = false;

      try {
        // Perform the operation
        if (operation === 'merge') {
          const result = await git.merge(currentDirectory, { branch });
          if (result.conflict) {
            hasConflict = true;
            setConflictFiles(result.conflictFiles ?? []);
            setConflictOperation('merge');
            setConflictDialogOpen(true);
          } else {
            operationSucceeded = true;
            toast.success(`Merged ${branch} into ${currentBranch || ''}`);
          }
        } else {
          const result = await git.rebase(currentDirectory, { onto: branch });
          if (result.conflict) {
            hasConflict = true;
            setConflictFiles(result.conflictFiles ?? []);
            setConflictOperation('rebase');
            setConflictDialogOpen(true);
          } else {
            operationSucceeded = true;
            toast.success(`Rebased ${currentBranch || ''} onto ${branch}`);
          }
        }

        // Restore stashed changes if requested and operation succeeded
        if (restoreAfter && operationSucceeded) {
          try {
            await git.stashPop(currentDirectory);
            bumpIndexRevision(currentDirectory);
            toast.success("Stashed changes restored");
          } catch (popErr) {
            const popMessage = popErr instanceof Error ? popErr.message : "Failed to restore stash";
            toast.error(popMessage);
          }
        } else if (restoreAfter && hasConflict) {
          toast.info("Stash restored manually required");
        }

        await refreshStatusAndBranches();
        await refreshLog();
      } catch (err) {
        // If the operation failed (not due to conflicts), try to restore stash
        if (restoreAfter) {
          try {
            await git.stashPop(currentDirectory);
            bumpIndexRevision(currentDirectory);
          } catch {
            // Ignore stash pop errors in this case
          }
        }
        throw err;
      }
    },
    [bumpIndexRevision, currentDirectory, git, status, stashDialogOperation, stashDialogBranch, refreshStatusAndBranches, refreshLog]
  );

  const handleLogMaxCountChange = React.useCallback(
    (count: number) => {
      setLogMaxCountLocal(count);
      if (currentDirectory) {
        setLogMaxCount(currentDirectory, count);
        fetchLog(currentDirectory, git, count);
      }
    },
    [currentDirectory, fetchLog, git, setLogMaxCount]
  );

  const handleGraphLogMaxCountChange = React.useCallback((count: number) => {
    setGraphLogMaxCount(count);
  }, []);

  const handleGraphActionSuccess = React.useCallback(() => {
    setGitLogDialogMode(null);
    if (currentDirectory) {
      fetchStatus(currentDirectory, git);
      fetchBranches(currentDirectory, git);
      fetchLog(currentDirectory, git, logMaxCountLocal);
    }
  }, [currentDirectory, fetchStatus, fetchBranches, fetchLog, logMaxCountLocal, git]);

  const handleGraphConflict = React.useCallback((result: {
    conflict: boolean;
    conflictFiles?: string[];
    operation: 'cherry-pick' | 'revert' | 'merge' | 'rebase';
  }) => {
    if (!result.conflict) return;

    if (result.operation === 'cherry-pick' || result.operation === 'revert') {
      // Cherry-pick and revert conflicts are not supported by the shared ConflictDialog
      // Show a toast with manual resolution instructions
      toast.error("Conflict", {
        description: `Conflicts in: ${result.conflictFiles?.join(', ') ?? 'unknown files'}. Resolve manually and commit, or abort with git cherry-pick/revert --abort.`,
      });
      if (currentDirectory) {
        fetchStatus(currentDirectory, git);
        fetchBranches(currentDirectory, git);
        fetchLog(currentDirectory, git, logMaxCountLocal);
      }
      return;
    }

    setConflictFiles(result.conflictFiles ?? []);
    setConflictOperation(result.operation);
    setConflictDialogOpen(true);
    if (currentDirectory) {
      persistConflictState(currentDirectory, result.conflictFiles ?? [], result.operation);
    }
  }, [ setConflictFiles, setConflictOperation, setConflictDialogOpen, persistConflictState, currentDirectory, fetchStatus, fetchBranches, fetchLog, logMaxCountLocal, git]);

  if (chrome === 'mobile') {
    return (
      <MobileGitChrome
        currentDirectory={currentDirectory ?? null}
        status={status}
        isGitRepo={isGitRepo}
        isLoadingStatus={isLoading}
        changeEntries={changeEntries}
        stagedChangeEntries={stagedChangeEntries}
        unstagedChangeEntries={unstagedChangeEntries}
        effectiveRemotes={effectiveRemotes}
        syncAction={syncAction}
        commitAction={commitAction}
        commitMessage={commitMessage}
        hasPendingIndexMutation={hasPendingIndexMutation}
        revertingPaths={revertingPaths}
        isRevertingAll={isRevertingAll}
        initialDiffPath={initialDiffPath}
        initialDiffStaged={initialDiffStaged}
        onSyncAction={(action, remote) => { void handleSyncAction(action, remote); }}
        onMoveChangePaths={moveChangePaths}
        onRevertFile={(path) => { void handleRevertFile(path); }}
        onRevertAll={handleRevertAll}
        onCommitMessageChange={setCommitMessage}
        onCommit={(options) => { void handleCommit(options); }}
        onVisiblePathsChange={setMobileVisibleChangePaths}
        loadDiff={loadMobileDiff}
      />
    );
  }

  if (!currentDirectory) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center">
        <p className="typography-ui-label text-muted-foreground">
          {"Select a session or directory to view Git status"}
        </p>
      </div>
    );
  }

  if (isGitRepo === null || (isGitRepo === true && !status)) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon name="loader-4" className="size-4 animate-spin" />
          <span className="typography-ui-label">{"Checking repository..."}</span>
        </div>
      </div>
    );
  }

  if (isGitRepo === false) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <React.Suspense fallback={null}>
          <DiffView
            diffScope="turn"
            hideStackedFileSidebar
            stackedDefaultCollapsedAll
            flushContent
          />
        </React.Suspense>
      </div>
    );
  }

  return (
    <div className={cn('flex h-full flex-col overflow-hidden')}>
          <GitHeader
        status={status}
        localBranches={localBranches}
        remoteBranches={remoteBranches}
        branchInfo={branches?.branches}
        syncAction={syncAction}
        remotes={effectiveRemotes}
        onFetch={(remote) => handleSyncAction('fetch', remote)}
        onSync={(remote) => handleSyncAction('sync', remote)}
        onRemoveRemote={handleRemoveRemote}
        removingRemoteName={removingRemoteName}
        onCheckoutBranch={handleCheckoutBranch}
        onCreateBranch={handleCreateBranch}
        onRenameBranch={handleRenameBranch}
        activeIdentityProfile={activeIdentityProfile}
        availableIdentities={availableIdentities}
        onSelectIdentity={handleApplyIdentity}
        isApplyingIdentity={isSettingIdentity}
        isWorktreeMode={false}
        onOpenHistory={() => setGitLogDialogMode('history')}
        onOpenGraph={() => setGitLogDialogMode('graph')}
        onOpenStashes={openStashes}
        onOpenUpdateBranch={canShowBranchWorkflows ? () => setIsUpdateBranchDialogOpen(true) : undefined}
        pullRequest={null}
        prChecks={null}
      />

      {/* In-progress operation banner */}
      {currentDirectory && (
        (status?.mergeInProgress?.head) ||
        (status?.rebaseInProgress?.headName || status?.rebaseInProgress?.onto)
      ) && (
          <InProgressOperationBanner
            mergeInProgress={status?.mergeInProgress}
            rebaseInProgress={status?.rebaseInProgress}
            onContinue={handleContinueOperation}
            onAbort={handleAbortOperation}
            onResolveWithAI={handleResolveWithAIFromBanner}
            conflictCount={conflictCount}
            isLoading={isLoading}
          />
        )}

      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="flex h-full min-h-0 flex-col">
          {(changeEntries?.length ?? 0) > 0 || branchScopeAvailable ? (
            <>
              <div className="min-h-0 flex-1 overflow-hidden">
                <React.Suspense fallback={null}>
                  <DiffView
                    diffScope={changeEntries.length > 0 ? 'all' : 'branch'}
                    branchBase={branchScopeAvailable ? baseBranch : null}
                    branchHead={branchScopeAvailable ? currentBranch : null}
                    showOpenInEditorAction
                    hideStackedFileSidebar
                    stackedDefaultCollapsedAll
                    flushContent
                  />
                </React.Suspense>
              </div>
              {changeEntries.length > 0 ? (
                <div ref={actionPanelScrollRef} className="shrink-0 px-4 pb-4 pt-2">
                  <CommitSection
                    stagedCount={stagedCount}
                    commitMessage={commitMessage}
                    onCommitMessageChange={setCommitMessage}
                    onCommit={() => handleCommit({ pushAfter: false })}
                    onCommitAndPush={() => handleCommit({ pushAfter: true })}
                    commitAction={commitAction}
                    hasPendingIndexMutation={hasPendingIndexMutation}
                    gitmojiEnabled={settingsGitmojiEnabled}
                    onOpenGitmojiPicker={() => setIsGitmojiPickerOpen(true)}
                  />
                </div>
              ) : null}
            </>
          ) : (
            <GitEmptyState onOpenStashes={() => setIsStashesDialogOpen(true)} />
          )}
        </div>
      </div>



      <GitViewDialogs
        currentDirectory={currentDirectory}
        isUpdateBranchDialogOpen={isUpdateBranchDialogOpen}
        setIsUpdateBranchDialogOpen={setIsUpdateBranchDialogOpen}
        branchOperation={branchOperation}
        currentBranch={status?.current}
        localBranches={localBranches}
        remoteBranches={remoteBranches}
        updateTargetBranch={updateTargetBranch}
        onMerge={handleMerge}
        onRebase={handleRebase}
        isBusy={isBusy}
        operationLogs={operationLogs}
        onOperationComplete={handleOperationComplete}
        canShowBranchWorkflows={canShowBranchWorkflows}
        gitLogDialogMode={gitLogDialogMode}
        setGitLogDialogMode={setGitLogDialogMode}
        onRefreshHistory={() => {
          if (gitLogDialogMode === 'graph') {
            setGraphLogRefreshToken((token) => token + 1);
            return;
          }
          if (!currentDirectory) return;
          void fetchLog(currentDirectory, git, logMaxCountLocal);
        }}
        isLogRefreshing={gitLogDialogMode === 'graph' ? graphLogLoading : isLogLoading}
        log={gitLogDialogMode === 'graph' ? graphLog ?? log : log}
        maxCount={gitLogDialogMode === 'graph' ? graphLogMaxCount : logMaxCountLocal}
        onMaxCountChange={gitLogDialogMode === 'graph' ? handleGraphLogMaxCountChange : handleLogMaxCountChange}
        expandedCommitHashes={expandedCommitHashes}
        onToggleCommit={handleToggleCommit}
        commitFilesMap={commitFilesMap}
        loadingCommitHashes={loadingCommitHashes}
        onCopyHash={handleCopyCommitHash}
        historyBranchDivider={historyBranchDivider}
        onConflict={gitLogDialogMode === 'graph' ? handleGraphConflict : undefined}
        onActionSuccess={gitLogDialogMode === 'graph' ? handleGraphActionSuccess : undefined}
        isStashesDialogOpen={isStashesDialogOpen}
        setIsStashesDialogOpen={setIsStashesDialogOpen}
        hasUncommittedChanges={(status?.files?.length ?? 0) > 0}
        hasStagedChanges={stagedChangeEntries.length > 0}
        uncommittedFileCount={status?.files?.length ?? 0}
        onStashesChanged={async (change) => {
          if (currentDirectory && change?.affectsIndex) {
            bumpIndexRevision(currentDirectory);
          }
          await refreshStatusAndBranches(false);
          await refreshLog();
        }}
        isGitmojiPickerOpen={isGitmojiPickerOpen}
        setIsGitmojiPickerOpen={setIsGitmojiPickerOpen}
        gitmojiEmojis={gitmojiEmojis}
        onSelectGitmoji={handleSelectGitmoji}
        conflictDialogOpen={conflictDialogOpen}
        setConflictDialogOpen={setConflictDialogOpen}
        conflictFiles={conflictFiles}
        conflictOperation={conflictOperation}
        onAbortConflict={handleAbortConflict}
        onClearConflictState={clearConflictState}
        stashDialogOpen={stashDialogOpen}
        setStashDialogOpen={setStashDialogOpen}
        stashDialogOperation={stashDialogOperation}
        stashDialogBranch={stashDialogBranch}
        onConfirmStashAndRetry={handleStashAndRetry}
      />

    </div>
  );
};
