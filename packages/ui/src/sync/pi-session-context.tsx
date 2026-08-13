/* eslint-disable */
import React, { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { getPiSessionStore, type PiSessionStore } from '@/apps/pi-session-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

const PiSessionContext = React.createContext<PiSessionStore | null>(null);

export const usePiSessionStore = (): PiSessionStore => {
  const store = React.useContext(PiSessionContext);
  return store ?? getPiSessionStore();
};

export const PiSessionProvider = ({ children }: { children: ReactNode }) => {
  const store = React.useMemo(() => getPiSessionStore(), []);
  const directory = useDirectoryStore((state) => state.currentDirectory);
  useEffect(() => {
    void store.start({ directory: directory || undefined });
  }, [store, directory]);
  return <PiSessionContext.Provider value={store}>{children}</PiSessionContext.Provider>;
};

export const usePiSessionSnapshot = () => {
  const store = usePiSessionStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
};

/** @deprecated OpenCode SyncProvider name kept for restored shell call sites. */
export const SyncProvider = ({ children }: { children?: ReactNode; sdk?: unknown; directory?: string }) => (
  <PiSessionProvider>{children}</PiSessionProvider>
);
