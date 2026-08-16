/**
 * Catalog feeder — keeps `PiSessionStore.catalog` populated for every
 * directory the user has in `useProjectsStore`. The feeder does not own
 * per-directory scheduling itself; it calls
 * `PiSessionStore.refreshAllDirectoryCatalogs(directories)`, which owns
 * the at-most-2-in-flight scheduler and the failure-is-not-empty rule.
 *
 * The feeder is intentionally a thin React wrapper:
 *
 * - Subscribe to `useProjectsStore` once on mount.
 * - On every change in the project directory set, ask the store to refresh.
 *   A subscription change while a refresh is already in flight still
 *   triggers a new batch \u2014 the store's scheduler queues correctly.
 * - On runtime switch (`resetForRuntime`), the catalog is already cleared
 *   by `PiSessionStore` itself; the next `useProjectsStore` subscription
 *   tick repopulates it from the new projects list.
 */

import { useEffect } from 'react';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { useProjectsStore } from '@/stores/useProjectsStore';

const collectProjectDirectories = (): string[] => {
  const projects = useProjectsStore.getState().projects;
  const seen = new Set<string>();
  for (const project of projects) {
    if (typeof project.path === 'string' && project.path.length > 0) {
      seen.add(project.path);
    }
  }
  return [...seen];
};

export const PiSessionCatalogFeeder: React.FC = () => {
  useEffect(() => {
    let cancelled = false;

    const refresh = () => {
      if (cancelled) return;
      const directories = collectProjectDirectories();
      if (directories.length === 0) return;
      void getPiSessionStore().refreshAllDirectoryCatalogs(directories);
    };

    refresh();
    const unsubscribe = useProjectsStore.subscribe(refresh);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return null;
};