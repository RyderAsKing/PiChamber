import React from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { normalizeSeparators } from './directoryExplorerPaths';
import { focusPathInput, isPrimaryModifierPressed, primaryModifierLabel } from './directoryExplorerTypes';
import type { useDirectoryBrowser } from './useDirectoryBrowser';

type DirectoryBrowser = ReturnType<typeof useDirectoryBrowser>;

interface DirectoryBrowserPaneProps {
  browser: DirectoryBrowser;
  /** Names the path field for screen readers, e.g. "Folder path" or "Location". */
  inputLabel: string;
  /** What Ctrl/⌘+Enter does, shown in the key hints. */
  submitHint: string;
  onSubmit: () => void;
  /** Backspace in an empty path field steps back out of the step. */
  onBack: () => void;
  autoFocus: boolean;
  disabled: boolean;
}

/**
 * A path field over the folders it points at. Typing filters the folder
 * listed; Enter opens the highlighted folder; the modifier plus Enter finishes
 * the step. Shared by every Add folder step that picks a place on the server.
 */
export const DirectoryBrowserPane: React.FC<DirectoryBrowserPaneProps> = ({
  browser,
  inputLabel,
  submitHint,
  onSubmit,
  onBack,
  autoFocus,
  disabled,
}) => {
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
    rows,
    highlightedRow,
    canRequestAccess,
    executeRow,
    handleBrowseLocation,
  } = browser;

  React.useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.scrollLeft = input.scrollWidth;
  }, [inputRef, query]);

  React.useLayoutEffect(() => {
    if (autoFocus) focusPathInput(inputRef.current);
  }, [autoFocus, inputRef]);

  React.useLayoutEffect(() => {
    const row = rows[highlightedIndex];
    if (!row) return;
    rowRefs.current.get(row.value)?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, rowRefs, rows]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
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
        onSubmit();
        return;
      }
      if (highlightedRow) executeRow(highlightedRow);
      return;
    }
    if (event.key === 'Backspace' && query === '') {
      event.preventDefault();
      onBack();
    }
  };

  let listBody: React.ReactNode;
  if (isLoading) {
    listBody = <p className="py-10 text-center typography-meta text-muted-foreground">{'Loading folders…'}</p>;
  } else if (browseErrorReason === 'not-found') {
    listBody = (
      <p className="py-10 text-center typography-meta text-muted-foreground text-balance">
        {'This folder doesn’t exist yet.'}
      </p>
    );
  } else if (browseErrorReason) {
    listBody = (
      <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
        <p className="typography-meta text-[var(--status-error)]">
          {browseErrorReason === 'os-permission'
            ? 'PiChamber needs access to this folder.'
            : 'Couldn’t load this folder.'}
        </p>
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
    );
  } else if (rows.length === 0) {
    listBody = (
      <p className="py-10 text-center typography-meta text-muted-foreground">
        {query.endsWith('/') ? 'No folders in here.' : 'No folders match.'}
      </p>
    );
  } else {
    listBody = (
      <div className="flex flex-col gap-px" role="listbox" aria-label={'Folders'}>
        {rows.map((row, index) => {
          const isActive = index === highlightedIndex;
          return (
            <button
              key={row.value}
              ref={(node) => {
                if (node) rowRefs.current.set(row.value, node);
                else rowRefs.current.delete(row.value);
              }}
              type="button"
              role="option"
              aria-selected={isActive}
              tabIndex={-1}
              aria-label={
                row.type === 'parent'
                  ? `Up to ${row.path}`
                  : `Open ${row.name}${row.alreadyAdded ? ', already added' : ''}`
              }
              onMouseEnter={() => setHighlightedIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => executeRow(row)}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                // The keyboard highlight only means something while the path
                // field has focus; elsewhere it would read as the chosen folder.
                isActive
                  ? 'hover:bg-interactive-hover/50 group-focus-within/pane:bg-interactive-selection group-focus-within/pane:text-interactive-selection-foreground'
                  : 'hover:bg-interactive-hover/50',
              )}
            >
              {row.type === 'parent' ? (
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <Icon name="arrow-up-s" className="size-4 shrink-0 text-subtle-foreground" />
                  <span className="shrink-0 typography-ui-label">{'Up to'}</span>
                  <span className="truncate font-mono typography-meta text-muted-foreground">{row.path}</span>
                </span>
              ) : (
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <Icon name="folder-6" className="size-4 shrink-0 text-subtle-foreground" />
                  <span className="truncate typography-ui-label">{row.name}</span>
                </span>
              )}
              {row.alreadyAdded ? (
                <span className="shrink-0 typography-micro text-muted-foreground">{'Added'}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="group/pane flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Icon
            name="folder-3"
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle-foreground"
          />
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(normalizeSeparators(event.target.value))}
            onKeyDown={handleKeyDown}
            aria-label={inputLabel}
            placeholder={'~/'}
            disabled={disabled}
            className="pl-8 font-mono md:typography-meta typography-meta"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={disabled || isPickingLocation}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void handleBrowseLocation()}
          title={'Pick a folder with the system dialog'}
        >
          {isPickingLocation ? 'Opening…' : 'Browse…'}
        </Button>
      </div>

      <div className="-mx-2 mt-2 h-[min(17rem,38vh)] overflow-y-auto px-2">
        <div
          key={browseDirectoryDisplayPath}
          className={cn(
            'animate-in fade-in-0 duration-150 motion-reduce:animate-none',
            folderEnterFrom === 'left' ? 'slide-in-from-left-1' : 'slide-in-from-right-1',
          )}
        >
          {listBody}
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-3 typography-micro text-subtle-foreground">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>{'↑↓ Move'}</span>
          <span>{'↵ Open'}</span>
          <span>{`${primaryModifierLabel()} ↵ ${submitHint}`}</span>
        </span>
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-muted-foreground">
          <Checkbox checked={showHidden} onChange={setShowHidden} ariaLabel={'Show hidden folders'} />
          {'Show hidden'}
        </label>
      </div>
    </div>
  );
};
