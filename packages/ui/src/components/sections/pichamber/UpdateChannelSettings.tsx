import React from 'react';

import { SettingsFieldRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import {
  getDesktopUpdateChannel,
  isDesktopLocalOriginActive,
  isDesktopShell,
  setDesktopUpdateChannel,
} from '@/lib/desktop';
import {
  buildLocalDesktopHost,
  getLocalDesktopOrigin,
  LOCAL_HOST_ID,
  resolveCurrentDesktopHost,
} from '@/lib/desktopCurrentHost';
import { desktopHostsGet, redactSensitiveUrl } from '@/lib/desktopHosts';
import { isCapacitorApp } from '@/lib/platform';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import {
  getMobileUpdateChannel,
  parseUpdateChannel,
  setMobileUpdateChannel,
  type UpdateChannel,
} from '@/lib/updateChannel';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { UpdateChannelSelect } from './UpdateChannelSelect';
import { useServerUpdateChannel } from './useServerUpdateChannel';

declare const __APP_VERSION__: string | undefined;

const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : undefined;

// Channel rows keep the label beside the select at every width, so a phone
// reads them like desktop instead of stacking a short select under its label.
const CHANNEL_ROW_LAYOUT = {
  className: 'flex-row items-center justify-between gap-3',
  labelClassName: '@xl:w-auto',
  controlClassName: 'flex-none justify-end',
} as const;
const CHANNEL_SELECT_CLASS = 'w-44 min-w-0 max-w-none';

/** The connected server's address when the client has one; a same-origin browser has none. */
const getServerAddress = (): string | null => {
  const runtimeUrl = getRuntimeApiBaseUrl().trim();
  return runtimeUrl ? redactSensitiveUrl(runtimeUrl) : null;
};

type ClientChannelTarget = {
  /** Visible label; the Updates heading already says what the channel is for. */
  label: string;
  ariaLabel: string;
  info: string;
  settingsItem: string;
  load: () => Promise<UpdateChannel>;
  save: (channel: UpdateChannel) => Promise<UpdateChannel>;
};

const DESKTOP_APP_CHANNEL: ClientChannelTarget = {
  label: 'Desktop app channel',
  ariaLabel: 'Desktop app update channel',
  info: 'Stable receives production desktop releases only. Release candidate offers the highest available version across stable and desktop RC builds. Switching to Stable changes future update eligibility and does not downgrade an installed RC.',
  settingsItem: 'about.desktop-update-channel',
  load: getDesktopUpdateChannel,
  save: setDesktopUpdateChannel,
};

// The Android and iOS app keeps its channel on the device (see lib/updateChannel).
const MOBILE_APP_CHANNEL: ClientChannelTarget = {
  label: 'App channel',
  ariaLabel: 'App update channel',
  info: 'Stable receives production app releases only. Release candidate offers the highest available version across stable and app RC builds. Switching to Stable changes future update eligibility and does not downgrade an installed RC.',
  settingsItem: 'about.app-update-channel',
  load: async () => getMobileUpdateChannel(APP_VERSION),
  save: async (channel) => setMobileUpdateChannel(channel),
};

/**
 * Settings → About → Updates on every runtime. The client row is the desktop
 * app's channel in Electron and the app's own channel in the Android and iOS
 * app; browsers have no client of their own. The server row shows wherever
 * the server is separate from the client: everywhere but the desktop app's
 * built-in server, which updates with the app.
 */
export const UpdateChannelSettings: React.FC = () => {
  const isDesktop = isDesktopShell();
  const isLocalDesktop = isDesktop && isDesktopLocalOriginActive();
  const clientTarget = React.useMemo<ClientChannelTarget | null>(() => {
    if (isDesktop) return DESKTOP_APP_CHANNEL;
    if (isCapacitorApp()) return MOBILE_APP_CHANNEL;
    return null;
  }, [isDesktop]);
  const showServer = !isLocalDesktop;
  const server = useServerUpdateChannel(showServer);
  const runtimeEpoch = server.runtimeEpoch;
  const [serverIdentity, setServerIdentity] = React.useState(getServerAddress);
  const [clientChannel, setClientChannel] = React.useState<UpdateChannel>('stable');
  const [clientLoading, setClientLoading] = React.useState(clientTarget !== null);
  const [clientSaving, setClientSaving] = React.useState(false);
  const [clientError, setClientError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!showServer) return;
    const fallback = getServerAddress();
    setServerIdentity(fallback);
    // Only the desktop app has saved host names to show instead of an address.
    if (!isDesktop) return;
    let cancelled = false;

    void desktopHostsGet()
      .then((config) => {
        if (cancelled) return;
        const localOrigin = getLocalDesktopOrigin();
        const resolved = resolveCurrentDesktopHost([
          buildLocalDesktopHost(localOrigin),
          ...config.hosts,
        ]);
        const savedLabel = resolved.id === LOCAL_HOST_ID || resolved.id === 'custom'
          ? ''
          : resolved.label.trim();
        setServerIdentity(savedLabel ? redactSensitiveUrl(savedLabel) : fallback);
      })
      .catch(() => {
        if (!cancelled) setServerIdentity(fallback);
      });

    return () => {
      cancelled = true;
    };
  }, [isDesktop, showServer, runtimeEpoch]);

  React.useEffect(() => {
    if (!clientTarget) return;
    let cancelled = false;
    setClientLoading(true);
    void clientTarget.load()
      .then((channel) => {
        if (!cancelled) {
          setClientChannel(channel);
          setClientError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) setClientError(error instanceof Error ? error.message : `Unable to load the ${clientTarget.ariaLabel.toLowerCase()}.`);
      })
      .finally(() => {
        if (!cancelled) setClientLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clientTarget]);

  if (!clientTarget && !showServer) return null;

  const changeClientChannel = (nextChannel: string) => {
    if (!clientTarget) return;
    const parsed = parseUpdateChannel(nextChannel);
    const previous = clientChannel;
    setClientChannel(parsed);
    setClientSaving(true);
    setClientError(null);

    void clientTarget.save(parsed)
      .then((saved) => {
        setClientChannel(saved);
        useUpdateStore.getState().reset();
        void useUpdateStore.getState().checkForUpdates();
      })
      .catch((error) => {
        setClientChannel(previous);
        setClientError(error instanceof Error ? error.message : `Unable to save the ${clientTarget.ariaLabel.toLowerCase()}.`);
      })
      .finally(() => setClientSaving(false));
  };

  const serverChannelLabel = serverIdentity
    ? `Server update channel (${serverIdentity})`
    : 'Server update channel';

  return (
    <SettingsSection title="Updates">
      {clientTarget ? (
        <SettingsFieldRow
          label={clientTarget.label}
          info={clientTarget.info}
          description={clientError ? <span className="text-[var(--status-error)]">{clientError}</span> : undefined}
          settingsItem={clientTarget.settingsItem}
          {...CHANNEL_ROW_LAYOUT}
        >
          <UpdateChannelSelect
            className={CHANNEL_SELECT_CLASS}
            channel={clientChannel}
            disabled={clientLoading || clientSaving}
            label={clientTarget.ariaLabel}
            onChange={changeClientChannel}
          />
        </SettingsFieldRow>
      ) : null}

      {showServer ? (
        <SettingsFieldRow
          label={(
            <span className="@xl:whitespace-nowrap">
              Server channel
              {serverIdentity ? <span className="font-normal text-muted-foreground"> · {serverIdentity}</span> : null}
            </span>
          )}
          info="Stable receives production server releases only. Release candidate offers the highest available version across stable and server RC builds. Switching to Stable changes future update eligibility and does not downgrade an installed RC."
          description={server.error ? <span className="text-[var(--status-error)]">{server.error}</span> : undefined}
          settingsItem="about.server-update-channel"
          {...CHANNEL_ROW_LAYOUT}
        >
          <UpdateChannelSelect
            className={CHANNEL_SELECT_CLASS}
            channel={server.channel}
            disabled={server.loading || server.saving}
            label={serverChannelLabel}
            onChange={server.change}
          />
        </SettingsFieldRow>
      ) : null}
    </SettingsSection>
  );
};
