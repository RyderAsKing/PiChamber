import React from 'react';

import { parseUpdateChannel, type UpdateChannel } from '@/lib/updateChannel';
import { updateDesktopSettings } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { notifyServerUpdateChannelChanged } from '@/lib/server-update-events';
import { useUpdateStore } from '@/stores/useUpdateStore';

type ServerUpdateSettings = { serverUpdateChannel?: unknown };

interface ServerUpdateChannelState {
  channel: UpdateChannel;
  loading: boolean;
  saving: boolean;
  error: string | null;
  change: (channel: string) => void;
  /** Bumps when the connected server changes, so callers can refresh what they show for it. */
  runtimeEpoch: number;
}

/**
 * The connected server's update channel (`serverUpdateChannel` in its UI settings).
 * Reads it while `enabled`, rereads after a runtime switch, and rolls a change back
 * when the server does not confirm it.
 */
export const useServerUpdateChannel = (enabled: boolean): ServerUpdateChannelState => {
  const [runtimeEpoch, setRuntimeEpoch] = React.useState(0);
  const [channel, setChannel] = React.useState<UpdateChannel>('stable');
  const [loading, setLoading] = React.useState(enabled);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const operationRef = React.useRef(0);

  React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
    operationRef.current += 1;
    setRuntimeEpoch((value) => value + 1);
  }), []);

  React.useEffect(() => {
    const operation = ++operationRef.current;
    if (!enabled) {
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setSaving(false);

    void (async () => {
      try {
        const response = await runtimeFetch('/api/pi/ui-settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error('Unable to load the server update channel.');
        const settings = await response.json().catch(() => null) as ServerUpdateSettings | null;
        if (!settings) throw new Error('Unable to load the server update channel.');
        if (operationRef.current === operation) {
          setChannel(parseUpdateChannel(settings.serverUpdateChannel));
          setError(null);
        }
      } catch (loadError) {
        if (operationRef.current === operation) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load the server update channel.');
        }
      } finally {
        if (operationRef.current === operation) setLoading(false);
      }
    })();
  }, [enabled, runtimeEpoch]);

  const change = React.useCallback((nextChannel: string) => {
    const parsed = parseUpdateChannel(nextChannel);
    const previous = channel;
    const operation = ++operationRef.current;
    setChannel(parsed);
    setSaving(true);
    setError(null);

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
        if (operationRef.current === operation) {
          notifyServerUpdateChannelChanged();
          // The About page's Server row comes from the update store; recheck it on the new channel.
          void useUpdateStore.getState().checkForUpdates();
        }
      } catch (saveError) {
        if (operationRef.current === operation) {
          setChannel(previous);
          setError(saveError instanceof Error ? saveError.message : 'Unable to save the server update channel.');
        }
      } finally {
        if (operationRef.current === operation) setSaving(false);
      }
    })();
  }, [channel]);

  return { channel, loading, saving, error, change, runtimeEpoch };
};
