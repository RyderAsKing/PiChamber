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
import { formatProjectLabel, normalizePath, sidebarRowIconClass, sidebarRowLabelClass } from './utils';

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
  onCloseWorktree?: (projectId: string, worktree: GitWorktree) => void;
  onOpenDirectoryDialog: () => void;
  onOpenProjectEditDialog: (id: string) => void;
  onRemoveProject: (id: string) => void;
  totalSessionCount?: number;
  getSessionCountForProject?: (projectId: string) => number;
  hasActiveSessionByProject?: (projectId: string) => boolean;
  /** Per-project set of normalized-lowercased directories that have a busy session. */
  activeDirectoriesByProject?: ReadonlyMap<string, ReadonlySet<string>>;
  hasUnseenByProject?: (projectId: string) => boolean;
  homeDirectory: string | null;
  className?: string;
  mobileVariant?: boolean;
}

const SIDEBAR_LONG_PRESS_MS = 500;

const WorktreeRow: React.FC<{
  projectId: string;
  worktree: GitWorktree;
  isSelected: boolean;
  hasActive: boolean;
  onSelect: () => void;
  onClose?: (projectId: string, worktree: GitWorktree) => void;
  mobileVariant?: boolean;
}> = ({ projectId, worktree, isSelected, hasActive, onSelect, onClose, mobileVariant = false }) => {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const longPressTimerRef = React.useRef<number | null>(null);
  const label = worktree.branch || (worktree.detached ? 'Detached HEAD' : worktree.name);

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
    }, SIDEBAR_LONG_PRESS_MS);
  }, [clearLongPress]);

  return (
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
            className={cn(folderBarRowClass(mobileVariant, isSelected), 'pl-6')}
            aria-pressed={isSelected}
            title={worktree.path}
          />
        }
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <Icon name="git-branch" className={cn(sidebarRowIconClass(mobileVariant), 'text-muted-foreground')} />
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
        <ContextMenuItem
          disabled={!onClose}
          title={hasActive ? 'Stop the active session before closing this worktree.' : undefined}
          onClick={() => onClose?.(projectId, worktree)}
          className="text-destructive focus:text-destructive"
        >
          <Icon name="close" className="mr-2 h-3.5 w-3.5" />
          <span>{"Close worktree"}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

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
    }, SIDEBAR_LONG_PRESS_MS);
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
                <Icon name="error-warning" className="size-4 text-[var(--status-warning)]" />
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
  onCloseWorktree,
  onOpenDirectoryDialog,
  onOpenProjectEditDialog,
  onRemoveProject,
  hasActiveSessionByProject,
  activeDirectoriesByProject,
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
          <Icon name="chat-history" className={sidebarRowIconClass(mobileVariant)} />
          <span className={sidebarRowLabelClass(mobileVariant)}>{"All sessions"}</span>
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
            const activeSet = activeDirectoriesByProject?.get(project.id);
            const normalizedRoot = normalizePath(project.normalizedPath)?.toLowerCase() ?? '';
            const hasActiveInRoot = normalizedRoot ? (activeSet?.has(normalizedRoot) ?? false) : false;
            const hasAnyActive = (activeSet?.size ?? 0) > 0;
            // When the project is expanded, only show the primary spinner on the root
            // if the busy session is actually in the primary worktree. When collapsed,
            // the root row aggregates all worktrees so the user still sees activity.
            const legacyHasActive = hasActiveSessionByProject?.(project.id) ?? false;
            const hasActiveForProject = activeDirectoriesByProject
              ? (isProjectExpanded ? hasActiveInRoot : hasAnyActive)
              : legacyHasActive;
            return (
              <React.Fragment key={project.id}>
                <SortableFolderRow
                  project={project}
                  label={label}
                  isSelected={isSelected}
                  hasActive={hasActiveForProject}
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
                  const normalizedWorktree = normalizePath(worktree.path)?.toLowerCase() ?? '';
                  const hasActiveInWorktree = normalizedWorktree ? (activeSet?.has(normalizedWorktree) ?? false) : false;
                  // Fallback to legacy global check only if the new map is unavailable (backwards compat).
                  const showWorktreeActive = activeDirectoriesByProject ? hasActiveInWorktree : false;
                  return (
                    <WorktreeRow
                      key={worktree.path}
                      projectId={project.id}
                      worktree={worktree}
                      isSelected={worktreeSelected}
                      hasActive={showWorktreeActive}
                      onSelect={() => onSelectWorktree?.(project.id, worktree.path)}
                      onClose={onCloseWorktree}
                      mobileVariant={mobileVariant}
                    />
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
