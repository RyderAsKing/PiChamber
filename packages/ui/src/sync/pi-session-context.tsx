/* eslint-disable react-refresh/only-export-components */
import React, { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { getPiSessionStore, type PiSessionStore, type PiSessionStoreState, type PiSessionTopic } from '@/apps/pi-session-store';
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

  // The cluster belongs to the connected runtime, not the focused project.
  // `start` itself routes to `focusProject` once the cluster is attached, so
  // we don't need a separate ref to remember which folder the cluster
  // bootstrap covered — later folder changes focus in place. With no
  // project selected we clear the focus pointer but never the resident
  // session cluster, so background busy runs keep streaming.
  useEffect(() => {
    const route = parseRoute();
    if (route.sessionId) {
      const state = store.getState();
      if (state.selectedSessionId === route.sessionId && state.connection === 'ready') return;
      void store.start({ directory: targetDirectory ?? undefined, sessionId: route.sessionId });
      return;
    }
    if (!targetDirectory) {
      void store.focusProject(null, null);
      return;
    }
    // Remembered session hint: warm folder switches can skip the chat
    // loader by pre-selecting the last session the cluster attached for
    // that directory. The hint is internal — explicit route / caller
    // hints still win.
    const remembered = store.lastSelectedSessionForDirectory(targetDirectory);
    void store.start({ directory: targetDirectory, ...(remembered ? { sessionId: remembered } : {}) });
  }, [store, targetDirectory]);
  return <PiSessionContext.Provider value={store}>{children}</PiSessionContext.Provider>;
};

const identitySnapshot = (state: PiSessionStoreState) => state;

export function usePiSessionSnapshot(): PiSessionStoreState;
export function usePiSessionSnapshot<T>(
  selector: (state: PiSessionStoreState) => T,
  isEqual?: (a: T, b: T) => boolean,
  topic?: PiSessionTopic,
): T;
export function usePiSessionSnapshot<T>(
  selector?: (state: PiSessionStoreState) => T,
  isEqual?: (a: T, b: T) => boolean,
  topic: PiSessionTopic = '*',
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

  // `useSyncExternalStore` requires a stable `subscribe` reference per
  // topic. Without `useMemo` keyed on `topic`, every render would
  // re-subscribe (and re-run the snapshot read on the next store commit).
  const subscribe = useMemo(
    () => (listener: () => void) => store.subscribe(listener, topic),
    [store, topic],
  );

  return useSyncExternalStore(subscribe, getSelection, getSelection);
}

/** @deprecated OpenCode SyncProvider name kept for restored shell call sites. */
export const SyncProvider = ({ children, directory }: { children?: ReactNode; sdk?: unknown; directory?: string | null }) => (
  <PiSessionProvider directory={directory}>{children}</PiSessionProvider>
);
