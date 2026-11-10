/* eslint-disable */
import React from 'react';
import type { Session } from '@/lib/chat/types';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import type { MainTab } from '@/stores/useUIStore';
import { useUIStore } from '@/stores/useUIStore';
import { streamPerfMark } from '@/stores/utils/streamDebug';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { archiveSessionsWithUndo } from '../sessionArchive';
import { getSessionDisplayTitle } from '@/lib/chat/sessionTitle';

type DeleteSessionConfirmSetter = React.Dispatch<React.SetStateAction<{
  session: Session;
  descendantCount: number;
  descendantIds: string[];
} | null>>;

type SessionSelectOptions = {
  /** Load the session without notifying mobile hosts to close the sessions drawer. */
  keepPanelOpen?: boolean;
};

type DeleteSessionSource = {
  archivedBucket?: boolean;
  hardDelete?: boolean;
  /** Bypass the delete confirmation dialog. Archive never asks. */
  skipConfirm?: boolean;
};

type Args = {
  mobileVariant: boolean;
  allowReselect: boolean;
  onSessionSelected?: (sessionId: string) => void;
  isSessionSearchOpen: boolean;
  sessionSearchQuery: string;
  setSessionSearchQuery: (value: string) => void;
  setIsSessionSearchOpen: (open: boolean) => void;
  setActiveMainTab: (tab: MainTab) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  setCurrentSession: (sessionId: string | null, directoryHint?: string | null) => void;
  updateSessionTitle: (id: string, title: string) => Promise<void>;
  shareSession: (id: string) => Promise<Session | null>;
  unshareSession: (id: string) => Promise<Session | null>;
  deleteSession: (id: string) => Promise<boolean>;
  deleteSessions: (ids: string[]) => Promise<{ deletedIds: string[]; failedIds: string[] }>;
  unarchiveSession: (id: string) => Promise<boolean>;
  childrenMap: Map<string, Session[]>;
  showDeletionDialog: boolean;
  setDeleteSessionConfirm: DeleteSessionConfirmSetter;
  deleteSessionConfirm: { session: Session; descendantCount: number; descendantIds: string[] } | null;
  setEditingId: (id: string | null) => void;
  setEditTitle: (value: string) => void;
  editingId: string | null;
  editTitle: string;
};

export const useSessionActions = (args: Args) => {
  const [copiedSessionId, setCopiedSessionId] = React.useState<string | null>(null);
  const copyTimeout = React.useRef<number | null>(null);

  React.useEffect(() => {
    return () => {
      if (copyTimeout.current) {
        clearTimeout(copyTimeout.current);
      }
    };
  }, []);

  const handleSessionSelect = React.useCallback(
    (sessionId: string, sessionDirectory?: string | null, options?: SessionSelectOptions) => {
      streamPerfMark('navigation.session_select');
      // Selecting a session always leaves any full-page surface, even when
      // the session is already the current one (no store transition fires).
      useUIStore.getState().closeMainSurfaces();
      const resetSessionSearch = () => {
        if (!args.isSessionSearchOpen && args.sessionSearchQuery.length === 0) {
          return;
        }
        args.setSessionSearchQuery('');
        args.setIsSessionSearchOpen(false);
      };
      const notifyHost = options?.keepPanelOpen !== true;

      if (args.mobileVariant) {
        args.setActiveMainTab('chat');
        args.setSessionSwitcherOpen(false);
      }

      if (sessionId === useSessionUIStore.getState().currentSessionId) {
        if (args.allowReselect && notifyHost) {
          args.onSessionSelected?.(sessionId);
        }
        resetSessionSearch();
        return;
      }
      streamPerfMark('navigation.session_state_set');
      args.setCurrentSession(sessionId, sessionDirectory ?? null);
      if (notifyHost) {
        args.onSessionSelected?.(sessionId);
      }
      resetSessionSearch();
    },
    [args],
  );

  const handleSessionDoubleClick = React.useCallback((sessionId: string, sessionTitle: string) => {
    args.setEditingId(sessionId);
    args.setEditTitle(sessionTitle);
  }, [args]);

  const handleSaveEdit = React.useCallback(async (titleOverride?: string) => {
    if (!args.editingId) return;
    const trimmed = (titleOverride ?? args.editTitle).trim();
    if (trimmed) {
      await args.updateSessionTitle(args.editingId, trimmed);
    }
    args.setEditingId(null);
    args.setEditTitle('');
  }, [args]);

  const handleCancelEdit = React.useCallback(() => {
    args.setEditingId(null);
    args.setEditTitle('');
  }, [args]);

  const copyShareUrl = React.useCallback(async (url: string, sessionId: string): Promise<boolean> => {
    try {
      const result = await copyTextToClipboard(url);
      if (!result.ok) return false;
      setCopiedSessionId(sessionId);
      if (copyTimeout.current) clearTimeout(copyTimeout.current);
      copyTimeout.current = window.setTimeout(() => {
        setCopiedSessionId(null);
        copyTimeout.current = null;
      }, 2000);
      return true;
    } catch {
      return false;
    }
  }, []);

  const handleShareSession = React.useCallback(async (session: Session) => {
    const result = await args.shareSession(session.id);
    if (!(result as any)?.share?.url) {
      toast.error("Unable to share session");
      return;
    }
    const copied = await copyShareUrl((result as any).share.url, session.id);
    toast[copied ? 'success' : 'warning']("Session shared", {
      description: (copied ? "Share link copied to clipboard." : "Failed to copy URL"),
    });
  }, [args, copyShareUrl]);

  const handleCopyShareUrl = React.useCallback((url: string, sessionId: string) => {
    void copyShareUrl(url, sessionId).then((copied) => {
      if (!copied) toast.error("Failed to copy URL");
    });
  }, [copyShareUrl]);

  const handleCopySessionId = React.useCallback((sessionId: string) => {
    void copyTextToClipboard(sessionId)
      .then((result) => {
        if (result.ok) {
          toast.success("Session ID copied");
          return;
        }
        toast.error("Failed to copy session ID");
      })
      .catch(() => toast.error("Failed to copy session ID"));
  }, []);

  const handleUnshareSession = React.useCallback(async (sessionId: string) => {
    const result = await args.unshareSession(sessionId);
    if (result) {
      toast.success("Session unshared");
    } else {
      toast.error("Unable to unshare session");
    }
  }, [args]);

  const collectDescendants = React.useCallback((sessionId: string): Session[] => {
    const collected: Session[] = [];
    const visit = (id: string) => {
      const children = args.childrenMap.get(id) ?? [];
      children.forEach((child) => {
        collected.push(child);
        visit(child.id);
      });
    };
    visit(sessionId);
    return collected;
  }, [args.childrenMap]);

  // Archive cascades to forks that aren't already archived; hard-delete
  // cascades to every descendant unconditionally. We collect once and filter
  // per-action so the dialog count and the executed ID list always agree.
  const filterDescendantsForAction = React.useCallback(
    (descendants: Session[], shouldHardDelete: boolean): Session[] => {
      if (shouldHardDelete) return descendants;
      return descendants.filter((s) => !s.time?.archived);
    },
    [],
  );

  // Delete only: archive goes through `archiveSessionsWithUndo` and never
  // reaches the confirmation dialog.
  const executeDeleteSession = React.useCallback(
    async (session: Session, precomputed?: { descendantIds: string[] }) => {
      // Use the snapshot taken when the dialog opened (if any) so the
      // executed list matches what the user was told.
      const descendantIds = precomputed?.descendantIds
        ?? filterDescendantsForAction(collectDescendants(session.id), true).map((s) => s.id);
      if (descendantIds.length === 0) {
        const success = await args.deleteSession(session.id);
        if (success) toast.success("Session deleted");
        else toast.error("Failed to delete session");
        return;
      }

      // Delete root + all descendants individually. If the server
      // cascade-deletes some children before we get to them, 404 is
      // treated as success by deleteSession and no rollback occurs.
      const { deletedIds, failedIds } = await args.deleteSessions([session.id, ...descendantIds]);
      if (failedIds.length === 0) {
        const totalDeleted = deletedIds.length;
        toast.success(totalDeleted === 1
          ? `Deleted ${totalDeleted} session`
          : `Deleted ${totalDeleted} sessions`);
      } else {
        toast.error("Failed to delete session");
      }
    },
    [args, collectDescendants, filterDescendantsForAction],
  );

  const handleDeleteSession = React.useCallback(
    (session: Session, source?: DeleteSessionSource) => {
      const shouldHardDelete = source?.archivedBucket === true || source?.hardDelete === true;
      const effectiveDescendantIds = filterDescendantsForAction(
        collectDescendants(session.id),
        shouldHardDelete,
      ).map((s) => s.id);
      // Archive needs no confirmation: it happens at once and its toast has
      // Undo. Delete keeps the dialog.
      if (!shouldHardDelete) {
        void archiveSessionsWithUndo(
          [{ sessionId: session.id, directory: session.directory ?? null, forkIds: effectiveDescendantIds }],
          { title: getSessionDisplayTitle(session, 'Untitled session') },
        );
        return;
      }
      if (!args.showDeletionDialog || source?.skipConfirm === true) {
        void executeDeleteSession(session, { descendantIds: effectiveDescendantIds });
        return;
      }
      args.setDeleteSessionConfirm({
        session,
        descendantCount: effectiveDescendantIds.length,
        descendantIds: effectiveDescendantIds,
      });
    },
    [args, collectDescendants, executeDeleteSession, filterDescendantsForAction],
  );

  const confirmDeleteSession = React.useCallback(async () => {
    if (!args.deleteSessionConfirm) return;
    const { session, descendantIds } = args.deleteSessionConfirm;
    args.setDeleteSessionConfirm(null);
    await executeDeleteSession(session, { descendantIds });
  }, [args, executeDeleteSession]);

  const handleRestoreSession = React.useCallback(
    async (session: Session) => {
      const success = await args.unarchiveSession(session.id);
      if (success) {
        toast.success("Session unarchived");
      } else {
        toast.error("Could not unarchive the session");
      }
    },
    [args],
  );

  return {
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
  };
};
