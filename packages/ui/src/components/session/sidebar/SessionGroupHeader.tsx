import React from 'react';
import type { Session } from '@/lib/chat/types';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { sessionEvents } from '@/lib/sessionEvents';
import type { SortableDragHandleProps } from './sortableItems';
import type { SessionGroup } from './types';
import { renderHighlightedText } from './highlightedText';
import type { MainTab } from '@/stores/useUIStore';

export interface SessionGroupHeaderProps {
  group: SessionGroup;
  groupKey: string;
  isCollapsed: boolean;
  onToggleCollapsedGroup: (groupKey: string) => void;
  normalizedSessionSearchQuery: string;
  alwaysShowActions: boolean;
  groupHeaderRightPadding: string;
  dragHandleProps?: SortableDragHandleProps | null;
  groupPrColor?: string;
  groupPrSummary?: { visualState: string; number: number } | null;
  groupActivityIndicator?: React.ReactNode;
  showBranchSubtitle?: boolean;
  statusLine?: { label: string; color: string | null } | null;
  allGroupSessions: Session[];
  projectId?: string | null;
  activeProjectId: string | null;
  setActiveProjectIdOnly: (id: string) => void;
  setActiveMainTab: (tab: MainTab) => void;
  mobileVariant: boolean;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: {
    selectedProjectId?: string | null;
    directoryOverride?: string | null;
    targetFolderId?: string;
  }) => void;
}

export function SessionGroupHeader({
  group,
  groupKey,
  isCollapsed,
  onToggleCollapsedGroup,
  normalizedSessionSearchQuery,
  alwaysShowActions,
  groupHeaderRightPadding,
  dragHandleProps,
  groupPrColor,
  groupPrSummary,
  groupActivityIndicator,
  showBranchSubtitle,
  statusLine,
  allGroupSessions,
  projectId,
  activeProjectId,
  setActiveProjectIdOnly,
  setActiveMainTab,
  mobileVariant,
  setSessionSwitcherOpen,
  openNewSessionDraft,
}: SessionGroupHeaderProps) {
  return (
    <div
      className={cn(
        'group/gh relative flex items-start justify-between gap-1 py-1 px-3 min-w-0 rounded-md',
        'cursor-pointer'
      )}
      onClick={() => onToggleCollapsedGroup(groupKey)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggleCollapsedGroup(groupKey);
        }
      }}
      aria-label={isCollapsed ? `Expand ${group.label}` : `Collapse ${group.label}`}
      aria-expanded={!isCollapsed}
    >
      <div
        ref={dragHandleProps?.setActivatorNodeRef}
        className={cn(
          'min-w-0 flex flex-1 items-start gap-1 overflow-hidden transition-[padding]',
          groupHeaderRightPadding
        )}
        {...(dragHandleProps?.listeners ?? {})}
      >
        <div className="min-w-0 flex flex-1 flex-col justify-center gap-0.5 overflow-hidden">
          <p className="typography-ui-label font-normal truncate text-foreground/92">
            {group.isArchivedBucket ? (
              <span className="inline-flex min-w-0 max-w-full items-center gap-1">
                <span className="inline-flex size-4 shrink-0 items-center justify-center">
                  <Icon
                    name="archive"
                    className={cn(
                      'size-4 shrink-0 text-muted-foreground',
                      alwaysShowActions ? 'hidden' : 'group-hover/gh:hidden'
                    )}
                  />
                  <span
                    className={cn(
                      'text-muted-foreground size-4 items-center justify-center',
                      alwaysShowActions ? 'inline-flex' : 'hidden group-hover/gh:inline-flex'
                    )}
                  >
                    {isCollapsed ? (
                      <Icon name="arrow-right-s" className="size-4" />
                    ) : (
                      <Icon name="arrow-down-s" className="size-4" />
                    )}
                  </span>
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {renderHighlightedText(group.label, normalizedSessionSearchQuery)}
                </span>
                {groupActivityIndicator}
              </span>
            ) : !group.isMain || group.worktree ? (
              // Worktree sub-header in the flat visual language: slim
              // folder-style row with a PR-tinted branch icon and PR badge.
              <span className="flex w-full min-w-0 items-center gap-1.5">
                <span className="inline-flex size-4 shrink-0 items-center justify-center">
                  <Icon
                    name="git-branch"
                    className={cn(
                      'size-4 shrink-0',
                      !groupPrColor && 'text-muted-foreground',
                      alwaysShowActions ? 'hidden' : 'group-hover/gh:hidden'
                    )}
                    style={groupPrColor ? { color: groupPrColor } : undefined}
                  />
                  <span
                    className={cn(
                      'text-muted-foreground size-4 items-center justify-center',
                      alwaysShowActions ? 'inline-flex' : 'hidden group-hover/gh:inline-flex'
                    )}
                  >
                    {isCollapsed ? (
                      <Icon name="arrow-right-s" className="size-4" />
                    ) : (
                      <Icon name="arrow-down-s" className="size-4" />
                    )}
                  </span>
                </span>
                <span className="min-w-0 truncate typography-ui-label font-normal text-muted-foreground">
                  {renderHighlightedText(group.label, normalizedSessionSearchQuery)}
                </span>
                {groupActivityIndicator}
                {groupPrSummary ? (
                  <span
                    className="ml-auto flex-shrink-0 text-[0.72rem] font-medium leading-none"
                    style={groupPrColor ? { color: groupPrColor } : undefined}
                  >
                    #{groupPrSummary.number}
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="inline-flex min-w-0 max-w-full items-center gap-1">
                <span className="min-w-0 truncate">
                  {renderHighlightedText(group.label, normalizedSessionSearchQuery)}
                </span>
                {groupActivityIndicator}
              </span>
            )}
          </p>
          {showBranchSubtitle && statusLine ? (
            <span className="inline-flex min-w-0 items-center gap-1.5 leading-tight">
              {group.isArchivedBucket ? (
                <Icon name="archive" className="size-4 flex-shrink-0 text-muted-foreground" />
              ) : (
                <Icon name="git-branch" className="size-4 flex-shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground/80">
                {statusLine.label}
              </span>
            </span>
          ) : null}
        </div>
      </div>
      {group.isArchivedBucket && allGroupSessions.length > 0 ? (
        <div
          className={cn(
            'absolute right-0.5 top-1/2 -translate-y-1/2 z-10 transition-opacity',
            alwaysShowActions
              ? 'opacity-100'
              : 'opacity-0 group-hover/gh:opacity-100 group-focus-within/gh:opacity-100'
          )}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  sessionEvents.requestDelete({
                    sessions: allGroupSessions,
                    mode: 'session',
                  });
                }}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                aria-label={`Delete archived sessions in ${group.label}`}
              >
                <Icon name="delete-bin" className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              <p>{'Delete archived sessions'}</p>
            </TooltipContent>
          </Tooltip>
        </div>
      ) : null}
      {group.directory ? (
        <div
          className={cn(
            'absolute right-0.5 top-1/2 -translate-y-1/2 z-10 transition-opacity',
            alwaysShowActions
              ? 'opacity-100'
              : 'opacity-0 group-hover/gh:opacity-100 group-focus-within/gh:opacity-100'
          )}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  if (projectId && projectId !== activeProjectId)
                    setActiveProjectIdOnly(projectId);
                  setActiveMainTab('chat');
                  if (mobileVariant) setSessionSwitcherOpen(false);
                  openNewSessionDraft({
                    selectedProjectId: projectId,
                    directoryOverride: group.directory,
                  });
                }}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                aria-label={`New draft session in ${group.label}`}
              >
                <Icon name="add" className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              <p>{'New draft session'}</p>
            </TooltipContent>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}
