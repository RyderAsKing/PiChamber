import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import type { GitStatus } from '@/lib/api/types';
import type { GitRemote } from '@/lib/api/types';
import { getLanguageFromExtension, isImageFile } from '@/lib/toolHelpers';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';

import { ChangesPanel, type ChangesGroupConfig } from './ChangesPanel';
import { CommitSection } from './CommitSection';
import { SyncActions } from './SyncActions';
import { PierreDiffViewer } from '../PierreDiffViewer';

const DiffView = lazyWithChunkRecovery(() =>
  import('../DiffView').then((module) => ({ default: module.DiffView })),
);

type SyncAction = 'fetch' | 'pull' | 'push' | 'sync' | null;
type CommitAction = 'commit' | 'commitAndPush' | null;

type MobileGitDiff = {
  original: string;
  modified: string;
  isBinary?: boolean;
};

type MobileGitChromeProps = {
  currentDirectory: string | null;
  status: GitStatus | null;
  isGitRepo: boolean | null;
  isLoadingStatus: boolean;
  changeEntries: GitStatus['files'];
  stagedChangeEntries: GitStatus['files'];
  unstagedChangeEntries: GitStatus['files'];
  effectiveRemotes: GitRemote[];
  syncAction: SyncAction;
  commitAction: CommitAction;
  commitMessage: string;
  hasPendingIndexMutation: boolean;
  revertingPaths: Set<string>;
  isRevertingAll: boolean;
  initialDiffPath?: string | null;
  initialDiffStaged?: boolean;
  onSyncAction: (action: Exclude<SyncAction, null>, remote?: GitRemote) => void;
  onMoveChangePaths: (paths: string[], direction: 'stage' | 'unstage') => void;
  onRevertFile: (path: string) => void;
  onRevertAll: (paths: string[]) => Promise<void> | void;
  onCommitMessageChange: (message: string) => void;
  onCommit: (options?: { pushAfter?: boolean }) => void;
  onVisiblePathsChange: (paths: string[]) => void;
  loadDiff: (path: string, staged: boolean) => Promise<MobileGitDiff>;
};

type MobileGitRoute =
  | { type: 'list' }
  | { type: 'diff'; path: string; staged: boolean };

export const MobileGitChrome: React.FC<MobileGitChromeProps> = ({
  currentDirectory,
  status,
  isGitRepo,
  isLoadingStatus,
  changeEntries,
  stagedChangeEntries,
  unstagedChangeEntries,
  effectiveRemotes,
  syncAction,
  commitAction,
  commitMessage,
  hasPendingIndexMutation,
  revertingPaths,
  isRevertingAll,
  initialDiffPath,
  initialDiffStaged = false,
  onSyncAction,
  onMoveChangePaths,
  onRevertFile,
  onRevertAll,
  onCommitMessageChange,
  onCommit,
  onVisiblePathsChange,
  loadDiff,
}) => {
  const [route, setRoute] = React.useState<MobileGitRoute>(() => (
    initialDiffPath
      ? { type: 'diff', path: initialDiffPath, staged: initialDiffStaged }
      : { type: 'list' }
  ));
  const [selectedDiff, setSelectedDiff] = React.useState<MobileGitDiff | null>(null);
  const [diffLoadError, setDiffLoadError] = React.useState<string | null>(null);
  const [diffRetryNonce, setDiffRetryNonce] = React.useState(0);

  React.useEffect(() => {
    if (!initialDiffPath) return;
    setRoute((current) => (
      current.type === 'diff'
        && current.path === initialDiffPath
        && current.staged === initialDiffStaged
        ? current
        : { type: 'diff', path: initialDiffPath, staged: initialDiffStaged }
    ));
  }, [initialDiffPath, initialDiffStaged]);

  const selectedFileExists = React.useMemo(() => (
    route.type === 'diff' && changeEntries.some((entry) => entry.path === route.path)
  ), [changeEntries, route]);

  React.useEffect(() => {
    if (route.type !== 'diff' || !selectedFileExists) {
      setSelectedDiff(null);
      setDiffLoadError(null);
      return;
    }

    let cancelled = false;
    setSelectedDiff(null);
    setDiffLoadError(null);
    void loadDiff(route.path, route.staged)
      .then((diff) => {
        if (!cancelled) setSelectedDiff(diff);
      })
      .catch((error) => {
        if (!cancelled) {
          setDiffLoadError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [diffRetryNonce, loadDiff, route, selectedFileExists]);

  const handleViewChangeDiff = React.useCallback((path: string, staged = false) => {
    setRoute({ type: 'diff', path, staged });
  }, []);

  const changeGroups = React.useMemo<ChangesGroupConfig[]>(() => {
    const groups: ChangesGroupConfig[] = [];

    if (stagedChangeEntries.length > 0) {
      groups.push({
        id: 'staged',
        title: 'Staged',
        entries: stagedChangeEntries,
        actionSymbol: '-',
        actionAllLabel: 'Unstage all changes',
        getActionLabel: (path) => `Unstage ${path}`,
        onActionFile: (path) => onMoveChangePaths([path], 'unstage'),
        onActionAll: (paths) => onMoveChangePaths(paths, 'unstage'),
        onViewDiff: (path) => handleViewChangeDiff(path, true),
        onRevertFile,
        showRevertActions: false,
        accent: true,
      });
    }

    if (unstagedChangeEntries.length > 0) {
      groups.push({
        id: 'unstaged',
        title: 'Changes',
        entries: unstagedChangeEntries,
        actionSymbol: '+',
        actionAllLabel: 'Stage all changes',
        getActionLabel: (path) => `Stage ${path}`,
        onActionFile: (path) => onMoveChangePaths([path], 'stage'),
        onActionAll: (paths) => onMoveChangePaths(paths, 'stage'),
        onViewDiff: (path) => handleViewChangeDiff(path, false),
        onRevertFile,
      });
    }

    return groups;
  }, [handleViewChangeDiff, onMoveChangePaths, onRevertFile, stagedChangeEntries, unstagedChangeEntries]);

  const renderListState = React.useCallback((state: React.ReactNode) => (
    <div className="flex h-full flex-col overflow-hidden bg-transparent text-foreground">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <p className="min-w-0 flex-1 truncate typography-ui-label text-muted-foreground">
          {status?.current || currentDirectory || ''}
        </p>
      </div>
      <div className="min-h-0 flex-1">{state}</div>
    </div>
  ), [currentDirectory, status]);

  if (!currentDirectory) {
    return renderListState(<MobileGitState message="Select a session or directory to view Git status" />);
  }

  if (isGitRepo === null || (isGitRepo === true && !status)) {
    return renderListState(<MobileGitState loading message="Checking repository..." />);
  }

  if (isGitRepo === false) {
    return renderListState(
      <React.Suspense fallback={<MobileGitState loading message="Loading last turn changes..." />}>
        <DiffView
          diffScope="turn"
          hideStackedFileSidebar
          stackedDefaultCollapsedAll
          flushContent
        />
      </React.Suspense>,
    );
  }

  if (route.type === 'diff') {
    return (
      <MobileDiffDetail
        path={route.path}
        diff={selectedDiff}
        fileExists={selectedFileExists}
        error={diffLoadError}
        onBack={() => setRoute({ type: 'list' })}
        onRetry={() => setDiffRetryNonce((value) => value + 1)}
      />
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-transparent text-foreground">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <p className="min-w-0 flex-1 truncate typography-ui-label text-muted-foreground">
          {status?.current || currentDirectory}
        </p>
        <SyncActions
          syncAction={syncAction}
          remotes={effectiveRemotes}
          onFetch={(remote) => onSyncAction('fetch', remote)}
          onSync={(remote) => onSyncAction('sync', remote)}
          disabled={commitAction !== null || isLoadingStatus}
          aheadCount={status?.ahead ?? 0}
          behindCount={status?.behind ?? 0}
          trackingRemoteName={status?.tracking?.split('/')[0]}
          hasUncommittedChanges={changeEntries.length > 0}
        />
      </div>
      {changeEntries.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden px-3 pt-2">
            <ChangesPanel
              groups={changeGroups}
              diffStats={status?.diffStats}
              revertingPaths={revertingPaths}
              onRevertAll={onRevertAll}
              isRevertingAll={isRevertingAll}
              headerBackgroundClassName="bg-transparent"
              onVisiblePathsChange={onVisiblePathsChange}
            />
          </div>
          <div className="shrink-0 border-t border-border/40 px-3 pb-3 pt-3">
            <CommitSection
              stagedCount={stagedChangeEntries.length}
              commitMessage={commitMessage}
              onCommitMessageChange={onCommitMessageChange}
              onCommit={() => {
                if (!commitMessage.trim()) {
                  toast.error('Enter a commit message');
                  return;
                }
                if (stagedChangeEntries.length === 0) {
                  toast.error('Select at least one file to commit');
                  return;
                }
                onCommit({ pushAfter: false });
              }}
              onCommitAndPush={() => {
                if (!commitMessage.trim()) {
                  toast.error('Enter a commit message');
                  return;
                }
                if (stagedChangeEntries.length === 0) {
                  toast.error('Select at least one file to commit');
                  return;
                }
                onCommit({ pushAfter: true });
              }}
              commitAction={commitAction}
              hasPendingIndexMutation={hasPendingIndexMutation}
              gitmojiEnabled={false}
              onOpenGitmojiPicker={() => {}}
            />
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <MobileGitState
            icon
            message="Working tree clean"
            description="There are no changed files in this workspace."
          />
        </div>
      )}
    </div>
  );
};

const MobileGitState: React.FC<{
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
  diff: MobileGitDiff | null;
  fileExists: boolean;
  error: string | null;
  onBack: () => void;
  onRetry: () => void;
}> = ({ path, diff, fileExists, error, onBack, onRetry }) => {
  const language = React.useMemo(() => getLanguageFromExtension(path) || 'text', [path]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-transparent text-foreground">
      <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-1 px-2 text-foreground">
        <button
          type="button"
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label="Back"
          onClick={onBack}
        >
          <Icon name="arrow-left" className="size-4" />
        </button>
        <div className="min-w-0 flex-1 px-2">
          <h2 className="truncate typography-ui-label text-foreground">{path}</h2>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {!fileExists ? (
          <MobileGitState icon message="File is no longer changed" description="Go back to Changes and refresh the list." />
        ) : error ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <div className="flex max-w-sm flex-col items-center gap-3">
              <p className="typography-ui-label font-semibold text-foreground">Failed to load diff</p>
              <p className="typography-meta text-muted-foreground">{error}</p>
              <Button type="button" size="sm" variant="outline" onClick={onRetry}>Retry</Button>
            </div>
          </div>
        ) : !diff ? (
          <MobileGitState loading message="Loading diff..." />
        ) : diff.isBinary ? (
          <MobileGitState icon message="Content of this file cannot be viewed." />
        ) : isImageFile(path) ? (
          <MobileGitState icon message="Image diffs are not available in mobile Changes yet." />
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
              wrapLines
              layout="inline"
            />
          </ScrollShadow>
        )}
      </div>
    </div>
  );
};
