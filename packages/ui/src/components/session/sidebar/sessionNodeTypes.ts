import React from 'react';
import type { Session } from '@/lib/chat/types';
import type { SessionPinnedTarget } from '@/stores/useSessionPinnedStore';
import type { SessionNodeChildRenderExtras, SessionNodeRenderExtras } from './sessionNodeItemUtils';
import type { SessionNode } from './types';

export type Folder = { id: string; name: string; sessionIds: string[] };

export type SecondaryMeta = {
  projectLabel?: string | null;
  branchLabel?: string | null;
  showFolderLabel?: boolean;
  globalSession?: boolean;
};

export type SessionNodeItemProps = {
  node: SessionNode;
  depth?: number;
  groupDirectory?: string | null;
  projectId?: string | null;
  archivedBucket?: boolean;
  pinnedSessionIds: Set<string>;
  expandedParents: Set<string>;
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  notifyOnSubtasks: boolean;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  editTitle: string;
  setEditTitle: (value: string) => void;
  handleSaveEdit: (titleOverride?: string) => void;
  handleCancelEdit: () => void;
  toggleParent: (expansionKey: string) => void;
  handleSessionSelect: (sessionId: string, sessionDirectory: string | null) => void;
  handleSessionDoubleClick: (sessionId: string, sessionTitle: string) => void;
  togglePinnedSession: (target: SessionPinnedTarget) => void;
  handleShareSession: (session: Session) => void;
  copiedSessionId: string | null;
  handleCopyShareUrl: (url: string, sessionId: string) => void;
  handleCopySessionId: (sessionId: string) => void;
  handleUnshareSession: (sessionId: string) => void;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  renamingFolderId: string | null;
  getFoldersForScope: (scopeKey: string) => Folder[];
  getSessionFolderId: (scopeKey: string, sessionId: string) => string | null;
  removeSessionFromFolder: (scopeKey: string, sessionId: string) => void;
  addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string) => void;
  createFolderAndStartRename: (scopeKey: string, parentId?: string | null) => { id: string } | null;
  handleDeleteSession: (session: Session, source?: { archivedBucket?: boolean; hardDelete?: boolean; skipConfirm?: boolean }) => void;
  handleRestoreSession: (session: Session) => void;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  allowQuickArchiveAction: boolean;
  renderSessionNode: (
    node: SessionNode,
    depth?: number,
    groupDirectory?: string | null,
    projectId?: string | null,
    archivedBucket?: boolean,
    secondaryMeta?: SecondaryMeta | null,
    renderContext?: 'project' | 'recent',
    renderExtras?: SessionNodeRenderExtras,
  ) => React.ReactNode;
  secondaryMeta?: SecondaryMeta | null;
  renderContext?: 'project' | 'recent';
  subtreeContainsEditing: Set<string>;
  menuOpenSessionId: string | null;
  nodeStructureKey: string;
  childRenderExtrasFor?: (child: SessionNode) => SessionNodeChildRenderExtras;
};
