import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { FileRow, type FileStatus } from './FilesViewChrome';
import { FileListRow } from './FileListRow';
import { getDisplayPath, type FileNode } from './filesViewModel';
import { createExpansionSet } from './fileTreeStatus';

export interface FilesTreePanelProps {
  root: string;
  isMobile: boolean;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  searching: boolean;
  searchFailed: boolean;
  searchResults: FileNode[];
  selectedFile: FileNode | null;
  onSelectFile: (file: FileNode) => void;
  onOpenDialog: (
    operation: 'createFile' | 'createFolder' | 'rename' | 'delete',
    data: { path: string; name?: string; type?: 'file' | 'directory' },
  ) => void;
  currentDirectory: string;
  refreshRoot: () => Promise<void>;
  childrenByDir: Record<string, FileNode[] | undefined>;
  loadErrorsByDir: Record<string, string | undefined>;
  expandedPaths: string[];
  isBrowserClient: boolean;
  alwaysShowActions: boolean;
  getFileStatus: (path: string) => FileStatus | null;
  getFolderBadge: (path: string) => { modified: number; added: number } | null;
  fileRowPermissions: {
    canRename: boolean;
    canCreateFile: boolean;
    canCreateFolder: boolean;
    canDelete: boolean;
    canReveal: boolean;
  };
  downloadFile?: (path: string) => Promise<void>;
  contextMenuPath: string | null;
  setContextMenuPath: (path: string | null) => void;
  rightClickMenuPath: string | null;
  setRightClickMenuPath: (path: string | null) => void;
  toggleDirectory: (path: string) => void;
  handleRevealPath: (path: string) => void;
  refreshDirectory: (path: string) => Promise<void>;
}

export const FilesTreePanel: React.FC<FilesTreePanelProps> = ({
  root,
  isMobile,
  searchQuery,
  onSearchQueryChange,
  searchInputRef,
  searching,
  searchFailed,
  searchResults,
  selectedFile,
  onSelectFile,
  onOpenDialog,
  currentDirectory,
  refreshRoot,
  childrenByDir,
  loadErrorsByDir,
  expandedPaths,
  isBrowserClient,
  alwaysShowActions,
  getFileStatus,
  getFolderBadge,
  fileRowPermissions,
  downloadFile,
  contextMenuPath,
  setContextMenuPath,
  rightClickMenuPath,
  setRightClickMenuPath,
  toggleDirectory,
  handleRevealPath,
  refreshDirectory,
}) => {
  const hasTree = Boolean(root && childrenByDir[root]);
  const searchActive = searchQuery.trim().length > 0;
  const rootLoadError = root ? loadErrorsByDir[root] : null;
  // One O(expanded) build per snapshot, then O(1) membership per row
  // instead of an `includes` scan per rendered node.
  const expandedSet = React.useMemo(() => createExpansionSet(expandedPaths), [expandedPaths]);

  function renderTree(dirPath: string, depth: number): React.ReactNode {
    const nodes = childrenByDir[dirPath] ?? [];

    return nodes.map((node) => {
      const isDir = node.type === 'directory';
      const isExpanded = isDir && expandedSet.has(node.path);
      const isActive = selectedFile?.path === node.path;

      return (
        <li key={node.path} className="relative">
          <FileRow
            node={node}
            root={root}
            isExpanded={isExpanded}
            isActive={isActive}
            isMobile={isMobile}
            isBrowserClient={isBrowserClient}
            alwaysShowActions={alwaysShowActions}
            status={!isDir ? getFileStatus(node.path) : undefined}
            badge={isDir ? getFolderBadge(node.path) : undefined}
            permissions={fileRowPermissions}
            downloadFile={downloadFile}
            contextMenuPath={contextMenuPath}
            setContextMenuPath={setContextMenuPath}
            rightClickMenuPath={rightClickMenuPath}
            setRightClickMenuPath={setRightClickMenuPath}
            onSelect={onSelectFile}
            onToggle={toggleDirectory}
            onRevealPath={handleRevealPath}
            onOpenDialog={onOpenDialog}
          />
          {isDir && isExpanded && (
            <ul className="relative ml-[15px] flex flex-col border-l border-border/50 pl-1.5">
              {loadErrorsByDir[node.path] ? (
                <li className="flex items-center gap-2 px-2 py-1 typography-meta text-muted-foreground">
                  <span
                    className="min-w-0 flex-1 truncate text-[var(--status-error)]"
                    title={loadErrorsByDir[node.path]}
                  >
                    {loadErrorsByDir[node.path]}
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="h-6 gap-1"
                    onClick={() => void refreshDirectory(node.path)}
                  >
                    <Icon name="refresh" className="size-3.5" />
                    Refresh
                  </Button>
                </li>
              ) : null}
              {renderTree(node.path, depth + 1)}
            </ul>
          )}
        </li>
      );
    });
  }

  return (
    <section
      className={cn(
        'flex min-h-0 flex-col overflow-hidden',
        isMobile
          ? 'h-full w-full bg-background'
          : 'h-full rounded-xl border border-border/60 bg-background/70',
      )}
    >
      <div className={cn('flex flex-col gap-2 py-2', isMobile ? 'px-3' : 'px-2')}>
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Icon
              name="search"
              className="pointer-events-none absolute left-2 top-2 size-4 text-muted-foreground"
            />
            <Input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => onSearchQueryChange(e.target.value)}
              placeholder="Search files..."
              className="h-8 pl-8 pr-8 typography-meta"
            />
            {searchQuery.trim().length > 0 && (
              <button
                type="button"
                aria-label="Clear search"
                className="absolute right-2 top-2 inline-flex size-4 items-center justify-center text-muted-foreground hover:text-foreground"
                onClick={() => {
                  onSearchQueryChange('');
                  searchInputRef.current?.focus();
                }}
              >
                <Icon name="close" className="size-4" />
              </button>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex flex-shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    onOpenDialog('createFile', { path: currentDirectory, type: 'directory' })
                  }
                  className="size-8 p-0 flex-shrink-0"
                  title="New file"
                  aria-label="New file"
                >
                  <Icon name="file-add" className="size-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              New File
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex flex-shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    onOpenDialog('createFolder', { path: currentDirectory, type: 'directory' })
                  }
                  className="size-8 p-0 flex-shrink-0"
                  title="New folder"
                  aria-label="New folder"
                >
                  <Icon name="folder-add" className="size-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              New Folder
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex flex-shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void refreshRoot()}
                  className="size-8 p-0 flex-shrink-0"
                  title="Refresh"
                  aria-label="Refresh"
                >
                  <Icon name="refresh" className="size-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Refresh
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <ScrollableOverlay
        outerClassName="flex-1 min-h-0"
        className={cn('py-2', isMobile ? 'px-3' : 'px-2')}
      >
        <ul className="flex flex-col">
          {searchActive && searching ? (
            <li className="flex items-center gap-1.5 px-2 py-1 typography-meta text-muted-foreground">
              <Icon name="loader-4" className="size-4 animate-spin" />
              Searching...
            </li>
          ) : searchActive && searchFailed ? (
            <li className="px-2 py-1 typography-meta text-[var(--status-error)]">Search failed. Edit the search to try again.</li>
          ) : searchActive && searchResults.length === 0 ? (
            <li className="px-2 py-1 typography-meta text-muted-foreground text-pretty">{`No files match “${searchQuery.trim()}”.`}</li>
          ) : searchActive ? (
            searchResults.map((node) => (
              <li key={node.path}>
                <FileListRow
                  path={node.relativePath || getDisplayPath(root, node.path) || node.path}
                  status={getFileStatus(node.path)}
                  active={selectedFile?.path === node.path}
                  match={searchQuery}
                  onClick={() => void onSelectFile(node)}
                />
              </li>
            ))
          ) : rootLoadError ? (
            <li className="flex flex-col gap-2 px-2 py-1 typography-meta text-muted-foreground">
              <span className="text-[var(--status-error)]">{rootLoadError}</span>
              <Button
                variant="outline"
                size="xs"
                className="w-fit gap-1.5"
                onClick={() => void refreshRoot()}
              >
                <Icon name="refresh" className="size-3.5" />
                Refresh
              </Button>
            </li>
          ) : hasTree ? (
            renderTree(root, 0)
          ) : (
            <li className="px-2 py-1 typography-meta text-muted-foreground">Loading...</li>
          )}
        </ul>
      </ScrollableOverlay>
    </section>
  );
};
