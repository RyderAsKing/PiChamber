import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';
import { DESKTOP_HEADER_ICON_BUTTON_CLASS } from './HeaderIconActionButton';
import { serverPlatformIcon, type ServerPlatformMetadata } from './serverPlatformIcon';
import { displayServerPlatform } from './serverPlatformLabel';

type ServerVersionInfo = ServerPlatformMetadata & {
  pichamberVersion?: unknown;
};

type ConnectedServerMenuProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ConnectedServerMenu({ open, onOpenChange }: ConnectedServerMenuProps) {
  const [metadata, setMetadata] = React.useState<ServerVersionInfo | null>(null);

  const refresh = React.useCallback(async () => {
    const generation = getRuntimeEndpointGeneration();
    try {
      const response = await runtimeFetch('/api/version');
      if (!response.ok) throw new Error('Version request failed');
      const value = await response.json().catch(() => null) as ServerVersionInfo | null;
      if (generation === getRuntimeEndpointGeneration()) setMetadata(value);
    } catch {
      if (generation === getRuntimeEndpointGeneration()) setMetadata(null);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    return subscribeRuntimeEndpointChanged(() => void refresh());
  }, [refresh]);

  const icon = serverPlatformIcon(metadata);
  const platform = displayServerPlatform(metadata);
  const version = typeof metadata?.pichamberVersion === 'string' ? metadata.pichamberVersion : null;
  const address = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (nextOpen) void refresh();
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Show connected server information"
              className={cn(DESKTOP_HEADER_ICON_BUTTON_CLASS, 'w-auto max-w-[14rem] justify-start gap-1.5 px-2.5')}
            >
              <Icon
                name={icon.name}
                className="h-[18px] w-[18px] shrink-0"
                style={icon.color ? { color: icon.color } : undefined}
              />
              <span className="truncate typography-ui-label font-medium text-foreground">{'This server'}</span>
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent><p>{'Connected server information'}</p></TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)] p-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <Icon
              name={icon.name}
              className="size-5 shrink-0"
              style={icon.color ? { color: icon.color } : undefined}
            />
            <div className="truncate typography-ui-label font-medium text-foreground">{platform}</div>
          </div>
          {version ? <div className="shrink-0 typography-micro text-muted-foreground">{`v${version}`}</div> : null}
        </div>
        <div className="mt-3 border-t border-[var(--interactive-border)] pt-3 typography-micro">
          <div className="flex min-w-0 items-center gap-3">
            <span className="shrink-0 text-muted-foreground">{'Address'}</span>
            <button
              type="button"
              className="ml-auto flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              title={`Copy ${address}`}
              aria-label="Copy server address"
              onClick={() => {
                void copyTextToClipboard(address).then((result) => {
                  if (result.ok) toast.success('Server address copied');
                  else toast.error('Could not copy server address');
                });
              }}
            >
              <span className="block max-w-[30ch] truncate font-mono">{address}</span>
              <Icon name="file-copy" className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
