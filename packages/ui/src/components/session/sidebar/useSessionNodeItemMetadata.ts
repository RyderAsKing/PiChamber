import React from 'react';
import type { Session } from '@/lib/chat/types';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGitBranchLabel, useIsGitRepo } from '@/stores/useGitStore';
import { getGitHubPrStatusKey, usePrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { useViewportStore, viewportSessionKey } from '@/sync/viewport-store';
import { useGlobalSessionStatus, useSessionPermissions, useSessionQuestionCount } from '@/sync/sync-context';
import { useHasSessionActivityDuration } from '@/sync/session-activity-timing';
import { useSessionUnseenCount } from '@/sync/notification-store';
import { isSessionPinned } from '@/stores/useSessionPinnedStore';
import { formatDirectoryName } from '@/lib/utils';
import { formatProjectLabel, normalizePath } from './utils';
import { formatSessionCompactDateLabel } from './utils';
import { getForkBackgroundColor, getForkColor } from './forkColor';
import { selectQuestionBadgeSessionScopes } from './sessionNodeItemUtils';
import type { SessionNode } from './types';
import type { SecondaryMeta } from './sessionNodeTypes';

export function useSessionNodeItemMetadata({
  node,
  groupDirectory,
  projectId,
  secondaryMeta,
  pinnedSessionIds,
  expandedParents,
  expansionKey,
  hasSessionSearchQuery,
  notifyOnSubtasks,
}: {
  node: SessionNode;
  groupDirectory?: string | null;
  projectId?: string | null;
  secondaryMeta?: SecondaryMeta | null;
  pinnedSessionIds: Set<string>;
  expandedParents: Set<string>;
  expansionKey: string;
  hasSessionSearchQuery: boolean;
  notifyOnSubtasks: boolean;
}) {
  const session = node.session;
  const sessionDirectory =
    normalizePath((session as Session & { directory?: string | null }).directory ?? null) ??
    normalizePath(groupDirectory ?? null);
  const isActive = useSessionUIStore((state) => state.currentSessionId === session.id);

  const liveBranch = useGitBranchLabel(sessionDirectory);
  const isGitRepoStatus = useIsGitRepo(sessionDirectory);

  const projectLabelFromStore = useProjectsStore(
    React.useCallback(
      (state) => {
        if (secondaryMeta?.projectLabel || !projectId) return null;
        const project = state.projects.find((entry) => entry.id === projectId);
        if (!project) return null;
        return (
          project.label?.trim() ||
          formatDirectoryName(normalizePath(project.path) ?? project.path, null) ||
          project.path
        );
      },
      [projectId, secondaryMeta?.projectLabel],
    ),
  );
  const tooltipProjectLabel =
    secondaryMeta?.projectLabel ?? (projectLabelFromStore ? formatProjectLabel(projectLabelFromStore) : null);
  const worktree = node.worktree;
  const resolvedBranchLabel =
    secondaryMeta?.branchLabel ??
    worktree?.branch ??
    (liveBranch && liveBranch !== 'HEAD' ? liveBranch : null);
  const tooltipBranchLabel = resolvedBranchLabel;
  const isGitRepo = isGitRepoStatus === true || Boolean(resolvedBranchLabel || worktree);
  const subtaskCount = node.children.length;
  const agentName = (session as Session & { agent?: string }).agent;

  const prLookupKey = React.useMemo(() => {
    const branch = worktree?.branch?.trim() || resolvedBranchLabel?.trim();
    const directory = normalizePath(worktree?.path ?? sessionDirectory);
    return branch && directory ? getGitHubPrStatusKey() : null;
  }, [resolvedBranchLabel, sessionDirectory, worktree]);
  const prSummary = usePrVisualSummary(prLookupKey);
  const prIconColor = prSummary ? `var(--pr-${prSummary.visualState})` : undefined;
  const prStatusLabel = React.useMemo(() => {
    if (!prSummary) return null;
    switch (prSummary.visualState) {
      case 'merged':
        return 'Merged';
      case 'open':
        return prSummary.canMerge === true ||
          prSummary.mergeableState === 'clean' ||
          prSummary.checks?.state === 'success'
          ? 'Ready to merge'
          : 'PR open';
      case 'blocked':
        return prSummary.mergeableState === 'dirty' ? 'Merge conflicts' : 'Merge blocked';
      case 'draft':
        return 'Draft PR';
      case 'closed':
        return 'Closed';
      default:
        return null;
    }
  }, [prSummary]);

  const selectionScopeKey = projectId ?? sessionDirectory ?? null;
  const selectionModeEnabled = useSessionMultiSelectStore((state) => state.enabled);
  const isRowSelected = useSessionMultiSelectStore(
    React.useCallback((state) => state.selectedIds.has(session.id), [session.id]),
  );
  const toggleRowSelected = useSessionMultiSelectStore((state) => state.toggleSelected);
  const setRowRange = useSessionMultiSelectStore((state) => state.setRange);

  const isZombie = useViewportStore(
    React.useCallback(
      (state) => Boolean(state.sessionMemoryState.get(viewportSessionKey(session.id))?.isZombie),
      [session.id],
    ),
  );
  const sessionStatus = useGlobalSessionStatus(session.id);
  const statusType = sessionStatus?.type ?? 'idle';
  const isStreaming = statusType === 'busy' || statusType === 'retry';
  const hasActivityDuration = useHasSessionActivityDuration(session.id, isStreaming);
  const sessionPermissions = useSessionPermissions(session.id, sessionDirectory ?? undefined);
  const sessionTitle = session.title || 'Untitled Session';
  const hasChildren = node.children.length > 0;
  const isPinnedSession = isSessionPinned(pinnedSessionIds, sessionDirectory, session.id);
  const isExpanded = hasSessionSearchQuery ? true : expandedParents.has(expansionKey);

  const questionBadgeSessionScopes = React.useMemo(
    () => selectQuestionBadgeSessionScopes(node, isExpanded, sessionDirectory),
    [isExpanded, node, sessionDirectory],
  );
  const pendingQuestionCount = useSessionQuestionCount(questionBadgeSessionScopes);
  const isSubtaskSession = Boolean((session as Session & { parentID?: string | null }).parentID);
  const unseenCount = useSessionUnseenCount(session.id);
  const needsAttention = unseenCount > 0 && (!isSubtaskSession || notifyOnSubtasks);
  const sessionTimestamp = session.time?.updated || session.time?.created || Date.now();
  const sessionCompactUpdatedLabel = formatSessionCompactDateLabel(sessionTimestamp);

  const forkSolid = React.useMemo(() => getForkColor(node.forkColorId), [node.forkColorId]);
  const forkBackground = React.useMemo(
    () => getForkBackgroundColor(node.forkColorId, { active: isActive || isRowSelected }),
    [node.forkColorId, isActive, isRowSelected],
  );
  const globalBackground =
    secondaryMeta?.globalSession && !isActive && !isRowSelected ? 'var(--surface-elevated)' : null;
  const rowBackground = forkBackground ?? globalBackground;

  return {
    session,
    sessionDirectory,
    isActive,
    tooltipProjectLabel,
    tooltipBranchLabel,
    isGitRepo,
    subtaskCount,
    agentName,
    prSummary,
    prIconColor,
    prStatusLabel,
    selectionScopeKey,
    selectionModeEnabled,
    isRowSelected,
    toggleRowSelected,
    setRowRange,
    isZombie,
    isStreaming,
    hasActivityDuration,
    sessionPermissions,
    sessionTitle,
    hasChildren,
    isPinnedSession,
    isExpanded,
    pendingQuestionCount,
    needsAttention,
    sessionCompactUpdatedLabel,
    forkSolid,
    rowBackground,
  };
}
