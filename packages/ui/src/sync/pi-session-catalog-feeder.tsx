/**
 * Catalog feeder — keeps `PiSessionStore.catalog` populated for every
 * directory the sidebar knows about: project roots plus the discovered
 * worktree paths in `useSessionUIStore.availableWorktreesByProject`. The
 * feeder is the single fill path; the at-most-2-in-flight scheduler and
 * the per-directory refresh generation live in `pi-session-store.ts`
 * and `pi-session-catalog.ts`.
 *
 * Why a thin React wrapper:
 *
 * - Subscribe to `useProjectsStore` and `useSessionUIStore` once on mount.
 * - Compute the sorted directory-set signature and skip the refresh when
 *   it has not changed. Subscription churn from unrelated state changes
 *   (collapsing projects, reordering) must not re-list every folder.
 * - On every change in the project / worktree set, ask the store to
 *   refresh. The store's scheduler queues correctly even when calls
 *   overlap.
 *
 * Mini-chat uses `SyncRuntimeEffects` (no feeder); the global
 * `useGlobalSessionsStore.loadSessions` is its fill path until hooks
 * migrate, and that store calls through the same catalog owner.
 */

import { useEffect } from 'react';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { buildKnownSessionDirectories } from '@/sync/known-session-directories';

const collectProjectDirectories = (): string[] => {
  const projects = useProjectsStore.getState().projects;
  // `availableWorktreesByProject` is a runtime-scoped field on the session
  // UI store; the field is not yet on the public state type, so reach
  // through a narrow cast that matches the sidebar's existing pattern.
  const worktrees = (useSessionUIStore.getState() as {
    availableWorktreesByProject?: Map<string, ReadonlyArray<{ path?: string | null }> | null | undefined>;
  }).availableWorktreesByProject;
  return [...buildKnownSessionDirectories(projects, worktrees, { includeWorktrees: true })];
};

const sortedSignature = (directories: readonly string[]): string => {
  if (directories.length === 0) return '';
  return [...directories].sort().join('|');
};

export const PiSessionCatalogFeeder: React.FC = () => {
  useEffect(() => {
    let cancelled = false;
    let lastSignature = '';
    const store = getPiSessionStore();

    const refresh = () => {
      if (cancelled) return;
      const directories = collectProjectDirectories();
      if (directories.length === 0) return;
      const signature = sortedSignature(directories);
      // Skip the refresh when the set of directories has not actually
      // changed. Project-list updates that reorder the same set, or
      // worktree discovery that yields the same paths, must not trigger
      // a fresh `listSessions` round-trip.
      if (signature === lastSignature) return;

      const state = store.getState();
      // The focused directory is already listed by the attach/focus path.
      // Wait for that path to settle before starting background catalog work;
      // otherwise every known project competes with the selected chat for the
      // browser connection pool during a runtime switch.
      if (
        state.connection !== 'ready'
        || state.sessionsListStatus === 'loading'
        || (
          state.selectedSessionId
          && state.focusPending
          && state.sessionsListStatus !== 'failed'
        )
      ) {
        return;
      }

      const pendingDirectories = directories.filter((directory) => (
        store.getState().catalog.listStatusByDirectory.get(directory) !== 'ready'
      ));
      if (pendingDirectories.length === 0) {
        lastSignature = signature;
        return;
      }

      lastSignature = signature;
      void store.refreshAllDirectoryCatalogs(pendingDirectories);
    };

    refresh();
    const unsubscribeProjects = useProjectsStore.subscribe(refresh);
    const unsubscribeUI = useSessionUIStore.subscribe(refresh);
    const unsubscribePi = store.subscribe(refresh, 'chrome');

    return () => {
      cancelled = true;
      unsubscribeProjects();
      unsubscribeUI();
      unsubscribePi();
    };
  }, []);

  return null;
};