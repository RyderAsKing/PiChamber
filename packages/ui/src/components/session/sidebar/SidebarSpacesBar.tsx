import React from 'react';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Icon } from '@/components/icon/Icon';
import type { GitWorktree } from '@/lib/api/types';
import { AgentThinkingLoader } from '@/components/chat/AgentThinkingLoader';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { formatProjectLabel, sidebarRowIconClass, sidebarRowLabelClass } from './utils';

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
  selectedWorktreePath?: string | null;
  worktreesByProject?: ReadonlyMap<string, readonly GitWorktree[]>;
  worktreeErrorsByProject?: ReadonlyMap<string, string>;
  onSelectProject: (projectId: string | null) => void;
  onSelectWorktree?: (projectId: string, worktreePath: string) => void;
  onOpenDirectoryDialog: () => void;
  onOpenProjectEditDialog: (id: string) => void;
  onRemoveProject: (id: string) => void;
  totalSessionCount?: number;
  getSessionCountForProject?: (projectId: string) => number;
  hasActiveSessionByProject?: (projectId: string) => boolean;
  hasUnseenByProject?: (projectId: string) => boolean;
  homeDirectory: string | null;
  className?: string;
  mobileVariant?: boolean;
}

const FOLDER_LONG_PRESS_MS = 500;

const folderBarRowClass = (mobileVariant: boolean, selected: boolean) => cn(
  'relative flex w-full items-center gap-1.5 rounded-xl px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
  mobileVariant && 'py-1.5',
  selected
    ? 'bg-interactive-selection text-foreground'
    : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
);

const SortableFolderRow: React.FC<{
  project: SpaceProject;
  label: string;
  isSelected: boolean;
  hasActive?: boolean;
  hasWorktrees?: boolean;
  worktreeError?: string;
  isExpanded?: boolean;
  canDrag: boolean;
  onSelect: () => void;
  onOpenProjectEditDialog: (id: string) => void;
  onRemoveProject: (id: string) => void;
  mobileVariant?: boolean;
}> = ({
  project,
  label,
  isSelected,
  hasActive,
  hasWorktrees,
  worktreeError,
  isExpanded,
  canDrag,
  onSelect,
  onOpenProjectEditDialog,
  onRemoveProject,
  mobileVariant = false,
}) => {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.id,
    disabled: !canDrag,
  });
  const [menuOpen, setMenuOpen] = React.useState(false);
  const longPressTimerRef = React.useRef<number | null>(null);

  const clearLongPress = React.useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  React.useEffect(() => () => clearLongPress(), [clearLongPress]);

  const handleTouchStart = React.useCallback(() => {
    clearLongPress();
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      setMenuOpen(true);
    }, FOLDER_LONG_PRESS_MS);
  }, [clearLongPress]);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && 'opacity-60')}
    >
      <ContextMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <ContextMenuTrigger
          render={
            <button
              type="button"
              onClick={() => {
                if (menuOpen) return;
                onSelect();
              }}
              onTouchStart={handleTouchStart}
              onTouchMove={clearLongPress}
              onTouchEnd={clearLongPress}
              onTouchCancel={clearLongPress}
              style={{ touchAction: 'manipulation' }}
              className={folderBarRowClass(mobileVariant, isSelected)}
              aria-pressed={isSelected}
            />
          }
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {/* Do not spread dnd-kit `attributes` here: they set role="button", and
                mobile.css then forces [role="button"] to min 36px, indenting the icon. */}
            <span
              className={cn(
                'inline-flex size-4 shrink-0 items-center justify-center',
                canDrag && 'touch-none select-none cursor-grab active:cursor-grabbing',
              )}
              aria-label={canDrag ? `Reorder ${label}` : undefined}
              {...(canDrag ? listeners : {})}
            >
              <Icon name="folder" className={cn(sidebarRowIconClass(mobileVariant), 'text-muted-foreground')} />
            </span>
            <span className={sidebarRowLabelClass(mobileVariant)}>{label}</span>
          </div>

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
            {worktreeError ? (
              <span title={worktreeError} aria-label="Worktree discovery failed">
                <Icon name="error-warning" className="size-4 text-[var(--status-warning-foreground)]" />
              </span>
            ) : null}
            {hasWorktrees ? <Icon name={isExpanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-4 text-muted-foreground" /> : null}
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
    </div>
  );
};

export const SidebarSpacesBar: React.FC<SidebarSpacesBarProps> = ({
  projects,
  selectedProjectId,
  selectedWorktreePath = null,
  worktreesByProject = new Map(),
  worktreeErrorsByProject = new Map(),
  onSelectProject,
  onSelectWorktree,
  onOpenDirectoryDialog,
  onOpenProjectEditDialog,
  onRemoveProject,
  hasActiveSessionByProject,
  homeDirectory,
  className,
  mobileVariant = false,
}) => {
  const isAllSelected = selectedProjectId === null;
  const reorderProjects = useProjectsStore((state) => state.reorderProjects);
  const canDrag = projects.length > 1;

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const storeProjects = useProjectsStore.getState().projects;
    const fromIndex = storeProjects.findIndex((project) => project.id === active.id);
    const toIndex = storeProjects.findIndex((project) => project.id === over.id);
    if (fromIndex < 0 || toIndex < 0) return;
    reorderProjects(fromIndex, toIndex);
  }, [reorderProjects]);

  return (
    <div className={cn('select-none px-3 pt-1 pb-2 border-b border-border/40 space-y-0.5', className)}>
      <button
        type="button"
        onClick={() => onSelectProject(null)}
        className={folderBarRowClass(mobileVariant, isAllSelected)}
        aria-pressed={isAllSelected}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <Icon name="folder" className={sidebarRowIconClass(mobileVariant)} />
          <span className={sidebarRowLabelClass(mobileVariant)}>{"All Folders"}</span>
        </div>
      </button>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={projects.map((project) => project.id)} strategy={verticalListSortingStrategy}>
          {projects.map((project) => {
            const isProjectExpanded = selectedProjectId === project.id;
            const isSelected = isProjectExpanded && !selectedWorktreePath;
            const worktrees = worktreesByProject.get(project.normalizedPath) ?? [];
            const label = formatProjectLabel(
              project.label?.trim()
              || formatDirectoryName(project.normalizedPath, homeDirectory)
              || project.normalizedPath,
            );
            return (
              <React.Fragment key={project.id}>
                <SortableFolderRow
                  project={project}
                  label={label}
                  isSelected={isSelected}
                  hasActive={hasActiveSessionByProject?.(project.id)}
                  hasWorktrees={worktrees.length > 0}
                  worktreeError={worktreeErrorsByProject.get(project.normalizedPath)}
                  isExpanded={isProjectExpanded}
                  canDrag={canDrag}
                  onSelect={() => onSelectProject(project.id)}
                  onOpenProjectEditDialog={onOpenProjectEditDialog}
                  onRemoveProject={onRemoveProject}
                  mobileVariant={mobileVariant}
                />
                {isProjectExpanded ? worktrees.map((worktree: GitWorktree) => {
                  const worktreeSelected = selectedWorktreePath === worktree.path;
                  return (
                    <button
                      key={worktree.path}
                      type="button"
                      onClick={() => onSelectWorktree?.(project.id, worktree.path)}
                      className={cn(folderBarRowClass(mobileVariant, worktreeSelected), 'pl-8')}
                      aria-pressed={worktreeSelected}
                      title={worktree.path}
                    >
                      <Icon name="git-branch" className={cn(sidebarRowIconClass(mobileVariant), 'text-muted-foreground')} />
                      <span className={sidebarRowLabelClass(mobileVariant)}>
                        {worktree.branch || (worktree.detached ? 'Detached HEAD' : worktree.name)}
                      </span>
                    </button>
                  );
                }) : null}
              </React.Fragment>
            );
          })}
        </SortableContext>
      </DndContext>

      <button
        type="button"
        onClick={onOpenDirectoryDialog}
        className={folderBarRowClass(mobileVariant, false)}
      >
        <Icon name="add" className={sidebarRowIconClass(mobileVariant)} />
        <span className={sidebarRowLabelClass(mobileVariant)}>{"Add folder"}</span>
      </button>
    </div>
  );
};
