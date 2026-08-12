import React from 'react';
import { PiApp } from '@/apps/PiApp';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import type { RuntimeAPIs } from '@/lib/api/types';

type AppProps = { apis: RuntimeAPIs };

/** The mounted session application is Pi-native; runtime APIs remain shell-owned. */
function App({ apis }: AppProps) {
  void apis;
  return <ErrorBoundary><div className="h-full bg-background text-foreground"><PiApp /></div></ErrorBoundary>;
}

export default App;
