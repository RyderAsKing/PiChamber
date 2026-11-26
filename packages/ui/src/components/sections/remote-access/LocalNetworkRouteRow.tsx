import * as React from 'react';

import { isDesktopLocalOriginActive, isDesktopShell } from '@/lib/desktop';
import type { DesktopLanAccessState } from './useDesktopLanAccessState';
import { DesktopLanToggleFields } from './DesktopLanAccessSettings';
import { RouteAddress, RouteRow, RouteStatusPill } from './RouteRow';
import type { PairingTransportsState } from './usePairingTransportsState';

/**
 * Local-network route row.
 *
 * Desktop (local origin): toggle wired to the desktop LAN setting with the
 * same restart-required flow as before. Web: read-only status from the
 * pairing transports endpoint.
 */
export const LocalNetworkRouteRow: React.FC<{
  lan: DesktopLanAccessState;
  transportsState: PairingTransportsState;
}> = ({ lan, transportsState }) => {
  const isDesktopLocal = isDesktopShell() && isDesktopLocalOriginActive();

  if (isDesktopLocal) {
    const pill = lan.lanUrl
      ? <RouteStatusPill tone="success">{'On'}</RouteStatusPill>
      : lan.draftLanEnabled
        ? <RouteStatusPill tone="warning">{'Restart needed'}</RouteStatusPill>
        : <RouteStatusPill tone="neutral">{'Off'}</RouteStatusPill>;
    return (
      <RouteRow
        id="remote-access-lan-row"
        icon="home"
        title={'Local network'}
        pill={pill}
        description={'Phones and computers on your Wi-Fi reach this computer directly.'}
        settingsItem="remote-access.lan"
      >
        <DesktopLanToggleFields lan={lan} />
      </RouteRow>
    );
  }

  return <WebLocalNetworkRouteRow state={transportsState} />;
};

const WebLocalNetworkRouteRow: React.FC<{ state: PairingTransportsState }> = ({ state }) => {
  const { transports, loading, failed } = state;

  if (loading) {
    return (
      <RouteRow
        id="remote-access-lan-row"
        icon="home"
        title={'Local network'}
        pill={<RouteStatusPill tone="neutral">{'Checking…'}</RouteStatusPill>}
        description={'Phones and computers on your Wi-Fi reach this server directly.'}
        settingsItem="remote-access.lan"
      >
        <p className="typography-meta text-muted-foreground">{'Checking whether this server is exposed on your network…'}</p>
      </RouteRow>
    );
  }

  if (failed || !transports) {
    return (
      <RouteRow
        id="remote-access-lan-row"
        icon="home"
        title={'Local network'}
        pill={<RouteStatusPill tone="neutral">{'Unknown'}</RouteStatusPill>}
        description={'Phones and computers on your Wi-Fi reach this server directly.'}
        settingsItem="remote-access.lan"
      >
        <p className="typography-meta text-[var(--status-error)]">
          {"Couldn't check local network status. Check your connection and try again."}
        </p>
      </RouteRow>
    );
  }

  if (!transports.lan) {
    return (
      <RouteRow
        id="remote-access-lan-row"
        icon="home"
        title={'Local network'}
        pill={<RouteStatusPill tone="neutral">{'Off'}</RouteStatusPill>}
        description={'Phones and computers on your Wi-Fi reach this server directly.'}
        settingsItem="remote-access.lan"
      >
        <p className="typography-meta text-muted-foreground">
          {'Not exposed on your network. Start the server with --lan and a UI password to allow local devices.'}
        </p>
      </RouteRow>
    );
  }

  return (
    <RouteRow
      id="remote-access-lan-row"
      icon="home"
      title={'Local network'}
      pill={<RouteStatusPill tone="success">{'On'}</RouteStatusPill>}
      description={'Phones and computers on your Wi-Fi reach this server directly.'}
      settingsItem="remote-access.lan"
    >
      <RouteAddress url={transports.lan} copyLabel="Copy local network address" />
    </RouteRow>
  );
};
