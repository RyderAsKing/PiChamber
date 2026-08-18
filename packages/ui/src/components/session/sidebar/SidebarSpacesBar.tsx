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
  mobileVariant?: boolean;
}

const FOLDER_LONG_PRESS_MS = 500;

const SortableFolderRow: React.FC<{
  project: SpaceProject;
  label: string;
  isSelected: boolean;
  hasActive?: boolean;
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
  canDrag,
  onSelect,
  onOpenProjectEditDialog,
  onRemoveProject,
  mobileVariant = false,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
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
              className={cn(
                'relative flex w-full items-center justify-between rounded-xl px-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                isSelected
                  ? 'bg-interactive-selection text-foreground'
                  : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
              )}
              aria-pressed={isSelected}
            />
          }
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              className={cn(
                'inline-flex shrink-0 items-center justify-center',
                canDrag && 'touch-none select-none cursor-grab active:cursor-grabbing',
              )}
              aria-label={canDrag ? `Reorder ${label}` : undefined}
              {...(canDrag ? { ...attributes, ...listeners } : {})}
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
  onSelectProject,
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
        className={cn(
          'group relative flex w-full items-center justify-between rounded-xl px-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
          isAllSelected
            ? 'bg-interactive-selection text-foreground'
            : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
        )}
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
            const isSelected = selectedProjectId === project.id;
            const label = formatProjectLabel(
              project.label?.trim()
              || formatDirectoryName(project.normalizedPath, homeDirectory)
              || project.normalizedPath,
            );
            return (
              <SortableFolderRow
                key={project.id}
                project={project}
                label={label}
                isSelected={isSelected}
                hasActive={hasActiveSessionByProject?.(project.id)}
                canDrag={canDrag}
                onSelect={() => onSelectProject(isSelected ? null : project.id)}
                onOpenProjectEditDialog={onOpenProjectEditDialog}
                onRemoveProject={onRemoveProject}
                mobileVariant={mobileVariant}
              />
            );
          })}
        </SortableContext>
      </DndContext>

      <button
        type="button"
        onClick={onOpenDirectoryDialog}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-xl px-3 py-2 typography-ui-label text-muted-foreground hover:bg-interactive-hover hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        )}
      >
        <Icon name="add" className={sidebarRowIconClass(mobileVariant)} />
        <span className={sidebarRowLabelClass(mobileVariant)}>{"Add folder"}</span>
      </button>
    </div>
  );
};
