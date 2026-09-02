import React from 'react';

import { DesktopHostSwitcherDialog } from '@/components/desktop/DesktopHostSwitcher';
import { Icon } from '@/components/icon/Icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { UpdateInfo } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import { DESKTOP_HEADER_ICON_BUTTON_CLASS } from './HeaderIconActionButton';

export type DesktopServicesMenuProps = {
  isDesktopApp: boolean;
  currentInstanceLabel: string;
  compactCurrentInstanceLabel: string;
  currentInstanceIsLocal: boolean;
  isDesktopServicesOpen: boolean;
  setIsDesktopServicesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  refreshCurrentInstanceLabel: () => Promise<void>;
  shortcutLabel: (actionId: string) => string;
  remoteUpdateInfo: UpdateInfo | null;
  remoteUpdateChecking: boolean;
  remoteUpdateError: string | null;
  onOpenRemoteUpdate: () => void;
};

export const DesktopServicesMenu = React.memo(function DesktopServicesMenu({
  isDesktopApp,
  currentInstanceLabel,
  compactCurrentInstanceLabel,
  currentInstanceIsLocal,
  isDesktopServicesOpen,
  setIsDesktopServicesOpen,
  refreshCurrentInstanceLabel,
  shortcutLabel,
  remoteUpdateInfo,
  remoteUpdateChecking,
  remoteUpdateError,
  onOpenRemoteUpdate,
}: DesktopServicesMenuProps) {
  return (
    <DropdownMenu
      open={isDesktopServicesOpen}
      onOpenChange={(open) => {
        setIsDesktopServicesOpen(open);
        if (open) {
          void refreshCurrentInstanceLabel();
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={
                isDesktopApp
                  ? `Open instance, usage and MCP (current: ${currentInstanceLabel})`
                  : 'Open services, usage and MCP'
              }
              className={cn(
                DESKTOP_HEADER_ICON_BUTTON_CLASS,
                isDesktopApp ? 'w-auto max-w-[14rem] justify-start gap-1.5 px-2.5' : 'h-8 w-8'
              )}
            >
              <Icon name="server" className="h-[18px] w-[18px]" />
              {isDesktopApp ? (
                <span className="truncate typography-ui-label font-medium text-foreground">
                  {compactCurrentInstanceLabel}
                </span>
              ) : null}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>
            {`Current instance: ${currentInstanceLabel} (${shortcutLabel('toggle_services_menu')})`}
          </p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className="w-[min(27rem,calc(100vw-2rem))] max-h-[75vh] overflow-y-auto p-0"
      >
        {isDesktopApp ? (
          <div>
            {!currentInstanceIsLocal ? (
              <div className="border-b border-[var(--interactive-border)] px-4 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="typography-ui-label font-medium text-foreground">
                      {'Remote instance update'}
                    </div>
                    <div className="typography-micro text-muted-foreground">
                      {remoteUpdateInfo?.available
                        ? `Version ${remoteUpdateInfo.version || ''} is available for this instance.`
                        : remoteUpdateChecking
                          ? 'Looking for updates...'
                          : remoteUpdateError || 'This instance is up to date.'}
                    </div>
                  </div>
                  {remoteUpdateInfo?.available ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-md bg-[var(--primary-base)] px-3 py-1.5 typography-ui-label font-medium text-[var(--primary-foreground)] hover:opacity-90"
                      onClick={onOpenRemoteUpdate}
                    >
                      {'Update'}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <DesktopHostSwitcherDialog
              embedded
              open={isDesktopServicesOpen}
              onOpenChange={() => {}}
              onHostSwitched={() => setIsDesktopServicesOpen(false)}
            />
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
