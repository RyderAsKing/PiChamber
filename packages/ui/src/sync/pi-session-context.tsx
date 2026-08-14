/* eslint-disable */
import React, { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { getPiSessionStore, type PiSessionStore } from '@/apps/pi-session-store';
import { useProjectsStore } from '@/stores/useProjectsStore';

const PiSessionContext = React.createContext<PiSessionStore | null>(null);

export const usePiSessionStore = (): PiSessionStore => {
  const store = React.useContext(PiSessionContext);
  return store ?? getPiSessionStore();
};

export const PiSessionProvider = ({ children, directory }: { children: ReactNode; directory?: string }) => {
  const store = React.useMemo(() => getPiSessionStore(), []);
  const activeProjectDirectory = useProjectsStore((state) => (
    state.projects.find((project) => project.id === state.activeProjectId)?.path ?? null
  ));
  const targetDirectory = directory?.trim() || activeProjectDirectory;
  useEffect(() => {
    if (!targetDirectory) {
      store.clear();
      return;
    }
    void store.start({ directory: targetDirectory });
  }, [store, targetDirectory]);
  return <PiSessionContext.Provider value={store}>{children}</PiSessionContext.Provider>;
};

export const usePiSessionSnapshot = () => {
  const store = usePiSessionStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
};

/** @deprecated OpenCode SyncProvider name kept for restored shell call sites. */
export const SyncProvider = ({ children, directory }: { children?: ReactNode; sdk?: unknown; directory?: string }) => (
  <PiSessionProvider directory={directory}>{children}</PiSessionProvider>
);
