import React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useGitStore } from '@/stores/useGitStore';
import { useUIStore } from '@/stores/useUIStore';
import { describeGitChange } from '../git/gitChangeDescriptors';
import { DiffViewToggle } from '@/components/chat/message/DiffViewToggle';
import type { DiffViewMode } from '@/components/chat/message/types';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isImageFile } from '@/lib/toolHelpers';
import { InlineDiffViewer } from './InlineDiffViewer';
import { FileDiffActions } from './FileDiffActions';
import { createTextDiffDataFromPatch, formatDiffTotals } from './diffFormatters';
import type { DiffContextMode, DiffData, FileDiffAction, FileEntry } from './diffTypes';
import {
  DEFAULT_CONTEXT_DIFF_LINES,
  DIFF_REQUEST_TIMEOUT_MS,
  FULL_CONTEXT_DIFF_LINES,
  LARGE_DIFF_CHANGED_LINES,
} from './diffConstants';

export interface MultiFileDiffEntryProps {
  directory: string;
  file: FileEntry;
  layout: 'inline' | 'side-by-side';
  wrapLines: boolean;
  isSelected: boolean;
  isExpanded: boolean;
  isMounted: boolean;
  onSelect: (path: string) => void;
  onExpandedChange: (path: string, expanded: boolean) => void;
  registerSectionRef: (path: string, node: HTMLDivElement | null) => void;
  showOpenInEditorAction?: boolean;
  isOpeningInEditor?: boolean;
  onOpenInEditor?: (filePath: string, diffData: DiffData | null) => void;
  staged?: boolean;
  showFileActions?: boolean;
  loadFullFiles?: boolean;
  initialDiffData?: DiffData | null;
}

export const MultiFileDiffEntry = React.memo<MultiFileDiffEntryProps>(function MultiFileDiffEntry({
  directory,
  file,
  layout,
  wrapLines,
  isSelected,
  isExpanded,
  isMounted,
  onSelect,
  onExpandedChange,
  registerSectionRef,
  showOpenInEditorAction = false,
  isOpeningInEditor = false,
  onOpenInEditor,
  staged = false,
  showFileActions = true,
  loadFullFiles = false,
  initialDiffData = null,
}) {
  const { git } = useRuntimeAPIs();
  const cachedDiff = useGitStore(
    React.useCallback((state) => {
      return state.directories.get(directory)?.diffCache.get(file.path) ?? null;
    }, [directory, file.path])
  );
  const setDiff = useGitStore((state) => state.setDiff);
  const fetchStatus = useGitStore((state) => state.fetchStatus);
  const setDiffFileLayout = useUIStore((state) => state.setDiffFileLayout);

  const [diffRetryNonce, setDiffRetryNonce] = React.useState(0);
  const [diffLoadError, setDiffLoadError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [fileAction, setFileAction] = React.useState<FileDiffAction | null>(null);
  const [forceRenderLarge, setForceRenderLarge] = React.useState(false);
  const [localDiffData, setLocalDiffData] = React.useState<DiffData | null>(null);
  const [stagedDiffData, setStagedDiffData] = React.useState<DiffData | null>(null);
  const lastDiffRequestRef = React.useRef<string | null>(null);
  const sectionRef = React.useRef<HTMLDivElement | null>(null);

  const descriptor = React.useMemo(() => describeGitChange(file), [file]);
  const renderSideBySide = layout === 'side-by-side';
  const desiredContextMode: DiffContextMode = loadFullFiles ? 'full' : 'patch';
  const fileStatusKey = `${file.index}:${file.working_dir}:${file.insertions}:${file.deletions}`;

  const diffData = React.useMemo<DiffData | null>(() => {
    if (initialDiffData) return initialDiffData;
    if (staged) return stagedDiffData;
    if (localDiffData) return localDiffData;
    if (!cachedDiff) return null;
    return { original: cachedDiff.original, modified: cachedDiff.modified, isBinary: cachedDiff.isBinary, contextMode: 'full' };
  }, [cachedDiff, initialDiffData, localDiffData, staged, stagedDiffData]);

  const diffDataMatchesContextMode = diffData?.contextMode === desiredContextMode;

  const setSectionRef = React.useCallback((node: HTMLDivElement | null) => {
    sectionRef.current = node;
    registerSectionRef(file.path, node);
  }, [file.path, registerSectionRef]);

  const handleOpenChange = React.useCallback((open: boolean) => {
    onExpandedChange(file.path, open);
  }, [file.path, onExpandedChange]);

  const handleSelect = React.useCallback(() => {
    onSelect(file.path);
  }, [file.path, onSelect]);

  React.useEffect(() => {
    if (!staged) {
      setLocalDiffData(null);
    } else {
      setStagedDiffData(null);
    }

    setDiffLoadError(null);
    lastDiffRequestRef.current = null;
  }, [fileStatusKey, staged]);

  React.useEffect(() => {
    if (!isExpanded || !isMounted) return;
    if (!directory || initialDiffData || (diffData && diffDataMatchesContextMode)) {
      lastDiffRequestRef.current = null;
      setIsLoading(false);
      return;
    }

    const requestKey = `${directory}::${file.path}::${staged ? 'staged' : 'unstaged'}::${fileStatusKey}::${desiredContextMode}::${diffRetryNonce}`;
    if (lastDiffRequestRef.current === requestKey) {
      return;
    }
    lastDiffRequestRef.current = requestKey;
    setDiffLoadError(null);
    setIsLoading(true);

    let cancelled = false;
    const runtimeKey = getRuntimeKey();
    const contextLines = loadFullFiles ? FULL_CONTEXT_DIFF_LINES : DEFAULT_CONTEXT_DIFF_LINES;
    const fetchPromise = isImageFile(file.path)
      ? git.getGitFileDiff(directory, { path: file.path, staged })
      : git.getGitDiff(directory, { path: file.path, staged, contextLines });
    const timeoutMs = DIFF_REQUEST_TIMEOUT_MS;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    void Promise.race([fetchPromise, timeoutPromise])
      .then((response) => {
        if (cancelled) return;

        if ('diff' in response) {
          const nextDiff = createTextDiffDataFromPatch(file.path, response.diff, desiredContextMode);
          if (staged) {
            setStagedDiffData(nextDiff);
          } else {
            setLocalDiffData(nextDiff);
          }
        } else {
          const nextDiff = {
            original: response.original ?? '',
            modified: response.modified ?? '',
            isBinary: response.isBinary,
            contextMode: 'full' as const,
          };
          if (staged) {
            setStagedDiffData(nextDiff);
          } else {
            setDiff(directory, file.path, nextDiff, runtimeKey);
          }
        }
        setIsLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setDiffLoadError(message);
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
      if (lastDiffRequestRef.current === requestKey) {
        lastDiffRequestRef.current = null;
      }
    };
  }, [desiredContextMode, diffData, diffDataMatchesContextMode, diffRetryNonce, directory, file.path, fileStatusKey, git, initialDiffData, isExpanded, isMounted, loadFullFiles, setDiff, staged]);

  const handleToggle = React.useCallback(() => {
    handleOpenChange(!isExpanded);
    handleSelect();
  }, [handleOpenChange, handleSelect, isExpanded]);

  const handleFileAction = React.useCallback(async (action: FileDiffAction) => {
    if (!directory || fileAction !== null) {
      return;
    }

    setFileAction(action);
    try {
      if (action === 'stage') {
        await git.stageGitFile(directory, file.path);
      } else if (action === 'unstage') {
        await git.unstageGitFile(directory, file.path);
      } else {
        await git.revertGitFile(directory, file.path, { scope: 'working' });
      }
      setDiffRetryNonce((nonce) => nonce + 1);
      await fetchStatus(directory, git);
    } catch (error) {
      const fallbackMessage = action === 'unstage'
        ? 'Failed to unstage changes'
        : action === 'stage'
          ? 'Failed to stage changes'
          : 'Failed to revert changes';
      toast.error(error instanceof Error ? error.message : fallbackMessage);
    } finally {
      setFileAction((current) => (current === action ? null : current));
    }
  }, [directory, fetchStatus, file.path, fileAction, git]);

  return (
    <div
      ref={setSectionRef}
      className={cn(
        'scroll-mt-9 border-b border-[var(--interactive-border)]/40 last:border-b-0'
      )}
    >
      <div className={cn(
        'z-30 border-b border-[var(--interactive-border)]/35 bg-[var(--surface-elevated)]/90 backdrop-blur-md supports-[backdrop-filter]:bg-[var(--surface-elevated)]/80',
        'sticky top-0'
      )}>
        <div
          role="button"
          tabIndex={0}
          onClick={handleToggle}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              handleToggle();
            }
          }}
          className={cn(
            'cursor-pointer',
            'group/header relative grid min-h-9 w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 overflow-hidden px-3 py-2',
            'bg-transparent',
            'text-muted-foreground hover:text-foreground',
            isSelected ? 'bg-[var(--interactive-selection)]/35' : null
          )}
        >
          <div className="absolute inset-0 pointer-events-none group-hover/header:bg-[var(--interactive-hover)]/50" />
          <div className="relative flex min-w-0 flex-1 items-center gap-2">
            <span className="flex size-5 items-center justify-center opacity-70 group-hover/header:opacity-100">
              {isExpanded ? (
                <Icon name="arrow-down-s" className="size-4" />
              ) : (
                <Icon name="arrow-right-s" className="size-4" />
              )}
            </span>
            <span
              className="typography-micro font-semibold leading-none w-4 text-center uppercase"
              style={{ color: descriptor.color }}
              title={descriptor.description}
              aria-label={descriptor.description}
            >
              {descriptor.code}
            </span>
            <span
              className="min-w-0 flex-1 overflow-hidden typography-ui-label"
              title={file.path}
            >
              <span className="flex min-w-0 items-center gap-2">
                <FileTypeIcon filePath={file.path} className="h-3.5 w-3.5 flex-shrink-0 align-middle" />
                {(() => {
                  const lastSlash = file.path.lastIndexOf('/');
                  if (lastSlash === -1) {
                    return (
                      <span
                        className="block min-w-0 truncate typography-ui-label text-foreground"
                        style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}
                      >
                        {file.path}
                      </span>
                    );
                  }

                  const dir = file.path.slice(0, lastSlash);
                  const name = file.path.slice(lastSlash + 1);

                  return (
                    <span className="flex min-w-0 items-baseline overflow-hidden">
                      <span
                        className="min-w-0 truncate typography-ui-label text-muted-foreground"
                        style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}
                      >
                        {dir}
                      </span>
                      <span className="flex-shrink-0 typography-ui-label">
                        <span className="text-muted-foreground">/</span>
                        <span className="text-foreground">{name}</span>
                      </span>
                    </span>
                  );
                })()}
              </span>
            </span>
          </div>
          <div className="relative flex shrink-0 items-center justify-self-end gap-2">
            {formatDiffTotals(file.insertions, file.deletions)}
            {showOpenInEditorAction && onOpenInEditor ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0 opacity-70 hover:opacity-100"
                title={"Open this file in editor at change"}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenInEditor(file.path, diffData);
                }}
                disabled={isOpeningInEditor}
              >
                {isOpeningInEditor ? (
                  <Icon name="loader-4" className="size-3.5 animate-spin" />
                ) : (
                  <Icon name="edit" className="size-3.5" />
                )}
              </Button>
            ) : null}
            <DiffViewToggle
              mode={renderSideBySide ? 'side-by-side' : 'unified'}
              onModeChange={(mode: DiffViewMode) => {
                const nextLayout: 'inline' | 'side-by-side' =
                  mode === 'side-by-side' ? 'side-by-side' : 'inline';
                setDiffFileLayout(file.path, nextLayout);
              }}
              className="opacity-70"
            />
          </div>
        </div>
      </div>
      {isExpanded && (
        <div className="relative overflow-hidden bg-background">
          {!isMounted && !diffLoadError ? (
            <div className="h-40 border border-border/40 bg-background/40" />
          ) : null}
          {diffLoadError ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
              <div className="typography-ui-label font-semibold text-foreground">
                {"Failed to load diff"}
              </div>
              <div className="typography-meta text-muted-foreground max-w-[32rem] text-center">
                {diffLoadError}
              </div>
              <button
                type="button"
                className="typography-ui-label text-primary hover:underline"
                onClick={() => setDiffRetryNonce((nonce) => nonce + 1)}
              >
                {"Retry"}
              </button>
            </div>
          ) : null}
          {isMounted && isLoading && !diffData && !diffLoadError ? (
            <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
              <Icon name="loader-4" className="size-4 animate-spin" />
              {"Loading diff..."}
            </div>
          ) : null}
          {isMounted && diffData && !forceRenderLarge && (file.insertions + file.deletions) > LARGE_DIFF_CHANGED_LINES ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
              <div className="typography-ui-label font-semibold text-foreground">
                {`Large diff (${file.insertions + file.deletions} changed lines)`}
              </div>
              <div className="typography-meta text-muted-foreground">
                {"Rendering may be slow. You can still view the diff by clicking below."}
              </div>
              <button
                type="button"
                className="typography-ui-label text-primary hover:underline"
                onClick={() => setForceRenderLarge(true)}
              >
                {"Render anyway"}
              </button>
            </div>
          ) : null}
          {isMounted && diffData && (forceRenderLarge || (file.insertions + file.deletions) <= LARGE_DIFF_CHANGED_LINES) ? (
            <>
              <InlineDiffViewer
                filePath={file.path}
                diff={diffData}
                renderSideBySide={renderSideBySide}
                wrapLines={wrapLines}
              />
              {showFileActions ? (
                <div className="pointer-events-none absolute bottom-3 right-3 z-20">
                  <div className="pointer-events-auto">
                    <FileDiffActions
                      filePath={file.path}
                      staged={staged}
                      busyAction={fileAction}
                      disabled={fileAction !== null}
                      onAction={handleFileAction}
                    />
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
});
