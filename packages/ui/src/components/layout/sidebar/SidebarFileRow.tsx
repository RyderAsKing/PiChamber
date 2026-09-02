import React from 'react';
import { toast } from '@/components/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { copyTextToClipboard } from '@/lib/clipboard';
import { cn, getRevealLabel } from '@/lib/utils';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from "@/components/icon/Icon";
import {
  getDisplayPath,
  type FileNode,
} from '@/components/views/files/filesViewModel';

export type FileStatus = 'open' | 'modified' | 'git-modified' | 'git-added' | 'git-deleted';

export const FileStatusDot: React.FC<{ status: FileStatus }> = ({ status }) => {
  const color = {
    open: 'var(--status-info)',
    modified: 'var(--status-warning)',
    'git-modified': 'var(--status-warning)',
    'git-added': 'var(--status-success)',
    'git-deleted': 'var(--status-error)',
  }[status];

  return <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />;
};

export const getFileIcon = (filePath: string, extension?: string): React.ReactNode => {
  return <FileTypeIcon filePath={filePath} extension={extension} />;
};

export interface FileRowProps {
  node: FileNode;
  root: string;
  isExpanded: boolean;
  isActive: boolean;
  isBrowserClient: boolean;
  status?: FileStatus | null;
  badge?: { modified: number; added: number } | null;
  permissions: {
    canRename: boolean;
    canCreateFile: boolean;
    canCreateFolder: boolean;
    canDelete: boolean;
    canReveal: boolean;
  };
  downloadFile?: (path: string) => Promise<void>;
  onSelect: (node: FileNode) => void;
  onToggle: (path: string) => void;
  onRevealPath: (path: string) => void;
  onOpenDialog: (
    type: 'createFile' | 'createFolder' | 'rename' | 'delete',
    data: { path: string; name?: string; type?: 'file' | 'directory' }
  ) => void;
}

export const FileRow: React.FC<FileRowProps> = ({
  node,
  root,
  isExpanded,
  isActive,
  isBrowserClient,
  status,
  badge,
  permissions,
  downloadFile,
  onSelect,
  onToggle,
  onRevealPath,
  onOpenDialog,
}) => {
  const isDir = node.type === 'directory';
  const { canRename, canCreateFile, canCreateFolder, canDelete, canReveal } = permissions;
  const canDownload = !isDir && Boolean(downloadFile);
  const canRevealPath = canReveal && !isBrowserClient;
  const hasMenuActions = canRename || canCreateFile || canCreateFolder || canDelete || canDownload || canRevealPath;

  const [contextMenuOpen, setContextMenuOpen] = React.useState(false);
  const [rightClickOpen, setRightClickOpen] = React.useState(false);

  const handleContextMenu = React.useCallback((event?: React.MouseEvent) => {
    if (!hasMenuActions) return;
    event?.preventDefault();
    setRightClickOpen(true);
  }, [hasMenuActions]);

  const handleInteraction = React.useCallback(() => {
    if (isDir) {
      onToggle(node.path);
    } else {
      onSelect(node);
    }
  }, [isDir, node, onSelect, onToggle]);

  const handleMenuButtonClick = React.useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setRightClickOpen(false);
    setContextMenuOpen(true);
  }, []);

  const renderMenuItems = ({
    Item,
    Separator,
  }: {
    Item: React.ElementType;
    Separator: React.ElementType;
  }) => (
    <>
      {canRename && (
        <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenDialog('rename', node); }}>
          <Icon name="edit" className="mr-2 h-4 w-4" /> {"Rename"}
        </Item>
      )}
      <Item onClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        void copyTextToClipboard(node.path).then((result) => {
          if (result.ok) {
            toast.success("Path copied");
            return;
          }
          toast.error("Copy failed");
        });
      }}>
        <Icon name="file-copy" className="mr-2 h-4 w-4" /> {"Copy Path"}
      </Item>
      {!isDir && downloadFile && (
        <Item onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          void downloadFile(node.path).catch((error) => {
            console.error('Download failed:', error);
            toast.error("Operation failed");
          });
        }}>
          <Icon name="download" className="mr-2 h-4 w-4" /> {(isBrowserClient ? "Download" : "Save")}
        </Item>
      )}
      {canRevealPath && (
        <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onRevealPath(node.path); }}>
          <Icon name="folder-received" className="mr-2 h-4 w-4" /> {getRevealLabel()}
        </Item>
      )}
      {isDir && (canCreateFile || canCreateFolder) && (
        <>
          <Separator />
          {canCreateFile && (
            <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenDialog('createFile', node); }}>
              <Icon name="file-add" className="mr-2 h-4 w-4" /> {"New File"}
            </Item>
          )}
          {canCreateFolder && (
            <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenDialog('createFolder', node); }}>
              <Icon name="folder-add" className="mr-2 h-4 w-4" /> {"New Folder"}
            </Item>
          )}
        </>
      )}
      {canDelete && (
        <>
          <Separator />
          <Item
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenDialog('delete', node); }}
            className="text-destructive focus:text-destructive"
          >
            <Icon name="delete-bin" className="mr-2 h-4 w-4" /> {"Delete"}
          </Item>
        </>
      )}
    </>
  );

  const handleDragStart = React.useCallback((e: React.DragEvent) => {
    const path = getDisplayPath(root, node.path);
    if (!path) return;
    e.dataTransfer.setData('application/x-pichamber-file-path', path);
    e.dataTransfer.effectAllowed = 'copy';
  }, [node.path, root]);

  return (
    <ContextMenu open={rightClickOpen} onOpenChange={setRightClickOpen}>
      <ContextMenuTrigger render={<div className="group relative flex items-center" onContextMenu={handleContextMenu} />}>
      <button
        type="button"
        onClick={handleInteraction}
        onContextMenu={handleContextMenu}
        draggable
        onDragStart={handleDragStart}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-foreground transition-colors pr-8 select-none',
          isActive ? 'bg-interactive-selection/70' : 'hover:bg-interactive-hover/40',
          'cursor-grab active:cursor-grabbing'
        )}
      >
        {isDir ? (
          isExpanded ? (
            <Icon name="folder-open" className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          ) : (
            <Icon name="folder-3" className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          )
        ) : (
          getFileIcon(node.path, node.extension)
        )}
        <span className="min-w-0 flex-1 truncate typography-meta" title={node.path}>
          {node.name}
        </span>
        {!isDir && status && <FileStatusDot status={status} />}
        {isDir && badge && (
          <span className="text-xs flex items-center gap-1 ml-auto mr-1">
            {badge.modified > 0 && <span className="text-[var(--status-warning)]">M{badge.modified}</span>}
            {badge.added > 0 && <span className="text-[var(--status-success)]">+{badge.added}</span>}
          </span>
        )}
      </button>
      {hasMenuActions && (
        <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
          <DropdownMenu
            open={contextMenuOpen}
            onOpenChange={setContextMenuOpen}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={handleMenuButtonClick}
                      title={"File menu"}
                      aria-label={"File menu"}
                    >
                      <Icon name="more-2-fill" className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>{"File menu"}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" side="bottom" onCloseAutoFocus={() => setContextMenuOpen(false)}>
              {renderMenuItems({ Item: DropdownMenuItem, Separator: DropdownMenuSeparator })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[180px]">
        {renderMenuItems({ Item: ContextMenuItem, Separator: ContextMenuSeparator })}
      </ContextMenuContent>
    </ContextMenu>
  );
};

export const areFileRowPropsEqual = (prev: FileRowProps, next: FileRowProps): boolean => (
  prev.node === next.node
  && prev.root === next.root
  && prev.isExpanded === next.isExpanded
  && prev.isActive === next.isActive
  && prev.isBrowserClient === next.isBrowserClient
  && prev.status === next.status
  && prev.badge === next.badge
  && prev.permissions === next.permissions
  && prev.downloadFile === next.downloadFile
  && prev.onSelect === next.onSelect
  && prev.onToggle === next.onToggle
  && prev.onRevealPath === next.onRevealPath
  && prev.onOpenDialog === next.onOpenDialog
);

export const MemoizedFileRow = React.memo(FileRow, areFileRowPropsEqual);
