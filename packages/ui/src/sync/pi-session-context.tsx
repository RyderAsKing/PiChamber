/* eslint-disable react-refresh/only-export-components */
import React, { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { getPiSessionStore, type PiSessionStore } from '@/apps/pi-session-store';
import { useProjectsStore } from '@/stores/useProjectsStore';

import { parseRoute } from '@/lib/router';

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

export const usePiSessionSnapshot = () => {
  const store = usePiSessionStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
};

/** @deprecated OpenCode SyncProvider name kept for restored shell call sites. */
export const SyncProvider = ({ children, directory }: { children?: ReactNode; sdk?: unknown; directory?: string | null }) => (
  <PiSessionProvider directory={directory}>{children}</PiSessionProvider>
);
