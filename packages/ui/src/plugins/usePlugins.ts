import React from 'react';

import type { PiPluginView } from '@/lib/pi/protocol';
import { selectPlugins, usePluginsStore, type PluginsEntry } from './store';

/**
 * Plugins resolved for `directory` (global values when it is empty). Loads on
 * mount and refreshes when the window comes back into view, so a change made
 * on another device shows up; the store skips reads fresher than 5 s.
 */
export function usePlugins(directory?: string | null): {
  plugins: PiPluginView[];
  entry: PluginsEntry | undefined;
} {
  const plugins = usePluginsStore(selectPlugins(directory));
  const entry = usePluginsStore((state) => state.entries[directory?.trim() ?? '']);
  const load = usePluginsStore((state) => state.load);

  React.useEffect(() => {
    void load(directory);
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      void load(directory);
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [directory, load]);

  return { plugins, entry };
}
