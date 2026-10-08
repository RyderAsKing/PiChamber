import React from 'react';

import { Button } from '@/components/ui/button';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { devicePlatformLabel } from './devicePlatform';
import type { RemoteDevicesApi } from './useRemoteDevicesState';

/**
 * Devices-with-access list, moved from the old mixed Remote Instances page.
 * Behavior is preserved, including the local-desktop-client revoke
 * special-case (owned by the hook).
 *
 * Route note: the server reports `lastTransport` as `relay` or `direct`
 * only. Tailscale connections arrive as direct (loopback proxy), so there is
 * no per-device "Connected · Tailscale" signal to show — and none is
 * invented here.
 */
export const DevicesSection: React.FC<{ devices: RemoteDevicesApi }> = ({ devices }) => {
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const {
    remoteClients,
    pendingPairings,
    loading,
    error,
    revokedClientCount,
    revokeRemoteClient,
    purgeRevokedRemoteClients,
    cancelPendingPairing,
  } = devices;

  return (
    <SettingsSection
      title={'Devices with access'}
      info={'Devices that can open this server. Revoking removes a device immediately, including its live connections.'}
      settingsItem="remote-access.devices"
      contentClassName="space-y-2.5"
    >
      {revokedClientCount > 0 ? (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="!font-normal"
            onClick={() => purgeRevokedRemoteClients()}
          >
            {'Clear revoked'}
          </Button>
        </div>
      ) : null}
      {loading && remoteClients.length === 0 && pendingPairings.length === 0 ? (
        <p className="typography-meta text-muted-foreground">{'Loading devices...'}</p>
      ) : remoteClients.length === 0 && pendingPairings.length === 0 ? (
        <p className="typography-meta text-muted-foreground">{'No devices connected yet.'}</p>
      ) : (
        <>
          {pendingPairings.map((pending) => (
            <div key={`pending-${pending.id}`} className="flex items-center justify-between gap-3 py-1.5">
              <div className="min-w-0 space-y-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--status-warning)] animate-pulse" aria-hidden />
                  <p className="typography-ui-label text-foreground truncate">
                    {pending.label || 'Pair new device'}
                  </p>
                  {pending.usesRelay ? (
                    <span className="typography-micro text-muted-foreground bg-muted px-1 rounded shrink-0 leading-none pb-px border border-border/50">
                      {'Relay'}
                    </span>
                  ) : null}
                </div>
                <p className="typography-micro text-muted-foreground truncate">{'Waiting to connect…'}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="!font-normal"
                onClick={() => cancelPendingPairing(pending.id)}
                aria-label={`Cancel pairing for ${pending.label || 'new device'}`}
              >
                {'Cancel'}
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
              ? 'Revoked'
              : isOnline
                ? client.lastTransport === 'relay' && !isLocalDesktopClient
                  ? 'Connected · Relay'
                  : 'Connected · Local network'
                : Number.isFinite(lastUsedMs)
                  ? `Last used ${formatDateTimeForPreference(lastUsedMs, timeFormatPreference, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}`
                  : 'Never used';
            return (
              <div key={client.id} className="flex items-center justify-between gap-3 py-1.5">
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span
                      aria-hidden
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
                        {'This device'}
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
                  onClick={() => revokeRemoteClient(client)}
                  disabled={Boolean(client.revokedAt)}
                  aria-label={`Revoke ${client.label}`}
                >
                  {'Revoke'}
                </Button>
              </div>
            );
          })}
        </>
      )}
      {error ? <p className="typography-meta text-[var(--status-error)]" role="alert">{error}</p> : null}
    </SettingsSection>
  );
};
