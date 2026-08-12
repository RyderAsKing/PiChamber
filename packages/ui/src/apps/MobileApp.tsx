import React from 'react';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { PiApp } from './PiApp';
import { MobileConnectionWelcome } from './MobileConnectionWelcome';
import { getRuntimeApiBaseUrl, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { isCapacitorApp } from '@/lib/platform';
import type { RuntimeAPIs } from '@/lib/api/types';

/**
 * Capacitor still owns instance selection, password unlock, pairing, and relay
 * transport. Once an authenticated runtime is selected, sessions are rendered
 * through the same Pi-native app as web and desktop.
 */
export function MobileApp({ apis }: { apis: RuntimeAPIs }) {
  void apis;
  const [endpointEpoch, setEndpointEpoch] = React.useState(0);
  const native = React.useMemo(() => isCapacitorApp(), []);
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => setEndpointEpoch((value) => value + 1)), []);
  if (native && !getRuntimeApiBaseUrl()) {
    return <MobileConnectionWelcome onConnected={() => setEndpointEpoch((value) => value + 1)} />;
  }
  return <ErrorBoundary><div key={endpointEpoch} className="h-full bg-background text-foreground"><PiApp /></div></ErrorBoundary>;
}
