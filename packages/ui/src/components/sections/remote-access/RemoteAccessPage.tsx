import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopLocalOriginActive, isDesktopShell, isWebRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { PasskeySettings } from '../pichamber/PasskeySettings';
import { AddDeviceDialog } from './AddDeviceDialog';
import { DevicesSection } from './DevicesSection';
import {
  DesktopPasswordFields,
} from './DesktopLanAccessSettings';
import { useDesktopLanAccessState } from './useDesktopLanAccessState';
import { LocalNetworkRouteRow } from './LocalNetworkRouteRow';
import { TailscaleRouteRow } from './TailscaleRouteRow';
import { useAddDeviceState } from './useAddDeviceState';
import { useRemoteDevicesState } from './useRemoteDevicesState';
import { fetchSessionStatus } from '@/components/auth/sessionAuthHelpers';

type UiPasswordState = 'loading' | 'set' | 'not-set' | 'unknown';

/**
 * Web UI-password state via the existing session-status endpoint: a 200 with
 * `{ disabled: true }` means no password is configured; 401 (locked) or an
 * authenticated 200 without `disabled` means one is set. Fetch failure stays
 * `unknown` — never presented as not-set.
 */
const useWebUiPasswordState = (enabled: boolean): UiPasswordState => {
  const [state, setState] = React.useState<UiPasswordState>(enabled ? 'loading' : 'unknown');
  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchSessionStatus();
        if (cancelled) return;
        if (response.status === 401) {
          setState('set');
          return;
        }
        if (!response.ok) {
          setState('unknown');
          return;
        }
        const body = (await response.json().catch(() => null)) as { disabled?: unknown } | null;
        setState(body?.disabled === true ? 'not-set' : 'set');
      } catch {
        if (!cancelled) setState('unknown');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return state;
};

const WebSecurityStatus: React.FC = () => {
  const passwordState = useWebUiPasswordState(true);
  if (passwordState === 'loading') {
    return (
      <p className="typography-meta text-muted-foreground" role="status">
        {'Checking UI password…'}
      </p>
    );
  }
  if (passwordState === 'set') {
    return (
      <p className="typography-meta text-muted-foreground">
        {'UI password is set. The server requires it for browser sign-in.'}
      </p>
    );
  }
  if (passwordState === 'not-set') {
    return (
      <div className="space-y-1">
        <p className="typography-meta text-muted-foreground">
          {'No UI password is set. Start the server with --ui-password or set PICHAMBER_UI_PASSWORD.'}
        </p>
      </div>
    );
  }
  return (
    <p className="typography-meta text-muted-foreground">
      {'The UI password is set when the server starts.'}
    </p>
  );
};

/**
 * Remote Access page: how other devices reach this computer.
 *
 * Available on the desktop shell and the web runtime; hidden on mobile.
 * Incoming direction only — outgoing servers live on the Servers page.
 */
export const RemoteAccessPage: React.FC = () => {
  const { isMobile } = useDeviceInfo();
  const { clientAuth } = useRuntimeAPIs();
  const isDesktop = isDesktopShell();
  const isDesktopLocal = isDesktop && isDesktopLocalOriginActive();
  // Passkeys only work against the browser's WebAuthn UI on the web surface —
  // desktop shell and the Capacitor app never show the login screen.
  const showPasskeySettings = isWebRuntime() && !isDesktopShell() && !isCapacitorApp();

  const lan = useDesktopLanAccessState();
  const devices = useRemoteDevicesState(clientAuth);
  const addDevice = useAddDeviceState(clientAuth, devices);

  return (
    <SettingsPageLayout
      title={isMobile ? undefined : 'Remote Access'}
      description={isMobile ? undefined : 'How other devices reach this computer.'}
      headerEnd={clientAuth ? (
        <div data-settings-item="remote-access.client-auth">
          <Button type="button" size="sm" className="!font-normal" onClick={() => addDevice.openDialog()}>
            <Icon name="add" className="h-4 w-4" aria-hidden />
            {'Add a device'}
          </Button>
        </div>
      ) : undefined}
    >
      <SettingsSection
        title={'Ways to connect'}
        divider={false}
        settingsItem="remote-access.ways"
        contentClassName="space-y-6"
      >
        <LocalNetworkRouteRow lan={lan} />
        <TailscaleRouteRow />
      </SettingsSection>

      {clientAuth ? <DevicesSection devices={devices} /> : null}

      <SettingsSection
        title={'Security'}
        description={'The password protects browser sign-in. It is required for Local network and Tailscale access.'}
        settingsItem="remote-access.security"
        contentClassName="space-y-3"
      >
        {isDesktopLocal ? <DesktopPasswordFields lan={lan} /> : null}
        {!isDesktopLocal ? <WebSecurityStatus /> : null}
      </SettingsSection>

      {showPasskeySettings ? <PasskeySettings /> : null}

      <AddDeviceDialog addDevice={addDevice} isDesktop={isDesktop} />
    </SettingsPageLayout>
  );
};
