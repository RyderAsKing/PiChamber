import React from 'react';
import { getRuntimeApiBaseUrl, getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

export function useActiveRemoteLabel(mobileAppInstanceLabel?: string | null): string | null {
  const [activeRemoteLabel, setActiveRemoteLabel] = React.useState<string | null>(null);

  React.useEffect(() => {
    const update = async () => {
      try {
        const { loadMobileConnections, isActiveRuntimeConnection } = await import(
          '@/apps/mobileConnections'
        );
        const connections = await loadMobileConnections().catch(() => []);
        const active = connections.find((c) => isActiveRuntimeConnection(c));
        if (active) {
          setActiveRemoteLabel(active.label);
          return;
        }
      } catch {}
      if (mobileAppInstanceLabel) {
        setActiveRemoteLabel(mobileAppInstanceLabel);
        return;
      }
      try {
        const { desktopHostsGet } = await import('@/lib/desktopHosts');
        const { buildLocalDesktopHost, getLocalDesktopOrigin, resolveCurrentDesktopHost } = await import(
          '@/lib/desktopCurrentHost'
        );
        const cfg = await desktopHostsGet().catch(() => ({ hosts: [] as any[] }));
        const local = buildLocalDesktopHost(getLocalDesktopOrigin());
        const all = [local, ...cfg.hosts];
        const resolved = resolveCurrentDesktopHost(all);
        if (resolved && resolved.label && resolved.label !== 'Instance') {
          setActiveRemoteLabel(resolved.label);
          return;
        }
      } catch {}
      const url = getRuntimeApiBaseUrl();
      const key = getRuntimeKey();
      if (key === 'local') {
        setActiveRemoteLabel('Local');
        return;
      }
      if (key.startsWith('relay:')) {
        const serverId = key.split(':')[1]?.split('@')[0];
        setActiveRemoteLabel(serverId ? `Relay ${serverId.slice(0, 8)}` : 'Private relay');
        return;
      }
      if (key.startsWith('host:')) {
        setActiveRemoteLabel(key.replace('host:', ''));
        return;
      }
      if (url) {
        try {
          const parsed = new URL(url);
          setActiveRemoteLabel(parsed.host);
          return;
        } catch {
          setActiveRemoteLabel(url);
          return;
        }
      }
      setActiveRemoteLabel(null);
    };

    void update();
    return subscribeRuntimeEndpointChanged(() => void update());
  }, [mobileAppInstanceLabel]);

  return activeRemoteLabel;
}
