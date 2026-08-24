/* eslint-disable react-refresh/only-export-components */
import React, { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { getPiSessionStore, type PiSessionStore, type PiSessionStoreState, type PiSessionTopic } from '@/apps/pi-session-store';
import { useProjectsStore } from '@/stores/useProjectsStore';

import { parseRoute } from '@/lib/router';
import { isNewSessionDraftActive } from '@/lib/router/session-intent';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { createSnapshotSelectorCache } from './select-snapshot';
import { readLastActiveSession } from '@/sync/last-session-cache';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isCapacitorMobileApp } from '@/apps/mobileNativeChrome';

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
    const ui = useSessionUIStore.getState();
    const draftIsActive = isNewSessionDraftActive(ui.newSessionDraft, ui.currentSessionId);
    if (route.sessionId && !draftIsActive) {
      const state = store.getState();
      if (state.selectedSessionId === route.sessionId && state.connection === 'ready') return;
      void store.start({ directory: targetDirectory ?? undefined, sessionId: route.sessionId });
      return;
    }
    if (!targetDirectory) {
      // Even with no project, a persisted last session on this runtime
      // (e.g. a global ~ session) should be re-opened on reload instead
      // of showing the empty project picker. Native mobile has its own
      // restore flow with snapshot validation, so skip the shortcut there.
      if (!draftIsActive && !isCapacitorMobileApp()) {
        const persisted = readLastActiveSession(getRuntimeKey());
        if (persisted?.sessionId) {
          void store.start({
            ...(persisted.directory ? { directory: persisted.directory } : {}),
            sessionId: persisted.sessionId,
            ...(persisted.directory ? { sessionDirectoryKnown: true } : {}),
          });
          return;
        }
      }
      void store.connectWithoutProject();
      return;
    }
    // Remembered session hint: warm folder switches can skip the chat
    // loader by pre-selecting the last session the cluster attached for
    // that directory. The hint is internal — explicit route / caller
    // hints still win.
    const remembered = draftIsActive ? null : store.lastSelectedSessionForDirectory(targetDirectory);
    if (remembered) {
      void store.start({
        directory: targetDirectory,
        sessionId: remembered,
        sessionDirectoryKnown: true,
      });
      return;
    }
    // Full reload: in-memory LRU is empty but the last active session
    // is persisted per runtime (see last-session-cache). Using it here
    // keeps Ctrl+R on the same chat instead of showing the project's
    // first session. Native mobile's restore does its own snapshot
    // validation, so keep this path for web/desktop only.
    if (!draftIsActive && !isCapacitorMobileApp()) {
      const persisted = readLastActiveSession(getRuntimeKey());
      if (persisted?.sessionId) {
        void store.start({
          directory: persisted.directory ?? targetDirectory,
          sessionId: persisted.sessionId,
          ...(persisted.directory ? { sessionDirectoryKnown: true } : {}),
        });
        return;
      }
    }
    void store.start({
      directory: targetDirectory,
    });
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

