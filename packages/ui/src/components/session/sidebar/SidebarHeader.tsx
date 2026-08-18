import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Icon } from "@/components/icon/Icon";

type Props = {
  hideDirectoryControls: boolean;
  handleOpenDirectoryDialog: () => void;
  onOpenArchive: () => void;
  onOpenSettings?: () => void;
        onOpenInstances?: () => void;
        instanceLabel?: string | null;
        onOpenUpdate?: () => void;
  headerActionIconClass: string;
  headerActionButtonClass: string;
  isSessionSearchOpen: boolean;
  setIsSessionSearchOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  sessionSearchInputRef: React.RefObject<HTMLInputElement | null>;
  sessionSearchQuery: string;
  setSessionSearchQuery: (value: string) => void;
  hasSessionSearchQuery: boolean;
  searchMatchCount: number;
  selectionModeEnabled: boolean;
  onToggleSelectionMode: () => void;
  /** Dedicated mobile: occupy the same header band as the chat and workspace drawers. */
  mobileVariant?: boolean;
};

export function SidebarHeader(props: Props): React.ReactNode {
  const {
    hideDirectoryControls,
    handleOpenDirectoryDialog,
    onOpenArchive,
    onOpenSettings,
    onOpenInstances,
    instanceLabel,
    onOpenUpdate,
    headerActionIconClass,
    headerActionButtonClass,
    isSessionSearchOpen,
    setIsSessionSearchOpen,
    sessionSearchInputRef,
    sessionSearchQuery,
    setSessionSearchQuery,
    hasSessionSearchQuery,
    searchMatchCount,
    selectionModeEnabled,
    onToggleSelectionMode,
    mobileVariant = false,
  } = props;

  if (hideDirectoryControls) {
    return null;
  }

  const actionClassName = cn(
    headerActionButtonClass,
    'text-muted-foreground hover:text-foreground',
    !mobileVariant && 'hover:bg-transparent',
  );

  return (
    <div className={cn('select-none flex-shrink-0', mobileVariant ? 'px-2' : 'px-3 py-1')}>
      <div className={cn('flex flex-col', mobileVariant ? 'gap-0' : 'h-auto min-h-8 gap-1')}>
        <div
          className={cn(
            'flex items-center justify-between',
            mobileVariant ? 'h-[var(--oc-header-height,56px)] gap-1' : 'min-h-8 gap-2',
          )}
        >
          <div className={cn('flex min-w-0 items-center', mobileVariant ? 'gap-0.5 overflow-x-auto' : 'gap-1.5')}>
            {onOpenSettings ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className={actionClassName}
                    aria-label={"Settings"}
                  >
                    <Icon name="settings-3" className={headerActionIconClass} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}><p>{"Settings"}</p></TooltipContent>
              </Tooltip>
            ) : null}

            {onOpenInstances ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onOpenInstances}
                    className={actionClassName}
                    aria-label={instanceLabel ? `Instances: ${instanceLabel}` : "Instances"}
                  >
                    <Icon name="server" className={headerActionIconClass} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}>
                  <p>{instanceLabel || "Instances"}</p>
                </TooltipContent>
              </Tooltip>
            ) : null}

            {onOpenUpdate ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onOpenUpdate}
                    className={actionClassName}
                    aria-label={"Update"}
                  >
                    <Icon name="download" className={headerActionIconClass} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}><p>{"Update"}</p></TooltipContent>
              </Tooltip>
            ) : null}

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleOpenDirectoryDialog}
                  className={actionClassName}
                  aria-label={"Add project"}
                >
                  <Icon name="folder-add" className={headerActionIconClass} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>{"Add project"}</p></TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onOpenArchive}
                  className={actionClassName}
                  aria-label={"Archive"}
                >
                  <Icon name="archive" className={headerActionIconClass} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>{"Archive"}</p></TooltipContent>
            </Tooltip>
          </div>

          <div className={cn('flex shrink-0 items-center', mobileVariant ? 'gap-0.5' : 'gap-1.5')}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setIsSessionSearchOpen((prev) => !prev)}
                  className={actionClassName}
                  aria-label={"Search sessions"}
                  aria-expanded={isSessionSearchOpen}
                >
                  <Icon name="search" className={headerActionIconClass} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>{"Search sessions"}</p></TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onToggleSelectionMode}
                  className={cn(actionClassName, selectionModeEnabled && 'bg-interactive-hover text-primary')}
                  aria-label={selectionModeEnabled
                    ? "Exit selection"
                    : "Select sessions"}
                  aria-pressed={selectionModeEnabled}
                >
                  <Icon name="checkbox-multiple" className={headerActionIconClass} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                <p>{selectionModeEnabled
                  ? "Exit selection"
                  : "Select sessions"}</p>
              </TooltipContent>
            </Tooltip>

          </div>
        </div>

        {isSessionSearchOpen ? (
          <div className={cn(mobileVariant ? 'pb-2' : 'pb-1')}>
            <div className="mb-1 flex items-center justify-between px-0.5 typography-micro text-muted-foreground/80">
              {hasSessionSearchQuery ? (
                <span>{searchMatchCount === 1
                  ? `${searchMatchCount} match`
                  : `${searchMatchCount} matches`}</span>
              ) : <span />}
            </div>
            <div className="relative">
              <Icon name="search" className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={sessionSearchInputRef}
                value={sessionSearchQuery}
                onChange={(event) => setSessionSearchQuery(event.target.value)}
                placeholder={"Search sessions..."}
                className="h-8 w-full rounded-md border border-border bg-transparent pl-8 pr-8 typography-ui-label text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    if (hasSessionSearchQuery) {
                      setSessionSearchQuery('');
                    } else {
                      setIsSessionSearchOpen(false);
                    }
                  }
                }}
              />
              {sessionSearchQuery.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setSessionSearchQuery('')}
                  className="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  aria-label={"Clear search"}
                >
                  <Icon name="close" className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
