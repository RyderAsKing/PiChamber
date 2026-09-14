import React from 'react';

import {
  SettingsFieldRow,
  SettingsSection,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
} from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
import { updateDesktopSettings } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { notifyServerUpdateChannelChanged } from '@/lib/server-update-events';
import { useUpdateStore } from '@/stores/useUpdateStore';

type UpdateChannel = 'stable' | 'rc';
type ServerUpdateSettings = { serverUpdateChannel?: unknown };

const parseUpdateChannel = (value: unknown): UpdateChannel => value === 'rc' ? 'rc' : 'stable';

const UPDATE_CHANNEL_LABELS: Record<UpdateChannel, string> = {
  stable: 'Stable',
  rc: 'Release candidate',
};

const getServerUrlFallback = (): string => {
  const runtimeUrl = getRuntimeApiBaseUrl().trim();
  return runtimeUrl ? redactSensitiveUrl(runtimeUrl) : 'Server';
};

const UpdateChannelSelect: React.FC<{
  channel: UpdateChannel;
  disabled: boolean;
  label: string;
  onChange: (channel: string) => void;
}> = ({ channel, disabled, label, onChange }) => (
  <Select value={channel} onValueChange={onChange} disabled={disabled}>
    <SelectTrigger
      size={SETTINGS_SELECT_SIZE}
      className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
      aria-label={label}
    >
      <SelectValue>{(value) => UPDATE_CHANNEL_LABELS[parseUpdateChannel(value)]}</SelectValue>
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="stable">{UPDATE_CHANNEL_LABELS.stable}</SelectItem>
      <SelectItem value="rc">{UPDATE_CHANNEL_LABELS.rc}</SelectItem>
    </SelectContent>
  </Select>
);

export const DesktopUpdateChannelSettings: React.FC = () => {
  const isDesktop = isDesktopShell();
  const [runtimeEpoch, setRuntimeEpoch] = React.useState(0);
  const isLocalDesktop = isDesktop && isDesktopLocalOriginActive();
  const [serverIdentity, setServerIdentity] = React.useState(getServerUrlFallback);
  const serverChannelLabel = `Server update channel (${serverIdentity})`;
  const [desktopChannel, setDesktopChannel] = React.useState<UpdateChannel>('stable');
  const [serverChannel, setServerChannel] = React.useState<UpdateChannel>('stable');
  const [desktopLoading, setDesktopLoading] = React.useState(isDesktop);
  const [serverLoading, setServerLoading] = React.useState(isDesktop && !isLocalDesktop);
  const [desktopSaving, setDesktopSaving] = React.useState(false);
  const [serverSaving, setServerSaving] = React.useState(false);
  const [desktopError, setDesktopError] = React.useState<string | null>(null);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const serverOperationRef = React.useRef(0);

  React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
    serverOperationRef.current += 1;
    setRuntimeEpoch((value) => value + 1);
  }), []);

  React.useEffect(() => {
    if (!isDesktop || isLocalDesktop) return;
    let cancelled = false;
    const fallback = getServerUrlFallback();
    setServerIdentity(fallback);

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
        setServerIdentity(redactSensitiveUrl(savedLabel || fallback));
      })
      .catch(() => {
        if (!cancelled) setServerIdentity(fallback);
      });

    return () => {
      cancelled = true;
    };
  }, [isDesktop, isLocalDesktop, runtimeEpoch]);

  React.useEffect(() => {
    if (!isDesktop) return;
    let cancelled = false;
    setDesktopLoading(true);
    void getDesktopUpdateChannel()
      .then((channel) => {
        if (!cancelled) {
          setDesktopChannel(channel);
          setDesktopError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) setDesktopError(error instanceof Error ? error.message : 'Unable to load the desktop update channel.');
      })
      .finally(() => {
        if (!cancelled) setDesktopLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isDesktop]);

  React.useEffect(() => {
    const operation = ++serverOperationRef.current;
    if (!isDesktop || isLocalDesktop) {
      setServerLoading(false);
      setServerError(null);
      return;
    }
    setServerLoading(true);
    setServerSaving(false);

    void (async () => {
      try {
        const response = await runtimeFetch('/api/pi/ui-settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error('Unable to load the server update channel.');
        const settings = await response.json().catch(() => null) as ServerUpdateSettings | null;
        if (!settings) throw new Error('Unable to load the server update channel.');
        if (serverOperationRef.current === operation) {
          setServerChannel(parseUpdateChannel(settings.serverUpdateChannel));
          setServerError(null);
        }
      } catch (error) {
        if (serverOperationRef.current === operation) {
          setServerError(error instanceof Error ? error.message : 'Unable to load the server update channel.');
        }
      } finally {
        if (serverOperationRef.current === operation) setServerLoading(false);
      }
    })();
  }, [isDesktop, isLocalDesktop, runtimeEpoch]);

  if (!isDesktop) return null;

  const changeDesktopChannel = (nextChannel: string) => {
    const parsed = parseUpdateChannel(nextChannel);
    const previous = desktopChannel;
    setDesktopChannel(parsed);
    setDesktopSaving(true);
    setDesktopError(null);

    void setDesktopUpdateChannel(parsed)
      .then((saved) => {
        setDesktopChannel(saved);
        useUpdateStore.getState().reset();
        void useUpdateStore.getState().checkForUpdates();
      })
      .catch((error) => {
        setDesktopChannel(previous);
        setDesktopError(error instanceof Error ? error.message : 'Unable to save the desktop update channel.');
      })
      .finally(() => setDesktopSaving(false));
  };

  const changeServerChannel = (nextChannel: string) => {
    const parsed = parseUpdateChannel(nextChannel);
    const previous = serverChannel;
    const operation = ++serverOperationRef.current;
    setServerChannel(parsed);
    setServerSaving(true);
    setServerError(null);

    void (async () => {
      try {
        await updateDesktopSettings({ serverUpdateChannel: parsed }, { immediate: true });
        const response = await runtimeFetch('/api/pi/ui-settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error('Unable to save the server update channel.');
        const settings = await response.json().catch(() => null) as ServerUpdateSettings | null;
        if (settings?.serverUpdateChannel !== parsed) throw new Error('Unable to save the server update channel.');
        if (serverOperationRef.current === operation) {
          notifyServerUpdateChannelChanged();
        }
      } catch (error) {
        if (serverOperationRef.current === operation) {
          setServerChannel(previous);
          setServerError(error instanceof Error ? error.message : 'Unable to save the server update channel.');
        }
      } finally {
        if (serverOperationRef.current === operation) setServerSaving(false);
      }
    })();
  };

  return (
    <SettingsSection title="Updates">
      <SettingsFieldRow
        label="Desktop app update channel"
        info="Stable receives production desktop releases only. Release candidate offers the highest available version across stable and desktop RC builds. Switching to Stable changes future update eligibility and does not downgrade an installed RC."
        description={desktopError ? <span className="text-[var(--status-error)]">{desktopError}</span> : undefined}
        settingsItem="about.desktop-update-channel"
        labelClassName="@xl:w-auto"
        controlClassName="@xl:flex-1"
      >
        <UpdateChannelSelect
          channel={desktopChannel}
          disabled={desktopLoading || desktopSaving}
          label="Desktop app update channel"
          onChange={changeDesktopChannel}
        />
      </SettingsFieldRow>

      {!isLocalDesktop && (
        <SettingsFieldRow
          label={(
            <span className="@xl:whitespace-nowrap">
              Server update channel <span className="font-normal text-muted-foreground">· {serverIdentity}</span>
            </span>
          )}
          info="Stable receives production server releases only. Release candidate offers the highest available version across stable and server RC builds. Switching to Stable changes future update eligibility and does not downgrade an installed RC."
          description={serverError ? <span className="text-[var(--status-error)]">{serverError}</span> : undefined}
          settingsItem="about.server-update-channel"
          labelClassName="@xl:w-auto"
          controlClassName="@xl:flex-1"
        >
          <UpdateChannelSelect
            channel={serverChannel}
            disabled={serverLoading || serverSaving}
            label={serverChannelLabel}
            onChange={changeServerChannel}
          />
        </SettingsFieldRow>
      )}
    </SettingsSection>
  );
};
