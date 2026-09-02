import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { cn } from '@/lib/utils';
import { IdentityDropdown } from '@/components/views/git/GitHeader';
import { useDeviceInfo } from '@/lib/device';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Icon } from '@/components/icon/Icon';
import { normalizeDirectoryPath, normalizeSeparators } from './directoryExplorerPaths';
import {
  type BrowseRow,
  type DirectoryExplorerDialogProps,
  focusPathInput,
  isPrimaryModifierPressed,
} from './directoryExplorerTypes';
import { useDirectoryBrowser } from './useDirectoryBrowser';
import { useDirectoryCloneAndAdd } from './useDirectoryCloneAndAdd';

export const DirectoryExplorerDialog: React.FC<DirectoryExplorerDialogProps> = ({
  open,
  onOpenChange,
}) => {
  const projects = useProjectsStore((s) => s.projects);
  const { isMobile, isTablet } = useDeviceInfo();
  const shouldSuppressAutoFocus = isMobile || isTablet;

  const addedProjectPaths = React.useMemo(
    () =>
      new Set(
        projects
          .map((project) => normalizeDirectoryPath(project.path))
          .filter((path): path is string => Boolean(path)),
      ),
    [projects],
  );

  const handleClose = React.useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const {
    inputRef,
    rowRefs,
    query,
    setQuery,
    isLoading,
    browseErrorReason,
    setBrowseReloadKey,
    highlightedIndex,
    setHighlightedIndex,
    isPickingLocation,
    showHidden,
    setShowHidden,
    folderEnterFrom,
    browseDirectoryDisplayPath,
    browseDirectoryAbsolutePath,
    rows,
    targetPath,
    isAlreadyAdded,
    shouldCreateTarget,
    highlightedRow,
    hasHighlightedBrowseItem,
    canRequestAccess,
    executeRow,
    handleBrowseLocation,
  } = useDirectoryBrowser({
    open,
    addedProjectPaths,
    shouldSuppressAutoFocus,
  });

  const {
    isConfirming,
    isCloneMode,
    setIsCloneMode,
    cloneRemoteUrl,
    setCloneRemoteUrl,
    setSelectedGitIdentityId,
    availableGitIdentities,
    selectedGitIdentity,
    canSubmit,
    submitActionLabel,
    submitModifierLabel,
    finalizeSelection,
  } = useDirectoryCloneAndAdd({
    open,
    onClose: handleClose,
    isMobile,
    addedProjectPaths,
    targetPath,
    shouldCreateTarget,
    browseErrorReason,
    browseDirectoryAbsolutePath,
    isAlreadyAdded,
    isPickingLocation,
  });

  React.useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.scrollLeft = input.scrollWidth;
  }, [inputRef, query]);

  React.useLayoutEffect(() => {
    if (!open || shouldSuppressAutoFocus) return;
    focusPathInput(inputRef.current);
  }, [inputRef, open, shouldSuppressAutoFocus]);

  React.useLayoutEffect(() => {
    const row = rows[highlightedIndex];
    if (!row) return;
    rowRefs.current.get(row.value)?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, rowRefs, rows]);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlightedIndex((index) => Math.min(rows.length - 1, index + 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlightedIndex((index) => Math.max(0, index - 1));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (isPrimaryModifierPressed(event)) {
          void finalizeSelection(targetPath);
          return;
        }
        if (hasHighlightedBrowseItem) {
          executeRow(highlightedRow);
        }
        return;
      }
      if (event.key === 'Backspace' && query === '') {
        event.preventDefault();
        handleClose();
      }
    },
    [
      executeRow,
      finalizeSelection,
      handleClose,
      hasHighlightedBrowseItem,
      highlightedRow,
      query,
      rows.length,
      setHighlightedIndex,
      targetPath,
    ],
  );

  const showHiddenToggle = (
    <button
      type="button"
      onClick={() => setShowHidden((value) => !value)}
      className="flex flex-shrink-0 items-center gap-2 rounded-lg px-2 py-1 typography-meta text-muted-foreground transition-colors hover:bg-interactive-hover/40"
    >
      {showHidden ? (
        <Icon name="checkbox" className="h-4 w-4 text-primary" />
      ) : (
        <Icon name="checkbox-blank" className="h-4 w-4" />
      )}
      {'Show hidden'}
    </button>
  );

  const inputSection = (
    <div className="py-1.5">
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Icon
            name="folder-3"
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/80"
          />
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(normalizeSeparators(event.target.value))}
            onKeyDown={handleKeyDown}
            placeholder={'Enter a folder path...'}
            className="border-transparent bg-transparent pl-9 font-mono typography-ui-label shadow-none focus-visible:ring-0"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
        </div>
        <Button
          variant="outline"
          size="xs"
          className="h-8 shrink-0 gap-1 px-2"
          disabled={isConfirming || isPickingLocation}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void handleBrowseLocation()}
          title={'Browse location'}
          aria-label={'Browse location'}
        >
          <Icon name="folder-open" className="h-3.5 w-3.5" />
          {isPickingLocation ? 'Opening...' : 'Browse'}
        </Button>
      </div>
    </div>
  );

  const hasParentRow = rows.some((row) => row.type === 'parent');

  const resultsSection = (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border/60 bg-[var(--surface-elevated)] shadow-sm">
      <div className="max-h-[min(28rem,58vh)] overflow-y-auto p-2">
        <div className="flex items-center justify-between gap-2 px-2 pb-1 pt-0.5">
          <div className="typography-meta font-medium uppercase tracking-wide text-muted-foreground/80">
            {'Directories'}
          </div>
          <Button
            variant="ghost"
            size="xs"
            className="h-6 shrink-0 gap-1 text-muted-foreground"
            aria-pressed={isCloneMode}
            disabled={isConfirming || isPickingLocation}
            onClick={() => setIsCloneMode((value) => !value)}
          >
            <Icon name="git-repository" className="h-3.5 w-3.5" />
            {'Clone'}
          </Button>
        </div>
        {isCloneMode ? (
          <div className="mb-2 space-y-1.5 px-2 pb-1">
            <p className="typography-meta text-muted-foreground">{'Clone into the folder path above.'}</p>
            <div className="flex items-center gap-1.5">
              <Input
                value={cloneRemoteUrl}
                onChange={(event) => setCloneRemoteUrl(event.target.value)}
                placeholder={'Repository URL (HTTPS or SSH)'}
                className="min-w-0 flex-1 font-mono typography-ui-label"
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
              />
              <IdentityDropdown
                activeProfile={selectedGitIdentity}
                identities={availableGitIdentities}
                onSelect={(profile) => setSelectedGitIdentityId(profile.id)}
                isApplying={isConfirming}
                iconOnly
              />
            </div>
          </div>
        ) : null}
        {isAlreadyAdded ? (
          <p className="px-2 pb-2 typography-meta text-muted-foreground">
            {'This folder is already added. Open a subfolder to add that instead.'}
          </p>
        ) : null}
        <div
          key={browseDirectoryDisplayPath}
          className={cn(
            'mt-3',
            'animate-in fade-in-0 duration-200 motion-reduce:animate-none',
            folderEnterFrom === 'left' ? 'slide-in-from-left-2' : 'slide-in-from-right-2',
          )}
        >
          {isLoading ? (
            <div className="py-10 text-center typography-ui-label text-muted-foreground">
              {'Loading directories...'}
            </div>
          ) : browseErrorReason && browseErrorReason !== 'not-found' ? (
            <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
              <div className="typography-ui-label text-status-error">
                {browseErrorReason === 'os-permission'
                  ? 'PiChamber needs access to this folder.'
                  : 'Could not load this folder.'}
              </div>
              <div className="flex items-center gap-2">
                {browseErrorReason === 'os-permission' && canRequestAccess ? (
                  <Button size="xs" onClick={() => void handleBrowseLocation()} disabled={isPickingLocation}>
                    {'Grant access'}
                  </Button>
                ) : null}
                <Button variant="outline" size="xs" onClick={() => setBrowseReloadKey((key) => key + 1)}>
                  {'Try again'}
                </Button>
              </div>
            </div>
          ) : rows.length === 0 ? (
            <div className="py-10 text-center typography-ui-label text-muted-foreground">
              {'No matching directories.'}
            </div>
          ) : (
            <div className="space-y-0.5">
              {rows.map((row, index) => {
                const isActive = index === highlightedIndex;
                const isChildRow = row.type === 'directory' && hasParentRow;
                return (
                  <button
                    key={row.value}
                    ref={(node) => {
                      if (node) {
                        rowRefs.current.set(row.value, node);
                      } else {
                        rowRefs.current.delete(row.value);
                      }
                    }}
                    type="button"
                    aria-label={
                      row.type === 'parent'
                        ? row.alreadyAdded
                          ? `Go back from ${row.name}, already added`
                          : `Go back from ${row.name}`
                        : row.alreadyAdded
                          ? `Open ${row.name}, already added`
                          : `Open ${row.name}`
                    }
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => executeRow(row)}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                      isActive && 'bg-interactive-selection text-interactive-selection-foreground',
                      !isActive && 'hover:bg-interactive-hover/50',
                    )}
                  >
                    <span className={cn('flex min-w-0 flex-1 items-center gap-2', isChildRow && 'pl-4')}>
                      {row.type === 'parent' ? (
                        <Icon
                          name="folder-open"
                          className="h-4 w-4 flex-shrink-0 text-muted-foreground/80"
                        />
                      ) : (
                        <Icon name="folder-6" className="h-4 w-4 flex-shrink-0 text-muted-foreground/80" />
                      )}
                      <span className="truncate typography-ui-label text-foreground">{row.name}</span>
                    </span>
                    {row.alreadyAdded ? (
                      <span
                        className={cn(
                          'inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 typography-meta font-medium',
                          isActive
                            ? 'bg-interactive-selection-foreground/15 text-interactive-selection-foreground'
                            : 'bg-[var(--surface-muted)] text-foreground',
                        )}
                      >
                        {'Added'}
                      </span>
                    ) : null}
                    {row.type === 'parent' ? (
                      <Icon
                        name="arrow-up-s"
                        className="h-4 w-4 flex-shrink-0 text-muted-foreground/80"
                        aria-hidden="true"
                      />
                    ) : (
                      <Icon
                        name="arrow-right-s"
                        className="h-4 w-4 flex-shrink-0 text-muted-foreground/80"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const content = (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {inputSection}
      {resultsSection}
    </div>
  );

  const footerHints = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 typography-micro text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <Icon name="arrow-up-s" className="h-3.5 w-3.5" />
        <Icon name="arrow-down-s" className="-ml-1 h-3.5 w-3.5" />
        {'Navigate'}
      </span>
      <span className="inline-flex items-center gap-1">
        <Icon name="corner-down-left" className="h-3.5 w-3.5" />
        {'Open folder'}
      </span>
      <span className="inline-flex items-center gap-1">
        <span>{submitModifierLabel}</span>
        <Icon name="corner-down-left" className="h-3.5 w-3.5" />
        {'Add folder'}
      </span>
    </div>
  );

  const addFolderButton = (
    <Button
      size={isMobile ? 'xs' : 'default'}
      onClick={() => void finalizeSelection(targetPath)}
      disabled={!canSubmit}
      className={cn(isMobile && 'w-full flex-1')}
    >
      {submitActionLabel}
    </Button>
  );

  const renderFooter = () => (
    <>
      {!isMobile ? footerHints : null}
      <div className={cn('flex w-full flex-row justify-end gap-2 sm:w-auto', isMobile && 'justify-stretch')}>
        {addFolderButton}
      </div>
    </>
  );

  if (isMobile) {
    return (
      <MobileOverlayPanel
        open={open}
        onClose={handleClose}
        title={'Add folder'}
        className="h-[88dvh] max-h-[720px]"
        contentMaxHeightClassName="flex-1"
        footer={<div className="flex flex-col gap-2">{renderFooter()}</div>}
      >
        <div className="flex h-full min-h-0 flex-col gap-3">
          <div className="flex justify-end">{showHiddenToggle}</div>
          {content}
        </div>
      </MobileOverlayPanel>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex w-full max-w-xl flex-col gap-0 overflow-hidden p-0 sm:max-h-[80vh]"
        initialFocus={false}
      >
        <DialogHeader className="px-5 pb-2 pt-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <DialogTitle>{'Add folder'}</DialogTitle>
              <DialogDescription className="mt-2">
                {'Choose a folder from the path above, then add it.'}
              </DialogDescription>
            </div>
            {showHiddenToggle}
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 px-5 pb-0">{content}</div>
        <DialogFooter className="flex w-full flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          {renderFooter()}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
