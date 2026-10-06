import React from 'react';
import { useTranslation } from 'react-i18next';
import { Popover } from '@base-ui/react/popover';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import type {
  GitHubAPI,
  GitHubErrorBody,
  GitHubPullRequestFile,
  GitHubPullRequestFilesResult,
  GitHubReviewThread,
} from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { GitHubDiffStat } from '../GitHubDetailScaffold';
import { GitHubListSkeleton } from '../GitHubListPrimitives';
import { FileCard } from './PullFileReview';
import { PullReviewControl } from './PullComposer';
import { SectionError } from '../GitHubListPrimitives';
import type { ViewerAccess } from './pullLogic';
import {
  defaultCollapsedForFiles,
  fileTotals,
  githubBlobUrlForFile,
  groupFilesByFolder,
  splitFilePath,
  statusIconForFile,
  statusKindForFile,
  statusTintForFile,
} from './pullFilesLogic';
import { usePendingReviewComments } from '@/stores/github/useGitHubPendingReviewStore';
import { useGitHubViewedFilesStore, useViewedFileCount, useViewedFilePaths } from '@/stores/github/useGitHubViewedFilesStore';

/** Client-side file window; the server cursor pages through `onLoadMoreFiles`. */
const FILE_WINDOW = 20;

const EMPTY_FILES: GitHubPullRequestFile[] = [];
const EMPTY_THREADS: GitHubReviewThread[] = [];

const fileAnchorId = (filename: string): string => `pr-file-${encodeURIComponent(filename)}`;

/** One row of the jump list / sidebar: status, names, stat, counts, viewed. */
const FileJumpRow: React.FC<{
  file: GitHubPullRequestFile;
  viewed: boolean;
  threadCount: number;
  pendingCount: number;
  /** False under a folder heading, which already names the directory. */
  showDir: boolean;
  onSelectFile: (filename: string) => void;
}> = React.memo(({ file, viewed, threadCount, pendingCount, showDir, onSelectFile }) => {
  const { t } = useTranslation();
  const kind = statusKindForFile(file.status);
  const { dir, base } = splitFilePath(file.filename);
  return (
    <button
      type="button"
      onClick={() => onSelectFile(file.filename)}
      title={file.filename}
      aria-label={t('Go to {{path}}', { path: file.filename })}
      className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-interactive-hover"
    >
      <Icon name={statusIconForFile(kind)} className={cn('size-3.5 shrink-0', statusTintForFile(kind))} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-mono typography-micro">
        {showDir && dir ? <span className="text-muted-foreground">{dir}/</span> : null}
        <span className="text-foreground">{base}</span>
      </span>
      <GitHubDiffStat additions={file.additions} deletions={file.deletions} className="typography-micro" />
      {threadCount > 0 ? (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 typography-micro text-muted-foreground"
          title={threadCount === 1 ? t('{{count}} conversation', { count: threadCount }) : t('{{count}} conversations', { count: threadCount })}
        >
          <Icon name="chat-1" className="size-3" aria-hidden="true" />
          <span className="tabular-nums">{threadCount}</span>
        </span>
      ) : null}
      {pendingCount > 0 ? (
        <span className="shrink-0 tabular-nums typography-micro text-muted-foreground" title={t('{{count}} pending', { count: pendingCount })}>
          +{pendingCount}
        </span>
      ) : null}
      {viewed ? (
        <Icon name="check" className="size-3.5 shrink-0 text-[var(--status-success)]" aria-label={t("Viewed")} />
      ) : null}
    </button>
  );
});
FileJumpRow.displayName = 'FileJumpRow';

/** Filterable file list grouped by folder; owns its filter text so typing never re-renders the diff cards. */
const FileJumpList: React.FC<{
  files: GitHubPullRequestFile[];
  viewedPaths: readonly string[];
  threadCounts: ReadonlyMap<string, number>;
  pendingCounts: ReadonlyMap<string, number>;
  onSelectFile: (filename: string) => void;
}> = ({ files, viewedPaths, threadCounts, pendingCounts, onSelectFile }) => {
  const { t } = useTranslation();
  const [filter, setFilter] = React.useState('');
  const groups = React.useMemo(() => groupFilesByFolder(files), [files]);
  const viewedSet = React.useMemo(() => new Set(viewedPaths), [viewedPaths]);
  const query = filter.trim().toLowerCase();
  const visibleGroups = React.useMemo(() => {
    if (!query) return groups;
    return groups
      .map((group) => ({
        ...group,
        files: group.files.filter((file) => file.filename.toLowerCase().includes(query)),
      }))
      .filter((group) => group.files.length > 0);
  }, [groups, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <Input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder={t("Filter files")}
        aria-label={t("Filter files")}
        className="h-7 shrink-0 typography-micro"
      />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" role="list" aria-label={t("Changed files")}>
        {visibleGroups.length === 0 ? (
          <p className="px-1.5 py-2 typography-micro text-muted-foreground">
            {files.length === 0 ? t('No changed files') : t('No files match')}
          </p>
        ) : (
          visibleGroups.map((group) => (
            <div key={group.folder} role="group" aria-label={group.folder || t('Repository root')}>
              {groups.length > 1 ? (
                <p className="truncate px-1.5 pt-1.5 pb-0.5 typography-micro text-muted-foreground" title={group.folder || '/'}>
                  {group.folder || '/'}
                </p>
              ) : null}
              {group.files.map((file) => (
                <FileJumpRow
                  key={file.filename}
                  file={file}
                  viewed={viewedSet.has(file.filename)}
                  threadCount={threadCounts.get(file.filename) ?? 0}
                  pendingCount={pendingCounts.get(file.filename) ?? 0}
                  showDir={groups.length <= 1}
                  onSelectFile={onSelectFile}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

/** "Files" jump control for narrow widths; the wide layout renders `FileJumpList` as a sidebar instead. */
const FilesJumpControl: React.FC<{
  files: GitHubPullRequestFile[];
  viewedPaths: readonly string[];
  threadCounts: ReadonlyMap<string, number>;
  pendingCounts: ReadonlyMap<string, number>;
  onSelectFile: (filename: string) => void;
}> = (props) => {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const { onSelectFile } = props;
  const handleSelect = React.useCallback(
    (filename: string) => {
      setOpen(false);
      onSelectFile(filename);
    },
    [onSelectFile],
  );
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0"
            aria-label={props.files.length === 1 ? t('Jump to file, {{count}} file', { count: props.files.length }) : t('Jump to file, {{count}} files', { count: props.files.length })}
            title={t("Jump to file")}
          />
        }
      >
        <Icon name="file" className="size-3.5" aria-hidden="true" />
        {t('Files')}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="z-50" side="bottom" align="start" sideOffset={4} collisionPadding={8}>
          <Popover.Popup
            aria-label={t("Jump to file")}
            className="flex max-h-[min(28rem,calc(100dvh-4rem))] w-[min(22rem,calc(100vw-2rem))] flex-col rounded-lg border border-border/60 bg-[var(--surface-elevated)] p-1.5 shadow-lg"
          >
            <FileJumpList {...props} onSelectFile={handleSelect} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};

// Summary bar (h-8) plus the sticky offset gap (top-10) and bottom breathing room.
const SIDEBAR_STICKY_OFFSET = 48;

/**
 * Height of the wide-layout file column: the detail's scroll viewport minus
 * the sticky offset, so the column scrolls on its own instead of riding along
 * with the diffs. Tracks panel resizes; null until measured (the CSS
 * max-height fallback applies meanwhile).
 */
const useStickySidebarHeight = (
  ref: React.RefObject<HTMLElement | null>,
  active: boolean,
): number | null => {
  const [height, setHeight] = React.useState<number | null>(null);
  React.useLayoutEffect(() => {
    if (!active) return;
    const root = ref.current?.closest('[data-diff-virtual-root]');
    if (!(root instanceof HTMLElement)) return;
    const measure = () => {
      const next = Math.max(160, Math.floor(root.clientHeight - SIDEBAR_STICKY_OFFSET));
      setHeight((prev) => (prev === next ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [ref, active]);
  return height;
};

/** Files ("Code") tab of the PR detail: summary bar plus one review-capable diff card per file. */
export const PullFilesTab: React.FC<{
  files: GitHubPullRequestFilesResult | null;
  filesLoading: boolean;
  filesError: GitHubErrorBody | null;
  filesHasMore: boolean;
  onLoadMoreFiles: () => void;
  onRetryFiles: () => void;
  threads: GitHubReviewThread[];
  threadsError: GitHubErrorBody | null;
  onRetryDetail: () => void;
  directory: string;
  repo: string;
  number: number;
  github: GitHubAPI;
  access: ViewerAccess;
  headSha?: string | null;
  /** Refresh callback after the review popover submits (detail read). */
  onReviewSubmitted?: () => void;
}> = (props) => {
  const { t } = useTranslation();
  const { directory, repo, number, github, access, headSha = null } = props;
  const files = props.files?.files ?? EMPTY_FILES;
  const viewedPaths = useViewedFilePaths(repo, number);
  const viewedCount = useViewedFileCount(repo, number);
  const pendingComments = usePendingReviewComments(repo, number);

  // Viewed marks belong to a head SHA; a moved head clears them.
  React.useEffect(() => {
    useGitHubViewedFilesStore.getState().syncHeadSha(repo, number, headSha);
  }, [repo, number, headSha]);

  // Collapse defaults (first 3 small files open) merge with user overrides,
  // so paging in more files never collapses what the reader already arranged.
  const defaults = React.useMemo(() => defaultCollapsedForFiles(files), [files]);
  const defaultsRef = React.useRef(defaults);
  defaultsRef.current = defaults;
  const filesRef = React.useRef(files);
  filesRef.current = files;
  const [overrides, setOverrides] = React.useState<Record<string, boolean>>({});
  const [visibleFileCount, setVisibleFileCount] = React.useState(FILE_WINDOW);

  const totals = React.useMemo(() => fileTotals(files), [files]);
  const threadsByPath = React.useMemo(() => {
    const map = new Map<string, GitHubReviewThread[]>();
    for (const thread of props.threads) {
      if (!thread.path) continue;
      const list = map.get(thread.path) ?? [];
      list.push(thread);
      map.set(thread.path, list);
    }
    return map;
  }, [props.threads]);
  const threadCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const [path, list] of threadsByPath) counts.set(path, list.length);
    return counts;
  }, [threadsByPath]);
  const pendingCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of pendingComments) {
      counts.set(comment.path, (counts.get(comment.path) ?? 0) + 1);
    }
    return counts;
  }, [pendingComments]);

  // Stable per-file callbacks so one card's toggle never re-renders the rest.
  const toggleCollapse = React.useCallback((filename: string) => {
    setOverrides((prev) => ({ ...prev, [filename]: !(prev[filename] ?? defaultsRef.current[filename] ?? false) }));
  }, []);
  const expandAll = React.useCallback(() => {
    setOverrides(Object.fromEntries(filesRef.current.map((file) => [file.filename, false])));
  }, []);
  const collapseAll = React.useCallback(() => {
    setOverrides(Object.fromEntries(filesRef.current.map((file) => [file.filename, true])));
  }, []);
  const toggleViewed = React.useCallback(
    (filename: string, next: boolean) => {
      useGitHubViewedFilesStore.getState().setViewed(repo, number, filename, next);
      // Checking a file as viewed collapses its card; unchecking reopens it.
      setOverrides((prev) => ({ ...prev, [filename]: next }));
    },
    [repo, number],
  );
  const focusFile = React.useCallback((filename: string) => {
    setOverrides((prev) => {
      if (!(prev[filename] ?? defaultsRef.current[filename] ?? false)) return prev;
      return { ...prev, [filename]: false };
    });
    const index = filesRef.current.findIndex((file) => file.filename === filename);
    if (index >= 0) setVisibleFileCount((count) => (index < count ? count : index + 1));
    requestAnimationFrame(() => {
      document.getElementById(fileAnchorId(filename))?.scrollIntoView({ block: 'start' });
    });
  }, []);

  const visibleFiles = React.useMemo(() => files.slice(0, visibleFileCount), [files, visibleFileCount]);
  const sidebarRef = React.useRef<HTMLElement | null>(null);
  const sidebarHeight = useStickySidebarHeight(sidebarRef, visibleFiles.length > 0);
  const viewedSet = React.useMemo(() => new Set(viewedPaths), [viewedPaths]);
  const fileCountLabel = files.length === 1 ? t('1 file') : t('{{count}} files', { count: files.length });
  const viewedLabel =
    files.length === 0
      ? t('Nothing viewed yet')
      : t('{{viewed}}/{{total}} viewed', { viewed: viewedCount, total: files.length });

  return (
    <section aria-label={t("Changed files")} className="@container flex flex-col gap-2" data-diff-virtual-content>
      <SectionError error={props.filesError} onRetry={props.onRetryFiles} label={t("Changed files")} />
      <SectionError error={props.threadsError} onRetry={props.onRetryDetail} label={t("Review threads")} />
      <div className="sticky top-0 z-10 flex h-8 shrink-0 items-center gap-2 border-b border-border/60 bg-[var(--surface-background)] px-1 text-[12px]">
        <span className="shrink-0 text-muted-foreground">{fileCountLabel}</span>
        <GitHubDiffStat additions={totals.additions} deletions={totals.deletions} />
        <span className="shrink-0 tabular-nums text-muted-foreground" aria-label={viewedLabel}>
          {t('{{viewed}}/{{total}} viewed', { viewed: viewedCount, total: files.length })}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <PullReviewControl
            directory={directory}
            repo={repo}
            number={number}
            github={github}
            access={access}
            size="xs"
            onReviewSubmitted={props.onReviewSubmitted}
          />
          <span className="@4xl:hidden">
            <FilesJumpControl
              files={files}
              viewedPaths={viewedPaths}
              threadCounts={threadCounts}
              pendingCounts={pendingCounts}
              onSelectFile={focusFile}
            />
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={expandAll}
            aria-label={t("Expand all files")}
            title={t("Expand all files")}
            className="size-7"
          >
            <Icon name="expand-up-down" className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={collapseAll}
            aria-label={t("Collapse all files")}
            title={t("Collapse all files")}
            className="size-7"
          >
            <Icon name="collapse-vertical" className="size-3.5" />
          </Button>
        </span>
      </div>
      {props.filesLoading && visibleFiles.length === 0 ? (
        <GitHubListSkeleton rows={5} label={t("Loading changed files")} />
      ) : null}
      {!props.filesLoading && visibleFiles.length === 0 ? (
        <p className="px-1 py-4 typography-micro text-muted-foreground">{t('No changed files')}</p>
      ) : null}
      {visibleFiles.length > 0 ? (
        <div className="flex min-h-0 items-start gap-3">
          <aside
            ref={sidebarRef}
            aria-label={t("Changed files")}
            style={sidebarHeight != null ? { height: sidebarHeight } : undefined}
            className="sticky top-10 hidden max-h-[calc(100dvh-10rem)] w-60 shrink-0 flex-col @4xl:flex"
          >
            <FileJumpList
              files={files}
              viewedPaths={viewedPaths}
              threadCounts={threadCounts}
              pendingCounts={pendingCounts}
              onSelectFile={focusFile}
            />
          </aside>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {visibleFiles.map((file) => (
              <div key={file.filename} id={fileAnchorId(file.filename)} className="scroll-mt-12">
                <FileCard
                  file={file}
                  collapsed={overrides[file.filename] ?? defaults[file.filename] ?? false}
                  onToggleCollapse={toggleCollapse}
                  viewed={viewedSet.has(file.filename)}
                  onToggleViewed={toggleViewed}
                  blobUrl={githubBlobUrlForFile(repo, headSha, file.filename)}
                  threads={threadsByPath.get(file.filename) ?? EMPTY_THREADS}
                  directory={directory}
                  repo={repo}
                  number={number}
                  github={github}
                  access={access}
                  onThreadsChanged={props.onRetryDetail}
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {files.length > visibleFileCount ? (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => setVisibleFileCount(visibleFileCount + FILE_WINDOW)}>
            {t('Show more files')}
          </Button>
        </div>
      ) : null}
      {props.filesHasMore ? (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={props.onLoadMoreFiles}>
            {t('Load more files')}
          </Button>
        </div>
      ) : null}
    </section>
  );
};
