import React from 'react';

import { useExtensionConfigStore, type ExtensionConfigEntry } from './extensionConfigStore';

/**
 * Pi's extensions and packages for `directory` (the global view when it is
 * empty). Loads on mount and when the window comes back into view, so a
 * change made in a terminal or on another device shows up; the store skips
 * reads fresher than 5 s.
 */
export function useExtensionConfig(directory?: string | null): ExtensionConfigEntry | undefined {
  const entry = useExtensionConfigStore((state) => state.entries[directory?.trim() ?? '']);
  const load = useExtensionConfigStore((state) => state.load);

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

  // A write to another view, or `invalidate`, ages this one while it is
  // shown: read it again. A failed read leaves `error`, so this cannot loop.
  const stale = entry?.status === 'ready' && entry.loadedAt === 0;
  React.useEffect(() => {
    if (stale) void load(directory);
  }, [stale, directory, load]);

  return entry;
}
