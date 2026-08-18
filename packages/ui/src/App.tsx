import React from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { Toaster } from '@/components/ui/sonner';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { getRegisteredRuntimeAPIs, registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { SyncAppEffects } from '@/apps/AppEffects';
import { resetAppForRuntimeEndpointChange } from '@/apps/runtimeEndpointReset';
import { useAppFontEffects } from '@/apps/useAppFontEffects';
import { PiSessionProvider } from '@/sync/pi-session-context';
import { FireworksProvider } from '@/contexts/FireworksContext';
import { PerfHudHost } from '@/components/perf/PerfHudHost';
import { useRouter } from '@/hooks/useRouter';
import type { RuntimeAPIs } from '@/lib/api/types';
import { syncDesktopSettings } from '@/lib/persistence';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

const AppInner: React.FC = () => {
  useAppFontEffects();
  useRouter();
  return (
    <FireworksProvider>
      <SyncAppEffects embeddedBackgroundWorkEnabled />
      <MainLayout />
      <Toaster />
      <PerfHudHost />
    </FireworksProvider>
  );
};

function App({ apis }: { apis?: RuntimeAPIs }) {
  const resolved = apis ?? getRegisteredRuntimeAPIs();
  const [runtimeEndpointEpoch, setRuntimeEndpointEpoch] = React.useState(0);

  React.useEffect(() => {
    return subscribeRuntimeEndpointChanged((detail) => {
      // A LAN↔relay change for the same instance only changes transport. The
      // session store reconnects in place; a different runtime needs a full
      // store reset so paths, sessions, and provider state cannot cross hosts.
      if (detail.runtimeKey === detail.previousRuntimeKey) return;
      resetAppForRuntimeEndpointChange(detail);
      setRuntimeEndpointEpoch((epoch) => epoch + 1);
    });
  }, []);

  // This effect runs after the authenticated App is mounted. On a real host
  // switch, an auth failure unmounts App before this reruns, so settings are
  // not fetched against a runtime that has not been unlocked yet.
  React.useEffect(() => {
    void syncDesktopSettings();
  }, [runtimeEndpointEpoch]);

  React.useEffect(() => {
    if (resolved) registerRuntimeAPIs(resolved);
  }, [resolved]);
  if (!resolved) {
    return (
      <ErrorBoundary>
        <div className="h-full w-full overflow-hidden bg-background text-foreground" />
      </ErrorBoundary>
    );
  }
  return (
    <ErrorBoundary>
      <div className="h-full w-full overflow-hidden bg-background text-foreground">
        <RuntimeAPIProvider apis={resolved}>
          <PiSessionProvider key={runtimeEndpointEpoch}>
            <TooltipProvider>
              <AppInner />
            </TooltipProvider>
          </PiSessionProvider>
        </RuntimeAPIProvider>
      </div>
    </ErrorBoundary>
  );
}

export default App;
