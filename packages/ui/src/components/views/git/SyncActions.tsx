import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from "@/components/icon/Icon";
import type { GitRemote } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { useDeviceInfo } from '@/lib/device';

type SyncAction = 'fetch' | 'pull' | 'push' | 'sync' | null;

interface SyncActionsProps {
  syncAction: SyncAction;
  remotes: GitRemote[];
  onFetch: (remote: GitRemote) => void;
  onSync: (remote: GitRemote) => void;
  disabled: boolean;
  /** Render the ⋯ fetch menu; hosts with their own overflow menu fold fetch into it instead. */
  showFetchMenu?: boolean;
  /** Compact chrome for single-row headers: icon plus ahead/behind counts, no text label. */
  iconOnly?: boolean;
  aheadCount?: number;
  behindCount?: number;
  trackingRemoteName?: string;
  hasUncommittedChanges?: boolean;
  /** Non-tracking upstream target (e.g. "origin/feature"); folded into the tooltip. */
  upstreamTarget?: string | null;
}

export const SyncActions: React.FC<SyncActionsProps> = ({
  syncAction,
  remotes = [],
  onFetch,
  onSync,
  disabled,
  showFetchMenu = true,
  aheadCount = 0,
  behindCount = 0,
  trackingRemoteName,
  hasUncommittedChanges = false,
  iconOnly = false,
  upstreamTarget = null,
}) => {
  const { t } = useTranslation();
  const { isMobile, isTablet } = useDeviceInfo();
  const isTouchSync = isMobile || isTablet;
  const trackingRemote = remotes.find((remote) => remote.name === trackingRemoteName) ?? remotes[0];
  const blocksRebaseSync = behindCount > 0 && hasUncommittedChanges;
  const isPrimaryDisabled = disabled || syncAction !== null || !trackingRemote || blocksRebaseSync;
  const isDropdownDisabled = disabled || syncAction !== null || remotes.length === 0;
  const hasKnownSyncWork = aheadCount > 0 || behindCount > 0;
  const primaryLabel = [
    t("sync"),
    behindCount > 0 ? `↓${behindCount}` : null,
    aheadCount > 0 ? `↑${aheadCount}` : null,
  ].filter(Boolean).join(' ');
  const tooltipLabel = blocksRebaseSync
    ? t("Commit or stash your changes before syncing")
    : trackingRemote
    ? [
        hasKnownSyncWork
          ? t('Sync Changes ({{behind}} down, {{ahead}} up)', { behind: behindCount, ahead: aheadCount })
          : t("Sync Changes"),
        upstreamTarget ? t('Compared with {{target}}', { target: upstreamTarget }) : null,
      ].filter(Boolean).join('. ')
    : t("No remotes configured");

  const handleSync = () => {
    if (!trackingRemote) {
      return;
    }
    onSync(trackingRemote);
  };

  const iconButtonSize = isTouchSync ? 'h-9' : 'h-8';
  const counts = [behindCount > 0 ? `↓${behindCount}` : null, aheadCount > 0 ? `↑${aheadCount}` : null].filter(Boolean).join(' ');
  const syncText = iconOnly ? counts : primaryLabel;

  return (
    <div className="inline-flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex" tabIndex={blocksRebaseSync ? 0 : undefined}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleSync}
              disabled={isPrimaryDisabled}
              className={cn(
                iconButtonSize,
                'flex-shrink-0 gap-1.5 tabular-nums',
                syncText ? 'px-2' : (isTouchSync ? 'w-9 p-0' : 'w-8 p-0'),
              )}
              aria-label={t("Sync Changes")}
            >
              {syncAction === 'sync' ? (
                <Icon name="loader-4" className="size-4 animate-spin" />
              ) : (
                <Icon name="refresh" className="size-4" />
              )}
              {syncText ? <span className="whitespace-nowrap">{syncText}</span> : null}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent sideOffset={8}>{tooltipLabel}</TooltipContent>
      </Tooltip>

      {showFetchMenu ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(iconButtonSize, isTouchSync ? 'w-9' : 'w-8', 'flex-shrink-0 p-0')}
            disabled={isDropdownDisabled}
            aria-label={t("More sync actions")}
          >
            <Icon name="more" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[min(360px,calc(100vw-2rem))] max-h-[320px] overflow-y-auto">
          {remotes.map((remote) => (
            <FetchRemoteMenuItem key={remote.name} remote={remote} onFetch={onFetch} />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      ) : null}
    </div>
  );
};

/** "Fetch from <remote>" menu row, shared with hosts that fold fetch into their own menu. */
export const FetchRemoteMenuItem: React.FC<{
  remote: GitRemote;
  onFetch: (remote: GitRemote) => void;
  disabled?: boolean;
}> = ({ remote, onFetch, disabled = false }) => {
  const { t } = useTranslation();
  return (
  <DropdownMenuItem disabled={disabled} onSelect={() => onFetch(remote)}>
    <div className="flex w-full min-w-0 items-center gap-2">
      <Icon name="refresh" className="size-4 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="typography-ui-label text-foreground">
          {t('Fetch from {{remote}}', { remote: remote.name })}
        </span>
        <span className="typography-meta text-muted-foreground truncate">
          {remote.fetchUrl}
        </span>
      </div>
    </div>
  </DropdownMenuItem>
  );
};
