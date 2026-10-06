import React from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation } from 'react-i18next';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useUIStore } from '@/stores/useUIStore';
import { useDeviceInfo } from '@/lib/device';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { redactSensitiveUrl } from '@/lib/desktopHosts';
import { isDesktopShell } from '@/lib/desktop';
import { devicePlatformLabel } from './remoteInstanceHelpers';
import { AddDeviceDialog } from './AddDeviceDialog';
import { AddDirectHostDialog, EditDirectHostDialog, ImportDirectConnectDialog } from './DirectHostDialogs';
import { useDirectHostsState } from './useDirectHostsState';
import { useDevicePairingState } from './useDevicePairingState';

export const RemoteInstancesPage: React.FC = () => {
  const { isMobile } = useDeviceInfo();
  const { t } = useTranslation();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const { clientAuth } = useRuntimeAPIs();
  const showInstanceManagement = isDesktopShell();

  const {
    directHosts,
    directHostStatus,
    directDefaultHostId,
    directLoading,
    directSaving,
    directLabel,
    setDirectLabel,
    directUrl,
    setDirectUrl,
    directToken,
    setDirectToken,
    directHeaders,
    setDirectHeaders,
    directConnectLink,
    setDirectConnectLink,
    directError,
    directAddDialogOpen,
    setDirectAddDialogOpen,
    directImportDialogOpen,
    setDirectImportDialogOpen,
    directEditingId,
    setDirectEditingId,
    directEditLabel,
    setDirectEditLabel,
    directEditUrl,
    setDirectEditUrl,
    directEditToken,
    setDirectEditToken,
    directEditHeaders,
    setDirectEditHeaders,
    handleAddDirectHost,
    importDirectConnectLink,
    handleRemoveDirectHost,
    beginEditDirectHost,
    saveDirectHostEdit,
    setDefaultDirectHost,
  } = useDirectHostsState(showInstanceManagement);

  const {
    remoteClients,
    pendingPairings,
    remoteClientsLoading,
    remoteClientLabel,
    setRemoteClientLabel,
    remoteClientError,
    pairingUrl,
    pairingQrDataUrl,
    pairingCopied,
    addDeviceOpen,
    setAddDeviceOpen,
    addDevicePhase,
    addDeviceCreating,
    addDeviceTransport,
    setAddDeviceTransport,
    addDeviceFallback,
    setAddDeviceFallback,
    transportOptions,
    revokedClientCount,
    openAddDevice,
    createPairingLink,
    handleCopyPairing,
    revokeRemoteClient,
    purgeRevokedRemoteClients,
    cancelPendingPairing,
  } = useDevicePairingState(clientAuth);

  return (
    <SettingsPageLayout title={isMobile ? undefined : t('Remote Instances')}>
      {clientAuth ? (
        <SettingsSection
          title={t('Connect to this server')}
          info={t('Create a secure link or token so PiChamber Desktop can connect to this server.')}
          divider={false}
          settingsItem="remote-instances.client-auth"
          contentClassName="space-y-3"
        >
          <div>
            <Button type="button" size="xs" className="!font-normal" onClick={() => void openAddDevice()}>
              <Icon name="add" className="h-3.5 w-3.5" />
              {t('Add a device')}
            </Button>
          </div>
          <div className="space-y-2.5">
            {revokedClientCount > 0 ? (
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="!font-normal"
                  onClick={() => void purgeRevokedRemoteClients()}
                >
                  {t('Clear revoked')}
                </Button>
              </div>
            ) : null}
            {remoteClientsLoading && remoteClients.length === 0 && pendingPairings.length === 0 ? (
              <p className="typography-meta text-muted-foreground">{t('Loading tokens...')}</p>
            ) : remoteClients.length === 0 && pendingPairings.length === 0 ? (
              <p className="typography-meta text-muted-foreground">{t('No devices connected yet.')}</p>
            ) : (
              <>
                {pendingPairings.map((pending) => (
                  <div key={`pending-${pending.id}`} className="flex items-center justify-between gap-3 py-1.5">
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--status-warning)] animate-pulse" />
                        <p className="typography-ui-label text-foreground truncate">
                          {pending.label || t('Device name — e.g. My iPhone')}
                        </p>
                        {pending.usesRelay ? (
                          <span className="typography-micro text-muted-foreground bg-muted px-1 rounded shrink-0 leading-none pb-px border border-border/50">
                            {t('Relay')}
                          </span>
                        ) : null}
                      </div>
                      <p className="typography-micro text-muted-foreground truncate">{t('Waiting to connect…')}</p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="!font-normal"
                      onClick={() => void cancelPendingPairing(pending.id)}
                    >
                      {t('Cancel')}
                    </Button>
                  </div>
                ))}
                {remoteClients.map((client) => {
                  const isLocalDesktopClient = client.clientKind === 'desktop-local';
                  const lastUsedMs = client.lastUsedAt ? Date.parse(client.lastUsedAt) : Number.NaN;
                  const isOnline =
                    !client.revokedAt &&
                    (isLocalDesktopClient || (Number.isFinite(lastUsedMs) && Date.now() - lastUsedMs < 90_000));
                  const statusText = client.revokedAt
                    ? t('Revoked')
                    : isOnline
                      ? client.lastTransport === 'relay' && !isLocalDesktopClient
                        ? t('Connected · Relay')
                        : t('Connected · Local network')
                      : Number.isFinite(lastUsedMs)
                        ? t('Last used {{time}}', { time: formatDateTimeForPreference(lastUsedMs, timeFormatPreference, {
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          }) })
                        : t('Never used');
                  return (
                    <div key={client.id} className="flex items-center justify-between gap-3 py-1.5">
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span
                            className={cn(
                              'h-2 w-2 shrink-0 rounded-full',
                              client.revokedAt
                                ? 'bg-muted-foreground/20'
                                : isOnline
                                  ? 'bg-[var(--status-success)]'
                                  : 'bg-muted-foreground/30',
                            )}
                          />
                          <p className="typography-ui-label text-foreground truncate">{client.label}</p>
                          {devicePlatformLabel(client.devicePlatform) ? (
                            <span className="typography-micro text-muted-foreground bg-muted px-1 rounded shrink-0 leading-none pb-px border border-border/50">
                              {devicePlatformLabel(client.devicePlatform)}
                            </span>
                          ) : null}
                          {isLocalDesktopClient ? (
                            <span className="typography-micro text-muted-foreground bg-muted px-1 rounded flex-shrink-0 leading-none pb-px border border-border/50">
                              {t('This device')}
                            </span>
                          ) : null}
                          <span
                            className={cn(
                              'typography-micro truncate',
                              isOnline && !client.revokedAt ? 'text-[var(--status-success)]' : 'text-muted-foreground',
                            )}
                          >
                            {statusText}
                          </span>
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="!font-normal"
                        onClick={() => void revokeRemoteClient(client)}
                        disabled={Boolean(client.revokedAt)}
                      >
                        {t('Revoke')}
                      </Button>
                    </div>
                  );
                })}
              </>
            )}
          </div>
          {remoteClientError ? <p className="typography-meta text-[var(--status-error)]">{remoteClientError}</p> : null}
        </SettingsSection>
      ) : null}

      {showInstanceManagement ? (
        <SettingsSection
          title={t('Other PiChamber servers')}
          info={t('Servers this app can switch to. Import a pairing link from the other server, or add one by address.')}
          settingsItem="remote-instances.direct-hosts"
          contentClassName="space-y-4"
          headerAction={
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                size="xs"
                className="!font-normal"
                onClick={() => setDirectImportDialogOpen(true)}
                disabled={directSaving}
              >
                {t('Import Link')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => setDirectAddDialogOpen(true)}
                disabled={directSaving}
              >
                <Icon name="add" className="h-3.5 w-3.5" />
                {t('Add Server')}
              </Button>
            </div>
          }
        >
          <div className="space-y-2.5">
            {directLoading ? (
              <p className="typography-meta text-muted-foreground">{t('Loading instances...')}</p>
            ) : directHosts.length === 0 ? (
              <p className="typography-meta text-muted-foreground">{t('No other servers added yet.')}</p>
            ) : (
              directHosts.map((host) => {
                const probe = directHostStatus[host.id];
                const statusLabel = !probe
                  ? t('Checking')
                  : probe.status === 'ok'
                    ? t('Connected')
                    : probe.status === 'auth'
                      ? t('Auth required')
                      : probe.status === 'update-recommended'
                        ? t('Update recommended')
                        : probe.status === 'incompatible'
                          ? t('Incompatible')
                          : probe.status === 'wrong-service'
                            ? t('Wrong service')
                            : t('Unreachable');
                const isOnline = probe?.status === 'ok';
                return (
                  <div key={host.id} className="py-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className={cn(
                              'h-2 w-2 shrink-0 rounded-full',
                              !probe
                                ? 'bg-muted-foreground/30 animate-pulse'
                                : isOnline
                                  ? 'bg-[var(--status-success)]'
                                  : 'bg-[var(--status-error)]',
                            )}
                          />
                          <p className="typography-ui-label text-foreground truncate">
                            {redactSensitiveUrl(host.label)}
                          </p>
                          {directDefaultHostId === host.id ? (
                            <span className="typography-micro text-muted-foreground shrink-0">{t('Default')}</span>
                          ) : null}
                          <span
                            className={cn(
                              'typography-micro shrink-0',
                              isOnline ? 'text-[var(--status-success)]' : 'text-muted-foreground',
                            )}
                          >
                            {statusLabel}
                            {isOnline && typeof probe?.latencyMs === 'number'
                              ? ` · ${Math.max(0, Math.round(probe.latencyMs))}${t('ms ping')}`
                              : ''}
                          </span>
                        </div>
                        <p className={cn('typography-micro text-muted-foreground truncate', host.apiUrl && 'font-mono')}>
                          {host.relay && !host.apiUrl
                            ? t('via PiChamber Relay')
                            : redactSensitiveUrl(host.apiUrl || host.url)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="!font-normal"
                          onClick={() => void setDefaultDirectHost(host.id)}
                          disabled={directSaving || directDefaultHostId === host.id}
                          aria-label={t('Set as default')}
                        >
                          {directDefaultHostId === host.id ? (
                            <Icon name="star-fill" className="h-3.5 w-3.5" />
                          ) : (
                            <Icon name="star" className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        {host.relay && !host.apiUrl ? null : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="!font-normal"
                            onClick={() => beginEditDirectHost(host)}
                            disabled={directSaving}
                          >
                            <Icon name="pencil" className="h-3.5 w-3.5" />
                            {t('Edit')}
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="!font-normal"
                          onClick={() => void handleRemoveDirectHost(host.id)}
                          disabled={directSaving}
                        >
                          <Icon name="delete-bin" className="h-3.5 w-3.5" />
                          {t('Delete')}
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {directError ? <p className="typography-meta text-[var(--status-error)]">{directError}</p> : null}
        </SettingsSection>
      ) : null}

      {showInstanceManagement ? (
        <>
          <AddDirectHostDialog
            open={directAddDialogOpen}
            onOpenChange={setDirectAddDialogOpen}
            label={directLabel}
            onLabelChange={setDirectLabel}
            url={directUrl}
            onUrlChange={setDirectUrl}
            token={directToken}
            onTokenChange={setDirectToken}
            headers={directHeaders}
            onHeadersChange={setDirectHeaders}
            saving={directSaving}
            onAdd={handleAddDirectHost}
          />

          <EditDirectHostDialog
            open={Boolean(directEditingId)}
            onOpenChange={(open) => {
              if (!open) setDirectEditingId(null);
            }}
            label={directEditLabel}
            onLabelChange={setDirectEditLabel}
            url={directEditUrl}
            onUrlChange={setDirectEditUrl}
            token={directEditToken}
            onTokenChange={setDirectEditToken}
            headers={directEditHeaders}
            onHeadersChange={setDirectEditHeaders}
            saving={directSaving}
            onSave={saveDirectHostEdit}
          />

          <ImportDirectConnectDialog
            open={directImportDialogOpen}
            onOpenChange={setDirectImportDialogOpen}
            link={directConnectLink}
            onLinkChange={setDirectConnectLink}
            saving={directSaving}
            onImport={importDirectConnectLink}
          />
        </>
      ) : null}

      <AddDeviceDialog
        open={addDeviceOpen}
        onOpenChange={setAddDeviceOpen}
        phase={addDevicePhase}
        remoteClientLabel={remoteClientLabel}
        onRemoteClientLabelChange={setRemoteClientLabel}
        remoteClientError={remoteClientError}
        addDeviceTransport={addDeviceTransport}
        onAddDeviceTransportChange={setAddDeviceTransport}
        addDeviceFallback={addDeviceFallback}
        onAddDeviceFallbackChange={setAddDeviceFallback}
        transportOptions={transportOptions}
        addDeviceCreating={addDeviceCreating}
        onCreatePairingLink={createPairingLink}
        pairingQrDataUrl={pairingQrDataUrl}
        pairingUrl={pairingUrl}
        pairingCopied={pairingCopied}
        onCopyPairing={handleCopyPairing}
      />
    </SettingsPageLayout>
  );
};
