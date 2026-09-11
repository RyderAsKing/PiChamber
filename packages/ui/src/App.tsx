import React from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { Toaster } from '@/components/ui/sonner';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { getRegisteredRuntimeAPIs, registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { SyncAppEffects } from '@/apps/AppEffects';
import { resetAppForRuntimeEndpointChange } from '@/apps/runtimeEndpointReset';
import { resetTerminalTransport } from '@/lib/terminalApi';
import { useAppFontEffects } from '@/apps/useAppFontEffects';
import { PiSessionProvider } from '@/sync/pi-session-context';
import { FireworksProvider } from '@/contexts/FireworksContext';
import { PerfHudHost } from '@/components/perf/PerfHudHost';
import { WorktreeCreationToasts } from '@/components/worktree/WorktreeCreationToasts';
import { useRouter } from '@/hooks/useRouter';
import type { RuntimeAPIs } from '@/lib/api/types';
import { syncDesktopSettings } from '@/lib/persistence';
import { startAppearanceAutoSave } from '@/lib/appearanceAutoSave';
import { startModelPrefsAutoSave } from '@/lib/modelPrefsAutoSave';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { WindowTitleEffect } from '@/hooks/useWindowTitle';

const AppInner: React.FC = () => {
  useAppFontEffects();
  useRouter();
  return (
    <FireworksProvider>
      <SyncAppEffects embeddedBackgroundWorkEnabled />
      <WindowTitleEffect />
      <MainLayout />
      <WorktreeCreationToasts />
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
      // A same-runtime LAN↔relay change keeps session and terminal state.
      // A different runtime clears state so IDs and paths cannot cross hosts.
      if (detail.runtimeKey === detail.previousRuntimeKey) {
        resetTerminalTransport();
        return;
      }
      resetAppForRuntimeEndpointChange(detail);
      setRuntimeEndpointEpoch((epoch) => epoch + 1);
    });
  }, []);

  // This effect runs after the authenticated App is mounted. On a real host
  // switch, an auth failure unmounts App before this reruns, so settings are
  // not fetched against a runtime that has not been unlocked yet.
  React.useEffect(() => {
    let active = true;
    let stopAppearanceAutoSave: (() => void) | null = null;
    let stopModelPrefsAutoSave: (() => void) | null = null;

    void syncDesktopSettings().then(() => {
      if (active) {
        stopAppearanceAutoSave = startAppearanceAutoSave();
        stopModelPrefsAutoSave = startModelPrefsAutoSave();
      }
    });

    return () => {
      active = false;
      stopAppearanceAutoSave?.();
      stopModelPrefsAutoSave?.();
    };
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
