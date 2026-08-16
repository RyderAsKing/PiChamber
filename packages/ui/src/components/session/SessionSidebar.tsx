/* eslint-disable */
import React from 'react';
import type { Session } from '@/lib/chat/types';
import { toast } from '@/components/ui';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopShell } from '@/lib/desktop';
import { sessionEvents } from '@/lib/sessionEvents';
import { formatDirectoryName, cn } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { catalogLiveSessionIdsKey } from '@/sync/pi-session-catalog';
import { buildKnownSessionDirectories, knownSessionDirectoryKey } from '@/sync/known-session-directories';
import { useCatalogUiSessions, useChildStoreManager } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSync } from '@/sync/use-sync';
import { SessionPrefetchEffect } from './sidebar/hooks/useSessionPrefetch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { useGitStore, useGitAllBranches, useGitRepoStatusMap } from '@/stores/useGitStore';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentThinkingLoader } from '@/components/chat/AgentThinkingLoader';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useArchivedAutoFolders } from './sidebar/hooks/useArchivedAutoFolders';
import { useGroupOrdering } from './sidebar/hooks/useGroupOrdering';
import { useSessionSidebarSections } from './sidebar/hooks/useSessionSidebarSections';
import { ProjectSessionSelectionEffect } from './sidebar/hooks/useProjectSessionSelection';
import { useSessionGrouping } from './sidebar/hooks/useSessionGrouping';
import { useSessionSearchEffects } from './sidebar/hooks/useSessionSearchEffects';
import { useSessionActions } from './sidebar/hooks/useSessionActions';
import { useSidebarPersistence } from './sidebar/hooks/useSidebarPersistence';
import { useProjectRepoStatus } from './sidebar/hooks/useProjectRepoStatus';
import { useProjectSessionLists } from './sidebar/hooks/useProjectSessionLists';
import { useAuthoritativeSessionCleanup } from './sidebar/hooks/useAuthoritativeSessionCleanup';
import { createSessionOwnershipIndex } from './sidebar/sessionOwnership';
import { useStickyProjectHeaders } from './sidebar/hooks/useStickyProjectHeaders';
import { ProjectEditDialog } from '@/components/layout/ProjectEditDialog';
import { UpdateDialog } from '@/components/ui/UpdateDialog';
import { SessionGroupSection } from './sidebar/SessionGroupSection';
import { SidebarHeader } from './sidebar/SidebarHeader';
import { SidebarNav } from './sidebar/SidebarNav';
import { SidebarSpacesBar } from './sidebar/SidebarSpacesBar';
import { SidebarFooter } from './sidebar/SidebarFooter';
import { SidebarProjectsList } from './sidebar/SidebarProjectsList';
import { SessionNodeItem } from './sidebar/SessionNodeItem';
import { buildSessionBootstrapDemands } from './sidebar/sessionBootstrapDemands';
import type { SessionNodeRenderExtras } from './sidebar/sessionNodeItemUtils';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useShallow } from 'zustand/react/shallow';
import { checkIsGitRepository } from '@/lib/gitApi';
import type { SortableDragHandleProps } from './sidebar/sortableItems';
import {
  BulkSessionDeleteConfirmDialog,
  FolderDeleteConfirmDialog,
  SessionDeleteConfirmDialog,
  type BulkDeleteSessionsConfirmState,
  type DeleteFolderConfirmState,
  type DeleteSessionConfirmState,
} from './sidebar/ConfirmDialogs';
import { BulkActionBar } from './sidebar/BulkActionBar';
import { useSidebarBulkActions } from './sidebar/hooks/useSidebarBulkActions';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { type SessionGroup, type SessionNode } from './sidebar/types';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import {
  formatProjectLabel,
  normalizePath,
  selectExpandedParentKeysForContext,
  toggleExpandedParentKey,
} from './sidebar/utils';
import { SidebarSessionLikeButton } from './sidebar/sidebarRowChrome';
import {
  compareSessionsByLifecycleOrder,
  EMPTY_SESSION_ORDER_RANKS,
  orderSessionsByLifecycleScopes,
  useSessionOrderingStore,
} from '@/sync/session-ordering';
import {
  resolveGlobalSessionDirectory,
} from '@/stores/useGlobalSessionsStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useNotificationStore } from '@/sync/notification-store';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getGitHubPrStatusKey, useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { streamPerfCount, streamPerfMark } from '@/stores/utils/streamDebug';
import { runBackgroundNetworkTask } from '@/lib/background-network';

const PROJECT_COLLAPSE_STORAGE_KEY = 'oc.sessions.projectCollapse';
const GROUP_ORDER_STORAGE_KEY = 'oc.sessions.groupOrder';
const GROUP_COLLAPSE_STORAGE_KEY = 'oc.sessions.groupCollapse';
const PROJECT_ACTIVE_SESSION_STORAGE_KEY = 'oc.sessions.activeSessionByProject';
// v3 holds composite "${renderContext}:${active|archived}:${sessionId}"
// entries so the same session in different render contexts (e.g. "Recent"
// and a project's root) has independent expand state. Older expansion state
// mixed contexts and is intentionally not migrated.
const SESSION_EXPANDED_STORAGE_KEY = 'oc.sessions.expandedParents.v3';

const isKnownActiveSessionDirectory = (
  session: Session,
  knownDirectories: Set<string>,
  options?: { allowUnknownDirectory?: boolean; allowEmptyDirectorySet?: boolean },
): boolean => {
  if (session.time?.archived) return true;
  const directory = knownSessionDirectoryKey(resolveGlobalSessionDirectory(session));
  if (!directory) return options?.allowUnknownDirectory ?? true;
  if (knownDirectories.size === 0) return options?.allowEmptyDirectorySet ?? true;
  for (const known of knownDirectories) {
    if (knownSessionDirectoryKey(known) === directory) return true;
  }
  return false;
};

const SIDEBAR_PR_NO_PR_RETRY_MS = 5 * 60_000;

const EMPTY_SUBTREE_SET: Set<string> = new Set();
const EMPTY_STRING_ARRAY: string[] = [];

const useStableRenderCallback = <Args extends unknown[], Return>(handler: (...args: Args) => Return): ((...args: Args) => Return) => {
  const handlerRef = React.useRef(handler);
  handlerRef.current = handler;
  return React.useCallback((...args: Args) => handlerRef.current(...args), []);
};

interface SessionSidebarProps {
  isVisible?: boolean;
  mobileVariant?: boolean;
  onSessionSelected?: (sessionId: string) => void;
  allowReselect?: boolean;
  hideDirectoryControls?: boolean;
  showOnlyMainWorkspace?: boolean;
}

const SidebarBootstrapDemandEffect: React.FC<{
  owner: string;
  childStores: ReturnType<typeof useChildStoreManager>;
  projectSections: Parameters<typeof buildSessionBootstrapDemands>[0]['projectSections'];
  activeProjectId: string | null;
  collapsedProjects: ReadonlySet<string>;
  collapsedGroups: ReadonlySet<string>;
  currentDirectory: string | null;
}> = ({
  owner,
  childStores,
  projectSections,
  activeProjectId,
  collapsedProjects,
  collapsedGroups,
  currentDirectory,
}) => {
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);

  React.useEffect(() => {
    childStores.setBootstrapDemand(owner, buildSessionBootstrapDemands({
      projectSections,
      activeProjectId,
      collapsedProjects,
      collapsedGroups,
      currentDirectory,
      currentSessionDirectory,
    }));
  }, [
    activeProjectId,
    childStores,
    collapsedGroups,
    collapsedProjects,
    currentDirectory,
    currentSessionDirectory,
    owner,
    projectSections,
  ]);

  React.useEffect(
    () => () => childStores.clearBootstrapDemand(owner),
    [childStores, owner],
  );

  return null;
};

// Aggregated activity/attention dot for a collapsed project header. Only
// mounted while the project is collapsed, so the per-status-event scans stay
// rare and bounded by the project's directory count.
const ProjectAggregateStatusIndicator: React.FC<{ directories: Array<string | null> }> = ({ directories }) => {
  const directorySet = React.useMemo(() => {
    const set = new Set<string>();
    directories.forEach((directory) => {
      const normalized = normalizePath(directory)?.toLowerCase();
      if (normalized) set.add(normalized);
    });
    return set;
  }, [directories]);
  const hasBusySession = usePiSessionSnapshot((state) => {
    for (const record of state.catalog.byId.values()) {
      if (record.lifecycle !== 'busy' && record.lifecycle !== 'retry') continue;
      const directory = normalizePath(record.directory)?.toLowerCase();
      if (directory && directorySet.has(directory)) return true;
    }
    return false;
  }, undefined, 'catalog');

  if (hasBusySession) {
    return (
      <span
        className="inline-flex items-center"
        aria-label={"Session active"}
        title={"Session active"}
      >
        <AgentThinkingLoader
          variant="inline"
          text={null}
          animationType="spinner"
          speedMs={80}
          className="text-primary text-xs shrink-0"
        />
      </span>
    );
  }
  return null;
};

const SessionSidebarComponent: React.FC<SessionSidebarProps> = ({
  isVisible = true,
  mobileVariant = false,
  onSessionSelected,
  allowReselect = false,
  hideDirectoryControls = false,
  showOnlyMainWorkspace = false,
}) => {
  streamPerfMark('react.session_sidebar_render');
  streamPerfCount('ui.session_sidebar.render');
  streamPerfCount(`ui.session_sidebar.render.${mobileVariant ? 'mobile' : 'desktop'}`);
  streamPerfCount(`ui.session_sidebar.render.${isVisible ? 'visible' : 'hidden'}`);
  const [isSessionSearchOpen, setIsSessionSearchOpen] = React.useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = React.useState('');
  const sessionSearchContainerRef = React.useRef<HTMLDivElement | null>(null);
  const sessionSearchInputRef = React.useRef<HTMLInputElement | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editTitle, setEditTitle] = React.useState('');
  const [editingProjectDialogId, setEditingProjectDialogId] = React.useState<string | null>(null);
  const [expandedParents, setExpandedParents] = React.useState<Set<string>>(new Set());
  const safeStorage = React.useMemo(() => getDeferredSafeStorage(), []);
  const [collapsedProjects, setCollapsedProjects] = React.useState<Set<string>>(new Set());
  const [selectedSpaceId, setSelectedSpaceId] = React.useState<string | null>(null);

  const [projectRepoStatus, setProjectRepoStatus] = React.useState<Map<string, boolean | null>>(new Map());
  const [visibleSessionCountByGroup, setVisibleSessionCountByGroup] = React.useState<Map<string, number>>(new Map());
  const [updateDialogOpen, setUpdateDialogOpen] = React.useState(false);
  const [openSidebarMenuKey, setOpenSidebarMenuKey] = React.useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = React.useState<string | null>(null);
  const [renameFolderDraft, setRenameFolderDraft] = React.useState('');
  const [deleteSessionConfirm, setDeleteSessionConfirm] = React.useState<DeleteSessionConfirmState>(null);
  const [deleteFolderConfirm, setDeleteFolderConfirm] = React.useState<DeleteFolderConfirmState>(null);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = React.useState<BulkDeleteSessionsConfirmState>(null);
  const pinnedSessionIds = useSessionPinnedStore((state) => state.ids);
  const sessionOrderRanks = useSessionOrderingStore(React.useCallback(
    (state) => isVisible ? state.rankById : EMPTY_SESSION_ORDER_RANKS,
    [isVisible],
  ));
  const catalogLiveKey = usePiSessionSnapshot((state) => (
    isVisible ? catalogLiveSessionIdsKey(state.catalog) : ''
  ), undefined, 'catalog');
  const activeSessionIds = React.useMemo(
    () => (catalogLiveKey ? catalogLiveKey.split('|') : EMPTY_STRING_ARRAY),
    [catalogLiveKey],
  );
  const activeSessionIdSet = React.useMemo(() => new Set(activeSessionIds), [activeSessionIds]);
  const unreadSessionIds = useNotificationStore(useShallow(
    (state) => isVisible
      ? Object.entries(state.index.session.unseenCount)
        .filter(([, count]) => count > 0)
        .map(([sessionId]) => sessionId)
        .sort()
      : EMPTY_STRING_ARRAY,
  ));
  const unreadSessionIdSet = React.useMemo(() => new Set(unreadSessionIds), [unreadSessionIds]);
  const togglePinnedSession = useSessionPinnedStore((state) => state.toggle);
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(() => {
    try {
      const raw = getDeferredSafeStorage().getItem(GROUP_COLLAPSE_STORAGE_KEY);
      if (!raw) {
        return new Set();
      }
      const parsed = JSON.parse(raw) as string[];
      return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []);
    } catch {
      return new Set();
    }
  });
  const [groupOrderByProject, setGroupOrderByProject] = React.useState<Map<string, string[]>>(() => {
    try {
      const raw = getDeferredSafeStorage().getItem(GROUP_ORDER_STORAGE_KEY);
      if (!raw) {
        return new Map();
      }
      const parsed = JSON.parse(raw) as Record<string, string[]>;
      const next = new Map<string, string[]>();
      Object.entries(parsed).forEach(([projectId, order]) => {
        if (Array.isArray(order)) {
          next.set(projectId, order.filter((item) => typeof item === 'string'));
        }
      });
      return next;
    } catch {
      return new Map();
    }
  });
  const initialActiveSessionByProject = React.useMemo<Map<string, string>>(() => {
    try {
      const raw = getDeferredSafeStorage().getItem(PROJECT_ACTIVE_SESSION_STORAGE_KEY);
      if (!raw) {
        return new Map();
      }
      const parsed = JSON.parse(raw) as Record<string, string>;
      const next = new Map<string, string>();
      Object.entries(parsed).forEach(([projectId, sessionId]) => {
        if (typeof sessionId === 'string' && sessionId.length > 0) {
          next.set(projectId, sessionId);
        }
      });
      return next;
    } catch {
      return new Map();
    }
  }, []);
  const persistActiveSessionByProject = React.useCallback((value: Map<string, string>) => {
    try {
      safeStorage.setItem(PROJECT_ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(Object.fromEntries(value.entries())));
    } catch { /* ignored */ }
  }, [safeStorage]);

  const [projectRootBranches, setProjectRootBranches] = React.useState<Map<string, string>>(new Map());
  const projectHeaderSentinelRefs = React.useRef<Map<string, HTMLDivElement | null>>(new Map());
  const ignoreIntersectionUntil = React.useRef<number>(0);

  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);

  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const removeProject = useProjectsStore((state) => state.removeProject);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);
  const reorderProjects = useProjectsStore((state) => state.reorderProjects);

  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const toggleHelpDialog = useUIStore((state) => state.toggleHelpDialog);
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const setArchivePageOpen = useUIStore((state) => state.setArchivePageOpen);
  const notifyOnSubtasks = useUIStore((state) => state.notifyOnSubtasks);
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const setShowDeletionDialog = useUIStore((state) => state.setShowDeletionDialog);

  const debouncedSessionSearchQuery = useDebouncedValue(sessionSearchQuery, 120);
  const normalizedSessionSearchQuery = React.useMemo(
    () => debouncedSessionSearchQuery.trim().toLowerCase(),
    [debouncedSessionSearchQuery],
  );

  const hasSessionSearchQuery = normalizedSessionSearchQuery.length > 0;

  // Session Folders store
  const collapsedFolderIds = useSessionFoldersStore((state) => state.collapsedFolderIds);
  const foldersMap = useSessionFoldersStore((state) => state.foldersMap);
  const getFoldersForScope = useSessionFoldersStore((state) => state.getFoldersForScope);
  const createFolder = useSessionFoldersStore((state) => state.createFolder);
  const renameFolder = useSessionFoldersStore((state) => state.renameFolder);
  const deleteFolder = useSessionFoldersStore((state) => state.deleteFolder);
  const addSessionToFolder = useSessionFoldersStore((state) => state.addSessionToFolder);
  const addSessionsToFolder = useSessionFoldersStore((state) => state.addSessionsToFolder);
  const removeSessionFromFolder = useSessionFoldersStore((state) => state.removeSessionFromFolder);
  const removeSessionsFromFolders = useSessionFoldersStore((state) => state.removeSessionsFromFolders);
  const toggleFolderCollapse = useSessionFoldersStore((state) => state.toggleFolderCollapse);
  const getSessionFolderId = useSessionFoldersStore((state) => state.getSessionFolderId);

  useSessionSearchEffects({
    enabled: isVisible,
    isSessionSearchOpen,
    setIsSessionSearchOpen,
    sessionSearchInputRef,
    sessionSearchContainerRef,
  });

  const gitBranches = useGitAllBranches(isVisible);

  const sync = useSync();
  const childStores = useChildStoreManager();
  const piConnection = usePiSessionSnapshot((state) => state.connection, undefined, 'chrome');
  const catalogReady = usePiSessionSnapshot((state) => {
    for (const status of state.catalog.listStatusByDirectory.values()) {
      if (status === 'ready') return true;
    }
    return false;
  }, undefined, 'catalog');
  const catalogSessions = useCatalogUiSessions({ archived: false });
  const archivedSessions = useCatalogUiSessions({ archived: true });
  const bootstrapDemandOwner = `session-sidebar:${React.useId()}`;
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const updateSessionTitle = useSessionUIStore((state) => state.updateSessionTitle);
  const shareSession = useSessionUIStore((state) => state.shareSession);
  const unshareSession = useSessionUIStore((state) => state.unshareSession);
  // sessionAttentionStates removed — now using notification-store directly in SessionNodeItem
  const worktreeMetadata = null;
  const availableWorktreesByProject = useSessionUIStore((state) => (state as any).availableWorktreesByProject) ?? new Map();
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  // The sidebar tree's +-buttons (project / group / folder) open a draft but,
  // unlike selecting an existing session, don't navigate. VS Code's compact view
  // is driven by the pichamber:navigate event, so switch to chat explicitly
  // (a no-op in the expanded side-by-side layout, which is always showing chat).
  const openNewSessionDraftFromTree = React.useCallback<typeof openNewSessionDraft>((options) => {
    // Starting a draft always leaves any full-page surface, even when a
    // draft was already open (no store transition fires in that case).
    useUIStore.getState().closeMainSurfaces();
    openNewSessionDraft(options);
  }, [openNewSessionDraft]);
  const updateStore = useUpdateStore(useShallow((s) => ({
    checkForUpdates: s.checkForUpdates,
    available: s.available,
    runtimeType: s.runtimeType,
    info: s.info,
    downloading: s.downloading,
    downloaded: s.downloaded,
    progress: s.progress,
    error: s.error,
    downloadUpdate: s.downloadUpdate,
    restartToUpdate: s.restartToUpdate,
  })));

  const knownSessionDirectories = React.useMemo(
    () => buildKnownSessionDirectories(projects, availableWorktreesByProject, { includeWorktrees: true }),
    [availableWorktreesByProject, projects],
  );

  const sessions = React.useMemo(() => {
    return catalogSessions.filter((session) => isKnownActiveSessionDirectory(session, knownSessionDirectories, {
      allowUnknownDirectory: true,
      allowEmptyDirectorySet: true,
    }));
  }, [catalogSessions, knownSessionDirectories]);

  const persistenceSessions = React.useMemo(
    () => [...sessions, ...archivedSessions],
    [archivedSessions, sessions],
  );

  const runtimeKey = getRuntimeKey();
  const projectWorktreeDiscoveryKey = React.useMemo(
    () => `${runtimeKey}|${projects
      .map((project) => `${project.id}:${normalizePath(project.path) ?? ''}`)
      .join('|')}`,
    [projects, runtimeKey],
  );
  const [resolvedWorktreeTopologyKey, setResolvedWorktreeTopologyKey] = React.useState<string | null>(null);
  const isWorktreeTopologyLoading = resolvedWorktreeTopologyKey !== projectWorktreeDiscoveryKey;
  const [unresolvedWorktreeProjectPaths, setUnresolvedWorktreeProjectPaths] = React.useState<ReadonlySet<string>>(new Set());

  const isDesktopShellRuntime = React.useMemo(() => isDesktopShell(), []);

  const { isTablet } = useDeviceInfo();
  const alwaysShowSidebarActions = mobileVariant || isTablet;

  const {
    buildGroupSearchText,
    filterSessionNodesForSearch,
    buildGroupedSessions,
  } = useSessionGrouping({
    homeDirectory,
    pinnedSessionIds,
    sessionOrderRanks,
    gitBranches,
  });

  const { scheduleCollapsedProjectsPersist } = useSidebarPersistence({
    safeStorage,
    keys: {
      sessionExpanded: SESSION_EXPANDED_STORAGE_KEY,
      projectCollapse: PROJECT_COLLAPSE_STORAGE_KEY,
      groupOrder: GROUP_ORDER_STORAGE_KEY,
      groupCollapse: GROUP_COLLAPSE_STORAGE_KEY,
    },
    groupOrderByProject,
    collapsedGroups,
    setExpandedParents,
    setCollapsedProjects,
  });

  const orderedSessions = React.useMemo(() => {
    return orderSessionsByLifecycleScopes(sessions, pinnedSessionIds, sessionOrderRanks);
  }, [pinnedSessionIds, sessionOrderRanks, sessions]);

  // Reuse the index while the ordered IDs stay unchanged.
  // Without this, a fresh `orderedSessions` array (cheap to rebuild) would
  // still hand a new Map identity to the entire SessionGroupSection
  // memo chain, invalidating sourceGroupNodes, nodeBySessionId, and the
  // rest of the down-stream useMemo chain.
  const sessionOrderSignature = React.useMemo(
    () => orderedSessions.map((session) => session.id).join('|'),
    [orderedSessions],
  );

  const sessionOrderIndexRef = React.useRef<{ signature: string; map: Map<string, number> } | null>(null);
  const sessionOrderIndex = React.useMemo(() => {
    const cached = sessionOrderIndexRef.current;
    if (cached && cached.signature === sessionOrderSignature) {
      return cached.map;
    }
    const next = new Map(orderedSessions.map((session, index) => [session.id, index]));
    sessionOrderIndexRef.current = { signature: sessionOrderSignature, map: next };
    return next;
  }, [orderedSessions, sessionOrderSignature]);

  const childrenMap = React.useMemo(() => {
    const map = new Map<string, Session[]>();
    orderedSessions.forEach((session) => {
      const parentID = (session as Session & { parentID?: string | null }).parentID;
      if (!parentID) {
        return;
      }
      const collection = map.get(parentID) ?? [];
      collection.push(session);
      map.set(parentID, collection);
    });
    map.forEach((list) => list.sort((a, b) => compareSessionsByLifecycleOrder(a, b, pinnedSessionIds, sessionOrderRanks)));
    return map;
  }, [orderedSessions, pinnedSessionIds, sessionOrderRanks]);

  const emptyState = React.useMemo(() => (
    <SidebarSessionLikeButton
      icon="chat-new"
      onClick={() => openNewSessionDraftFromTree()}
    >
      {"New session"}
    </SidebarSessionLikeButton>
  ), [openNewSessionDraftFromTree]);

  const editingProject = React.useMemo(
    () => projects.find((project) => project.id === editingProjectDialogId) ?? null,
    [projects, editingProjectDialogId],
  );

  const handleSaveProjectEdit = React.useCallback((data: {
    label: string;
    icon: string | null;
    color: string | null;
    iconBackground: string | null;
    defaultModel: string | null;
  }) => {
    if (!editingProjectDialogId) {
      return;
    }
    updateProjectMeta(editingProjectDialogId, {
      label: data.label,
      icon: data.icon,
      color: data.color,
      iconBackground: data.iconBackground,
      defaultModel: data.defaultModel ?? null,
    });
  }, [editingProjectDialogId, updateProjectMeta]);

  const handleOpenUpdateDialog = React.useCallback(() => {
    const current = useUpdateStore.getState();
    if (current.available && current.info) {
      setUpdateDialogOpen(true);
      return;
    }

    void updateStore.checkForUpdates().then(() => {
      const { available, error } = useUpdateStore.getState();
      if (error) {
        toast.error("Failed to check for updates", { description: error });
        return;
      }
      if (!available) {
        toast.success("You are on the latest version");
        return;
      }
      setUpdateDialogOpen(true);
    });
  }, [ updateStore]);

  const handleOpenSettings = React.useCallback(() => {
    if (mobileVariant) {
      setSessionSwitcherOpen(false);
    }
    setSettingsDialogOpen(true);
  }, [mobileVariant, setSessionSwitcherOpen, setSettingsDialogOpen]);

  const showSidebarUpdateButton =
    updateStore.available &&
    (updateStore.runtimeType === 'desktop' || updateStore.runtimeType === 'web');

  const deleteSession = useSessionUIStore((state) => state.deleteSession);
  const deleteSessions = useSessionUIStore((state) => state.deleteSessions);
  const archiveSession = useSessionUIStore((state) => state.archiveSession);
  const archiveSessions = useSessionUIStore((state) => state.archiveSessions);
  const unarchiveSession = useSessionUIStore((state) => state.unarchiveSession);
  const unarchiveSessions = useSessionUIStore((state) => state.unarchiveSessions);

  const {
    copiedSessionId,
    handleSessionSelect,
    handleSessionDoubleClick,
    handleSaveEdit,
    handleCancelEdit,
    handleShareSession,
    handleCopyShareUrl,
    handleCopySessionId,
    handleUnshareSession,
    handleDeleteSession,
    handleRestoreSession,
    confirmDeleteSession,
  } = useSessionActions({
    mobileVariant,
    allowReselect,
    onSessionSelected,
    isSessionSearchOpen,
    sessionSearchQuery,
    setSessionSearchQuery,
    setIsSessionSearchOpen,
    setActiveMainTab,
    setSessionSwitcherOpen,
    setCurrentSession,
    updateSessionTitle,
    shareSession,
    unshareSession,
    deleteSession,
    deleteSessions,
    archiveSession,
    archiveSessions,
    unarchiveSession,
    childrenMap,
    showDeletionDialog,
    setDeleteSessionConfirm,
    deleteSessionConfirm,
    setEditingId,
    setEditTitle,
    editingId,
    editTitle,
  });

  const confirmDeleteFolder = React.useCallback(() => {
    if (!deleteFolderConfirm) return;
    const { scopeKey, folderId } = deleteFolderConfirm;
    setDeleteFolderConfirm(null);
    deleteFolder(scopeKey, folderId);
  }, [deleteFolderConfirm, deleteFolder]);

  const handleOpenDirectoryDialog = React.useCallback(() => {
    sessionEvents.requestDirectoryDialog();
  }, []);

  const toggleParent = React.useCallback((expansionKey: string) => {
    setExpandedParents((previous) => {
      const next = toggleExpandedParentKey(previous, expansionKey);
      try {
        safeStorage.setItem(SESSION_EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch { /* ignored */ }
      return next;
    });
  }, [safeStorage]);

  const createFolderAndStartRename = React.useCallback(
    (scopeKey: string, parentId?: string | null) => {
      if (!scopeKey) {
        return null;
      }

      if (parentId && collapsedFolderIds.has(parentId)) {
        toggleFolderCollapse(parentId);
      }

      const newFolder = createFolder(scopeKey, "New folder", parentId);
      setRenamingFolderId(newFolder.id);
      setRenameFolderDraft(newFolder.name);
      return newFolder;
    },
    [collapsedFolderIds, toggleFolderCollapse, createFolder],
  );

  const stableHandleSessionSelect = useStableRenderCallback(handleSessionSelect);
  const stableHandleSessionDoubleClick = useStableRenderCallback(handleSessionDoubleClick);
  const stableHandleSaveEdit = useStableRenderCallback(handleSaveEdit);
  const stableHandleCancelEdit = useStableRenderCallback(handleCancelEdit);
  const stableHandleShareSession = useStableRenderCallback(handleShareSession);
  const stableHandleCopyShareUrl = useStableRenderCallback(handleCopyShareUrl);
  const stableHandleCopySessionId = useStableRenderCallback(handleCopySessionId);
  const stableHandleUnshareSession = useStableRenderCallback(handleUnshareSession);
  const stableHandleDeleteSession = useStableRenderCallback(handleDeleteSession);
  const stableHandleRestoreSession = useStableRenderCallback(handleRestoreSession);
  const stableCreateFolderAndStartRename = useStableRenderCallback(createFolderAndStartRename);

  const showMoreGroupSessions = React.useCallback((groupId: string, currentVisibleCount: number) => {
    setVisibleSessionCountByGroup((prev) => {
      const next = new Map(prev);
      next.set(groupId, currentVisibleCount + 7);
      return next;
    });
  }, []);

  const resetGroupSessionLimit = React.useCallback((groupId: string) => {
    setVisibleSessionCountByGroup((prev) => {
      if (!prev.has(groupId)) {
        return prev;
      }
      const next = new Map(prev);
      next.delete(groupId);
      return next;
    });
  }, []);

  const resetProjectSessionLimits = React.useCallback((projectId: string) => {
    setVisibleSessionCountByGroup((prev) => {
      let changed = false;
      const next = new Map(prev);
      const projectGroupPrefix = `${projectId}:`;
      for (const groupId of next.keys()) {
        if (groupId.startsWith(projectGroupPrefix)) {
          next.delete(groupId);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  // Collapse/expand covers both levels: projects and their worktree groups.
  const projectSectionsRef = React.useRef<typeof projectSections>([]);

  const collapseAllProjects = React.useCallback(() => {
    ignoreIntersectionUntil.current = Date.now() + 150;
    setVisibleSessionCountByGroup(new Map());
    setCollapsedGroups(() => {
      const allGroupKeys = new Set<string>();
      projectSectionsRef.current.forEach((section) => {
        section.groups.forEach((group) => {
          if (!group.isMain) allGroupKeys.add(`${section.project.id}:${group.id}`);
        });
      });
      return allGroupKeys;
    });
    setCollapsedProjects(() => {
      const allIds = new Set(projects.map((p) => p.id));
      try {
        safeStorage.setItem(PROJECT_COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(allIds)));
      } catch { /* ignored */ }
      scheduleCollapsedProjectsPersist(allIds);
      return allIds;
    });
  }, [projects, safeStorage, scheduleCollapsedProjectsPersist]);

  const expandAllProjects = React.useCallback(() => {
    ignoreIntersectionUntil.current = Date.now() + 150;
    setVisibleSessionCountByGroup(new Map());
    setCollapsedGroups(new Set());
    setCollapsedProjects(() => {
      const empty = new Set<string>();
      try {
        safeStorage.setItem(PROJECT_COLLAPSE_STORAGE_KEY, JSON.stringify([]));
      } catch { /* ignored */ }
      scheduleCollapsedProjectsPersist(empty);
      return empty;
    });
  }, [safeStorage, scheduleCollapsedProjectsPersist]);

  const toggleProject = React.useCallback((projectId: string) => {
    // Ignore intersection events for a short period after toggling
    ignoreIntersectionUntil.current = Date.now() + 150;
    resetProjectSessionLimits(projectId);
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      try {
        safeStorage.setItem(PROJECT_COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch { /* ignored */ }

      // Persist collapse state to server settings (web + desktop local/remote).
      scheduleCollapsedProjectsPersist(next);
      return next;
    });
  }, [resetProjectSessionLimits, safeStorage, scheduleCollapsedProjectsPersist]);

  const normalizedProjects = React.useMemo(() => {
    return projects
      .map((project) => ({
        ...project,
        normalizedPath: normalizePath(project.path),
      }))
      .filter((project) => Boolean(project.normalizedPath)) as Array<{
        id: string;
        path: string;
        label?: string;
        normalizedPath: string;
        icon?: string;
        color?: string;
        iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
        iconBackground?: string;
        addedAt?: number;
        lastOpenedAt?: number;
        sidebarCollapsed?: boolean;
      }>;
  }, [projects]);

  const normalizedProjectPaths = React.useMemo(
    () => normalizedProjects.map((project) => project.normalizedPath),
    [normalizedProjects],
  );

  const gitRepoStatus = useGitRepoStatusMap(isVisible ? normalizedProjectPaths : EMPTY_STRING_ARRAY);

  useProjectRepoStatus({
    enabled: isVisible,
    normalizedProjects,
    gitRepoStatus,
    setProjectRepoStatus,
    setProjectRootBranches,
  });

  const isSessionsLoading = useSessionUIStore((state) => state.isLoading);
  const sessionOwnership = React.useMemo(
    () => createSessionOwnershipIndex(sessions, normalizedProjects, availableWorktreesByProject, archivedSessions),
    [archivedSessions, availableWorktreesByProject, normalizedProjects, sessions],
  );
  useAuthoritativeSessionCleanup({
    enabled: isVisible,
    hasAuthoritativeGlobalSessions: catalogReady,
    sessions: persistenceSessions,
  });

  const { getSessionsForProject, getArchivedSessionsForProject } = useProjectSessionLists({
    ownership: sessionOwnership,
  });

  useArchivedAutoFolders({
    enabled: isVisible,
    normalizedProjects,
    ownership: sessionOwnership,
    isSessionsLoading,
    hasAuthoritativeGlobalSessions: catalogReady,
    isWorktreeTopologyLoading,
    unresolvedWorktreeProjectPaths,
    foldersMap,
    createFolder,
    addSessionToFolder,
  });

  // Keep last-known repo status to avoid UI jiggling during project switch
  const lastRepoStatusRef = React.useRef(false);
  if (activeProjectId && projectRepoStatus.has(activeProjectId)) {
    lastRepoStatusRef.current = Boolean(projectRepoStatus.get(activeProjectId));
  }

  const showArchivedSessions = useSessionDisplayStore((state) => state.showArchivedSessions);
  const projectSortOrder = useSessionDisplayStore((state) => state.projectSortOrder);
  const stickyZoneHeaders = useSessionDisplayStore((state) => state.stickyZoneHeaders);
  const manualProjectOrder = useProjectsStore((state) => state.manualProjectOrder);
  const projectExpandedParentsRef = React.useRef<Set<string>>(new Set());
  const projectExpandedParents = selectExpandedParentKeysForContext(
    projectExpandedParentsRef.current,
    expandedParents,
    'project',
  );
  projectExpandedParentsRef.current = projectExpandedParents;

  const sidebarRenderSources = {
    isVisible,
    mobileVariant,
    onSessionSelected,
    allowReselect,
    hideDirectoryControls,
    showOnlyMainWorkspace,
    isTablet,
    catalogSessions,
    archivedSessions,
    projects,
    activeProjectId,
    manualProjectOrder,
    currentDirectory,
    availableWorktreesByProject,
    pinnedSessionIds,
    sessionOrderRanks,
    foldersMap,
    collapsedFolderIds,
    gitBranches,
    gitRepoStatus,
    updateStore,
    showArchivedSessions,
    projectSortOrder,
    projectRepoStatus,
    projectRootBranches,
    resolvedWorktreeTopologyKey,
    unresolvedWorktreeProjectPaths,
    isSessionSearchOpen,
    sessionSearchQuery,
    editingId,
    editTitle,
    editingProjectDialogId,
    expandedParents,
    collapsedProjects,
    visibleSessionCountByGroup,
    updateDialogOpen,
    openSidebarMenuKey,
    renamingFolderId,
    renameFolderDraft,
    deleteSessionConfirm,
    deleteFolderConfirm,
    bulkDeleteConfirm,
    collapsedGroups,
  };
  const previousSidebarRenderSourcesRef = React.useRef<typeof sidebarRenderSources | null>(null);
  const previousSidebarRenderSources = previousSidebarRenderSourcesRef.current;
  if (previousSidebarRenderSources) {
    let attributed = false;
    for (const source of Object.keys(sidebarRenderSources) as Array<keyof typeof sidebarRenderSources>) {
      if (!Object.is(previousSidebarRenderSources[source], sidebarRenderSources[source])) {
        streamPerfCount(`ui.session_sidebar.source.${source}`);
        attributed = true;
      }
    }
    if (!attributed) {
      streamPerfCount('ui.session_sidebar.source.parent_or_context');
    }
  }
  previousSidebarRenderSourcesRef.current = sidebarRenderSources;

  const sortedProjects = React.useMemo(() => {
    const list = [...normalizedProjects];

    switch (projectSortOrder) {
      case 'a-z':
        list.sort((a, b) => {
          const aLabel = (a.label || a.path).toLowerCase();
          const bLabel = (b.label || b.path).toLowerCase();
          return aLabel.localeCompare(bLabel);
        });
        break;
      case 'z-a':
        list.sort((a, b) => {
          const aLabel = (a.label || a.path).toLowerCase();
          const bLabel = (b.label || b.path).toLowerCase();
          return bLabel.localeCompare(aLabel);
        });
        break;
      case 'date-added':
        list.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
        break;
      case 'recent':
        list.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0));
        break;
      case 'manual': {
        const orderMap = new Map(manualProjectOrder.map((id, i) => [id, i]));
        list.sort((a, b) => {
          const ai = orderMap.get(a.id) ?? Infinity;
          const bi = orderMap.get(b.id) ?? Infinity;
          return ai - bi;
        });
        break;
      }
    }

    return list;
  }, [normalizedProjects, projectSortOrder, manualProjectOrder]);

  const {
    projectSections,
    groupSearchDataByGroup,
    sectionsForRender,
    flatSectionsForRender,
    searchMatchCount,
  } = useSessionSidebarSections({
    normalizedProjects: sortedProjects,
    getSessionsForProject,
    getArchivedSessionsForProject,
    availableWorktreesByProject,
    projectRepoStatus,
    projectRootBranches,
    lastRepoStatus: lastRepoStatusRef.current,
    buildGroupedSessions,
    hasSessionSearchQuery,
    normalizedSessionSearchQuery,
    filterSessionNodesForSearch,
    buildGroupSearchText,
    foldersMap,
  });

  projectSectionsRef.current = projectSections;

  const searchEmptyState = React.useMemo(() => (
    <div className="py-6 text-center text-muted-foreground">
      <p className="typography-ui-label font-semibold">{"No matching sessions"}</p>
      <p className="typography-meta mt-1">{"Try a different title, branch, folder, or path."}</p>
    </div>
  ), []);

  const { getOrderedGroups } = useGroupOrdering(groupOrderByProject);
  const hasInitializedArchivedCollapseRef = React.useRef(false);

  React.useEffect(() => {
    if (hasInitializedArchivedCollapseRef.current || projectSections.length === 0) {
      return;
    }
    const archivedGroupKeys = projectSections.flatMap((section) =>
      section.groups
        .filter((group) => group.isArchivedBucket)
        .map((group) => `${section.project.id}:${group.id}`),
    );
    if (archivedGroupKeys.length > 0) {
      setCollapsedGroups((prev) => new Set([...prev, ...archivedGroupKeys]));
    }
    hasInitializedArchivedCollapseRef.current = true;
  }, [projectSections]);

  const sessionSidebarMetaById = React.useMemo(() => {
    const meta = new Map<string, {
      node: SessionNode;
      projectId: string | null;
      groupDirectory: string | null;
      secondaryMeta: {
        projectLabel?: string | null;
        branchLabel?: string | null;
      } | null;
    }>();
    const projectPathLengthBySessionId = new Map<string, number>();

    projectSections.forEach((section) => {
      const projectLabel = formatProjectLabel(
        section.project.label?.trim()
        || formatDirectoryName(section.project.normalizedPath, homeDirectory)
        || section.project.normalizedPath,
      );
      section.groups.forEach((group) => {
        const branchCandidate = group.branch && group.branch !== 'HEAD' && group.branch !== projectLabel
          ? group.branch
          : null;
        const secondaryMeta = { projectLabel, branchLabel: branchCandidate };

        const visit = (nodes: SessionNode[]) => {
          nodes.forEach((node) => {
            const nextProjectPathLength = section.project.normalizedPath.length;
            const currentProjectPathLength = projectPathLengthBySessionId.get(node.session.id) ?? -1;
            if (nextProjectPathLength < currentProjectPathLength) {
              return;
            }

            meta.set(node.session.id, {
              node,
              projectId: section.project.id,
              groupDirectory: group.directory,
              secondaryMeta,
            });
            projectPathLengthBySessionId.set(node.session.id, nextProjectPathLength);
            if (node.children.length > 0) {
              visit(node.children);
            }
          });
        };

        visit(group.sessions);
      });
    });

    return meta;
  }, [projectSections, homeDirectory]);

  const sectionsForSidebarRender = React.useMemo(() => {
    return flatSectionsForRender.map((section) => (
        section.groups.some((group) => group.isArchivedBucket)
          ? { ...section, groups: section.groups.filter((group) => !group.isArchivedBucket) }
          : section
      ));
  }, [flatSectionsForRender]);

  const filteredSectionsForSidebarRender = React.useMemo(() => {
    if (!selectedSpaceId) {
      return sectionsForSidebarRender;
    }
    return sectionsForSidebarRender.filter((section) => section.project.id === selectedSpaceId);
  }, [sectionsForSidebarRender, selectedSpaceId]);

  const totalSessionCount = React.useMemo(() => {
    let count = 0;
    for (const section of projectSections) {
      for (const group of section.groups) {
        if (!group.isArchivedBucket) {
          count += group.sessions.length;
        }
      }
    }
    return count;
  }, [projectSections]);

  const sessionCountByProject = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const section of projectSections) {
      let count = 0;
      for (const group of section.groups) {
        if (!group.isArchivedBucket) {
          count += group.sessions.length;
        }
      }
      map.set(section.project.id, count);
    }
    return map;
  }, [projectSections]);

  const hasActiveSessionByProject = React.useCallback((projectId: string) => {
    const section = projectSections.find((s) => s.project.id === projectId);
    if (!section) return false;
    return section.groups.some((group) => {
      if (group.isArchivedBucket) return false;
      return group.sessions.some((node) => activeSessionIdSet.has(node.session.id));
    });
  }, [activeSessionIdSet, projectSections]);

  const hasUnseenByProject = React.useCallback((projectId: string) => {
    const section = projectSections.find((s) => s.project.id === projectId);
    if (!section) return false;
    return section.groups.some((group) => {
      if (group.isArchivedBucket) return false;
      return group.sessions.some((node) => unreadSessionIdSet.has(node.session.id));
    });
  }, [projectSections, unreadSessionIdSet]);

  // Discover/refresh PR status for expanded projects' worktree branches so
  // session rows can tint their branch marker and show PR state in tooltips.


  const desktopHeaderActionButtonClass =
    'inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md leading-none text-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed';
  const mobileHeaderActionButtonClass =
    'inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md leading-none text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed';
  const headerActionButtonClass = mobileVariant ? mobileHeaderActionButtonClass : desktopHeaderActionButtonClass;
  const headerActionIconClass = 'h-4.5 w-4.5';
  const stuckProjectHeaders = useStickyProjectHeaders({
    enabled: isVisible && stickyZoneHeaders,
    isDesktopShellRuntime,
    projectSections,
    projectHeaderSentinelRefs,
  });

  const renderSessionNode = useStableRenderCallback(
    (
      node: SessionNode,
      depth: number = 0,
      groupDirectory?: string | null,
      projectId?: string | null,
      archivedBucket: boolean = false,
      secondaryMeta?: { projectLabel?: string | null; branchLabel?: string | null } | null,
      renderContext: 'project' | 'recent' = 'project',
      renderExtras?: SessionNodeRenderExtras,
    ): React.ReactNode => (
      <SessionNodeItem
        node={node}
        depth={depth}
        groupDirectory={groupDirectory}
        projectId={projectId}
        archivedBucket={archivedBucket}
        pinnedSessionIds={pinnedSessionIds}
        expandedParents={projectExpandedParents}
        hasSessionSearchQuery={hasSessionSearchQuery}
        normalizedSessionSearchQuery={normalizedSessionSearchQuery}
        notifyOnSubtasks={notifyOnSubtasks}
        editingId={editingId}
        setEditingId={setEditingId}
        editTitle={editTitle}
        setEditTitle={setEditTitle}
        handleSaveEdit={stableHandleSaveEdit}
        handleCancelEdit={stableHandleCancelEdit}
        toggleParent={toggleParent}
        handleSessionSelect={stableHandleSessionSelect}
        handleSessionDoubleClick={stableHandleSessionDoubleClick}
        togglePinnedSession={togglePinnedSession}
        handleShareSession={stableHandleShareSession}
        copiedSessionId={copiedSessionId}
        handleCopyShareUrl={stableHandleCopyShareUrl}
        handleCopySessionId={stableHandleCopySessionId}
        handleUnshareSession={stableHandleUnshareSession}
        openSidebarMenuKey={openSidebarMenuKey}
        setOpenSidebarMenuKey={setOpenSidebarMenuKey}
        renamingFolderId={renamingFolderId}
        getFoldersForScope={getFoldersForScope}
        getSessionFolderId={getSessionFolderId}
        removeSessionFromFolder={removeSessionFromFolder}
        addSessionToFolder={addSessionToFolder}
        createFolderAndStartRename={stableCreateFolderAndStartRename}
        openContextPanelTab={openContextPanelTab}
        handleDeleteSession={stableHandleDeleteSession}
        handleRestoreSession={stableHandleRestoreSession}
        mobileVariant={mobileVariant}
        alwaysShowActions={alwaysShowSidebarActions}
        renderSessionNode={renderSessionNode}
        secondaryMeta={secondaryMeta}
        renderContext={renderContext}
        subtreeContainsEditing={renderExtras?.subtreeContainsEditing ?? EMPTY_SUBTREE_SET}
        menuOpenSessionId={renderExtras?.menuOpenSessionId ?? null}
        nodeStructureKey={renderExtras?.nodeStructureKey ?? ''}
        childRenderExtrasFor={renderExtras?.childRenderExtrasFor}
      />
    ),
  );

  // Selection scope is the project id; bulk folder actions need the project's
  // directory scopes (root + worktrees) to resolve folders across worktrees.
  const folderScopesByProject = React.useMemo(() => {
    const map = new Map<string, Array<{ scopeKey: string; directory: string | null }>>();
    flatSectionsForRender.forEach((section) => {
      const flatGroup = section.groups.find((group) => !group.isArchivedBucket);
      if (flatGroup?.folderScopes && flatGroup.folderScopes.length > 0) {
        map.set(section.project.id, flatGroup.folderScopes);
      }
    });
    return map;
  }, [flatSectionsForRender]);

  const renderProjectStatusIndicator = React.useCallback((_projectId: string, groups: SessionGroup[]) => {
    const directories: Array<string | null> = [];
    groups.forEach((group) => {
      if (group.isArchivedBucket) return;
      directories.push(group.directory);
      group.folderScopes?.forEach((scope) => directories.push(scope.directory));
    });
    return <ProjectAggregateStatusIndicator directories={directories} />;
  }, []);

  const toggleCollapsedGroup = React.useCallback((key: string) => {
    resetGroupSessionLimit(key);
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [resetGroupSessionLimit]);

  const renderGroupSessions = React.useCallback(
    (
      group: SessionGroup,
      groupKey: string,
      projectId?: string | null,
      hideGroupLabel?: boolean,
      dragHandleProps?: SortableDragHandleProps | null,
      compactBodyPadding?: boolean,
      scrollContainerRef?: React.RefObject<HTMLElement | null>,
    ) => (
      <SessionGroupSection
        group={group}
        groupKey={groupKey}
        projectId={projectId}
        hideGroupLabel={hideGroupLabel}
        dragHandleProps={dragHandleProps}
        compactBodyPadding={compactBodyPadding}
        hasSessionSearchQuery={hasSessionSearchQuery}
        normalizedSessionSearchQuery={normalizedSessionSearchQuery}
        groupSearchDataByGroup={groupSearchDataByGroup}
        visibleSessionCount={visibleSessionCountByGroup.get(groupKey)}
        collapsedGroups={collapsedGroups}
        hideDirectoryControls={hideDirectoryControls}
        collapsedFolderIds={collapsedFolderIds}
        toggleFolderCollapse={toggleFolderCollapse}
        renameFolder={renameFolder}
        deleteFolder={deleteFolder}
        showDeletionDialog={showDeletionDialog}
        setDeleteFolderConfirm={setDeleteFolderConfirm}
        renderSessionNode={renderSessionNode}
        showMoreGroupSessions={showMoreGroupSessions}
        resetGroupSessionLimit={resetGroupSessionLimit}
        mobileVariant={mobileVariant}
        alwaysShowActions={alwaysShowSidebarActions}
        activeProjectId={activeProjectId}
        setActiveProjectIdOnly={setActiveProjectIdOnly}
        setActiveMainTab={setActiveMainTab}
        setSessionSwitcherOpen={setSessionSwitcherOpen}
        openNewSessionDraft={openNewSessionDraftFromTree}
        addSessionToFolder={addSessionToFolder}
        createFolderAndStartRename={stableCreateFolderAndStartRename}
        renamingFolderId={renamingFolderId}
        renameFolderDraft={renameFolderDraft}
        setRenameFolderDraft={setRenameFolderDraft}
        setRenamingFolderId={setRenamingFolderId}
        pinnedSessionIds={pinnedSessionIds}
        expandedParents={projectExpandedParents}
        sessionOrderIndex={sessionOrderIndex}
        editingId={editingId}
        editTitle={editTitle}
        openSidebarMenuKey={openSidebarMenuKey}
        activeActivitySessionIds={activeSessionIdSet}
        unreadActivitySessionIds={unreadSessionIdSet}
        notifyOnSubtasks={notifyOnSubtasks}
        onToggleCollapsedGroup={toggleCollapsedGroup}
        scrollContainerRef={scrollContainerRef}
      />
    ),
    [
      hasSessionSearchQuery,
      normalizedSessionSearchQuery,
      groupSearchDataByGroup,
      visibleSessionCountByGroup,
      collapsedGroups,
      hideDirectoryControls,
      collapsedFolderIds,
      toggleFolderCollapse,
      renameFolder,
      deleteFolder,
      showDeletionDialog,
      renderSessionNode,
      showMoreGroupSessions,
      resetGroupSessionLimit,
      mobileVariant,
      alwaysShowSidebarActions,
      activeProjectId,
      setActiveProjectIdOnly,
      setActiveMainTab,
      setSessionSwitcherOpen,
      openNewSessionDraftFromTree,
      addSessionToFolder,
      stableCreateFolderAndStartRename,
      renamingFolderId,
      renameFolderDraft,
      pinnedSessionIds,
      projectExpandedParents,
      sessionOrderIndex,
      editingId,
      editTitle,
      openSidebarMenuKey,
      activeSessionIdSet,
      unreadSessionIdSet,
      notifyOnSubtasks,
      toggleCollapsedGroup,
    ],
  );

  const isInlineEditing = Boolean(renamingFolderId || editingId || editingProjectDialogId);

  const {
    selectionModeEnabled,
    hasSelection,
    selectedIdsSize,
    bulkScopeIsArchived,
    derivedSelectionScope,
    bulkScopeFolders,
    bulkCanRemoveFromFolder,
    handleToggleSelectionMode,
    handleExitSelectionMode,
    handleBulkMoveToFolder,
    handleBulkCreateFolderAndMove,
    handleBulkRemoveFromFolder,
    handleBulkDelete,
    handleBulkRestore,
    confirmBulkDelete,
  } = useSidebarBulkActions({
    isInlineEditing,
    showDeletionDialog,
    foldersMap,
    folderScopesByProject,
    addSessionsToFolder,
    removeSessionsFromFolders,
    createFolderAndStartRename,
    archiveSessions,
    unarchiveSessions,
    deleteSessions,
    setBulkDeleteConfirm,
  });

  const handleOpenNewSessionDraftFromHeader = React.useCallback(() => {
    useUIStore.getState().closeMainSurfaces();
    setActiveMainTab('chat');
    if (mobileVariant) {
      setSessionSwitcherOpen(false);
    }
    openNewSessionDraft();
  }, [mobileVariant, openNewSessionDraft, setActiveMainTab, setSessionSwitcherOpen]);

  return (
    // One shared tooltip provider for the whole sidebar: session tooltips open
    // instantly, and moving between rows hands the tooltip over (grouping)
    // instead of replaying the exit/enter animation for each row.
    // closeDelay bridges the small gap between rows: the tooltip survives the
    // pointer crossing row margins, and the grouping timeout hands it over to
    // the next row without an exit/enter cycle.
    <TooltipProvider delay={0} closeDelay={150} timeout={600}>
    <div
      ref={sessionSearchContainerRef}
      className={cn(
        'relative flex h-full flex-col text-foreground overflow-x-hidden',
        mobileVariant ? '' : 'bg-transparent',
      )}
    >
      <SidebarBootstrapDemandEffect
        owner={bootstrapDemandOwner}
        childStores={childStores}
        projectSections={projectSections}
        activeProjectId={activeProjectId}
        collapsedProjects={collapsedProjects}
        collapsedGroups={collapsedGroups}
        currentDirectory={currentDirectory}
      />
      <ProjectSessionSelectionEffect
        projectSections={projectSections}
        activeProjectId={activeProjectId}
        initialActiveSessionByProject={initialActiveSessionByProject}
        persistActiveSessionByProject={persistActiveSessionByProject}
        handleSessionSelect={stableHandleSessionSelect}
        mobileVariant={mobileVariant}
        openNewSessionDraft={openNewSessionDraft}
        setActiveMainTab={setActiveMainTab}
        setSessionSwitcherOpen={setSessionSwitcherOpen}
      />
      <SessionPrefetchEffect
        enabled={isVisible}
        sortedSessions={orderedSessions}
        prefetchSession={async (sessionId) => { await sync.syncSession(sessionId); }}
      />
      {!hideDirectoryControls ? (
        <SidebarNav onNewSession={handleOpenNewSessionDraftFromHeader} />
      ) : null}

      <SidebarHeader
        hideDirectoryControls={hideDirectoryControls}
        handleOpenDirectoryDialog={handleOpenDirectoryDialog}
        onOpenArchive={() => {
          if (mobileVariant) setSessionSwitcherOpen(false);
          setArchivePageOpen(true);
        }}
        headerActionIconClass={headerActionIconClass}
        headerActionButtonClass={headerActionButtonClass}
        isSessionSearchOpen={isSessionSearchOpen}
        setIsSessionSearchOpen={setIsSessionSearchOpen}
        sessionSearchInputRef={sessionSearchInputRef}
        sessionSearchQuery={sessionSearchQuery}
        setSessionSearchQuery={setSessionSearchQuery}
        hasSessionSearchQuery={hasSessionSearchQuery}
        searchMatchCount={searchMatchCount}
        collapseAllProjects={collapseAllProjects}
        expandAllProjects={expandAllProjects}
        selectionModeEnabled={selectionModeEnabled}
        onToggleSelectionMode={handleToggleSelectionMode}
      />

      {piConnection === 'error' || piConnection === 'unavailable' ? (
        <div
          role="alert"
          className="mx-2 mb-2 rounded bg-[var(--status-error-background)] p-2 text-xs text-[var(--status-error-foreground)]"
        >
          {"Unable to reach server"}
        </div>
      ) : null}

      {!hideDirectoryControls && projectSections.length > 0 ? (
        <SidebarSpacesBar
          projects={projectSections.map((s) => s.project)}
          selectedProjectId={selectedSpaceId}
          onSelectProject={(id) => {
            setSelectedSpaceId(id);
            if (id) {
              setActiveProjectIdOnly(id);
            }
          }}
          onOpenDirectoryDialog={handleOpenDirectoryDialog}
          onOpenProjectEditDialog={setEditingProjectDialogId}
          onRemoveProject={removeProject}
          totalSessionCount={totalSessionCount}
          getSessionCountForProject={(id) => sessionCountByProject.get(id) ?? 0}
          hasActiveSessionByProject={hasActiveSessionByProject}
          hasUnseenByProject={hasUnseenByProject}
          homeDirectory={homeDirectory}
        />
      ) : null}

      {isVisible ? <SidebarProjectsList
        sectionsForRender={filteredSectionsForSidebarRender}
        projectSections={projectSections}
        activeProjectId={activeProjectId}
        showOnlyMainWorkspace={showOnlyMainWorkspace}
        hasSessionSearchQuery={hasSessionSearchQuery}
        emptyState={emptyState}
        searchEmptyState={searchEmptyState}
        isAllFoldersView={selectedSpaceId === null}
        pinnedSessionIds={pinnedSessionIds}
        renderSessionNode={renderSessionNode}
        renderGroupSessions={renderGroupSessions}
        homeDirectory={homeDirectory}
        collapsedProjects={collapsedProjects}
        hideDirectoryControls={hideDirectoryControls}
        projectRepoStatus={projectRepoStatus}
        isDesktopShellRuntime={isDesktopShellRuntime}
        stickyZoneHeaders={stickyZoneHeaders}
        stuckProjectHeaders={stuckProjectHeaders}
        mobileVariant={mobileVariant}
        alwaysShowActions={alwaysShowSidebarActions}
        toggleProject={toggleProject}
        setActiveProjectIdOnly={setActiveProjectIdOnly}
        setActiveMainTab={setActiveMainTab}
        setSessionSwitcherOpen={setSessionSwitcherOpen}
        openNewSessionDraft={openNewSessionDraftFromTree}
        openProjectEditDialog={setEditingProjectDialogId}
        removeProject={removeProject}
        projectHeaderSentinelRefs={projectHeaderSentinelRefs}
        reorderProjects={reorderProjects}
        projectSortOrder={projectSortOrder}
        getOrderedGroups={getOrderedGroups}
        setGroupOrderByProject={setGroupOrderByProject}
        renderProjectStatusIndicator={renderProjectStatusIndicator}
        openSidebarMenuKey={openSidebarMenuKey}
        setOpenSidebarMenuKey={setOpenSidebarMenuKey}
        isInlineEditing={isInlineEditing}
      /> : null}

      {selectionModeEnabled && hasSelection ? (
        <BulkActionBar
          selectedCount={selectedIdsSize}
          scopeKey={derivedSelectionScope}
          scopeFolders={bulkScopeFolders}
          archivedBucket={bulkScopeIsArchived}
          onMoveToFolder={handleBulkMoveToFolder}
          onCreateFolderAndMove={handleBulkCreateFolderAndMove}
          onRemoveFromFolder={handleBulkRemoveFromFolder}
          canRemoveFromFolder={bulkCanRemoveFromFolder}
          onRestore={handleBulkRestore}
          onDelete={handleBulkDelete}
          onDone={handleExitSelectionMode}
        />
      ) : null}

      <SidebarFooter
        onOpenSettings={handleOpenSettings}
        onOpenShortcuts={toggleHelpDialog}
        onOpenAbout={() => {
          setSettingsPage('about');
          setSettingsDialogOpen(true);
        }}
        onOpenUpdate={handleOpenUpdateDialog}
        showRuntimeButtons
        showUpdateButton={showSidebarUpdateButton}
      />

      <UpdateDialog
        open={updateDialogOpen}
        onOpenChange={setUpdateDialogOpen}
        info={updateStore.info}
        downloading={updateStore.downloading}
        downloaded={updateStore.downloaded}
        progress={updateStore.progress}
        error={updateStore.error}
        onDownload={updateStore.downloadUpdate}
        onRestart={updateStore.restartToUpdate}
        runtimeType={updateStore.runtimeType}
      />

      <ProjectEditDialog
        open={Boolean(editingProject)}
        onOpenChange={(open) => {
          if (!open) {
            setEditingProjectDialogId(null);
          }
        }}
        project={editingProject}
        onSave={handleSaveProjectEdit}
      />



      <SessionDeleteConfirmDialog
        value={deleteSessionConfirm}
        setValue={setDeleteSessionConfirm}
        showDeletionDialog={showDeletionDialog}
        setShowDeletionDialog={setShowDeletionDialog}
        onConfirm={confirmDeleteSession}
      />

      <FolderDeleteConfirmDialog
        value={deleteFolderConfirm}
        setValue={setDeleteFolderConfirm}
        onConfirm={confirmDeleteFolder}
      />

      <BulkSessionDeleteConfirmDialog
        value={bulkDeleteConfirm}
        setValue={setBulkDeleteConfirm}
        showDeletionDialog={showDeletionDialog}
        setShowDeletionDialog={setShowDeletionDialog}
        onConfirm={confirmBulkDelete}
      />
    </div>
    </TooltipProvider>
  );
};

export const SessionSidebar = React.memo(SessionSidebarComponent);
