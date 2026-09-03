import React from 'react';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
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
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from '@/components/icon/Icon';
import { cn, getRevealLabel } from '@/lib/utils';
import { getDisplayPath, type FileNode } from './filesViewModel';

export const OpenInAppListIcon = ({ label, iconDataUrl }: { label: string; iconDataUrl?: string }) => {
  const [failed, setFailed] = React.useState(false);
  const initial = label.trim().slice(0, 1).toUpperCase() || '?';

  if (iconDataUrl && !failed) {
    return (
      <img
        src={iconDataUrl}
        alt=""
        className="size-4 rounded-sm"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span
      className={cn(
        'size-4 rounded-sm flex items-center justify-center',
        'bg-[var(--surface-muted)] text-[9px] font-medium text-muted-foreground'
      )}
    >
      {initial}
    </span>
  );
};

export const FileIcon: React.FC<{ filePath: string; extension?: string }> = ({ filePath, extension }) => (
  <FileTypeIcon filePath={filePath} extension={extension} />
);

export type FileStatus = 'open' | 'modified' | 'git-modified' | 'git-added' | 'git-deleted';

const FileStatusDot: React.FC<{ status: FileStatus }> = ({ status }) => {
  const color = {
    open: 'var(--status-info)',
    modified: 'var(--status-warning)',
    'git-modified': 'var(--status-warning)',
    'git-added': 'var(--status-success)',
    'git-deleted': 'var(--status-error)',
  }[status];

  return <span className="size-2 rounded-full" style={{ backgroundColor: color }} />;
};

export const ScrollingFileName: React.FC<{ name: string }> = ({ name }) => {
  const containerRef = React.useRef<HTMLSpanElement | null>(null);
  const textRef = React.useRef<HTMLSpanElement | null>(null);
  const [overflowing, setOverflowing] = React.useState(false);

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    const text = textRef.current;
    if (!container || !text) {
      return;
    }

    const updateOverflow = () => {
      setOverflowing(text.scrollWidth > container.clientWidth + 1);
    };

    updateOverflow();
    const resizeObserver = new ResizeObserver(updateOverflow);
    resizeObserver.observe(container);
    resizeObserver.observe(text);

    return () => {
      resizeObserver.disconnect();
    };
  }, [name]);

  return (
    <span ref={containerRef} className="relative block min-w-0 flex-1 overflow-hidden whitespace-nowrap">
      <span ref={textRef} aria-hidden="true" className="invisible absolute whitespace-nowrap">{name}</span>
      {overflowing ? (
        <span className="open-file-name-marquee-track">
          <span className="open-file-name-marquee-item">{name}</span>
          <span className="open-file-name-marquee-item" aria-hidden="true">{name}</span>
        </span>
      ) : (
        <span className="block min-w-0 truncate">{name}</span>
      )}
    </span>
  );
};

interface FileRowProps {
  node: FileNode;
  root: string;
  isExpanded: boolean;
  isActive: boolean;
  isMobile: boolean;
  isBrowserClient: boolean;
  alwaysShowActions: boolean;
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
  contextMenuPath: string | null;
  setContextMenuPath: (path: string | null) => void;
  rightClickMenuPath: string | null;
  setRightClickMenuPath: (path: string | null) => void;
  onSelect: (node: FileNode) => void;
  onToggle: (path: string) => void;
  onRevealPath: (path: string) => void;
  onOpenDialog: (type: 'createFile' | 'createFolder' | 'rename' | 'delete', data: { path: string; name?: string; type?: 'file' | 'directory' }) => void;
}

export const FileRow: React.FC<FileRowProps> = ({
  node,
  root,
  isExpanded,
  isActive,
  isMobile,
  isBrowserClient,
  alwaysShowActions,
  status,
  badge,
  permissions,
  downloadFile,
  contextMenuPath,
  setContextMenuPath,
  rightClickMenuPath,
  setRightClickMenuPath,
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

  const handleContextMenu = React.useCallback((event?: React.MouseEvent) => {
    if (!hasMenuActions) {
      return;
    }
    event?.preventDefault();
    setRightClickMenuPath(node.path);
  }, [hasMenuActions, node.path, setRightClickMenuPath]);

  const handleInteraction = React.useCallback(() => {
    if (isDir) {
      onToggle(node.path);
    } else {
      onSelect(node);
    }
  }, [isDir, node, onSelect, onToggle]);

  const handleMenuButtonClick = React.useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setRightClickMenuPath(null);
    setContextMenuPath(node.path);
  }, [node.path, setContextMenuPath, setRightClickMenuPath]);

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
          <Icon name="edit" className="mr-2 size-4" /> {"Rename"}
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
        <Icon name="file-copy" className="mr-2 size-4" /> {"Copy Path"}
      </Item>
      <Item onClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        const relativePath = getDisplayPath(root, node.path) || node.path;
        void copyTextToClipboard(relativePath).then((result) => {
          if (result.ok) {
            toast.success("Relative path copied");
            return;
          }
          toast.error("Copy failed");
        });
      }}>
        <Icon name="file-copy-2" className="mr-2 size-4" /> {"Copy Relative Path"}
      </Item>
      {!isDir && downloadFile && (
        <Item onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          void downloadFile(node.path).catch((error) => {
            console.error('Download failed:', error);
            toast.error("Operation failed");
          });
        }}>
          <Icon name="download" className="mr-2 size-4" /> {(isBrowserClient ? "Download" : "Save")}
        </Item>
      )}
      {canRevealPath && (
        <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onRevealPath(node.path); }}>
          <Icon name="folder-received" className="mr-2 size-4" /> {getRevealLabel()}
        </Item>
      )}
      {isDir && (canCreateFile || canCreateFolder) && (
        <>
          <Separator />
          {canCreateFile && (
            <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenDialog('createFile', node); }}>
              <Icon name="file-add" className="mr-2 size-4" /> {"New File"}
            </Item>
          )}
          {canCreateFolder && (
            <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenDialog('createFolder', node); }}>
              <Icon name="folder-add" className="mr-2 size-4" /> {"New Folder"}
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
            <Icon name="delete-bin" className="mr-2 size-4" /> {"Delete"}
          </Item>
        </>
      )}
    </>
  );

  return (
    <ContextMenu open={rightClickMenuPath === node.path} onOpenChange={(open) => setRightClickMenuPath(open ? node.path : null)}>
      <ContextMenuTrigger render={<div className="group relative flex items-center" onContextMenu={!isMobile ? handleContextMenu : undefined} />}>
      <button
        type="button"
        onClick={handleInteraction}
        onContextMenu={!isMobile ? handleContextMenu : undefined}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-foreground transition-colors pr-8 select-none',
          isActive ? 'bg-interactive-selection/70' : 'hover:bg-interactive-hover/40'
        )}
      >
        {isDir ? (
          isExpanded ? (
            <Icon name="folder-open" className="size-4 flex-shrink-0 text-muted-foreground" />
          ) : (
            <Icon name="folder-3" className="size-4 flex-shrink-0 text-muted-foreground" />
          )
        ) : (
          <FileIcon filePath={node.path} extension={node.extension} />
        )}
        <span
          className="min-w-0 flex-1 truncate typography-meta"
          title={node.path}
        >
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
        <div className={cn(
          "absolute right-1 top-1/2 -translate-y-1/2",
          alwaysShowActions ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover:opacity-100"
        )}>
          <DropdownMenu
            open={contextMenuPath === node.path}
            onOpenChange={(open) => setContextMenuPath(open ? node.path : null)}
          >
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={handleMenuButtonClick}
              >
                <Icon name="more-2-fill" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side={isMobile ? "bottom" : "bottom"} onCloseAutoFocus={() => setContextMenuPath(null)}>
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
