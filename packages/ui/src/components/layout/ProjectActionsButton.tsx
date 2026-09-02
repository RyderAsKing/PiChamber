import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import type { ProjectRef } from '@/lib/pichamberConfig';
import {
  PROJECT_ACTION_ICON_MAP,
  toProjectActionRunKey,
} from '@/lib/projectActions';
import { AUTO_DISCOVER_ACTION_ID } from './projectActionUrlHelpers';
import { useProjectActionsRunner } from './useProjectActionsRunner';

export interface ProjectActionsButtonProps {
  projectRef: ProjectRef | null;
  directory: string;
  className?: string;
  compact?: boolean;
  allowMobile?: boolean;
}

export const ProjectActionsButton = ({
  projectRef,
  directory,
  className,
  compact = false,
  allowMobile = false,
}: ProjectActionsButtonProps) => {
  const {
    shouldRender,
    isLoading,
    normalizedDirectory,
    resolvedSelected,
    displayActions,
    projectActionRuns,
    selectedRunPreviewUrl,
    handlePrimaryClick,
    handleSelectAction,
    openProjectActionsSettings,
    openContextPreview,
  } = useProjectActionsRunner({ projectRef, directory, allowMobile });

  if (!shouldRender || !resolvedSelected) {
    return null;
  }

  const selectedIconKey = (resolvedSelected.icon || 'play') as keyof typeof PROJECT_ACTION_ICON_MAP;
  const selectedIconName = resolvedSelected.id === AUTO_DISCOVER_ACTION_ID
    ? 'scan-2'
    : PROJECT_ACTION_ICON_MAP[selectedIconKey] || 'play';
  const selectedRunKey = toProjectActionRunKey(normalizedDirectory, resolvedSelected.id);
  const selectedRunning = projectActionRuns[selectedRunKey];
  const isStoppingSelected = selectedRunning?.status === 'stopping';
  const isWaitingForSelectedPreview = selectedRunning?.status === 'waiting-for-preview';
  const showSelectedPreviewButton = Boolean(selectedRunning && selectedRunPreviewUrl);
  const handleOpenSelectedPreview = () => {
    if (!selectedRunning || !selectedRunPreviewUrl) {
      return;
    }
    openContextPreview(selectedRunning.directory, selectedRunPreviewUrl);
  };
  const isAutoDiscoverSelected = resolvedSelected.id === AUTO_DISCOVER_ACTION_ID;

  if (compact) {
    return (
      <div className="inline-flex items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={isLoading || isStoppingSelected}
              className={cn(
                'app-region-no-drag inline-flex h-9 w-9 items-center justify-center rounded-[10px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] p-2',
                'typography-ui-label font-medium text-muted-foreground hover:bg-interactive-hover hover:text-foreground transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                'disabled:cursor-not-allowed',
                className
              )}
              onClick={handlePrimaryClick}
              aria-label={selectedRunning
                ? `Stop ${resolvedSelected.name}`
                : `Run ${resolvedSelected.name}`}
            >
              {isStoppingSelected || isWaitingForSelectedPreview
                ? <Icon name="loader-4" className="h-5 w-5 animate-spin text-[var(--status-warning)]" />
                : selectedRunning
                  ? <Icon name="stop" className="h-5 w-5 text-[var(--status-warning)]" />
                  : <Icon name={selectedIconName} className="h-5 w-5" />}
            </button>
          </TooltipTrigger>
          {isAutoDiscoverSelected ? (
            <TooltipContent sideOffset={6}>{"Automatically discover and run the development server"}</TooltipContent>
          ) : null}
        </Tooltip>
        {showSelectedPreviewButton ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="app-region-no-drag -ml-1 inline-flex h-9 w-7 items-center justify-center rounded-[10px] text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                aria-label={"Open Preview"}
                onClick={handleOpenSelectedPreview}
              >
                <Icon name="global" className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{"Open Preview"}</TooltipContent>
          </Tooltip>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="app-region-no-drag -ml-1 inline-flex h-9 w-5 items-center justify-center rounded-[10px] text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label={"Choose project action"}
            >
              <Icon name="arrow-down-s" className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52 max-h-[70vh] overflow-y-auto">
            <DropdownMenuItem className="flex items-center gap-2" onClick={openProjectActionsSettings}>
              <Icon name="add" className="h-4 w-4" />
              <span className="typography-ui-label text-foreground">{"Add new action"}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {displayActions.map((entry) => {
              const iconKey = (entry.icon || 'play') as keyof typeof PROJECT_ACTION_ICON_MAP;
              const iconName = entry.id === AUTO_DISCOVER_ACTION_ID
                ? 'scan-2'
                : PROJECT_ACTION_ICON_MAP[iconKey] || 'play';
              const runKey = toProjectActionRunKey(normalizedDirectory, entry.id);
              const runState = projectActionRuns[runKey];
              const isRunning = Boolean(runState);
              const isStopping = runState?.status === 'stopping';

              return (
                <DropdownMenuItem
                  key={entry.id}
                  className="flex items-center gap-2"
                  onClick={() => {
                    handleSelectAction(entry, true);
                  }}
                >
                  <Icon name={iconName} className="h-4 w-4" />
                  <span className="typography-ui-label text-foreground truncate">{entry.name}</span>
                  {isStopping || runState?.status === 'waiting-for-preview'
                    ? <Icon name="loader-4" className="ml-auto h-4 w-4 animate-spin text-[var(--status-warning)]" />
                    : isRunning
                      ? <Icon name="stop" className="ml-auto h-4 w-4 text-[var(--status-warning)]" />
                      : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'app-region-no-drag inline-flex shrink-0 items-center self-center rounded-[9px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px]',
        'bg-[var(--surface-elevated)] overflow-hidden',
        'border border-border/60',
        compact ? 'h-9' : 'h-7',
        className
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handlePrimaryClick}
            disabled={isLoading || isStoppingSelected}
            className={cn(
              'inline-flex h-full items-center justify-center typography-ui-label font-medium text-foreground hover:bg-interactive-hover',
              compact ? 'w-9 px-0' : 'px-2.5',
              'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed'
            )}
            aria-label={selectedRunning
              ? `Stop ${resolvedSelected.name}`
              : `Run ${resolvedSelected.name}`}
          >
            <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
              {isStoppingSelected || isWaitingForSelectedPreview
                ? <Icon name="loader-4" className="h-4 w-4 animate-spin text-[var(--status-warning)]" />
                : selectedRunning
                  ? <Icon name="stop" className="h-4 w-4 text-[var(--status-warning)]" />
                  : <Icon name={selectedIconName} className="h-4 w-4" />}
            </span>
          </button>
        </TooltipTrigger>
        {isAutoDiscoverSelected ? (
          <TooltipContent sideOffset={6}>{"Automatically discover and run the development server"}</TooltipContent>
        ) : null}
      </Tooltip>

      {showSelectedPreviewButton ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleOpenSelectedPreview}
              className={cn(
                compact ? 'inline-flex h-full w-8 items-center justify-center' : 'inline-flex h-full w-7 items-center justify-center',
                'border-l border-[var(--interactive-border)] text-foreground',
                'hover:bg-interactive-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
              )}
              aria-label={"Open Preview"}
            >
              <Icon name="global" className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>{"Open Preview"}</TooltipContent>
        </Tooltip>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              compact ? 'inline-flex h-full w-8 items-center justify-center' : 'inline-flex h-full w-7 items-center justify-center',
              'border-l border-[var(--interactive-border)] text-muted-foreground',
              'hover:bg-interactive-hover hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
            )}
            aria-label={"Choose project action"}
          >
            <Icon name="arrow-down-s" className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52 max-h-[70vh] overflow-y-auto">
          <DropdownMenuItem className="flex items-center gap-2" onClick={openProjectActionsSettings}>
            <Icon name="add" className="h-4 w-4" />
            <span className="typography-ui-label text-foreground">{"Add new action"}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {displayActions.map((entry) => {
            const iconKey = (entry.icon || 'play') as keyof typeof PROJECT_ACTION_ICON_MAP;
            const iconName = entry.id === AUTO_DISCOVER_ACTION_ID
              ? 'scan-2'
              : PROJECT_ACTION_ICON_MAP[iconKey] || 'play';
            const runKey = toProjectActionRunKey(normalizedDirectory, entry.id);
            const runState = projectActionRuns[runKey];
            const isRunning = Boolean(runState);
            const isStopping = runState?.status === 'stopping';

            return (
              <DropdownMenuItem
                key={entry.id}
                className="flex items-center gap-2"
                onClick={() => {
                  handleSelectAction(entry, true);
                }}
              >
                <Icon name={iconName} className="h-4 w-4" />
                <span className="typography-ui-label text-foreground truncate">{entry.name}</span>
                {isStopping || runState?.status === 'waiting-for-preview'
                  ? <Icon name="loader-4" className="ml-auto h-4 w-4 animate-spin text-[var(--status-warning)]" />
                  : isRunning
                    ? <Icon name="stop" className="ml-auto h-4 w-4 text-[var(--status-warning)]" />
                    : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
