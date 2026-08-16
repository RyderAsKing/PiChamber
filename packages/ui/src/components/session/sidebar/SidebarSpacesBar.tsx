import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { AgentThinkingLoader } from '@/components/chat/AgentThinkingLoader';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { cn, formatDirectoryName } from '@/lib/utils';
import { formatProjectLabel, sidebarRowIconClassName, sidebarRowLabelClassName } from './utils';

export type SpaceProject = {
  id: string;
  path?: string;
  normalizedPath: string;
  label?: string;
  icon?: string;
  color?: string;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
  iconBackground?: string;
};

export interface SidebarSpacesBarProps {
  projects: SpaceProject[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  onOpenDirectoryDialog: () => void;
  onOpenProjectEditDialog: (id: string) => void;
  onRemoveProject: (id: string) => void;
  totalSessionCount?: number;
  getSessionCountForProject?: (projectId: string) => number;
  hasActiveSessionByProject?: (projectId: string) => boolean;
  hasUnseenByProject?: (projectId: string) => boolean;
  homeDirectory: string | null;
  className?: string;
}

export const SidebarSpacesBar: React.FC<SidebarSpacesBarProps> = ({
  projects,
  selectedProjectId,
  onSelectProject,
  onOpenDirectoryDialog,
  onOpenProjectEditDialog,
  onRemoveProject,
  hasActiveSessionByProject,
  homeDirectory,
  className,
}) => {
  const isAllSelected = selectedProjectId === null;

  return (
    <div className={cn('select-none px-2 pt-1 pb-2 border-b border-border/40 space-y-0.5', className)}>
      {/* 'All Folders' item */}
      <button
        type="button"
        onClick={() => onSelectProject(null)}
        className={cn(
          'group relative flex w-full items-center justify-between rounded-xl px-2.5 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
          isAllSelected
            ? 'bg-interactive-selection text-interactive-selection-foreground'
            : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
        )}
        aria-pressed={isAllSelected}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <Icon name="folder" className={sidebarRowIconClassName} />
          <span className={sidebarRowLabelClassName}>{"All Folders"}</span>
        </div>
      </button>

      {/* Individual Folder Items */}
      {projects.map((project) => {
        const isSelected = selectedProjectId === project.id;
        const label = formatProjectLabel(
          project.label?.trim()
          || formatDirectoryName(project.normalizedPath, homeDirectory)
          || project.normalizedPath,
        );
        const hasActive = hasActiveSessionByProject?.(project.id);

        return (
          <ContextMenu key={project.id}>
            <ContextMenuTrigger
              render={
                <button
                  type="button"
                  onClick={() => {
                    onSelectProject(isSelected ? null : project.id);
                  }}
                  className={cn(
                    'relative flex w-full items-center justify-between rounded-xl px-2.5 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                    isSelected
                      ? 'bg-interactive-selection text-interactive-selection-foreground'
                      : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
                  )}
                  aria-pressed={isSelected}
                />
              }
            >
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                {project.iconImage ? (
                  <img
                    src={`/api/projects/${project.id}/icon?t=${project.iconImage.updatedAt}`}
                    alt=""
                    className={cn(sidebarRowIconClassName, 'rounded object-cover')}
                  />
                ) : (
                  <Icon name="folder" className={cn(sidebarRowIconClassName, 'text-muted-foreground')} />
                )}

                <span className={sidebarRowLabelClassName}>{label}</span>
              </div>

              {/* Status indicators */}
              <div className="flex items-center gap-1 shrink-0 ml-1">
                {hasActive ? (
                  <AgentThinkingLoader
                    variant="inline"
                    text={null}
                    animationType="spinner"
                    speedMs={80}
                    className="text-primary text-xs shrink-0"
                  />
                ) : null}
              </div>
            </ContextMenuTrigger>

            <ContextMenuContent className="min-w-[160px]">
              <ContextMenuItem onClick={() => onOpenProjectEditDialog(project.id)}>
                <Icon name="edit" className="mr-2 h-3.5 w-3.5" />
                <span>{"Edit folder"}</span>
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => onRemoveProject(project.id)}
                className="text-destructive focus:text-destructive"
              >
                <Icon name="close" className="mr-2 h-3.5 w-3.5" />
                <span>{"Close folder"}</span>
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}

      {/* Add Folder button */}
      <button
        type="button"
        onClick={onOpenDirectoryDialog}
        className="flex w-full items-center gap-1.5 rounded-xl px-2.5 py-2 typography-ui-label text-muted-foreground hover:bg-interactive-hover hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        <Icon name="add" className={sidebarRowIconClassName} />
        <span className={sidebarRowLabelClassName}>{"Add folder"}</span>
      </button>
    </div>
  );
};
