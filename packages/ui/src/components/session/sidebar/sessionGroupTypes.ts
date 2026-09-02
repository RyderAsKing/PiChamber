import React from 'react';
import type { MainTab } from '@/stores/useUIStore';
import type { SortableDragHandleProps } from './sortableItems';
import type { GroupSearchData, SessionGroup, SessionNode } from './types';
import type { SessionNodeRenderExtras } from './sessionNodeItemUtils';

export type DeleteFolderConfirm = {
  scopeKey: string;
  folderId: string;
  folderName: string;
  subFolderCount: number;
  sessionCount: number;
} | null;

export type SessionGroupSectionProps = {
  group: SessionGroup;
  groupKey: string;
  projectId?: string | null;
  hideGroupLabel?: boolean;
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  groupSearchDataByGroup: WeakMap<SessionGroup, GroupSearchData>;
  visibleSessionCount?: number;
  collapsedGroups: Set<string>;
  hideDirectoryControls: boolean;
  collapsedFolderIds: Set<string>;
  toggleFolderCollapse: (folderId: string) => void;
  renameFolder: (scopeKey: string, folderId: string, name: string) => void;
  deleteFolder: (scopeKey: string, folderId: string) => void;
  showDeletionDialog: boolean;
  setDeleteFolderConfirm: React.Dispatch<React.SetStateAction<DeleteFolderConfirm>>;
  renderSessionNode: (
    node: SessionNode,
    depth?: number,
    groupDirectory?: string | null,
    projectId?: string | null,
    archivedBucket?: boolean,
    secondaryMeta?: { projectLabel?: string | null; branchLabel?: string | null } | null,
    renderContext?: 'project' | 'recent',
    renderExtras?: SessionNodeRenderExtras,
  ) => React.ReactNode;
  showMoreGroupSessions: (groupKey: string, currentVisibleCount: number) => void;
  resetGroupSessionLimit: (groupKey: string) => void;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  activeProjectId: string | null;
  setActiveProjectIdOnly: (id: string) => void;
  setActiveMainTab: (tab: MainTab) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null; targetFolderId?: string }) => void;
  addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string) => void;
  createFolderAndStartRename: (scopeKey: string, parentId?: string | null) => { id: string } | null;
  renamingFolderId: string | null;
  renameFolderDraft: string;
  setRenameFolderDraft: React.Dispatch<React.SetStateAction<string>>;
  setRenamingFolderId: React.Dispatch<React.SetStateAction<string | null>>;
  pinnedSessionIds: Set<string>;
  expandedParents: Set<string>;
  sessionOrderIndex: Map<string, number>;
  editingId: string | null;
  editTitle: string;
  openSidebarMenuKey: string | null;
  activeActivitySessionIds: Set<string>;
  unreadActivitySessionIds: Set<string>;
  notifyOnSubtasks: boolean;
  onToggleCollapsedGroup: (groupKey: string) => void;
  dragHandleProps?: SortableDragHandleProps | null;
  compactBodyPadding?: boolean;
  scrollContainerRef?: React.RefObject<HTMLElement | null>;
};
