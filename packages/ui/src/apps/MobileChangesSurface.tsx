import React from 'react';
import { Icon } from '@/components/icon/Icon';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { ChangesPanel, type ChangesGroupConfig } from '@/components/views/git/ChangesPanel';
import { CommitSection } from '@/components/views/git/CommitSection';
import { SyncActions } from '@/components/views/git/SyncActions';
import { PierreDiffViewer } from '@/components/views/PierreDiffViewer';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import type { GitStatus } from '@/lib/api/types';
import { generateCommitMessage, stageGitFile, stageGitFiles, unstageGitFile, unstageGitFiles } from '@/lib/gitApi';
import type { GitRemote } from '@/lib/gitApi';
import { getLanguageFromExtension, isImageFile } from '@/lib/toolHelpers';
import {
  useGitStore,
  useGitStatus,
  useIsGitRepo,
  useGitLoadingStatus,
} from '@/stores/useGitStore';
import { getRuntimeKey } from '@/lib/runtime-switch';

type SyncAction = 'fetch' | 'pull' | 'push' | 'sync' | null;
type CommitAction = 'commit' | 'commitAndPush' | null;

const normalizePath = (value?: string | null): string => (value || '').replace(/\\/g, '/').replace(/\/+$/g, '');

const isStagedStatusFile = (file: GitStatus['files'][number]): boolean => {
  const indexStatus = file.index?.trim();
  return Boolean(indexStatus && indexStatus !== '?');
};

const isUnstagedStatusFile = (file: GitStatus['files'][number]): boolean => {
  const workingStatus = file.working_dir?.trim();
  const indexStatus = file.index?.trim();
  return Boolean(workingStatus || indexStatus === '?');
};

const diffCacheKey = (path: string, staged: boolean): string => staged ? `${path}\u0000staged` : path;

type MobileChangesSurfaceProps = {
  /** When provided, the list header gets a close X that calls this. */
  onClose?: () => void;
  /**
   * When set (and non-null), the surface opens directly into the per-file diff view for this
   * relative path. Updating it (incl. setting it to a different path while open) routes the
   * surface to that diff. Setting it back to null leaves the user on the current internal route.
   */
  initialDiffPath?: string | null;
  initialDiffStaged?: boolean;
};

export const MobileChangesSurface: React.FC<MobileChangesSurfaceProps> = ({ onClose, initialDiffPath, initialDiffStaged = false }) => {
  const { git } = useRuntimeAPIs();
  const currentDirectory = normalizePath(useEffectiveDirectory() ?? null);
  const status = useGitStatus(currentDirectory || null);
  const isGitRepo = useIsGitRepo(currentDirectory || null);
  const isLoadingStatus = useGitLoadingStatus(currentDirectory || null);
  const setActiveDirectory = useGitStore((state) => state.setActiveDirectory);
  const ensureAll = useGitStore((state) => state.ensureAll);
  const fetchStatus = useGitStore((state) => state.fetchStatus);
  const fetchBranches = useGitStore((state) => state.fetchBranches);
  const prefetchDiffs = useGitStore((state) => state.prefetchDiffs);
  const getDiff = useGitStore((state) => state.getDiff);
  const setDiff = useGitStore((state) => state.setDiff);

  const [route, setRoute] = React.useState<{ type: 'list' } | { type: 'diff'; path: string; staged: boolean }>(
    () => (initialDiffPath ? { type: 'diff', path: initialDiffPath, staged: initialDiffStaged } : { type: 'list' }),
  );

  // Allow the host (MobileApp) to push us into a specific diff when the surface
  // is reopened or when an external trigger (e.g. PendingChangesBar tap) requests
  // a different file mid-session.
  React.useEffect(() => {
    if (!initialDiffPath) return;
    setRoute((current) => (
      current.type === 'diff' && current.path === initialDiffPath && current.staged === initialDiffStaged
        ? current
        : { type: 'diff', path: initialDiffPath, staged: initialDiffStaged }
    ));
  }, [initialDiffPath, initialDiffStaged]);
  const [syncAction, setSyncAction] = React.useState<SyncAction>(null);
  const [commitAction, setCommitAction] = React.useState<CommitAction>(null);
  const [commitMessage, setCommitMessage] = React.useState('');
  const [revertingPaths, setRevertingPaths] = React.useState<Set<string>>(new Set());
  const [isRevertingAll, setIsRevertingAll] = React.useState(false);
  const [isGeneratingMessage, setIsGeneratingMessage] = React.useState(false);
  const [generatedHighlights, setGeneratedHighlights] = React.useState<string[]>([]);
  const [visibleChangePaths, setVisibleChangePaths] = React.useState<string[]>([]);
  const [remotes, setRemotes] = React.useState<GitRemote[]>([]);
  const [remoteUrl, setRemoteUrl] = React.useState<string | null>(null);
  const [diffLoadError, setDiffLoadError] = React.useState<string | null>(null);
  const [diffRetryNonce, setDiffRetryNonce] = React.useState(0);

  const changeEntries = React.useMemo(() => {
    const files = status?.files ?? [];
    const unique = new Map<string, (typeof files)[number]>();
    for (const file of files) {
      unique.set(file.path, file);
    }
    return Array.from(unique.values()).sort((a, b) => a.path.localeCompare(b.path));
  }, [status?.files]);

  const stagedChangeEntries = React.useMemo(
    () => changeEntries.filter(isStagedStatusFile),
    [changeEntries],
  );

  const unstagedChangeEntries = React.useMemo(
    () => changeEntries.filter(isUnstagedStatusFile),
    [changeEntries],
  );

  const effectiveRemotes = React.useMemo<GitRemote[]>(() => {
    if (remotes.length > 0) return remotes;
    const trackingRemote = status?.tracking?.includes('/') ? status.tracking.split('/')[0] : null;
    if (trackingRemote || remoteUrl) {
      return [{ name: trackingRemote || 'origin', fetchUrl: remoteUrl ?? '', pushUrl: remoteUrl ?? '' }];
    }
    return [];
  }, [remoteUrl, remotes, status?.tracking]);

  const selectedDiff = useGitStore(React.useCallback((state) => {
    if (!currentDirectory || route.type !== 'diff') return null;
    return state.directories.get(currentDirectory)?.diffCache.get(diffCacheKey(route.path, route.staged)) ?? null;
  }, [currentDirectory, route]));

  const selectedFileEntry = React.useMemo(() => {
    if (route.type !== 'diff') return null;
    return changeEntries.find((entry) => entry.path === route.path) ?? null;
  }, [changeEntries, route]);

  const refreshStatusAndBranches = React.useCallback(async (showErrors = true) => {
    if (!currentDirectory) return;
    try {
      await Promise.all([
        fetchStatus(currentDirectory, git),
        fetchBranches(currentDirectory, git),
      ]);
    } catch (error) {
      if (showErrors) {
        toast.error(error instanceof Error ? error.message : "Failed to refresh repository");
      }
    }
  }, [currentDirectory, fetchBranches, fetchStatus, git]);

  const refreshRemotes = React.useCallback(async () => {
    if (!currentDirectory) {
      setRemotes([]);
      setRemoteUrl(null);
      return;
    }
    try {
      const [remoteList, url] = await Promise.all([
        git.getRemotes(currentDirectory).catch(() => []),
        git.getRemoteUrl ? git.getRemoteUrl(currentDirectory).catch(() => null) : Promise.resolve(null),
      ]);
      setRemotes(remoteList);
      setRemoteUrl(url);
    } catch {
      setRemotes([]);
      setRemoteUrl(null);
    }
  }, [currentDirectory, git]);

  React.useEffect(() => {
    if (!currentDirectory) return;
    setActiveDirectory(currentDirectory);
    void ensureAll(currentDirectory, git);
  }, [currentDirectory, ensureAll, git, setActiveDirectory]);

  React.useEffect(() => {
    void refreshRemotes();
  }, [refreshRemotes]);

  React.useEffect(() => {
    if (!currentDirectory || changeEntries.length === 0) return;
    const orderedPaths = Array.from(new Set([
      ...stagedChangeEntries.map((entry) => entry.path),
      ...visibleChangePaths,
      ...changeEntries.slice(0, 20).map((entry) => entry.path),
    ])).filter(Boolean);
    if (orderedPaths.length === 0) return;
    const timeoutId = window.setTimeout(() => {
      void prefetchDiffs(currentDirectory, git, orderedPaths, { maxFiles: 40 });
    }, 120);
    return () => window.clearTimeout(timeoutId);
  }, [changeEntries, currentDirectory, git, prefetchDiffs, stagedChangeEntries, visibleChangePaths]);

  React.useEffect(() => {
    if (route.type !== 'diff') {
      setDiffLoadError(null);
      return;
    }
    const cacheKey = diffCacheKey(route.path, route.staged);
    if (!currentDirectory || getDiff(currentDirectory, cacheKey)) {
      setDiffLoadError(null);
      return;
    }

    let cancelled = false;
    const runtimeKey = getRuntimeKey();
    setDiffLoadError(null);
    void git.getGitFileDiff(currentDirectory, { path: route.path, staged: route.staged || undefined })
      .then((response) => {
        if (cancelled) return;
        setDiff(currentDirectory, cacheKey, {
          original: response.original ?? '',
          modified: response.modified ?? '',
          isBinary: response.isBinary,
        }, runtimeKey);
      })
      .catch((error) => {
        if (cancelled) return;
        setDiffLoadError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
    };
  }, [currentDirectory, diffRetryNonce, getDiff, git, route, setDiff]);

  const handleSyncAction = async (action: Exclude<SyncAction, null>, remote?: GitRemote) => {
    if (!currentDirectory) return;
    setSyncAction(action);
    try {
      const getPullOptions = (pullRemote: GitRemote) => {
        const trackingPrefix = `${pullRemote.name}/`;
        const trackedBranch = status?.tracking?.startsWith(trackingPrefix)
          ? status.tracking.slice(trackingPrefix.length)
          : undefined;
        return { remote: pullRemote.name, branch: trackedBranch, rebase: true };
      };

      if (action === 'fetch') {
        if (!remote) throw new Error("No remote available");
        await git.gitFetch(currentDirectory, { remote: remote.name });
        toast.success(`Fetched from ${remote.name}`);
      } else if (action === 'sync') {
        if (!remote) throw new Error("No remote available");
        await git.gitFetch(currentDirectory, { remote: remote.name });
        const afterFetch = await git.getGitStatus(currentDirectory);
        if ((afterFetch.behind ?? 0) > 0) {
          if ((afterFetch.files?.length ?? 0) > 0) {
            toast.error("Commit or stash your changes before syncing");
            return;
          }
          await git.gitPull(currentDirectory, getPullOptions(remote));
        }
        const afterPull = await git.getGitStatus(currentDirectory);
        if ((afterPull.ahead ?? 0) > 0) {
          await git.gitPush(currentDirectory);
        }
        toast.success("Already up to date");
      }
      await refreshStatusAndBranches(false);
      await refreshRemotes();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Sync Changes failed`);
    } finally {
      setSyncAction(null);
    }
  };

  const moveChangePaths = React.useCallback(async (paths: string[], direction: 'stage' | 'unstage') => {
    if (!currentDirectory || paths.length === 0) return;
    try {
      if (direction === 'stage') {
        if (paths.length > 1) await stageGitFiles(currentDirectory, paths);
        else await stageGitFile(currentDirectory, paths[0]);
      } else {
        if (paths.length > 1) await unstageGitFiles(currentDirectory, paths);
        else await unstageGitFile(currentDirectory, paths[0]);
      }
      await refreshStatusAndBranches(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : direction === 'stage'
        ? "Failed to stage changes"
        : "Failed to unstage changes");
    }
  }, [currentDirectory, refreshStatusAndBranches]);

  const handleViewChangeDiff = React.useCallback((path: string, staged = false) => {
    setRoute({ type: 'diff', path, staged });
  }, []);

  const handleRevertFile = React.useCallback(async (filePath: string) => {
    if (!currentDirectory) return;
    setRevertingPaths((previous) => new Set(previous).add(filePath));
    try {
      await git.revertGitFile(currentDirectory, filePath);
      toast.success(`Reverted ${filePath}`);
      await refreshStatusAndBranches(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to revert changes");
    } finally {
      setRevertingPaths((previous) => {
        const next = new Set(previous);
        next.delete(filePath);
        return next;
      });
    }
  }, [currentDirectory, git, refreshStatusAndBranches]);

  const handleRevertAll = React.useCallback(async (paths: string[]) => {
    if (!currentDirectory || paths.length === 0 || isRevertingAll) return;
    const uniquePaths = Array.from(new Set(paths));
    setIsRevertingAll(true);
    setRevertingPaths(new Set(uniquePaths));
    try {
      await Promise.all(uniquePaths.map((filePath) => git.revertGitFile(currentDirectory, filePath)));
      await refreshStatusAndBranches(false);
      toast.success(uniquePaths.length === 1
        ? `Reverted ${uniquePaths.length} file`
        : `Reverted ${uniquePaths.length} files`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to revert changes");
    } finally {
      setRevertingPaths(new Set());
      setIsRevertingAll(false);
    }
  }, [currentDirectory, git, isRevertingAll, refreshStatusAndBranches]);

  const handleInsertHighlights = React.useCallback((highlights: string[]) => {
    const normalized = highlights.map((text) => text.trim()).filter(Boolean);
    if (normalized.length === 0) {
      setGeneratedHighlights([]);
      return;
    }
    setCommitMessage((current) => `${current.trim()}${current.trim() ? '\n\n' : ''}${normalized.join('\n')}`.trim());
    setGeneratedHighlights([]);
  }, []);

  const handleGenerateCommitMessage = React.useCallback(async () => {
    if (!currentDirectory) return;
    const selectedFilePaths = stagedChangeEntries.map((file) => file.path).sort();
    if (selectedFilePaths.length === 0) {
      toast.error("Select at least one file to describe");
      return;
    }
    setIsGeneratingMessage(true);
    try {
      const { message } = await generateCommitMessage(currentDirectory, selectedFilePaths);
      setCommitMessage(message.subject?.trim() ?? '');
      setGeneratedHighlights(Array.isArray(message.highlights) ? message.highlights : []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to generate commit message");
    } finally {
      setIsGeneratingMessage(false);
    }
  }, [currentDirectory, stagedChangeEntries]);

  const handleCommit = async (options: { pushAfter?: boolean } = {}) => {
    if (!currentDirectory) return;
    if (!commitMessage.trim()) {
      toast.error("Enter a commit message");
      return;
    }
    const filesToCommit = stagedChangeEntries.map((file) => file.path).sort();
    if (filesToCommit.length === 0) {
      toast.error("Select at least one file to commit");
      return;
    }

    setCommitAction(options.pushAfter ? 'commitAndPush' : 'commit');
    try {
      await git.createGitCommit(currentDirectory, commitMessage.trim(), { files: filesToCommit });
      toast.success("Commit created");
      setCommitMessage('');
      setGeneratedHighlights([]);

      if (options.pushAfter) {
        const trackingRemoteName = status?.tracking?.split('/')[0];
        const remote = effectiveRemotes.find((entry) => entry.name === trackingRemoteName) ?? effectiveRemotes[0];
        if (!remote) throw new Error("No remote available");
        setSyncAction('sync');
        const trackingPrefix = `${remote.name}/`;
        const trackedBranch = status?.tracking?.startsWith(trackingPrefix)
          ? status.tracking.slice(trackingPrefix.length)
          : undefined;

        await git.gitFetch(currentDirectory, { remote: remote.name });
        const afterFetch = await git.getGitStatus(currentDirectory);
        if ((afterFetch.behind ?? 0) > 0) {
          await git.gitPull(currentDirectory, { remote: remote.name, branch: trackedBranch, rebase: true });
        }

        const afterPull = await git.getGitStatus(currentDirectory);
        if ((afterPull.ahead ?? 0) > 0) {
          await git.gitPush(currentDirectory);
        }

        await refreshStatusAndBranches(false);
        await refreshRemotes();
      } else {
        await refreshStatusAndBranches(false);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create commit");
    } finally {
      setCommitAction(null);
      if (options.pushAfter) setSyncAction(null);
    }
  };

  const changeGroups = React.useMemo<ChangesGroupConfig[]>(() => {
    const groups: ChangesGroupConfig[] = [];

    if (stagedChangeEntries.length > 0) {
      groups.push({
        id: 'staged',
        title: "Staged",
        entries: stagedChangeEntries,
        actionSymbol: '-',
        actionAllLabel: "Unstage all changes",
        getActionLabel: (path: string) => `Unstage ${path}`,
        onActionFile: (path: string) => void moveChangePaths([path], 'unstage'),
        onActionAll: (paths: string[]) => void moveChangePaths(paths, 'unstage'),
        onViewDiff: (path: string) => handleViewChangeDiff(path, true),
        onRevertFile: handleRevertFile,
        showRevertActions: false,
        accent: true,
      });
    }

    if (unstagedChangeEntries.length > 0) {
      groups.push({
        id: 'unstaged',
        title: "Changes",
        entries: unstagedChangeEntries,
        actionSymbol: '+',
        actionAllLabel: "Stage all changes",
        getActionLabel: (path: string) => `Stage ${path}`,
        onActionFile: (path: string) => void moveChangePaths([path], 'stage'),
        onActionAll: (paths: string[]) => void moveChangePaths(paths, 'stage'),
        onViewDiff: (path: string) => handleViewChangeDiff(path, false),
        onRevertFile: handleRevertFile,
      });
    }

    return groups;
  }, [handleRevertFile, handleViewChangeDiff, moveChangePaths, stagedChangeEntries, unstagedChangeEntries]);

  const renderListState = (state: React.ReactNode) => (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 px-3 text-foreground">
        {onClose ? (
          <button
            type="button"
            className="-ml-1 flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={"Close"}
            onClick={onClose}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="close" className="size-5" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1 px-1">
          <h2 className="typography-ui-label text-foreground">{"Changes"}</h2>
          <p className="truncate typography-micro text-muted-foreground">
            {status?.current || currentDirectory || ''}
          </p>
        </div>
      </header>
      <div className="min-h-0 flex-1">{state}</div>
    </div>
  );

  if (!currentDirectory) {
    return renderListState(<MobileChangesState message={"Select a session or directory to view Git status"} />);
  }

  if (isLoadingStatus && isGitRepo === null) {
    return renderListState(<MobileChangesState loading message={"Checking repository..."} />);
  }

  if (isGitRepo === false) {
    return renderListState(<MobileChangesState icon message={"This directory is not a Git repository"} description={"Initialize Git in this directory or open a repository."} />);
  }

  if (route.type === 'diff') {
    return (
      <MobileDiffDetail
        path={route.path}
        diff={selectedDiff}
        fileExists={Boolean(selectedFileEntry)}
        error={diffLoadError}
        onBack={() => setRoute({ type: 'list' })}
        onRetry={() => setDiffRetryNonce((value) => value + 1)}
      />
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 px-3 text-foreground">
        {onClose ? (
          <button
            type="button"
            className="-ml-1 flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={"Close"}
            onClick={onClose}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="close" className="size-5" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1 px-1">
          <h2 className="typography-ui-label text-foreground">{"Changes"}</h2>
          <p className="truncate typography-micro text-muted-foreground">
            {status?.current || currentDirectory}
          </p>
        </div>
        <SyncActions
          syncAction={syncAction}
          remotes={effectiveRemotes}
          onFetch={(remote) => void handleSyncAction('fetch', remote)}
          onSync={(remote) => void handleSyncAction('sync', remote)}
          disabled={commitAction !== null || isLoadingStatus}
          aheadCount={status?.ahead ?? 0}
          behindCount={status?.behind ?? 0}
          trackingRemoteName={status?.tracking?.split('/')[0]}
          hasUncommittedChanges={changeEntries.length > 0}
        />
      </header>
      {changeEntries.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* File list scrolls inside ChangesPanel; the commit footer stays pinned. */}
          <div className="min-h-0 flex-1 overflow-hidden px-4 pt-4">
            <ChangesPanel
              groups={changeGroups}
              diffStats={status?.diffStats}
              revertingPaths={revertingPaths}
              onRevertAll={handleRevertAll}
              isRevertingAll={isRevertingAll}
              headerBackgroundClassName="bg-transparent"
              onVisiblePathsChange={setVisibleChangePaths}
            />
          </div>
          <div className="shrink-0 border-t border-border/70 px-4 pb-4 pt-3">
            <CommitSection
              stagedCount={stagedChangeEntries.length}
              commitMessage={commitMessage}
              onCommitMessageChange={setCommitMessage}
              generatedHighlights={generatedHighlights}
              onInsertHighlights={handleInsertHighlights}
              onGenerateMessage={handleGenerateCommitMessage}
              isGeneratingMessage={isGeneratingMessage}
              onCommit={() => void handleCommit({ pushAfter: false })}
              onCommitAndPush={() => void handleCommit({ pushAfter: true })}
              commitAction={commitAction}
              gitmojiEnabled={false}
              onOpenGitmojiPicker={() => {}}
            />
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <MobileChangesState icon message={"Working tree clean"} description={"There are no changed files in this workspace."} />
        </div>
      )}
    </div>
  );
};

const MobileChangesState: React.FC<{
  message: string;
  description?: string;
  loading?: boolean;
  icon?: boolean;
}> = ({ message, description, loading = false, icon = false }) => (
  <div className="flex h-full items-center justify-center px-6 text-center">
    <div className="flex max-w-sm flex-col items-center gap-2">
      {loading ? <Icon name="loader-4" className="size-5 animate-spin text-muted-foreground" /> : null}
      {icon ? <Icon name="git-branch" className="size-6 text-muted-foreground" /> : null}
      <p className="typography-ui-label font-semibold text-foreground">{message}</p>
      {description ? <p className="typography-meta text-muted-foreground">{description}</p> : null}
    </div>
  </div>
);

const MobileDiffDetail: React.FC<{
  path: string;
  diff: { original: string; modified: string; isBinary?: boolean } | null;
  fileExists: boolean;
  error: string | null;
  onBack: () => void;
  onRetry: () => void;
}> = ({ path, diff, fileExists, error, onBack, onRetry }) => {
  const language = React.useMemo(() => getLanguageFromExtension(path) || 'text', [path]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-3 border-b border-border/70 px-3 text-foreground">
        <button
          type="button"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={"Back"}
          onClick={onBack}
        >
          <Icon name="arrow-left" className="size-5" />
        </button>
        <div className="min-w-0 flex-1 px-2">
          <h2 className="truncate typography-ui-header text-foreground">{path}</h2>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {!fileExists ? (
          <MobileChangesState icon message={"File is no longer changed"} description={"Go back to Changes and refresh the list."} />
        ) : error ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="flex max-w-sm flex-col items-center gap-3">
              <p className="typography-ui-label font-semibold text-foreground">{"Failed to load diff"}</p>
              <p className="typography-meta text-muted-foreground">{error}</p>
              <Button type="button" size="sm" variant="outline" onClick={onRetry}>{"Retry"}</Button>
            </div>
          </div>
        ) : !diff ? (
          <MobileChangesState loading message={"Loading diff..."} />
        ) : diff.isBinary ? (
          <MobileChangesState icon message={"Content of this file cannot be viewed."} />
        ) : isImageFile(path) ? (
          <MobileChangesState icon message={"Image diffs are not available in mobile Changes yet."} />
        ) : (
          <ScrollShadow
            className="h-full overflow-y-auto overflow-x-hidden p-3"
            data-diff-virtual-root
            data-diff-virtual-content
          >
            <PierreDiffViewer
              original={diff.original}
              modified={diff.modified}
              language={language}
              fileName={path}
              renderSideBySide={false}
              wrapLines={true}
              layout="inline"
            />
          </ScrollShadow>
        )}
      </div>
    </div>
  );
};
