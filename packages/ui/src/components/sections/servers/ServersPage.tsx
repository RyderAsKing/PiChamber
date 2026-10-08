import React from 'react';

import { Button } from '@/components/ui/button';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { Icon } from '@/components/icon/Icon';
import { ServerList } from '@/components/servers/ServerList';
import { AddServerDialog } from '@/components/servers/AddServerDialog';
import { useDesktopServers } from '@/components/servers/useDesktopServers';
import { readRequestHeaderDrafts, type HeaderDraft } from '@/components/servers/serverHeaderDrafts';
import { EditDirectHostDialog } from './DirectHostDialogs';
import { MobileServersPage } from './MobileServersPage';
import type { DesktopHost } from '@/lib/desktopHosts';
import { isCapacitorApp } from '@/lib/platform';

/**
 * Servers page: which PiChamber server this app uses, plus the other
 * PiChamber servers it can connect to. Desktop shell renders the desktop
 * hook below; the native Capacitor app renders the same mobile-backed list
 * as the quick-access sheet (see `MobileServersPage`).
 *
 * Rows and the add-server flow render through the shared server components;
 * probing, import (direct-then-relay race and redeem), and persistence live
 * in useDesktopServers, shared with the desktop host switcher.
 */
export const ServersPage: React.FC<{
  onActiveConnectionDeleted?: () => void;
}> = ({ onActiveConnectionDeleted }) => {
  const isCapacitor = React.useMemo(() => isCapacitorApp(), []);
  if (isCapacitor) {
    return <MobileServersPage onActiveConnectionDeleted={onActiveConnectionDeleted} />;
  }
  return <DesktopServersPage />;
};

const DesktopServersPage: React.FC = () => {
  const servers = useDesktopServers();
  const [addDialogOpen, setAddDialogOpen] = React.useState(false);
  const [editingHost, setEditingHost] = React.useState<DesktopHost | null>(null);
  const [editLabel, setEditLabel] = React.useState('');
  const [editUrl, setEditUrl] = React.useState('');
  const [editToken, setEditToken] = React.useState('');
  const [editHeaders, setEditHeaders] = React.useState<HeaderDraft[]>([]);

  const remoteItems = React.useMemo(
    () => servers.items.filter((item) => !item.isLocal),
    [servers.items],
  );

  const hostList = servers.remoteHosts;
  React.useEffect(() => {
    if (hostList.length === 0) return;
    void servers.probeAll(servers.allHosts);
    // Re-probe when the host list changes; the shared status cache and
    // per-host dedupe keep this to one probe cycle across surfaces.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostList]);

  const beginEdit = React.useCallback(
    (id: string) => {
      const host = servers.remoteHosts.find((entry) => entry.id === id);
      if (!host) return;
      setEditingHost(host);
      setEditLabel(host.label);
      setEditUrl(host.apiUrl || host.url);
      setEditToken(host.clientToken || '');
      setEditHeaders(readRequestHeaderDrafts(host.requestHeaders));
      servers.setError(null);
    },
    [servers],
  );

  const saveEdit = React.useCallback(async () => {
    if (!editingHost) return;
    const result = await servers.updateServer(editingHost.id, {
      label: editLabel,
      url: editUrl,
      token: editToken,
      headers: editHeaders,
    });
    if (result.ok) setEditingHost(null);
  }, [editingHost, editLabel, editUrl, editToken, editHeaders, servers]);

  return (
    <SettingsPageLayout
      title="Servers"
      description="Which PiChamber server this app uses. Add other servers to switch between them."
    >
      <SettingsSection
        title={'Other PiChamber servers'}
        info={'Servers this app can switch to. Import a pairing link from the other server, or add one by address.'}
        divider={false}
        settingsItem="servers.direct-hosts"
        contentClassName="space-y-4"
        headerAction={
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => {
                servers.setError(null);
                setAddDialogOpen(true);
              }}
              disabled={servers.saving}
            >
              <Icon name="add" className="h-3.5 w-3.5" aria-hidden />
              {'Add server'}
            </Button>
          </div>
        }
      >
        {servers.loading ? (
          <p className="typography-meta text-muted-foreground">{'Loading servers...'}</p>
        ) : (
          <ServerList
            items={remoteItems}
            emptyMessage="No other servers added yet."
            refreshing={servers.probing}
            actionsDisabled={servers.saving}
            onSwitch={(item) => void servers.switchToHost(item.id)}
            onSetDefault={(item) => void servers.setDefaultServer(item.id)}
            onEdit={(item) => beginEdit(item.id)}
            onRemove={(item) => void servers.removeServer(item.id)}
          />
        )}

        {servers.error ? (
          <p className="typography-meta text-[var(--status-error)]" role="alert">{servers.error}</p>
        ) : null}
      </SettingsSection>

      <AddServerDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        canScanQr={false}
        onImportLink={async (link) => {
          const result = await servers.importPairingLink(link);
          if (result.ok) setAddDialogOpen(false);
        }}
        importSaving={servers.saving}
        importError={servers.error}
        onAddManual={async (input) => {
          const result = await servers.addManualServer(input);
          if (result.ok) setAddDialogOpen(false);
        }}
        manualSaving={servers.saving}
        manualError={servers.error}
      />

      <EditDirectHostDialog
        open={Boolean(editingHost)}
        onOpenChange={(open) => {
          if (!open) setEditingHost(null);
        }}
        label={editLabel}
        onLabelChange={setEditLabel}
        url={editUrl}
        onUrlChange={setEditUrl}
        token={editToken}
        onTokenChange={setEditToken}
        headers={editHeaders}
        onHeadersChange={setEditHeaders}
        saving={servers.saving}
        error={servers.error}
        onSave={() => void saveEdit()}
      />
    </SettingsPageLayout>
  );
};
