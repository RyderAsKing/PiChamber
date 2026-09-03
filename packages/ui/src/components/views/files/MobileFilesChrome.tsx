import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from '@/components/icon/Icon';
import {
  sidebarRowIconClass,
  sidebarRowLabelClass,
  sidebarSessionRowClassNameMobile,
} from '@/components/session/sidebar/utils';
import { Input } from '@/components/ui/input';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { cn } from '@/lib/utils';

import {
  canNavigateToParent,
  getNameFromPath,
  getParentDirectory,
  resolveChildPath,
} from './mobileFilesPaths';

type MobileFilesChromeEntry = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  relativePath?: string;
};

type MobileFilesChromeProps = {
  root: string;
  directory: string;
  entries: MobileFilesChromeEntry[] | undefined;
  query: string;
  searchResults: MobileFilesChromeEntry[];
  isSearching: boolean;
  directoryError: string | null;
  refreshing: boolean;
  editorPath: string | null;
  editor: React.ReactNode;
  onClose?: () => void;
  onQueryChange: (value: string) => void;
  onOpenDirectory: (directory: string) => void;
  onOpenFile: (path: string) => void;
  onBackFromEditor: () => void;
  onRefresh: () => void;
};

const formatFileSize = (size?: number): string => {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = size / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) {
      return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
    }
    value /= 1024;
  }
  return '';
};

const getRelativePath = (path: string, root: string): string => {
  if (!root || path === root) return getNameFromPath(path);
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path;
};

export const MobileFilesChrome: React.FC<MobileFilesChromeProps> = ({
  root,
  directory,
  entries,
  query,
  searchResults,
  isSearching,
  directoryError,
  refreshing,
  editorPath,
  editor,
  onClose,
  onQueryChange,
  onOpenDirectory,
  onOpenFile,
  onBackFromEditor,
  onRefresh,
}) => {
  if (!root) {
    return <MobileFilesState message="Select a project to browse files." />;
  }

  if (editorPath) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-transparent text-foreground">
        <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-1 px-2 text-foreground">
          <button
            type="button"
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label="Back"
            onClick={onBackFromEditor}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="arrow-left" className="size-4" />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate typography-ui-label text-foreground">{getNameFromPath(editorPath)}</h2>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">{editor}</div>
      </div>
    );
  }

  const directoryLabel = directory === root ? 'Project files' : getNameFromPath(directory);
  const parentDirectory = canNavigateToParent(directory, root) ? getParentDirectory(directory) : null;
  const canGoBack = Boolean(parentDirectory) && !query.trim();
  const parentLabel = parentDirectory === root ? 'Project files' : getNameFromPath(parentDirectory ?? '');

  return (
    <div className="flex h-full flex-col overflow-hidden bg-transparent text-foreground">
      <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-1 px-2 text-foreground">
        {onClose ? (
          <button
            type="button"
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label="Close"
            onClick={onClose}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="close" className="size-4" />
          </button>
        ) : null}
        {canGoBack && parentDirectory ? (
          <button
            type="button"
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={`Back to ${getNameFromPath(parentDirectory)}`}
            onClick={() => onOpenDirectory(parentDirectory)}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="arrow-left" className="size-4" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1 px-1">
          <h2 className="truncate typography-ui-label text-foreground">{directoryLabel}</h2>
        </div>
        <button
          type="button"
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label="Refresh files"
          onClick={onRefresh}
          style={{ touchAction: 'manipulation' }}
        >
          <Icon name="refresh" className={cn('size-4', refreshing && 'animate-spin')} />
        </button>
      </header>

      <div className="shrink-0 px-3 pb-2 pt-1">
        <div className="relative">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search files"
            className="h-11 pl-9"
          />
        </div>
      </div>

      <ScrollShadow className="min-h-0 w-full flex-1 overflow-y-auto pb-3">
        {directoryError ? (
          <MobileFilesState message={directoryError} />
        ) : query.trim() ? (
          <MobileSearchResults
            root={root}
            results={searchResults}
            isSearching={isSearching}
            onOpenFile={onOpenFile}
          />
        ) : entries === undefined ? (
          <MobileFilesState loading message="Loading..." />
        ) : (
          <div className="flex w-full min-w-0 flex-col">
            {canGoBack && parentDirectory ? (
              <button
                type="button"
                className={sidebarSessionRowClassNameMobile}
                aria-label={`Up one level to ${parentLabel}`}
                onClick={() => onOpenDirectory(parentDirectory)}
                style={{ touchAction: 'manipulation' }}
              >
                <Icon name="arrow-left" className={cn(sidebarRowIconClass(true), 'text-muted-foreground')} />
                <span className={cn(sidebarRowLabelClass(true), 'flex-1 text-muted-foreground')}>Up one level</span>
              </button>
            ) : null}
            {entries.length === 0 ? (
              <div className="px-3 py-8 text-center typography-ui-label text-muted-foreground">This directory is empty.</div>
            ) : null}
            {entries.map((entry) => (
              <MobileFileRow
                key={entry.path}
                name={entry.name}
                path={entry.path}
                directory={entry.type === 'directory'}
                meta={entry.type === 'directory' ? undefined : formatFileSize(entry.size)}
                onClick={() => (
                  entry.type === 'directory'
                    ? onOpenDirectory(resolveChildPath(entry.path, directory || root))
                    : onOpenFile(resolveChildPath(entry.path, directory || root))
                )}
              />
            ))}
          </div>
        )}
      </ScrollShadow>
    </div>
  );
};

const MobileFileRow: React.FC<{
  name: string;
  path: string;
  directory: boolean;
  meta?: string;
  onClick: () => void;
}> = ({ name, path, directory, meta, onClick }) => (
  <button
    type="button"
    className={sidebarSessionRowClassNameMobile}
    onClick={onClick}
    style={{ touchAction: 'manipulation' }}
  >
    {directory ? (
      <Icon name="folder-3-fill" className={cn(sidebarRowIconClass(true), 'text-primary/80')} />
    ) : (
      <FileTypeIcon filePath={path} className={sidebarRowIconClass(true)} />
    )}
    <span className={cn(sidebarRowLabelClass(true), 'flex-1 text-foreground')}>{name}</span>
    {meta ? <span className="shrink-0 typography-micro text-muted-foreground">{meta}</span> : null}
    {directory ? <Icon name="arrow-right-s" className="size-4 shrink-0 text-muted-foreground/60" /> : null}
  </button>
);

const MobileSearchResults: React.FC<{
  root: string;
  results: MobileFilesChromeEntry[];
  isSearching: boolean;
  onOpenFile: (path: string) => void;
}> = ({ root, results, isSearching, onOpenFile }) => {
  if (isSearching) return <MobileFilesState loading message="Loading..." />;
  if (results.length === 0) return <MobileFilesState message="No files found." />;

  return (
    <div className="flex w-full min-w-0 flex-col">
      {results.map((result) => (
        <MobileFileRow
          key={result.path}
          name={getNameFromPath(result.path)}
          path={result.path}
          directory={false}
          meta={result.relativePath ?? getRelativePath(result.path, root)}
          onClick={() => onOpenFile(result.path)}
        />
      ))}
    </div>
  );
};

const MobileFilesState: React.FC<{ message: string; loading?: boolean }> = ({ message, loading = false }) => (
  <div className="flex h-full items-center justify-center px-6 text-center">
    <div className="flex max-w-sm flex-col items-center gap-2">
      {loading ? <Icon name="loader-4" className="size-5 animate-spin text-muted-foreground" /> : <Icon name="folder-open-fill" className="size-6 text-muted-foreground" />}
      <p className="typography-ui-label font-semibold text-foreground">{message}</p>
    </div>
  </div>
);
