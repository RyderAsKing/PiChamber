import React from 'react';
import { useTranslation } from 'react-i18next';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { MobileSurfaceHeader } from '@/apps/MobileSurfaceHeader';
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
  const { t } = useTranslation();
  if (!root) {
    return <MobileFilesState message={t("Select a project to browse files.")} />;
  }

  if (editorPath) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
        <MobileSurfaceHeader
          leading={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("Back")}
              onClick={onBackFromEditor}
              style={{ touchAction: 'manipulation' }}
            >
              <Icon name="arrow-left" className="size-4" />
            </Button>
          }
          icon={<FileTypeIcon filePath={editorPath} className="size-4 shrink-0" />}
          title={getNameFromPath(editorPath)}
        />
        <div className="min-h-0 flex-1 overflow-hidden">{editor}</div>
      </div>
    );
  }

  const directoryLabel = directory === root ? t('Project files') : getNameFromPath(directory);
  const parentDirectory = canNavigateToParent(directory, root) ? getParentDirectory(directory) : null;
  const canGoBack = Boolean(parentDirectory) && !query.trim();
  const parentLabel = parentDirectory === root ? t('Project files') : getNameFromPath(parentDirectory ?? '');

  const filesLeading = onClose || (canGoBack && parentDirectory) ? (
    <>
      {onClose ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("Close")}
          onClick={onClose}
          style={{ touchAction: 'manipulation' }}
        >
          <Icon name="close" className="size-4" />
        </Button>
      ) : null}
      {canGoBack && parentDirectory ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('Back to {{name}}', { name: getNameFromPath(parentDirectory) })}
          onClick={() => onOpenDirectory(parentDirectory)}
          style={{ touchAction: 'manipulation' }}
        >
          <Icon name="arrow-left" className="size-4" />
        </Button>
      ) : null}
    </>
  ) : undefined;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <MobileSurfaceHeader
        leading={filesLeading}
        icon={directory === root ? 'file-text' : 'folder'}
        title={directoryLabel}
        actions={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("Refresh files")}
            onClick={onRefresh}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="refresh" className={cn('size-4', refreshing && 'animate-spin')} />
          </Button>
        }
      />

      <div className="shrink-0 px-3 py-2">
        <div className="relative">
          <Icon name="search" className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("Search files")}
            className="h-8 pl-7"
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
          <MobileFilesState loading message={t("Loading...")} />
        ) : (
          <div className="flex w-full min-w-0 flex-col px-1">
            {canGoBack && parentDirectory ? (
              <button
                type="button"
                className={cn(sidebarSessionRowClassNameMobile, 'px-2')}
                aria-label={t('Up one level to {{label}}', { label: parentLabel })}
                onClick={() => onOpenDirectory(parentDirectory)}
                style={{ touchAction: 'manipulation' }}
              >
                <Icon name="arrow-left" className={cn(sidebarRowIconClass(true), 'text-muted-foreground')} />
                <span className={cn(sidebarRowLabelClass(true), 'flex-1 text-muted-foreground')}>{t("Up one level")}</span>
              </button>
            ) : null}
            {entries.length === 0 ? (
              <div className="px-3 py-8 text-center typography-ui-label text-muted-foreground">{t("This directory is empty.")}</div>
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
    className={cn(sidebarSessionRowClassNameMobile, 'px-2')}
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
  const { t } = useTranslation();
  if (isSearching) return <MobileFilesState loading message={t("Loading...")} />;
  if (results.length === 0) return <MobileFilesState message={t("No files found.")} />;

  return (
    <div className="flex w-full min-w-0 flex-col px-1">
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
