import React from 'react';
import { createPortal } from 'react-dom';
import {
  RiAddLine,
  RiArchiveLine,
  RiArrowDownSLine,
  RiArrowUpSLine,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiDragMove2Line,
  RiEdit2Line,
  RiFolder6Line,
  RiFolderAddLine,
  RiSearchLine,
} from '@remixicon/react';
import type { Session } from '@/lib/chat/types';
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { DirectoryExplorerDialog } from '@/components/session/DirectoryExplorerDialog';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { toast } from '@/components/ui';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { getProjectLabel, normalizePath } from './mobilePaths';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { cn } from '@/lib/utils';
import { useAllLiveSessions, useGlobalSessionStatus } from '@/sync/sync-context';
import { useMobileSessionExpansionStore } from '@/stores/useMobileSessionExpansionStore';
import { useMobileSessionTreeStore } from '@/stores/useMobileSessionTreeStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import {
  EMPTY_SESSION_ORDER_RANKS,
  orderSessionsByLifecycleScopes,
  useSessionOrderingStore,
} from '@/sync/session-ordering';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionUnseenCount } from '@/sync/notification-store';
import { useHasSessionActivityDuration } from '@/sync/session-activity-timing';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';

import { MobileProjectEditSurface } from './MobileProjectEditSurface';

type MobileSessionsSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 'drawer' (default) renders a full-width left drawer over the app;
      'sidebar' renders the same content inline for the iPad persistent sidebar. */
  variant?: 'drawer' | 'sidebar';
  /** App-level footer bar (desktop-sidebar-style): current instance on the
      left, settings (and, on hosted web, a pending update) on the right. */
  footer?: {
    /** Connected instance label — Capacitor only; null hides the left slot. */
    instanceLabel: string | null;
    onOpenInstances?: () => void;
    onOpenSettings: () => void;
    /** Present only while a server update is available (hosted web). */
    onOpenUpdate?: () => void;
  };
};

const EMPTY_PINNED_SESSION_IDS = new Set<string>();

type ProjectMeta = {
  id: string;
  label: string;
  path: string;
  icon?: string | null;
  color?: string | null;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
  iconBackground?: string | null;
};

type ProjectNode = {
  project: ProjectMeta;
  sessions: Session[];
  totalSessions: number;
  isActive: boolean;
};

const SESSIONS_PER_PROJECT = 7;
const PROJECT_SESSION_INDENT = 40;
const CHILD_INDENT_STEP = 16;

const getParentId = (session: Session): string | null =>
  (session as Session & { parentID?: string | null }).parentID ?? null;

const getSessionDirectory = (session: Session): string => {
  const sessionWithDirectory = session as Session & {
    directory?: string | null;
  };
  return normalizePath(sessionWithDirectory.directory ?? null);
};

const getSessionTimestamp = (session: Session): number => {
  const raw = session.time?.updated ?? session.time?.created;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

const formatRelativeShort = (timestamp: number): string => {
  if (timestamp <= 0) return '';
  const diffMs = Date.now() - timestamp;
  if (diffMs < 60_000) return 'now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(timestamp));
};

const projectMatchesExactDirectory = (project: ProjectMeta, normalizedDirectory: string): boolean => (
  normalizedDirectory === project.path || normalizedDirectory.startsWith(`${project.path}/`)
);

const findExactProjectMatch = (projects: ProjectMeta[], directory: string): ProjectMeta | null => {
  const normalizedDirectory = normalizePath(directory);
  if (!normalizedDirectory) return null;
  return projects.find((project) => projectMatchesExactDirectory(project, normalizedDirectory)) ?? null;
};

const sessionMatchesQuery = (session: Session, projectLabel: string, query: string): boolean => {
  if (!query) return true;
  const haystack = `${session.title ?? ''} ${session.id} ${getSessionDirectory(session)} ${projectLabel}`.toLowerCase();
  return haystack.includes(query);
};

const MobileProjectIcon: React.FC<{
  project: Pick<ProjectMeta, 'id' | 'icon' | 'color' | 'iconImage' | 'iconBackground'>;
  size?: 'sm' | 'md';
}> = ({ project, size = 'md' }) => {
  const { currentTheme } = useThemeSystem();

  const ProjectIcon = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
  const iconColor = project.color ? PROJECT_COLOR_MAP[project.color] ?? null : null;

  const containerClasses = size === 'sm' ? 'size-6 rounded-md' : 'size-8 rounded-lg';
  const innerClasses = size === 'sm' ? 'size-3.5' : 'size-4';
  const fallbackIcon = ProjectIcon ? (
    <Icon name={ProjectIcon} className={innerClasses} style={iconColor ? { color: iconColor } : undefined} />
  ) : (
    <RiFolder6Line className={innerClasses} style={iconColor ? { color: iconColor } : undefined} />
  );

  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden bg-[var(--surface-muted)] text-muted-foreground',
        containerClasses,
      )}
      style={project.iconBackground ? { backgroundColor: project.iconBackground } : undefined}
    >
      {project.iconImage ? (
        <ProjectIconImage
          project={{ id: project.id, iconImage: project.iconImage ?? null }}
          options={{
            themeVariant: currentTheme.metadata.variant,
            iconColor: currentTheme.colors.surface.foreground,
          }}
          className="size-full object-contain"
          fallback={fallbackIcon}
        />
      ) : fallbackIcon}
    </span>
  );
};

const ActiveDot: React.FC<{ ariaLabel?: string }> = ({ ariaLabel }) => (
  <span
    className="inline-block size-1.5 shrink-0 rounded-full bg-primary"
    aria-label={ariaLabel}
  />
);

const ROW_ACTIONS_WIDTH = 144;
const ROW_SWIPE_SNAP_MS = 180;

const MobileSwipeActionsRow: React.FC<{
  actionsWidth: number;
  actions: React.ReactNode;
  revealed: boolean;
  onRevealedChange: (revealed: boolean) => void;
  children: React.ReactNode;
}> = ({ actionsWidth, actions, revealed, onRevealedChange, children }) => {
  const contentRef = React.useRef<HTMLDivElement>(null);
  const startRef = React.useRef<{ x: number; y: number } | null>(null);
  const draggingRef = React.useRef(false);
  const offsetRef = React.useRef(0);
  const revealedRef = React.useRef(revealed);

  const applyOffset = React.useCallback((px: number, animate: boolean) => {
    const el = contentRef.current;
    if (!el) return;
    el.style.transition = animate ? `transform ${ROW_SWIPE_SNAP_MS}ms ease-out` : 'none';
    el.style.transform = px === 0 ? 'none' : `translateX(${px}px)`;
    offsetRef.current = px;
  }, []);

  React.useEffect(() => {
    revealedRef.current = revealed;
    applyOffset(revealed ? -actionsWidth : 0, true);
  }, [actionsWidth, applyOffset, revealed]);

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    startRef.current = { x: touch.clientX, y: touch.clientY };
    draggingRef.current = false;
  };

  const handleTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    if (!startRef.current || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const dx = touch.clientX - startRef.current.x;
    const dy = touch.clientY - startRef.current.y;

    if (!draggingRef.current) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        startRef.current = null;
        return;
      }
      if (Math.abs(dx) > 10) {
        draggingRef.current = true;
      } else {
        return;
      }
    }

    const baseOffset = revealedRef.current ? -actionsWidth : 0;
    const targetOffset = Math.min(0, Math.max(-actionsWidth, baseOffset + dx));
    applyOffset(targetOffset, false);
  };

  const handleTouchEnd = () => {
    if (!draggingRef.current) {
      startRef.current = null;
      return;
    }
    draggingRef.current = false;
    startRef.current = null;

    const threshold = actionsWidth / 2;
    const shouldReveal = -offsetRef.current > threshold;
    if (shouldReveal !== revealedRef.current) {
      onRevealedChange(shouldReveal);
    } else {
      applyOffset(revealedRef.current ? -actionsWidth : 0, true);
    }
  };

  return (
    <div
      className="relative overflow-hidden bg-muted"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      <div
        className="absolute inset-y-0 right-0 z-0 flex items-stretch"
        style={{ width: actionsWidth }}
      >
        {actions}
      </div>
      <div ref={contentRef} className="relative z-10 bg-[var(--surface-base)]">
        {children}
      </div>
    </div>
  );
};

const SessionRow: React.FC<{
  session: Session;
  active: boolean;
  indent: number;
  hasChildren?: boolean;
  expanded?: boolean;
  onToggleChildren?: () => void;
  onSelect: () => void;
  revealed?: boolean;
  onRevealedChange?: (revealed: boolean) => void;
  confirmingDelete?: boolean;
  onArchive?: () => void;
  onRequestDelete?: () => void;
  onConfirmDelete?: () => void;
  renaming?: boolean;
  onRequestRename?: () => void;
  onSubmitRename?: (title: string) => void;
  onCancelRename?: () => void;
  contextLabel?: string;
}> = ({
  session,
  active,
  indent,
  hasChildren = false,
  expanded = false,
  onToggleChildren,
  onSelect,
  revealed = false,
  onRevealedChange = () => {},
  confirmingDelete = false,
  onArchive = () => {},
  onRequestDelete = () => {},
  onConfirmDelete = () => {},
  renaming = false,
  onRequestRename = () => {},
  onSubmitRename = () => {},
  onCancelRename = () => {},
  contextLabel,
}) => {
  
  const title = (session.title || "Untitled Session").trim();
  const timestamp = getSessionTimestamp(session);
  const relativeTime = formatRelativeShort(timestamp);
  const sessionStatus = useGlobalSessionStatus(session.id);
  const statusType = sessionStatus?.type ?? 'idle';
  const isStreaming = statusType === 'busy' || statusType === 'retry';
  const hasActivityDuration = useHasSessionActivityDuration(session.id, isStreaming);
  const unseenCount = useSessionUnseenCount(session.id);
  const showUnreadStatus = !isStreaming && unseenCount > 0 && !active;

  const [editTitle, setEditTitle] = React.useState(title);
  const renameInputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (renaming) {
      setEditTitle(title);
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renaming, title]);

  const handleRenameKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onSubmitRename(editTitle);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onCancelRename();
    }
  };

  const actions = (
    <>
      <button
        type="button"
        tabIndex={revealed ? 0 : -1}
        className="flex flex-1 items-center justify-center text-muted-foreground transition-colors active:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        aria-label={`Rename ${title}`}
        onClick={onRequestRename}
        style={{ touchAction: 'manipulation' }}
      >
        <RiEdit2Line className="size-[18px]" />
      </button>
      <button
        type="button"
        tabIndex={revealed ? 0 : -1}
        className="flex flex-1 items-center justify-center text-muted-foreground transition-colors active:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        aria-label={`Archive ${title}`}
        onClick={onArchive}
        style={{ touchAction: 'manipulation' }}
      >
        <RiArchiveLine className="size-[18px]" />
      </button>
      <button
        type="button"
        tabIndex={revealed ? 0 : -1}
        className={cn(
          'flex flex-1 items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-destructive',
          confirmingDelete
            ? 'rounded-lg bg-destructive text-destructive-foreground'
            : 'text-[var(--status-error)] active:opacity-80',
        )}
        aria-label={confirmingDelete ? `Confirm deleting ${title}` : `Delete ${title}`}
        onClick={confirmingDelete ? onConfirmDelete : onRequestDelete}
        style={{ touchAction: 'manipulation' }}
      >
        <RiDeleteBinLine className="size-[18px]" />
      </button>
    </>
  );

  return (
    <MobileSwipeActionsRow
      actionsWidth={ROW_ACTIONS_WIDTH}
      actions={actions}
      revealed={revealed}
      onRevealedChange={onRevealedChange}
    >
      <div
        data-active-session={active || undefined}
        className={cn(
          'group relative flex min-h-12 w-full items-center gap-2 py-1.5 pr-3 text-left transition-colors hover:bg-interactive-hover',
          active && 'bg-interactive-active/10',
        )}
        style={{ paddingLeft: indent }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onToggleChildren?.();
            }}
            aria-expanded={expanded}
            aria-label={expanded ? `Collapse ${title}` : `Expand ${title}`}
            style={{ touchAction: 'manipulation' }}
          >
            <RiArrowDownSLine className={cn('size-4 transition-transform', !expanded && '-rotate-90')} />
          </button>
        ) : null}

        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
          onClick={() => {
            if (revealed) {
              onRevealedChange(false);
              return;
            }
            onSelect();
          }}
          style={{ touchAction: 'manipulation' }}
        >
          {showUnreadStatus || isStreaming ? (
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                isStreaming ? 'bg-primary animate-pulse' : 'bg-[var(--status-info)]',
              )}
            />
          ) : null}

          <div className="min-w-0 flex-1">
            {renaming ? (
              <Input
                ref={renameInputRef}
                value={editTitle}
                onChange={(event) => setEditTitle(event.target.value)}
                onKeyDown={handleRenameKeyDown}
                onBlur={() => onSubmitRename(editTitle)}
                className="h-7 px-2 typography-ui-label"
              />
            ) : (
              <span className={cn('block truncate typography-ui-label', active ? 'font-semibold text-foreground' : 'text-foreground/90')}>
                {title}
              </span>
            )}
            {contextLabel ? (
              <span className="block truncate typography-micro text-muted-foreground">
                {contextLabel}
              </span>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
            {hasActivityDuration ? (
              <SessionActivityDuration sessionId={session.id} running={isStreaming} className="typography-micro tabular-nums" />
            ) : relativeTime ? (
              <span className="typography-micro tabular-nums">{relativeTime}</span>
            ) : null}
          </div>
        </button>
      </div>
    </MobileSwipeActionsRow>
  );
};

const ShowMoreRow: React.FC<{ indent: number; onClick: () => void }> = ({ indent, onClick }) => {
  
  return (
    <button
      type="button"
      className="flex min-h-10 w-full items-center gap-2 py-1 pr-3 typography-micro text-muted-foreground hover:text-foreground transition-colors"
      onClick={onClick}
      style={{ paddingLeft: indent, touchAction: 'manipulation' }}
    >
      <RiArrowDownSLine className="size-4" />
      <span>{"Show {count} more"}</span>
    </button>
  );
};

const ShowFewerRow: React.FC<{ indent: number; onClick: () => void }> = ({ indent, onClick }) => {
  
  return (
    <button
      type="button"
      className="flex min-h-10 w-full items-center gap-2 py-1 pr-3 typography-micro text-muted-foreground hover:text-foreground transition-colors"
      onClick={onClick}
      style={{ paddingLeft: indent, touchAction: 'manipulation' }}
    >
      <RiArrowUpSLine className="size-4" />
      <span>{"Hide archived"}</span>
    </button>
  );
};

const MobileSessionsEmpty: React.FC<{
  title: string;
  description: string;
  action?: React.ReactNode;
}> = ({ title, description, action }) => (
  <div className="flex min-h-64 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
    <Icon name="chat-3" className="size-8 text-muted-foreground/60" />
    <p className="typography-ui-label font-semibold text-foreground">{title}</p>
    <p className="typography-meta max-w-sm text-muted-foreground">{description}</p>
    {action ? <div className="mt-4">{action}</div> : null}
  </div>
);

const SortableProjectRow: React.FC<{
  project: ProjectMeta;
  totalSessions: number;
}> = ({ project, totalSessions }) => {
  
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : 1 }}
      className={cn(
        'rounded-2xl border border-border/70 bg-[var(--surface-elevated)] px-1.5 py-1.5 transition-colors',
        isDragging && 'shadow-lg shadow-black/20',
      )}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="flex size-9 shrink-0 cursor-grab touch-none items-center justify-center rounded-xl text-muted-foreground/70 transition-colors hover:text-foreground active:cursor-grabbing"
          aria-label={`Drag ${project.label} to reorder`}
          {...attributes}
          {...listeners}
        >
          <RiDragMove2Line className="size-4" />
        </button>
        <div className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-xl px-1 text-left">
          <MobileProjectIcon project={project} />
          <span className="block min-w-0 flex-1 truncate typography-ui-label text-foreground">{project.label}</span>
          <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">{totalSessions}</span>
        </div>
      </div>
    </div>
  );
};

export const MobileSessionsSheet: React.FC<MobileSessionsSheetProps> = ({
  open,
  onOpenChange,
  variant = 'drawer',
  footer,
}) => {
  
  const liveSessions = useAllLiveSessions();
  const pinnedSessionIds = useSessionPinnedStore(React.useCallback(
    (state) => open || variant === 'sidebar' ? state.ids : EMPTY_PINNED_SESSION_IDS,
    [open, variant],
  ));
  const sessionOrderRanks = useSessionOrderingStore(React.useCallback(
    (state) => open || variant === 'sidebar' ? state.rankById : EMPTY_SESSION_ORDER_RANKS,
    [open, variant],
  ));
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const setActiveProject = useProjectsStore((state) => state.setActiveProject);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const reorderProjects = useProjectsStore((state) => state.reorderProjects);
  const removeProject = useProjectsStore((state) => state.removeProject);
  const projectExpandedMap = useMobileSessionTreeStore((state) => state.projectExpanded);
  const setProjectExpanded = useMobileSessionTreeStore((state) => state.setProjectExpanded);
  const expandedParents = useMobileSessionExpansionStore((state) => state.expandedParents);
  const toggleParent = useMobileSessionExpansionStore((state) => state.toggleParent);
  const [query, setQuery] = React.useState('');
  const [editingProjectId, setEditingProjectId] = React.useState<string | null>(null);
  const [revealedSessionId, setRevealedSessionId] = React.useState<string | null>(null);
  const [confirmingDeleteSessionId, setConfirmingDeleteSessionId] = React.useState<string | null>(null);
  const [renamingSessionId, setRenamingSessionId] = React.useState<string | null>(null);
  const [revealedRowId, setRevealedRowId] = React.useState<string | null>(null);
  const [confirmingRemoveProjectId, setConfirmingRemoveProjectId] = React.useState<string | null>(null);
  const [directoryDialogOpen, setDirectoryDialogOpen] = React.useState(false);
  const [editingOrder, setEditingOrder] = React.useState(false);
  const [visibleCountByProject, setVisibleCountByProject] = React.useState<Map<string, number>>(new Map());

  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const archiveSession = useSessionUIStore((state) => state.archiveSession);
  const deleteSession = useSessionUIStore((state) => state.deleteSession);
  const updateSessionTitle = useSessionUIStore((state) => state.updateSessionTitle);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);

  React.useEffect(() => {
    if (!open) {
      setQuery('');
      setEditingOrder(false);
      setVisibleCountByProject(new Map());
      setEditingProjectId(null);
      setRevealedSessionId(null);
      setConfirmingDeleteSessionId(null);
      setRenamingSessionId(null);
      setRevealedRowId(null);
      setConfirmingRemoveProjectId(null);
      return;
    }
  }, [open]);

  const projectsMeta = React.useMemo<ProjectMeta[]>(
    () =>
      projects.map((project) => ({
        id: project.id,
        label: project.label?.trim() || getProjectLabel(project.path),
        path: normalizePath(project.path),
        icon: project.icon,
        color: project.color,
        iconImage: project.iconImage,
        iconBackground: project.iconBackground,
      })),
    [projects],
  );

  const sessions = React.useMemo(
    () => liveSessions.filter((session) => !session.time?.archived),
    [liveSessions],
  );

  const normalizedQuery = query.trim().toLowerCase();

  const contentRootRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const root = contentRootRef.current;
      if (!root) return;
      const target = root.querySelector<HTMLElement>('[data-active-session="true"]')
        ?? root.querySelector<HTMLElement>('[data-active-project="true"]');
      target?.scrollIntoView({ block: 'center' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const projectNodes = React.useMemo<ProjectNode[]>(() => {
    const nodes: ProjectNode[] = projectsMeta.map((project) => ({
      project,
      sessions: [] as Session[],
      totalSessions: 0,
      isActive: project.id === activeProjectId,
    }));

    for (const session of sessions) {
      const directory = getSessionDirectory(session);
      if (!directory) continue;
      const node = nodes.find((entry) => projectMatchesExactDirectory(entry.project, directory));
      if (!node) continue;
      node.sessions.push(session);
    }

    for (const node of nodes) {
      node.sessions = orderSessionsByLifecycleScopes(node.sessions, pinnedSessionIds, sessionOrderRanks);
      for (const session of node.sessions) {
        if (!getParentId(session)) node.totalSessions += 1;
      }
    }

    return nodes;
  }, [activeProjectId, pinnedSessionIds, projectsMeta, sessionOrderRanks, sessions]);

  const isProjectExpanded = (node: ProjectNode): boolean =>
    projectExpandedMap[node.project.id] ?? true;

  const resetProjectVisibleCount = (projectId: string) => {
    setVisibleCountByProject((previous) => {
      if (!previous.has(projectId)) return previous;
      const next = new Map(previous);
      next.delete(projectId);
      return next;
    });
  };

  const showMoreProjectSessions = (projectId: string, currentVisibleCount: number) => {
    setVisibleCountByProject((previous) => {
      const next = new Map(previous);
      next.set(projectId, currentVisibleCount + SESSIONS_PER_PROJECT);
      return next;
    });
  };

  const renderProjectSessions = (node: ProjectNode, indent: number) => {
    const idsInProject = new Set(node.sessions.map((entry) => entry.id));
    const childrenByParent = new Map<string, Session[]>();
    for (const candidate of node.sessions) {
      const parentId = getParentId(candidate);
      if (parentId && idsInProject.has(parentId)) {
        const list = childrenByParent.get(parentId) ?? [];
        list.push(candidate);
        childrenByParent.set(parentId, list);
      }
    }
    const roots = node.sessions.filter((entry) => {
      const parentId = getParentId(entry);
      return !parentId || !idsInProject.has(parentId);
    });

    const visibleCount = visibleCountByProject.get(node.project.id) ?? SESSIONS_PER_PROJECT;
    const visibleRoots = roots.slice(0, visibleCount);
    const remaining = roots.length - visibleRoots.length;
    const canShowFewer = roots.length > SESSIONS_PER_PROJECT && remaining === 0;

    const renderNode = (session: Session, rowIndent: number): React.ReactNode => {
      const children = childrenByParent.get(session.id) ?? [];
      const hasChildren = children.length > 0;
      const expanded = Boolean(expandedParents[session.id]);
      return (
        <React.Fragment key={session.id}>
          <SessionRow
            session={session}
            active={currentSessionId === session.id}
            indent={rowIndent}
            hasChildren={hasChildren}
            expanded={expanded}
            onToggleChildren={hasChildren ? () => toggleParent(session.id) : undefined}
            onSelect={() => handleSelectSession(session)}
            revealed={revealedSessionId === session.id}
            onRevealedChange={(nextRevealed) => handleRowRevealedChange(session.id, nextRevealed)}
            confirmingDelete={confirmingDeleteSessionId === session.id}
            onArchive={() => void handleArchive(session)}
            onRequestDelete={() => setConfirmingDeleteSessionId(session.id)}
            onConfirmDelete={() => void handleConfirmDelete(session)}
            renaming={renamingSessionId === session.id}
            onRequestRename={() => handleRequestRename(session.id)}
            onSubmitRename={(nextTitle) => void handleSubmitRename(session.id, nextTitle)}
            onCancelRename={() => setRenamingSessionId(null)}
          />
          {hasChildren && expanded
            ? children.map((child) => renderNode(child, rowIndent + CHILD_INDENT_STEP))
            : null}
        </React.Fragment>
      );
    };

    return (
      <div>
        {visibleRoots.map((session) => renderNode(session, indent))}
        {remaining > 0 ? (
          <ShowMoreRow indent={indent} onClick={() => showMoreProjectSessions(node.project.id, visibleRoots.length)} />
        ) : null}
        {canShowFewer ? (
          <ShowFewerRow indent={indent} onClick={() => resetProjectVisibleCount(node.project.id)} />
        ) : null}
      </div>
    );
  };

  const toggleProject = (projectId: string, currentlyExpanded: boolean) => {
    setProjectExpanded(projectId, !currentlyExpanded);
    resetProjectVisibleCount(projectId);
  };

  const handleSelectSession = (session: Session) => {
    const directory = getSessionDirectory(session) || null;
    const project = findExactProjectMatch(projectsMeta, directory ?? '');
    if (project) {
      setActiveProjectIdOnly(project.id);
      setProjectExpanded(project.id, true);
    }
    void setCurrentSession(session.id, directory);
    onOpenChange(false);
  };

  const handleRowRevealedChange = (sessionId: string, nextRevealed: boolean) => {
    setRevealedSessionId(nextRevealed ? sessionId : null);
    setConfirmingDeleteSessionId(null);
    setRevealedRowId(null);
    setConfirmingRemoveProjectId(null);
  };

  const handleRowKeyRevealedChange = (rowKey: string, nextRevealed: boolean) => {
    setRevealedRowId(nextRevealed ? rowKey : null);
    setConfirmingRemoveProjectId(null);
    setRevealedSessionId(null);
    setConfirmingDeleteSessionId(null);
  };

  const handleArchive = async (session: Session) => {
    setRevealedSessionId(null);
    setConfirmingDeleteSessionId(null);
    const ok = await archiveSession(session.id);
    if (ok) toast.success("Session archived");
    else toast.error("Failed to archive session");
  };

  const handleConfirmDelete = async (session: Session) => {
    setRevealedSessionId(null);
    setConfirmingDeleteSessionId(null);
    const ok = await deleteSession(session.id);
    if (ok) toast.success("Session deleted");
    else toast.error("Failed to delete session");
  };

  const handleRequestRename = (sessionId: string) => {
    setRevealedSessionId(null);
    setConfirmingDeleteSessionId(null);
    setRenamingSessionId(sessionId);
  };

  const handleSubmitRename = async (sessionId: string, title: string) => {
    setRenamingSessionId(null);
    try {
      await updateSessionTitle(sessionId, title);
    } catch {
      toast.error("Failed to rename session");
    }
  };

  const handleStartNewChat = () => {
    openNewSessionDraft();
    onOpenChange(false);
  };

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleReorderDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromIndex = projectsMeta.findIndex((p) => p.id === active.id);
    const toIndex = projectsMeta.findIndex((p) => p.id === over.id);
    if (fromIndex < 0 || toIndex < 0) return;
    reorderProjects(fromIndex, toIndex);
  };

  const buildSessionContextLabel = React.useCallback(
    (session: Session): string => {
      const directory = getSessionDirectory(session);
      const project = findExactProjectMatch(projectsMeta, directory);
      return project ? project.label : getProjectLabel(directory) || directory;
    },
    [projectsMeta],
  );

  const handleSelectProject = (project: ProjectMeta) => {
    setActiveProject(project.id);
    onOpenChange(false);
  };

  const filteredNodes = React.useMemo(() => {
    if (!normalizedQuery) return projectNodes;
    return projectNodes.filter((node) => {
      if (`${node.project.label} ${node.project.path}`.toLowerCase().includes(normalizedQuery)) return true;
      return node.sessions.some((session) => sessionMatchesQuery(session, node.project.label, normalizedQuery));
    });
  }, [normalizedQuery, projectNodes]);

  const orderedNodes = filteredNodes;

  const searchSessionMatches = React.useMemo(() => {
    if (!normalizedQuery) return [] as Session[];
    return orderSessionsByLifecycleScopes(
      sessions.filter((session) => {
        if (getParentId(session)) return false;
        const directory = getSessionDirectory(session);
        const project = findExactProjectMatch(projectsMeta, directory);
        return sessionMatchesQuery(session, project?.label ?? '', normalizedQuery);
      }),
      pinnedSessionIds,
      sessionOrderRanks,
    );
  }, [normalizedQuery, pinnedSessionIds, projectsMeta, sessionOrderRanks, sessions]);

  const searchProjectMatches = React.useMemo(() => {
    if (!normalizedQuery) return [] as Array<ProjectMeta & { sessionCount: number }>;
    return projectsMeta
      .filter((project) => `${project.label} ${project.path}`.toLowerCase().includes(normalizedQuery))
      .map((project) => ({
        ...project,
        sessionCount: sessions.filter((session) => {
          if (getParentId(session)) return false;
          const directory = normalizePath(getSessionDirectory(session));
          return projectMatchesExactDirectory(project, directory);
        }).length,
      }));
  }, [normalizedQuery, projectsMeta, sessions]);

  const hasNoMatches =
    normalizedQuery && searchSessionMatches.length === 0 && searchProjectMatches.length === 0;
  const canEditOrder = !normalizedQuery && projectsMeta.length > 1;

  const editToggle = canEditOrder ? (
    <Button
      type="button"
      variant="chip"
      size="sm"
      aria-label={editingOrder ? "Done" : "Reorder projects"}
      aria-pressed={editingOrder}
      onClick={() => setEditingOrder((value) => !value)}
      style={{ touchAction: 'manipulation' }}
    >
      {editingOrder ? <RiCheckLine className="size-4" /> : <RiEdit2Line className="size-4" />}
    </Button>
  ) : null;

  const newChatButton =
    !editingOrder && projectsMeta.length > 0 ? (
      <Button
        type="button"
        variant="default"
        size="sm"
        aria-label={"New chat"}
        onClick={handleStartNewChat}
        style={{ touchAction: 'manipulation' }}
      >
        <RiAddLine className="size-4" />
        {"New chat"}
      </Button>
    ) : null;

  const addProjectButton = !editingOrder ? (
    <Button
      type="button"
      variant="chip"
      size="sm"
      aria-label={"Add project"}
      title={"Add project"}
      onClick={() => setDirectoryDialogOpen(true)}
      style={{ touchAction: 'manipulation' }}
    >
      <RiFolderAddLine className="size-4" />
    </Button>
  ) : null;

  const trailingActions =
    newChatButton || addProjectButton || editToggle ? (
      <>
        {newChatButton}
        {addProjectButton}
        {editToggle}
      </>
    ) : null;

  const surfaceContent = (
    <div ref={contentRootRef} className="flex min-h-0 flex-1 flex-col">
      <ScrollShadow className="min-h-0 flex-1 overflow-y-auto pb-4">
        <div className={cn('px-4 pb-2 pt-1', editingOrder && 'hidden')}>
          <div className="relative">
            <RiSearchLine className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={"Search sessions"}
              className={cn('h-11 pl-9', query && 'pr-10')}
            />
            {query ? (
              <button
                type="button"
                className="absolute right-1.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                aria-label={"Clear search"}
                onClick={() => setQuery('')}
                style={{ touchAction: 'manipulation' }}
              >
                <RiCloseLine className="size-4" />
              </button>
            ) : null}
          </div>
        </div>
        {projectsMeta.length === 0 ? (
          <MobileSessionsEmpty
            title={"No projects yet"}
            description={"Add a project to start chatting with your code."}
            action={
              <button
                type="button"
                className="flex items-center justify-center gap-2 rounded-2xl bg-primary px-5 py-3 typography-ui-label text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                onClick={() => setDirectoryDialogOpen(true)}
              >
                <RiFolderAddLine className="size-4" />
                {"Add project"}
              </button>
            }
          />
        ) : hasNoMatches ? (
          <MobileSessionsEmpty
            title={"No matches"}
            description={"Try a different search term."}
          />
        ) : normalizedQuery && !editingOrder ? (
          <div className="flex flex-col gap-3 px-3 pt-2">
            {searchSessionMatches.length > 0 ? (
              <section>
                <div className="flex items-center justify-between px-1 pb-1.5">
                  <span className="typography-micro font-semibold uppercase tracking-wider text-muted-foreground">
                    {"Sessions"}
                  </span>
                  <span className="typography-micro text-muted-foreground tabular-nums">
                    {searchSessionMatches.length}
                  </span>
                </div>
                <div className="overflow-hidden rounded-2xl border border-border/70 bg-[var(--surface-elevated)]">
                  {searchSessionMatches.map((session, index) => (
                    <div key={session.id} className={cn(index > 0 && 'border-t border-border/70')}>
                      <SessionRow
                        session={session}
                        active={currentSessionId === session.id}
                        indent={12}
                        contextLabel={buildSessionContextLabel(session)}
                        onSelect={() => handleSelectSession(session)}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {searchProjectMatches.length > 0 ? (
              <section>
                <div className="flex items-center justify-between px-1 pb-1.5">
                  <span className="typography-micro font-semibold uppercase tracking-wider text-muted-foreground">
                    {"Projects"}
                  </span>
                  <span className="typography-micro text-muted-foreground tabular-nums">
                    {searchProjectMatches.length}
                  </span>
                </div>
                <div className="overflow-hidden rounded-2xl border border-border/70 bg-[var(--surface-elevated)]">
                  {searchProjectMatches.map((project, index) => (
                    <div
                      key={project.id}
                      className={cn('flex items-center', index > 0 && 'border-t border-border/70')}
                    >
                      <button
                        type="button"
                        className="flex min-h-12 min-w-0 flex-1 items-center gap-3 px-3 py-1.5 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
                        onClick={() => handleSelectProject(project)}
                        style={{ touchAction: 'manipulation' }}
                      >
                        <MobileProjectIcon project={project} />
                        <span className="block min-w-0 flex-1 truncate typography-ui-label text-foreground">
                          {project.label}
                        </span>
                        <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">
                          {project.sessionCount}
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : editingOrder ? (
          <div className="flex flex-col gap-2 px-3 py-2">
            <p className="px-1 typography-micro text-muted-foreground">
              {"Drag the handle to reorder projects. Tap a project to show its worktrees and drag those too. Tap the check to finish."}
            </p>
            <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleReorderDragEnd}>
              <SortableContext
                items={projectsMeta.map((p) => p.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="flex flex-col gap-1.5">
                  {projectsMeta.map((project) => {
                    const node = projectNodes.find((n) => n.project.id === project.id);
                    return (
                      <SortableProjectRow
                        key={project.id}
                        project={project}
                        totalSessions={node?.totalSessions ?? 0}
                      />
                    );
                  })}
                </div>
              </SortableContext>
            </DndContext>
          </div>
        ) : (
          <div className="flex flex-col">
            {orderedNodes.map((node, nodeIndex) => {
              const projectExpanded = isProjectExpanded(node);
              return (
                <section
                  key={node.project.id}
                  className={cn(nodeIndex > 0 && 'border-t border-border/70')}
                >
                  <MobileSwipeActionsRow
                    actionsWidth={96}
                    revealed={revealedRowId === `project:${node.project.id}`}
                    onRevealedChange={(nextRevealed) => handleRowKeyRevealedChange(`project:${node.project.id}`, nextRevealed)}
                    actions={(
                      <>
                        <button
                          type="button"
                          tabIndex={revealedRowId === `project:${node.project.id}` ? 0 : -1}
                          className="flex flex-1 items-center justify-center text-muted-foreground transition-colors active:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                          aria-label={`Edit ${node.project.label}`}
                          onClick={() => {
                            setRevealedRowId(null);
                            setEditingProjectId(node.project.id);
                          }}
                          style={{ touchAction: 'manipulation' }}
                        >
                          <RiEdit2Line className="size-[18px]" />
                        </button>
                        <button
                          type="button"
                          tabIndex={revealedRowId === `project:${node.project.id}` ? 0 : -1}
                          className={cn(
                            'flex flex-1 items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-destructive',
                            confirmingRemoveProjectId === node.project.id
                              ? 'rounded-lg bg-destructive text-destructive-foreground'
                              : 'text-[var(--status-error)] active:opacity-80',
                          )}
                          aria-label={confirmingRemoveProjectId === node.project.id
                            ? `Confirm removing ${node.project.label}`
                            : `Remove ${node.project.label}`}
                          onClick={() => {
                            if (confirmingRemoveProjectId === node.project.id) {
                              setRevealedRowId(null);
                              setConfirmingRemoveProjectId(null);
                              removeProject(node.project.id);
                              toast.success(`Removed ${node.project.label}`);
                              return;
                            }
                            setConfirmingRemoveProjectId(node.project.id);
                          }}
                          style={{ touchAction: 'manipulation' }}
                        >
                          <RiDeleteBinLine className="size-[18px]" />
                        </button>
                      </>
                    )}
                  >
                    <div data-active-project={node.isActive || undefined} className="flex min-h-12 w-full items-center">
                      <button
                        type="button"
                        className="flex min-h-12 min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
                        onClick={() => {
                          if (revealedRowId) {
                            handleRowKeyRevealedChange(revealedRowId, false);
                            return;
                          }
                          toggleProject(node.project.id, projectExpanded);
                        }}
                        aria-expanded={projectExpanded}
                        aria-label={
                          projectExpanded
                            ? `Collapse ${node.project.label}`
                            : `Expand ${node.project.label}`
                        }
                        style={{ touchAction: 'manipulation' }}
                      >
                        <MobileProjectIcon project={node.project} />
                        <span className="block min-w-0 flex-1 truncate typography-ui-label font-semibold text-foreground">
                          {node.project.label}
                        </span>
                        {node.isActive ? <ActiveDot ariaLabel={"Active project"} /> : null}
                        <span className="shrink-0 typography-micro text-muted-foreground tabular-nums">
                          {node.totalSessions}
                        </span>
                      </button>
                    </div>
                  </MobileSwipeActionsRow>

                  {projectExpanded ? (
                    <div className="pb-2">
                      {node.sessions.length > 0
                        ? renderProjectSessions(node, PROJECT_SESSION_INDENT)
                        : null}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        )}
      </ScrollShadow>

      {footer ? (
        <div
          className="flex shrink-0 items-center justify-between gap-2 border-t border-border/70 px-2 pt-1.5"
          style={{ paddingBottom: 'calc(0.375rem + var(--oc-safe-area-bottom, 0px))' }}
        >
          {footer.instanceLabel && footer.onOpenInstances ? (
            <Button
              type="button"
              variant="info"
              size="lg"
              className="min-w-0 shrink justify-start"
              onClick={footer.onOpenInstances}
              aria-label={"Instances"}
              style={{ touchAction: 'manipulation' }}
            >
              <Icon name="server" className="size-[18px]" />
              <span className="block min-w-0 truncate">{footer.instanceLabel}</span>
            </Button>
          ) : (
            <div className="min-w-0 flex-1" />
          )}
          <div className="flex shrink-0 items-center gap-1">
            {footer.onOpenUpdate ? (
              <Button
                type="button"
                variant="default"
                size="lg"
                className="w-10 px-0"
                onClick={footer.onOpenUpdate}
                aria-label={"Update"}
                title={"Update"}
                style={{ touchAction: 'manipulation' }}
              >
                <Icon name="download" className="size-5" />
                <span className="absolute right-2 top-2 inline-flex size-2 rounded-full bg-primary" aria-hidden />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="chip"
              size="lg"
              className="w-10 px-0"
              onClick={footer.onOpenSettings}
              aria-label={"Settings"}
              title={"Settings"}
              style={{ touchAction: 'manipulation' }}
            >
              <Icon name="settings-3" className="size-5" />
            </Button>
          </div>
        </div>
      ) : null}

      <DirectoryExplorerDialog
        open={directoryDialogOpen}
        onOpenChange={setDirectoryDialogOpen}
      />

      {editingProjectId ? (
        <MobileProjectEditSurface
          open={Boolean(editingProjectId)}
          project={(() => {
            const p = projects.find((x) => x.id === editingProjectId);
            if (!p) return null;
            return {
              id: p.id,
              label: p.label || p.path.split(/[\\/]/).pop() || p.path,
              path: p.path,
              icon: p.icon ?? null,
              color: p.color ?? null,
              iconImage: p.iconImage ?? null,
              iconBackground: p.iconBackground ?? null,
              isGitRepo: false,
            };
          })()}
          onClose={() => setEditingProjectId(null)}
        />
      ) : null}
    </div>
  );

  if (variant === 'sidebar') {
    return (
      <aside className="flex h-full w-full flex-col bg-[var(--surface-base)]">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border/70 px-4">
          <h1 className="typography-ui-label font-bold text-foreground">{"Sessions"}</h1>
          <div className="flex items-center gap-1">{trailingActions}</div>
        </header>
        {surfaceContent}
      </aside>
    );
  }

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex bg-black/40 backdrop-blur-sm transition-opacity">
      <div
        className="relative flex h-full w-full max-w-md flex-col bg-[var(--surface-base)] shadow-2xl animate-in slide-in-from-left duration-200"
        style={{ paddingTop: 'var(--oc-safe-area-top, 0px)' }}
      >
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border/70 px-4">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="chip"
              size="sm"
              aria-label={"Close sessions and projects"}
              onClick={() => onOpenChange(false)}
              style={{ touchAction: 'manipulation' }}
            >
              <RiCloseLine className="size-4" />
            </Button>
            <h1 className="typography-ui-label font-bold text-foreground">{"Sessions"}</h1>
          </div>
          <div className="flex items-center gap-1">{trailingActions}</div>
        </header>
        {surfaceContent}
      </div>
      <div className="flex-1" onClick={() => onOpenChange(false)} />
    </div>,
    document.body,
  );
};
