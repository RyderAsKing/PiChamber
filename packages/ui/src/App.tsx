import React from 'react';
import { PiApp } from '@/apps/PiApp';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';

/** The mounted session application is Pi-native. */
function App() {
  return <ErrorBoundary><div className="h-full bg-background text-foreground"><PiApp /></div></ErrorBoundary>;
}

export default App;
