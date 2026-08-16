/* eslint-disable react-refresh/only-export-components */
import React, { useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { getPiSessionStore, type PiSessionStore, type PiSessionStoreState } from '@/apps/pi-session-store';
import { useProjectsStore } from '@/stores/useProjectsStore';

import { parseRoute } from '@/lib/router';
import { createSnapshotSelectorCache } from './select-snapshot';

const PiSessionContext = React.createContext<PiSessionStore | null>(null);

export const usePiSessionStore = (): PiSessionStore => {
  const store = React.useContext(PiSessionContext);
  return store ?? getPiSessionStore();
};

export const PiSessionProvider = ({ children, directory }: { children: ReactNode; directory?: string | null }) => {
  const store = React.useMemo(() => getPiSessionStore(), []);
  const activeProjectDirectory = useProjectsStore((state) => (
    state.projects.find((project) => project.id === state.activeProjectId)?.path ?? null
  ));
  const targetDirectory = directory?.trim() || activeProjectDirectory;
  const startedRef = React.useRef<string | null>(null);

  useEffect(() => {
    const route = parseRoute();
    if (route.sessionId) {
      if (store.getState().selectedSessionId === route.sessionId && store.getState().connection === 'ready') {
        return;
      }
      if (startedRef.current === `session:${route.sessionId}`) {
        return;
      }
      startedRef.current = `session:${route.sessionId}`;
      void store.start({ directory: targetDirectory ?? undefined, sessionId: route.sessionId });
      return;
    }

    if (!targetDirectory) {
      startedRef.current = null;
      store.clear();
      return;
    }

    if (startedRef.current === `dir:${targetDirectory}`) {
      return;
    }
    startedRef.current = `dir:${targetDirectory}`;
    void store.start({ directory: targetDirectory });
  }, [store, targetDirectory]);
  return <PiSessionContext.Provider value={store}>{children}</PiSessionContext.Provider>;
};

const identitySnapshot = (state: PiSessionStoreState) => state;

export function usePiSessionSnapshot(): PiSessionStoreState;
export function usePiSessionSnapshot<T>(
  selector: (state: PiSessionStoreState) => T,
  isEqual?: (a: T, b: T) => boolean,
): T;
export function usePiSessionSnapshot<T>(
  selector?: (state: PiSessionStoreState) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  const store = usePiSessionStore();
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const isEqualRef = useRef(isEqual);
  isEqualRef.current = isEqual;
  const cacheRef = useRef<ReturnType<typeof createSnapshotSelectorCache<PiSessionStoreState, T>> | null>(null);
  cacheRef.current ??= createSnapshotSelectorCache<PiSessionStoreState, T>();

  // The cache keys on store snapshot identity, not selector identity. Entity
  // ids must be read outside this hook (subscribe to the map, then `.get(id)`).

  const getSelection = useCallback(() => {
    const select = (selectorRef.current ?? identitySnapshot) as (state: PiSessionStoreState) => T;
    const equal = typeof isEqualRef.current === 'function' ? isEqualRef.current : Object.is;
    return cacheRef.current!(store.getState(), select, equal);
  }, [store]);

  return useSyncExternalStore(store.subscribe, getSelection, getSelection);
}

/** @deprecated OpenCode SyncProvider name kept for restored shell call sites. */
export const SyncProvider = ({ children, directory }: { children?: ReactNode; sdk?: unknown; directory?: string | null }) => (
  <PiSessionProvider directory={directory}>{children}</PiSessionProvider>
);
