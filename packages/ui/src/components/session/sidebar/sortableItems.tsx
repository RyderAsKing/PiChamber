import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { sidebarRowIconClass, sidebarRowLabelClass } from './utils';
import { treeRowGapClassName } from './sessionRowVariant';

export type SortableDragHandleProps = {
  listeners: ReturnType<typeof useSortable>['listeners'];
  setActivatorNodeRef: ReturnType<typeof useSortable>['setActivatorNodeRef'];
};

type ProjectIdentityProps = {
  id: string;
  projectLabel: string;
};

type ProjectHeaderIdentityProps = ProjectIdentityProps & {
  mobileVariant?: boolean;
};

export const ProjectHeaderIdentity: React.FC<ProjectHeaderIdentityProps> = ({
  projectLabel,
  mobileVariant = false,
}) => {
  const iconClassName = sidebarRowIconClass(mobileVariant);
  const labelClassName = sidebarRowLabelClass(mobileVariant);

  return (
    <>
      <span className={cn('inline-flex shrink-0 items-center justify-center', iconClassName)}>
        <Icon name="folder" className={cn(iconClassName, 'text-muted-foreground/80')} />
      </span>
      <span className={cn(labelClassName, 'text-foreground')}>{projectLabel}</span>
    </>
  );
};

/** Collapse marker on the right edge of a folder header; the folder icon on the left never changes. */
export const ProjectHeaderChevron: React.FC<{
  isCollapsed: boolean;
  mobileVariant?: boolean;
  className?: string;
}> = ({ isCollapsed, mobileVariant = false, className }) => (
  <span className={cn('ml-auto inline-flex shrink-0 items-center text-muted-foreground', className)}>
    <Icon name={isCollapsed ? 'arrow-right-s' : 'arrow-down-s'} className={sidebarRowIconClass(mobileVariant)} />
  </span>
);

export interface SortableProjectItemProps extends ProjectIdentityProps {
  disabled?: boolean;
  projectDescription: string;
  isCollapsed: boolean;
  hideDirectoryControls: boolean;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  stickyHeader?: boolean;
  onToggle: () => void;
  onNewSession: () => void;
  onRenameStart: () => void;
  onClose: () => void;
  children?: React.ReactNode;
  showCreateButtons?: boolean;
  hideHeader?: boolean;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  /** Aggregated activity/attention indicator shown while the project is collapsed. */
  statusIndicator?: React.ReactNode;
}

export const SortableProjectItem: React.FC<SortableProjectItemProps> = ({
  id,
  disabled = false,
  projectLabel,
  projectDescription,
  isCollapsed,
  hideDirectoryControls,
  mobileVariant,
  alwaysShowActions,
  stickyHeader = false,
  onToggle,
  onNewSession,
  onRenameStart,
  onClose,
  children,
  showCreateButtons = true,
  hideHeader = false,
  openSidebarMenuKey,
  setOpenSidebarMenuKey,
  statusIndicator = null,
}) => {
  const {
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  const suppressNextToggleRef = React.useRef(false);
  const menuInstanceKey = `project:${id}`;
  const isMenuOpen = openSidebarMenuKey === menuInstanceKey;
  const [isContextMenuOpen, setIsContextMenuOpen] = React.useState(false);
  // A collapsed folder is only as tall as its header, so the header has nothing to
  // stick over. Leaving it out keeps a long list of collapsed folders free of
  // sticky boxes and scroll-state containers the scroller would track every frame.
  const isSticky = stickyHeader && !isCollapsed;

  const handleMenuOpenChange = React.useCallback((open: boolean) => {
    if (open) setIsContextMenuOpen(false);
    setOpenSidebarMenuKey(open ? menuInstanceKey : null);
  }, [menuInstanceKey, setOpenSidebarMenuKey]);

  const renderProjectMenuItems = (Item: React.ElementType) => (
    <>
      {showCreateButtons && !hideDirectoryControls && onNewSession && (
        <Item onClick={onNewSession}>
          <Icon name="add" className="mr-1.5 h-4 w-4" />
          {"New session"}
        </Item>
      )}
      <Item onClick={onRenameStart}>
        <Icon name="pencil-ai" className="mr-1.5 h-4 w-4" />
        {"Edit folder"}
      </Item>
      <Item onClick={onClose} className="text-destructive focus:text-destructive">
        <Icon name="close" className="mr-1.5 h-4 w-4" />
        {"Close folder"}
      </Item>
    </>
  );

  const handleMenuTriggerClick = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const handleMenuTriggerPointerDown = React.useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const handleMenuTriggerMouseDown = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const handleToggleMouseDown = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (event.button === 2 || (event.button === 0 && event.ctrlKey)) {
      suppressNextToggleRef.current = true;
    }
  }, []);

  const handleToggleClick = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    // Drop mouse-click focus so hover-revealed chrome hides again on mouse-leave
    event.currentTarget.blur();
    if (suppressNextToggleRef.current) {
      suppressNextToggleRef.current = false;
      return;
    }
    onToggle();
  }, [onToggle]);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('relative', isDragging && 'opacity-60')}
    >
      {!hideHeader ? (
        <ContextMenu open={isContextMenuOpen} onOpenChange={setIsContextMenuOpen}>
          <ContextMenuTrigger
            render={
              <div
                className={cn(
                  'text-left group/project select-none',
                  // The ::before covers the scroller's top padding above a stuck header.
                  isSticky && 'oc-sidebar-sticky-header sticky top-0 z-20 bg-sidebar before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-2 before:bg-sidebar',
                )}
                data-sidebar-sticky-header={isSticky ? 'true' : undefined}
                onContextMenu={(event) => {
                  if (hideDirectoryControls || isDragging) return;
                  event.preventDefault();
                  setIsContextMenuOpen(true);
                }}
              />
            }
          >
            <div
              className="relative flex items-center gap-1 py-1.5 px-3 rounded-xl transition-colors hover:bg-interactive-hover"
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    style={{ touchAction: 'manipulation' }}
                    onMouseDown={handleToggleMouseDown}
                    onClick={handleToggleClick}
                    {...listeners}
                    className={cn(
                      treeRowGapClassName,
                      'flex-1 min-w-0 flex items-center text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 rounded-md cursor-grab active:cursor-grabbing',
                    )}
                  >
                    <ProjectHeaderIdentity
                      id={id}
                      projectLabel={projectLabel}
                      mobileVariant={mobileVariant}
                    />
                    {statusIndicator ? (
                      <span className="ml-1 inline-flex flex-shrink-0 items-center">{statusIndicator}</span>
                    ) : null}
                    {/* The left padding reserves the slot the hover actions take, so the label truncates before them. */}
                    <ProjectHeaderChevron
                      isCollapsed={isCollapsed}
                      mobileVariant={mobileVariant}
                      className={cn(
                        'transition-[padding]',
                        // Touch layouts keep the actions visible, and their 36px touch targets need the wider slot.
                        alwaysShowActions
                          ? 'pl-16'
                          : 'pl-2 group-hover/project:pl-14 group-focus-within/project:pl-14',
                      )}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {projectDescription}
                </TooltipContent>
              </Tooltip>

              {/* Left of the new-session button (right-7 plus its w-6); written out because 13 is not on the padding-scaled spacing scale. */}
              <div className="absolute right-[calc(3.25rem*var(--padding-scale,1))] top-1/2 z-10 -translate-y-1/2">
                {!hideDirectoryControls ? (
                  <DropdownMenu
                    open={isMenuOpen}
                    onOpenChange={handleMenuOpenChange}
                  >
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 hover:text-foreground',
                          isMenuOpen
                            ? 'opacity-100 pointer-events-auto'
                            : alwaysShowActions
                              ? 'opacity-100'
                              : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-focus-within/project:opacity-100 group-focus-within/project:pointer-events-auto',
                        )}
                        aria-label={"Folder menu"}
                        onPointerDown={handleMenuTriggerPointerDown}
                        onMouseDown={handleMenuTriggerMouseDown}
                        onClick={handleMenuTriggerClick}
                      >
                        <Icon name="more-2" className="size-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[180px]">
                      {renderProjectMenuItems(DropdownMenuItem)}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>

              {showCreateButtons && !hideDirectoryControls && onNewSession ? (
                <div className="absolute right-7 top-1/2 z-10 -translate-y-1/2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNewSession();
                        }}
                        className={cn(
                          'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-opacity',
                          alwaysShowActions
                            ? 'opacity-100'
                            : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-focus-within/project:opacity-100 group-focus-within/project:pointer-events-auto',
                        )}
                        aria-label={"New session"}
                      >
                        <Icon name="add" className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={4}>
                      <p>{"New session"}</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
              ) : null}
            </div>
            {isSticky ? (
              <span
                aria-hidden
                className="oc-sidebar-sticky-header-fade pointer-events-none absolute inset-x-0 top-full h-4 bg-gradient-to-b from-sidebar to-transparent"
              />
            ) : null}
          </ContextMenuTrigger>
          <ContextMenuContent className="min-w-[180px]">
            {renderProjectMenuItems(ContextMenuItem)}
          </ContextMenuContent>
        </ContextMenu>
      ) : null}

      {children}
    </div>
  );
};

const SortableGroupItemBase: React.FC<{
  id: string;
  disabled?: boolean;
  children: React.ReactNode | ((dragHandleProps: SortableDragHandleProps) => React.ReactNode);
}> = ({ id, disabled = false, children }) => {
  const {
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  const dragHandleProps = React.useMemo<SortableDragHandleProps>(() => ({
    listeners,
    setActivatorNodeRef,
  }), [listeners, setActivatorNodeRef]);

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(
        'space-y-0.5 rounded-md',
        isDragging && 'opacity-50',
      )}
    >
      {typeof children === 'function' ? children(dragHandleProps) : children}
    </div>
  );
};

export const SortableGroupItem = React.memo(SortableGroupItemBase);
