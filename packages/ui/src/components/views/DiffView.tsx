import React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { DiffViewToggle } from '@/components/chat/message/DiffViewToggle';
import { Icon } from "@/components/icon/Icon";
import { ChangeScopeSelector } from './diff/ChangeScopeSelector';
import { FileList } from './diff/FileList';
import { MultiFileDiffEntry } from './diff/MultiFileDiffEntry';
import type { DiffScope } from './diff/diffTypes';
import { useDiffViewState } from './diff/useDiffViewState';

export type { DiffScope };

export type DiffHeaderScope = Extract<DiffScope, 'all' | 'working' | 'staged' | 'turn' | 'branch'>;

/**
 * Live toolbar state a host's unified header needs when the inline diff
 * toolbar is hidden (git-embedded mode). Counts feed the scope picker;
 * the actions feed the header overflow menu so no view option is lost.
 */
export interface DiffHeaderControlsState {
  turnCount: number;
  branchCount: number;
  expandedCount: number;
  totalCount: number;
  loadFullFiles: boolean;
  wrapLines: boolean;
  layoutMode: 'inline' | 'side-by-side' | null;
  onExpandOrCollapseAll: () => void;
  onToggleLoadFullFiles: () => void;
  onToggleWrapLines: () => void;
  onToggleLayout: () => void;
}

interface DiffViewProps {
  hideStackedFileSidebar?: boolean;
  stackedDefaultCollapsedAll?: boolean;
  pinSelectedFileHeaderToTopOnNavigate?: boolean;
  showOpenInEditorAction?: boolean;
  diffScope?: DiffScope;
  onDiffScopeChange?: (scope: DiffHeaderScope) => void;
  branchBase?: string | null;
  branchHead?: string | null;
  targetFilePath?: string | null;
  /** Render diff content flush with the container edges (no outer padding). */
  flushContent?: boolean;
  /**
   * Hide the inline toolbar row. The host renders the scope picker and view
   * options in its own header and receives live state via
   * onHeaderControlsStateChange; scope changes that originate inside (pending
   * file navigation) are mirrored back through onDiffScopeChange.
   */
  hideToolbar?: boolean;
  onHeaderControlsStateChange?: (state: DiffHeaderControlsState) => void;
  /**
   * Panel host only: element in the host header that owns the toolbar
   * controls. When provided, the scope picker plus view actions portal there
   * instead of rendering the inline toolbar row (terminal/git pattern), so
   * the panel keeps a single header row. Hosts without panel chrome omit it
   * and keep the inline row.
   */
  toolbarSlot?: HTMLDivElement | null;
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
  hideToolbar = false,
  onHeaderControlsStateChange,
  toolbarSlot = null,
}) => {
  const {
    effectiveDirectory,
    isGitRepo,
    status,
    isLoadingStatus,
    activeDiffScope,
    setActiveDiffScope,
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
  } = useDiffViewState({
    hideStackedFileSidebar,
    stackedDefaultCollapsedAll,
    pinSelectedFileHeaderToTopOnNavigate,
    diffScope,
    branchBase,
    branchHead,
    targetFilePath,
  });

  // Embedded mode (git panel header owns the controls): mirror scope changes
  // that originate inside — pending-file navigation, target file effects —
  // back to the host so its picker stays in sync. The parent only writes back
  // when its own state actually changes, so identical values converge.
  React.useEffect(() => {
    if (!hideToolbar) {
      return;
    }
    onDiffScopeChange?.(activeDiffScope);
  }, [activeDiffScope, hideToolbar, onDiffScopeChange]);

  const handleToggleLoadFullFiles = React.useCallback(() => {
    setLoadFullFiles((value) => !value);
  }, [setLoadFullFiles]);

  const handleToggleWrapLines = React.useCallback(() => {
    setDiffWrapLines(!diffWrapLines);
  }, [diffWrapLines, setDiffWrapLines]);

  const handleToggleLayout = React.useCallback(() => {
    handleHeaderLayoutChange(currentLayoutForAllFiles === 'side-by-side' ? 'unified' : 'side-by-side');
  }, [currentLayoutForAllFiles, handleHeaderLayoutChange]);

  const expandedCount = expandedFiles.size;

  const headerControlsState = React.useMemo<DiffHeaderControlsState>(() => ({
    turnCount: turnFileCount,
    branchCount: branchFileCount,
    expandedCount,
    totalCount: changedFiles.length,
    loadFullFiles,
    wrapLines: diffWrapLines,
    layoutMode: currentLayoutForAllFiles,
    onExpandOrCollapseAll: handleExpandOrCollapseAll,
    onToggleLoadFullFiles: handleToggleLoadFullFiles,
    onToggleWrapLines: handleToggleWrapLines,
    onToggleLayout: handleToggleLayout,
  }), [
    turnFileCount,
    branchFileCount,
    expandedCount,
    changedFiles.length,
    loadFullFiles,
    diffWrapLines,
    currentLayoutForAllFiles,
    handleExpandOrCollapseAll,
    handleToggleLoadFullFiles,
    handleToggleWrapLines,
    handleToggleLayout,
  ]);

  React.useEffect(() => {
    if (!hideToolbar) {
      return;
    }
    onHeaderControlsStateChange?.(headerControlsState);
  }, [hideToolbar, headerControlsState, onHeaderControlsStateChange]);

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

  // Single header row: the scope picker plus view actions. Hosts with their
  // own chrome (ContextPanel) portal this row into their header via
  // toolbarSlot instead of rendering it inline (terminal/git pattern).
  const toolbarRow = (
      <div
        className={
          toolbarSlot
            ? 'flex min-w-0 flex-1 items-center gap-1.5'
            : '@container/diff-toolbar flex min-w-0 items-center gap-2 px-3 py-2 bg-background'
        }
      >
        {(isGitRepo !== false || activeDiffScope === 'turn') &&
        (activeDiffScope === 'all' ||
          activeDiffScope === 'working' ||
          activeDiffScope === 'staged' ||
          activeDiffScope === 'turn' ||
          activeDiffScope === 'branch') ? (
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
                : changedFiles.length === 1
                ? `${changedFiles.length} file changed`
                : `${changedFiles.length} files changed`}
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
              'ml-auto'
            )}
            title={expandedFiles.size > 0 ? "Collapse all" : "Expand all"}
          >
            <Icon name="expand-up-down" className="size-4" />
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
                  loadFullFiles && 'bg-interactive-selection text-interactive-selection-foreground'
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
            onClick={() => setDiffWrapLines(!diffWrapLines)}
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
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {toolbarSlot ? createPortal(toolbarRow, toolbarSlot) : hideToolbar ? null : toolbarRow}

      {renderContent()}
    </div>
  );
};
