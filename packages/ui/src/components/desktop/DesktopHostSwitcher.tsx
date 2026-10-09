import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { isDesktopShell } from '@/lib/desktop';
import { Icon } from "@/components/icon/Icon";
import { useUIStore } from '@/stores/useUIStore';
import { ServerList } from '@/components/servers/ServerList';
import { useDesktopServers } from '@/components/servers/useDesktopServers';
import { redactSensitiveUrl } from '@/lib/desktopHosts';

type DesktopHostSwitcherDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  embedded?: boolean;
  onHostSwitched?: () => void;
};

export function DesktopHostSwitcherDialog({
  open,
  onOpenChange,
  embedded = false,
  onHostSwitched,
}: DesktopHostSwitcherDialogProps) {
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const servers = useDesktopServers({ autoLoad: false });

  const openServersSettings = React.useCallback(() => {
    setSettingsPage('servers');
    setSettingsDialogOpen(true);
    onOpenChange(false);
  }, [onOpenChange, setSettingsDialogOpen, setSettingsPage]);

  React.useEffect(() => {
    if (!open) return;
    void servers.load();
    // Load on open; the probe effect below runs once hosts resolve.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  const hostList = servers.allHosts;
  React.useEffect(() => {
    if (!open) return;
    void servers.probeAll(hostList);
    // Direct first, relay fallback, settled all at once (inside the hook).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hostList]);

  if (!isDesktopShell()) {
    return null;
  }

  const desktopAvailable = isDesktopShell();

  const content = (
    <>
      {embedded ? (
        <div className="flex-shrink-0 border-b border-[var(--interactive-border)] px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex items-baseline gap-1.5 typography-ui-label">
              <span className="font-medium text-foreground">{"Current"}</span>
              <span className="max-w-[9rem] truncate text-muted-foreground">{redactSensitiveUrl(servers.current.label)}</span>
              <span className="text-muted-foreground/50">•</span>
              <span className="font-medium text-foreground">{"Default"}</span>
              <span className="max-w-[9rem] truncate text-muted-foreground">{redactSensitiveUrl(servers.currentDefaultLabel)}</span>
            </div>
            <button
              type="button"
              className={cn(
                'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors',
                'hover:text-foreground hover:bg-interactive-hover',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
              )}
              onClick={() => void servers.probeAll(servers.allHosts)}
              disabled={!desktopAvailable || servers.loading || servers.probing}
              aria-label={"Refresh servers"}
            >
              <Icon name="refresh" className={cn('h-4 w-4', servers.probing && 'animate-spin')} />
            </button>
          </div>
        </div>
      ) : (
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Icon name="server" className="h-5 w-5" />
            {"Servers"}
          </DialogTitle>
          <DialogDescription>
            {"Switch between this computer and remote PiChamber servers"}
          </DialogDescription>
        </DialogHeader>
      )}

      {!embedded && (
        <div className="flex items-center justify-between gap-2 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="typography-meta text-muted-foreground">{"Current:"}</span>
            <span className="typography-ui-label text-foreground truncate">{redactSensitiveUrl(servers.current.label)}</span>
            <span className="typography-meta text-muted-foreground">{"Current default:"}</span>
            <span className="typography-ui-label text-foreground truncate">{redactSensitiveUrl(servers.currentDefaultLabel)}</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void servers.probeAll(servers.allHosts)}
              disabled={!desktopAvailable || servers.loading || servers.probing}
            >
              <Icon name="refresh" className={cn('h-4 w-4', servers.probing && 'animate-spin')} />
              {"Refresh"}
            </Button>
          </div>
        </div>
      )}

        {!desktopAvailable && (
          <div className="flex-shrink-0 rounded-lg border border-border/50 bg-muted/20 p-3">
            <div className="typography-meta text-muted-foreground">
              {"Server switcher is limited on this page. Use Local to recover."}
            </div>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className={cn(embedded && 'px-3 py-1')}>
            {servers.loading ? (
              <div className="px-2 py-2 text-muted-foreground text-sm">{"Loading..."}</div>
            ) : (
              <ServerList
                items={servers.items}
                layout={embedded ? 'touch' : 'comfortable'}
                guardDefaultByStatus
                refreshing={servers.probing}
                pendingId={servers.switchingHostId}
                actionsDisabled={servers.saving}
                onSwitch={(item) => void servers.switchToHost(item.id, { onSwitched: onHostSwitched })}
                onSetDefault={(item) => void servers.setDefaultServer(item.id)}
                onOpenInNewWindow={(item) => servers.openInNewWindow(item.id)}
              />
            )}
          </div>
        </div>

        <div className="flex-shrink-0 border-t border-[var(--interactive-border)]">
          <button
            type="button"
            className="w-full flex items-center gap-2 px-2 py-2 text-left text-muted-foreground hover:text-foreground hover:bg-interactive-hover/30 transition-colors"
            onClick={openServersSettings}
          >
            <Icon name="add" className="h-4 w-4" />
            <span className="typography-ui-label">{"Add server"}</span>
          </button>
        </div>

        {servers.error && (
          <div className="flex-shrink-0 typography-meta text-status-error">{servers.error}</div>
        )}
    </>
  );

  if (embedded) {
    return (
      <div className="w-full max-h-[70vh] flex flex-col overflow-hidden gap-2">
        {content}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(42rem,calc(100vw-2rem))] max-w-none max-h-[70vh] flex flex-col overflow-hidden gap-3">
        {content}
      </DialogContent>
    </Dialog>
  );
}

export function DesktopHostSwitcherInline() {
  const [open, setOpen] = React.useState(false);

  if (!isDesktopShell()) {
    return null;
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-oc-host-switcher
        className="w-full justify-center"
        onClick={() => setOpen(true)}
      >
        <Icon name="server" className="h-4 w-4" />
        {"Switch server"}
      </Button>
      <DesktopHostSwitcherDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
