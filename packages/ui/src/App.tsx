import React from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { Toaster } from '@/components/ui/sonner';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { getRegisteredRuntimeAPIs, registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { SyncAppEffects } from '@/apps/AppEffects';
import { useAppFontEffects } from '@/apps/useAppFontEffects';
import { PiSessionProvider } from '@/sync/pi-session-context';
import { FireworksProvider } from '@/contexts/FireworksContext';
import { useRouter } from '@/hooks/useRouter';
import type { RuntimeAPIs } from '@/lib/api/types';

const AppInner: React.FC = () => {
  useAppFontEffects();
  useRouter();
  return (
    <FireworksProvider>
      <SyncAppEffects embeddedBackgroundWorkEnabled />
      <MainLayout />
      <Toaster />
    </FireworksProvider>
  );
};

function App({ apis }: { apis?: RuntimeAPIs }) {
  const resolved = apis ?? getRegisteredRuntimeAPIs();
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
          <PiSessionProvider>
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
