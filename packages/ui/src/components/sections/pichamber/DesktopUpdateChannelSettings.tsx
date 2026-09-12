import React from 'react';

import {
  SettingsFieldRow,
  SettingsSection,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
} from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { isDesktopLocalOriginActive, isDesktopShell } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useUpdateStore } from '@/stores/useUpdateStore';

type DesktopUpdateChannel = 'stable' | 'rc';

const parseDesktopUpdateChannel = (value: unknown): DesktopUpdateChannel => value === 'rc' ? 'rc' : 'stable';

export const DesktopUpdateChannelSettings: React.FC = () => {
  const isLocalDesktop = isDesktopShell() && isDesktopLocalOriginActive();
  const [channel, setChannel] = React.useState<DesktopUpdateChannel>('stable');
  const [loading, setLoading] = React.useState(isLocalDesktop);
  const [saving, setSaving] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!isLocalDesktop) return;
    let cancelled = false;

    void (async () => {
      try {
        const response = await runtimeFetch('/api/pi/ui-settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error('Unable to load the update channel.');
        const settings = await response.json().catch(() => null) as { desktopUpdateChannel?: unknown } | null;
        if (!settings) throw new Error('Unable to load the update channel.');
        if (!cancelled) {
          setChannel(parseDesktopUpdateChannel(settings.desktopUpdateChannel));
          setLoadError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Unable to load the update channel.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLocalDesktop]);

  if (!isLocalDesktop) return null;

  const changeChannel = (nextChannel: string) => {
    const parsed = parseDesktopUpdateChannel(nextChannel);
    const previous = channel;
    setChannel(parsed);
    setSaving(true);
    setLoadError(null);
    useUpdateStore.getState().reset();

    void (async () => {
      try {
        await updateDesktopSettings({ desktopUpdateChannel: parsed }, { immediate: true });
        const response = await runtimeFetch('/api/pi/ui-settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error('Unable to save the update channel.');
        const settings = await response.json().catch(() => null) as { desktopUpdateChannel?: unknown } | null;
        if (settings?.desktopUpdateChannel !== parsed) throw new Error('Unable to save the update channel.');
      } catch (error) {
        setChannel(previous);
        setLoadError(error instanceof Error ? error.message : 'Unable to save the update channel.');
      } finally {
        setSaving(false);
      }
    })();
  };

  return (
    <SettingsSection title="Updates">
      <SettingsFieldRow
        label="Update channel"
        info="Stable receives production releases only. Release candidate also receives RC builds before they become stable."
        description={loadError ? <span className="text-[var(--status-error)]">{loadError}</span> : undefined}
        settingsItem="about.update-channel"
      >
        <Select value={channel} onValueChange={changeChannel} disabled={loading || saving}>
          <SelectTrigger
            size={SETTINGS_SELECT_SIZE}
            className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
            aria-label="Update channel"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stable">Stable</SelectItem>
            <SelectItem value="rc">Release candidate</SelectItem>
          </SelectContent>
        </Select>
      </SettingsFieldRow>
    </SettingsSection>
  );
};
